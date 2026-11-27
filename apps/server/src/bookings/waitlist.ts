import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  ACTIVE_BOOKING_STATUSES,
  bookings,
  clubs,
  guests,
  waitlistEntries,
  type Club,
  type Guest,
  type WaitlistEntry,
} from '../db/schema.js';
import { paxRangeCode } from '../data/event-types.js';
import { emit } from '../data/events.js';
import { isTestContext } from '../data/test-flag.js';
import { currentNightDate } from '../lib/time.js';
import { newId } from '../lib/util.js';
import { availableTables, isNightOpen, paxRange, SELF_BOOK_MAX_PAX, type Actor, type PaxRangeKey } from './service.js';

/**
 * Waitlist (plan B22, spec §5.2 steps 1 and 3). A guest waits for one night and one party-size
 * range. When a table frees up, the `waitlist` job offers it to waiting guests in join order; the
 * offer is a message with [Book now], not a hold, so the first guest to hold the table wins.
 */

/** How long an offer stays open before the next guest is offered (plan B22 assumption). */
export const WAITLIST_OFFER_MINUTES = 15;

const OPEN = ['waiting', 'offered'] as const;

export class WaitlistError extends Error {
  constructor(readonly code: 'bad_range' | 'night_not_bookable' | 'not_found') {
    super(code);
    this.name = 'WaitlistError';
  }
}

/** The ranges a guest can wait for: the self-book ranges (13+ goes to a host). */
function waitRange(key: string) {
  const r = paxRange(key);
  return r && r.min <= SELF_BOOK_MAX_PAX ? r : undefined;
}

/**
 * Adds the guest to the night's waitlist, or returns their open entry (its range updated to the
 * new one). `waitlist.joined` is emitted only for a new entry.
 */
export async function joinWaitlist(
  db: Db,
  club: Club,
  input: { guestId: string; nightDate: string; paxRange: PaxRangeKey },
  now: Date,
): Promise<{ entry: WaitlistEntry; created: boolean }> {
  if (!waitRange(input.paxRange)) throw new WaitlistError('bad_range');
  const guest = await db.query.guests.findFirst({ where: and(eq(guests.id, input.guestId), eq(guests.clubId, club.id)) });
  if (!guest) throw new WaitlistError('not_found');
  if (!(await isNightOpen(db, club, input.nightDate, now))) throw new WaitlistError('night_not_bookable');
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(waitlistEntries)
      .values({ id: newId(), clubId: club.id, guestId: guest.id, nightDate: input.nightDate, paxRange: input.paxRange, status: 'waiting', createdAt: now })
      .onConflictDoNothing()
      .returning();
    if (row) {
      await emit(tx, {
        clubId: club.id,
        type: 'waitlist.joined',
        occurredAt: now,
        actorType: 'guest',
        actorId: guest.id,
        dataOrigin: 'first_party',
        guestId: guest.id,
        nightDate: input.nightDate,
        isTest: isTestContext({ club, guest }),
        props: { pax_range: paxRangeCode(input.paxRange) },
      });
      return { entry: row, created: true };
    }
    const [open] = await tx
      .update(waitlistEntries)
      .set({ paxRange: input.paxRange })
      .where(
        and(
          eq(waitlistEntries.clubId, club.id),
          eq(waitlistEntries.guestId, guest.id),
          eq(waitlistEntries.nightDate, input.nightDate),
          inArray(waitlistEntries.status, [...OPEN]),
        ),
      )
      .returning();
    return { entry: open!, created: false };
  });
}

/** Cancels an open entry of this club (guest "leave" or staff delete). `undefined` when there is none. */
export async function leaveWaitlist(db: Db, clubId: string, entryId: string, _actor: Actor, now: Date): Promise<WaitlistEntry | undefined> {
  const [row] = await db
    .update(waitlistEntries)
    .set({ status: 'cancelled', endedAt: now })
    .where(and(eq(waitlistEntries.id, entryId), eq(waitlistEntries.clubId, clubId), inArray(waitlistEntries.status, [...OPEN])))
    .returning();
  return row;
}

/** A waitlist entry of this club, or undefined. */
export async function getWaitlistEntry(db: Db, clubId: string, entryId: string): Promise<WaitlistEntry | undefined> {
  return db.query.waitlistEntries.findFirst({ where: and(eq(waitlistEntries.id, entryId), eq(waitlistEntries.clubId, clubId)) });
}

export interface WaitlistRow {
  entry: WaitlistEntry;
  guestName: string | null;
  isTest: boolean;
}

