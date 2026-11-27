import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { expireHold } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import {
  bookingPreorders,
  bookings,
  bookingStatusHistory,
  clubs,
  conversations,
  crowdRatings,
  deposits,
  doorCounts,
  events,
  guestNotes,
  guests,
  guestTags,
  handoffEpisodes,
  identityMap,
  messages,
  notices,
  posBills,
  promoterAttributions,
  removalRequests,
  waitlistEntries,
  type Booking,
  type Club,
} from '../db/schema.js';
import type { AppContext } from '../http/context.js';
import { releaseNow } from '../jobs/no-show.js';
import { remindNow } from '../jobs/reminders.js';
import { currentNightDate } from '../lib/time.js';
import { SEED_HIST, seedTonight } from './seed-history.js';

export class DemoError extends Error {
  constructor(readonly code: 'not_found' | 'not_demo') {
    super(code);
    this.name = 'DemoError';
  }
}

async function demoClub(db: Db, clubId: string): Promise<Club> {
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  if (!club) throw new DemoError('not_found');
  if (club.status !== 'demo') throw new DemoError('not_demo');
  return club;
}

/** True for a row id that is not part of the six weeks of seeded history. */
const notHist = (col: unknown): SQL => sql`left(${col}, ${SEED_HIST.length}) <> ${SEED_HIST}`;

/**
 * Puts a demo club back to its seeded state for `now` (plan B7, spec §12.4). In one transaction:
 * deletes every activity row of the club whose id does not start with `seed_hist_` (guests,
 * conversations, messages, bookings, deposits, status history, events, handoffs, door counts,
 * crowd ratings, and the rows that hang off a deleted guest or booking), then seeds tonight again
 * for `currentNightDate(now, nightEndHour)`. Content (zones, tables, prices, policies, brain notes,
 * profile) and the audit log are kept. Only for clubs with `status = 'demo'`.
 */
export async function resetDemoClub(db: Db, clubId: string, now: Date): Promise<{ nightDate: string }> {
  const club = await demoClub(db, clubId);
  return db.transaction(async (tx) => {
    const doomedGuests = (await tx.select({ id: guests.id }).from(guests).where(and(eq(guests.clubId, clubId), notHist(guests.id)))).map((r) => r.id);
    const clubBookings = await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.clubId, clubId));
    const doomedBookings = clubBookings.filter((b) => !b.id.startsWith(SEED_HIST)).map((b) => b.id);
    const doomedConvs = (
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.clubId, clubId), doomedGuests.length ? or(notHist(conversations.id), inArray(conversations.guestId, doomedGuests)) : notHist(conversations.id)))
    ).map((r) => r.id);
    const doomedMsgs = (
      await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.clubId, clubId), doomedGuests.length ? or(notHist(messages.id), inArray(messages.guestId, doomedGuests)) : notHist(messages.id)))
    ).map((r) => r.id);
    const anyOf = (conds: (SQL | undefined)[]) => or(...conds.filter((c): c is SQL => !!c));
    const within = <T>(col: Parameters<typeof inArray>[0], list: T[]) => (list.length ? inArray(col, list as never) : undefined);

    await tx
      .delete(handoffEpisodes)
      .where(
        and(
          eq(handoffEpisodes.clubId, clubId),
          anyOf([notHist(handoffEpisodes.id), within(handoffEpisodes.conversationId, doomedConvs), within(handoffEpisodes.firstMessageId, doomedMsgs), within(handoffEpisodes.lastMessageId, doomedMsgs)]),
        ),
      );
    const clubBookingIds = clubBookings.map((b) => b.id);
    if (clubBookingIds.length) {
      await tx
        .delete(bookingStatusHistory)
        .where(and(inArray(bookingStatusHistory.bookingId, clubBookingIds), anyOf([notHist(bookingStatusHistory.id), within(bookingStatusHistory.bookingId, doomedBookings)])));
    }
    await tx.delete(deposits).where(and(eq(deposits.clubId, clubId), anyOf([notHist(deposits.id), within(deposits.bookingId, doomedBookings)])));
    if (doomedBookings.length) {
      await tx.delete(posBills).where(and(eq(posBills.clubId, clubId), inArray(posBills.bookingId, doomedBookings)));
      await tx.delete(promoterAttributions).where(and(eq(promoterAttributions.clubId, clubId), inArray(promoterAttributions.bookingId, doomedBookings)));
    }
    // B22: pre-orders and waitlist entries are activity rows (none is seeded history).
    await tx.delete(bookingPreorders).where(eq(bookingPreorders.clubId, clubId));
    await tx.delete(waitlistEntries).where(eq(waitlistEntries.clubId, clubId));
    if (doomedMsgs.length) await tx.delete(messages).where(and(eq(messages.clubId, clubId), inArray(messages.id, doomedMsgs)));
    if (doomedConvs.length) await tx.delete(conversations).where(and(eq(conversations.clubId, clubId), inArray(conversations.id, doomedConvs)));
    if (doomedBookings.length) await tx.delete(bookings).where(and(eq(bookings.clubId, clubId), inArray(bookings.id, doomedBookings)));
    if (doomedGuests.length) {
      for (const t of [guestTags, guestNotes, notices, identityMap, removalRequests] as const) {
        await tx.delete(t).where(and(eq(t.clubId, clubId), inArray(t.guestId, doomedGuests)));
      }
      await tx.delete(guests).where(and(eq(guests.clubId, clubId), inArray(guests.id, doomedGuests)));
    }
    await tx.delete(events).where(and(eq(events.clubId, clubId), notHist(events.id)));
    await tx.delete(doorCounts).where(and(eq(doorCounts.clubId, clubId), notHist(doorCounts.id)));
    await tx.delete(crowdRatings).where(and(eq(crowdRatings.clubId, clubId), notHist(crowdRatings.id)));

    const nightDate = await seedTonight(tx, club, now);
    if (nightDate !== currentNightDate(now, club.settings.nightEndHour)) throw new Error('resetDemoClub: tonight seeded for the wrong night');
    return { nightDate };
  });
}

/**
 * Demo fast-forward (plan B7, spec §12.4). Does not change the clock: moves the chosen booking's
 * `hold_expires_at` to just before `now`, expires that one hold with `expireHold` (never the global
 * sweep, which would also expire other clubs' stale holds), then tells the guest. B10: `'reminder'`
 * sends that booking's reminder now (`remindNow`) and `'release'` releases it as a no-show now
 * (`releaseNow`). `undefined` when nothing happened to a booking of that club (not a hold, reminder
 * already sent, not confirmed).
 */
export type FastForwardWhat = 'hold_expiry' | 'reminder' | 'release';

export async function fastForward(ctx: AppContext, clubId: string, what: FastForwardWhat, bookingId: string, now: Date): Promise<Booking | undefined> {
  const db = ctx.deps.db;
  await demoClub(db, clubId);
  if (what === 'reminder' || what === 'release') {
    const done = what === 'reminder' ? await remindNow(ctx, clubId, bookingId, now) : await releaseNow(ctx, clubId, bookingId, now);
    if (!done) return undefined;
    return db.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId)) });
  }
  if (what !== 'hold_expiry') throw new Error(`fastForward: unsupported ${String(what)}`);
  const moved = await db
    .update(bookings)
    .set({ holdExpiresAt: new Date(now.getTime() - 1000) })
    .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId), inArray(bookings.status, ['held', 'awaiting_payment'])))
    .returning({ id: bookings.id });
  if (!moved.length) return undefined;
  const expired = await expireHold(db, clubId, bookingId, now);
  if (expired) await ctx.notifier.holdExpired(expired);
  return expired;
}