/** The night's entries in join order. Test guests are hidden once the club is live (spec §9 rule 2). */
export async function listWaitlist(db: Db, club: Club, nightDate: string): Promise<WaitlistRow[]> {
  const rows = await db
    .select({ entry: waitlistEntries, guest: guests })
    .from(waitlistEntries)
    .innerJoin(guests, eq(guests.id, waitlistEntries.guestId))
    .where(and(eq(waitlistEntries.clubId, club.id), eq(waitlistEntries.nightDate, nightDate)))
    .orderBy(asc(waitlistEntries.createdAt));
  return rows
    .filter((r) => club.status !== 'live' || !r.guest.isTest)
    .map((r) => ({ entry: r.entry, guestName: r.guest.name ?? r.guest.displayName, isTest: r.guest.isTest }));
}

export interface WaitlistOffer {
  entry: WaitlistEntry;
  club: Club;
  guest: Guest;
}

const end = (db: Db, id: string, set: Partial<typeof waitlistEntries.$inferInsert>) =>
  db
    .update(waitlistEntries)
    .set(set)
    .where(and(eq(waitlistEntries.id, id), inArray(waitlistEntries.status, [...OPEN])));

/**
 * One waitlist pass (the `waitlist` job, every minute). Per open entry: a past night expires it;
 * an active booking of the guest that night marks it `booked`; an offer past
 * `offer_expires_at` expires it. Then, per club, night and side (B6: test guests see test-side
 * tables only), free tables are offered to waiting entries in join order, never more open offers
 * than free tables, and only to entries a free table fits. Returns the new offers to send.
 */
export async function runWaitlist(db: Db, now: Date): Promise<WaitlistOffer[]> {
  const open = await db
    .select({ entry: waitlistEntries, guest: guests, club: clubs })
    .from(waitlistEntries)
    .innerJoin(guests, eq(guests.id, waitlistEntries.guestId))
    .innerJoin(clubs, eq(clubs.id, waitlistEntries.clubId))
    .where(inArray(waitlistEntries.status, [...OPEN]))
    .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id));

  const live: typeof open = [];
  for (const row of open) {
    const { entry, club } = row;
    if (entry.nightDate < currentNightDate(now, club.settings.nightEndHour)) {
      await end(db, entry.id, { status: 'expired', endedAt: now });
      continue;
    }
    const [booked] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.clubId, club.id),
          eq(bookings.guestId, entry.guestId),
          eq(bookings.nightDate, entry.nightDate),
          inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
        ),
      )
      .limit(1);
    if (booked) {
      await end(db, entry.id, { status: 'booked', bookingId: booked.id, endedAt: now });
      continue;
    }
    if (entry.status === 'offered' && entry.offerExpiresAt && entry.offerExpiresAt <= now) {
      await end(db, entry.id, { status: 'expired', endedAt: now });
      continue;
    }
    live.push(row);
  }

  const groups = new Map<string, typeof open>();
  for (const row of live) {
    const side = isTestContext({ club: row.club, guest: row.guest });
    const key = `${row.club.id}|${row.entry.nightDate}|${side}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const offers: WaitlistOffer[] = [];
  for (const rows of groups.values()) {
    const { club, entry: first, guest: firstGuest } = rows[0]!;
    if (!(await isNightOpen(db, club, first.nightDate, now))) continue;
    const isTest = isTestContext({ club, guest: firstGuest });
    const free = await availableTables(db, club.id, first.nightDate, { min: 0, max: 99 }, now, { isTest });
    let budget = free.length - rows.filter((r) => r.entry.status === 'offered').length;
    for (const { entry, guest } of rows) {
      if (budget <= 0) break;
      if (entry.status !== 'waiting') continue;
      const range = waitRange(entry.paxRange);
      if (!range || !free.some((o) => o.table.maxPax >= range.min && o.table.minPax <= range.max)) continue;
      const offered = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(waitlistEntries)
          .set({ status: 'offered', offeredAt: now, offerExpiresAt: new Date(now.getTime() + WAITLIST_OFFER_MINUTES * 60_000) })
          .where(and(eq(waitlistEntries.id, entry.id), eq(waitlistEntries.status, 'waiting')))
          .returning();
        if (!row) return undefined;
        await emit(tx, {
          clubId: club.id,
          type: 'waitlist.offered',
          occurredAt: now,
          actorType: 'system',
          dataOrigin: 'first_party',
          guestId: guest.id,
          nightDate: row.nightDate,
          isTest: isTestContext({ club, guest }),
          props: { pax_range: paxRangeCode(row.paxRange as PaxRangeKey) },
        });
        return row;
      });
      if (!offered) continue;
      budget--;
      offers.push({ entry: offered, club, guest });
    }
  }
  return offers;
}

/** Open entries of a guest for nights from `fromDate` on (bot "My booking" and tests). */
export async function openEntriesForGuest(db: Db, clubId: string, guestId: string, fromDate: string): Promise<WaitlistEntry[]> {
  return db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.clubId, clubId),
        eq(waitlistEntries.guestId, guestId),
        inArray(waitlistEntries.status, [...OPEN]),
        gte(waitlistEntries.nightDate, fromDate),
      ),
    )
    .orderBy(asc(waitlistEntries.nightDate));
}
