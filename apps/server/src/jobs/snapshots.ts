import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import { emit } from '../data/events.js';
import type { Db } from '../db/client.js';
import {
  bookings,
  clubs,
  crowdRatings,
  deposits,
  nights,
  occupancySnapshots,
  platformFlags,
  tables,
  type Booking,
  type Club,
} from '../db/schema.js';
import { addDays, bangkokParts, currentNightDate } from '../lib/time.js';
import { newId } from '../lib/util.js';

/**
 * Occupancy snapshots and the staff crowd rating (spec §14.3, plan B12).
 * The booking curve: a timed snapshot of each club-night that is not closed, at fixed lead buckets.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BKK_OFFSET_MS = 7 * HOUR;
/** A bucket is due until the next bucket starts, never longer than this. */
const MAX_WINDOW_MS = 2 * HOUR;
/** The last bucket of a night is due for one live step. */
const LIVE_STEP_MS = 30 * MINUTE;
/** Lead days before the night, each taken at 12:00 on that day. */
const LEAD_DAYS = [14, 7, 3, 1] as const;

/** The instant of `hour:minute` Bangkok time on `date`. */
function bangkokAt(date: string, hour: number, minute = 0): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - BKK_OFFSET_MS);
}

const hhmm = (at: Date) => {
  const p = bangkokParts(at);
  return `${String(p.hour).padStart(2, '0')}${String(p.minute).padStart(2, '0')}`;
};

/**
 * The scheduled lead buckets of a night, in time order: `d14`, `d7`, `d3`, `d1` at 12:00 that many
 * days before, `d0_1200` and `d0_1800` on the day, then `live_HHMM` every 30 minutes from doors
 * (`nightStartHour`) to close (`nightEndHour`, inclusive). A live slot at the instant of an earlier
 * bucket is dropped.
 */
export function leadBuckets(club: Club, nightDate: string): { bucket: string; at: Date }[] {
  const out: { bucket: string; at: Date }[] = LEAD_DAYS.map((n) => ({ bucket: `d${n}`, at: bangkokAt(addDays(nightDate, -n), 12) }));
  out.push({ bucket: 'd0_1200', at: bangkokAt(nightDate, 12) }, { bucket: 'd0_1800', at: bangkokAt(nightDate, 18) });
  const { nightStartHour, nightEndHour } = club.settings;
  const doors = bangkokAt(nightDate, nightStartHour);
  const close = bangkokAt(nightEndHour <= nightStartHour ? addDays(nightDate, 1) : nightDate, nightEndHour);
  const taken = new Set(out.map((b) => b.at.getTime()));
  for (let t = doors.getTime(); t <= close.getTime(); t += LIVE_STEP_MS) {
    if (taken.has(t)) continue;
    const at = new Date(t);
    out.push({ bucket: `live_${hhmm(at)}`, at });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The bucket of `nightDate` due at `now`, or null. Due from its time until the next bucket (capped at 2 h). */
export function dueBucket(club: Club, nightDate: string, now: Date): string | null {
  const list = leadBuckets(club, nightDate);
  const t = now.getTime();
  for (let i = 0; i < list.length; i++) {
    const start = list[i]!.at.getTime();
    const next = list[i + 1]?.at.getTime() ?? start + LIVE_STEP_MS;
    const end = Math.min(next, start + MAX_WINDOW_MS);
    if (t >= start && t < end) return list[i]!.bucket;
  }
  return null;
}

const HELD = new Set(['held', 'awaiting_payment']);

/** Which snapshot column a booking counts in at `now`, or null when it holds no table. */
function category(b: Booking, now: Date): 'held' | 'confirmed' | 'arrived' | null {
  if (HELD.has(b.status)) return b.holdExpiresAt && b.holdExpiresAt <= now ? null : 'held';
  if (b.status === 'payment_review') return 'held';
  if (b.status === 'confirmed') return 'confirmed';
  if (b.status === 'arrived' || b.status === 'completed') return 'arrived';
  return null;
}

/**
 * Writes the `bucket` snapshot of one club-night. Returns false (and writes nothing) when that
 * bucket already exists. A real club counts only `is_test = false` bookings; a demo club's rows
 * are all test rows and count for its own curve.
 */
export async function takeSnapshot(db: Db, club: Club, nightDate: string, bucket: string, now: Date): Promise<boolean> {
  const existing = await db
    .select({ b: occupancySnapshots.leadBucket })
    .from(occupancySnapshots)
    .where(and(eq(occupancySnapshots.clubId, club.id), eq(occupancySnapshots.nightDate, nightDate), eq(occupancySnapshots.leadBucket, bucket)))
    .limit(1);
  if (existing.length) return false;

  const tableRows = await db
    .select({ id: tables.id, validFrom: tables.validFrom, validTo: tables.validTo })
    .from(tables)
    .where(and(eq(tables.clubId, club.id), eq(tables.active, true)));
  const tablesActive = tableRows.filter((t) => (!t.validFrom || t.validFrom <= nightDate) && (!t.validTo || t.validTo >= nightDate)).length;

  const nightBookings = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.clubId, club.id), eq(bookings.nightDate, nightDate)));
  const counted = nightBookings
    .filter((b) => club.status === 'demo' || !b.isTest)
    .map((b) => ({ b, cat: category(b, now) }))
    .filter((x): x is { b: Booking; cat: 'held' | 'confirmed' | 'arrived' } => x.cat !== null);

  const tablesIn = (cat: string) => new Set(counted.filter((x) => x.cat === cat).map((x) => x.b.tableId)).size;
  const ids = counted.map((x) => x.b.id);
  const verified = ids.length
    ? await db
        .select({ amount: deposits.amountSatang })
        .from(deposits)
        .where(and(eq(deposits.clubId, club.id), inArray(deposits.bookingId, ids), eq(deposits.status, 'verified')))
    : [];

  await db
    .insert(occupancySnapshots)
    .values({
      clubId: club.id,
      nightDate,
      takenAt: now,
      leadBucket: bucket,
      tablesActive,
      tablesHeld: tablesIn('held'),
      tablesConfirmed: tablesIn('confirmed'),
      tablesArrived: tablesIn('arrived'),
      paxBooked: counted.reduce((s, x) => s + x.b.pax, 0),
      minSpendBookedSatang: counted.reduce((s, x) => s + x.b.minSpendSatang, 0),
      depositsVerifiedSatang: verified.reduce((s, d) => s + d.amount, 0),
    })
    .onConflictDoNothing();
  return true;
}

/**
 * The `snapshots` job (every 5 minutes, `jobs/index.ts`): every club, every `nights` row from the
 * previous night to 15 days ahead whose status is not `closed`, gets the bucket due now. A closed
 * night gets none, so its gap is explained by its `nights` row. Returns the snapshots written.
 */
export async function runSnapshots(db: Db, now: Date): Promise<number> {
  const all = await db.select().from(clubs);
  let written = 0;
  for (const club of all) {
    const tonight = currentNightDate(now, club.settings.nightEndHour);
    const rows = await db
      .select({ date: nights.date })
      .from(nights)
      .where(and(eq(nights.clubId, club.id), ne(nights.status, 'closed'), gte(nights.date, addDays(tonight, -1)), lte(nights.date, addDays(tonight, 15))));
    for (const { date } of rows) {
      const bucket = dueBucket(club, date, now);
      if (bucket && (await takeSnapshot(db, club, date, bucket, now))) written++;
    }
  }
  return written;
}

// ---------- Crowd rating ----------

export type CrowdRating = typeof crowdRatings.$inferSelect;

export class CrowdRatingError extends Error {
  constructor(public code: 'bad_level') {
    super(code);
    this.name = 'CrowdRatingError';
  }
}

/**
 * Staff "how full now?" rating (spec §14.3): an integer 1–5 for the current night, stored with the
 * user, and `crowd.rated` emitted in the same transaction.
 */
export async function recordCrowdRating(
  db: Db,
  club: Club,
  input: { level: number; userId: string; actorType?: 'staff' | 'platform' },
  now: Date,
): Promise<CrowdRating> {
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > 5) throw new CrowdRatingError('bad_level');
  const nightDate = currentNightDate(now, club.settings.nightEndHour);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(crowdRatings)
      .values({ id: newId(), clubId: club.id, nightDate, at: now, level: input.level, userId: input.userId })
      .returning();
    await emit(tx, {
      clubId: club.id,
      type: 'crowd.rated',
      occurredAt: now,
      actorType: input.actorType ?? 'staff',
      actorId: input.userId,
      dataOrigin: 'first_party',
      nightDate,
      props: { rating: input.level },
      isTest: club.status === 'demo',
    });
    return row!;
  });
}

// ---------- "How full now?" prompt ----------

/** Default prompt hours (Bangkok): every hour from 22:00 to 01:00 (spec §14.3). */
export const DEFAULT_CROWD_PROMPT_HOURS = [22, 23, 0, 1];
/** A prompt goes out only in the first minutes of its hour; a later tick skips that hour. */
const PROMPT_WINDOW_MINUTES = 15;

/** The club's prompt hours: `settings.crowdPromptHours` when set, else 22, 23, 0 and 1. */
export function crowdPromptHours(club: Club): number[] {
  const hours: unknown = club.settings.crowdPromptHours;
  return Array.isArray(hours) && hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 23) ? (hours as number[]) : DEFAULT_CROWD_PROMPT_HOURS;
}

export const crowdPromptKey = (clubId: string) => `crowd_prompt:${clubId}`;

/**
 * The `crowd-prompt` job (every 5 minutes): in the first 15 minutes of each prompt hour, on a night
 * that is not closed, `send` is called once per club and hour (the last slot is kept in
 * `platform_flags`). Live and demo clubs only. Returns the prompts sent.
 */
export async function runCrowdPrompts(db: Db, now: Date, send: (club: Club, nightDate: string) => Promise<void>): Promise<number> {
  const p = bangkokParts(now);
  if (p.minute >= PROMPT_WINDOW_MINUTES) return 0;
  const all = await db.select().from(clubs).where(inArray(clubs.status, ['live', 'demo']));
  let sent = 0;
  for (const club of all) {
    if (!crowdPromptHours(club).includes(p.hour)) continue;
    const nightDate = currentNightDate(now, club.settings.nightEndHour);
    const night = await db.query.nights.findFirst({ where: and(eq(nights.clubId, club.id), eq(nights.date, nightDate)) });
    if (!night || night.status === 'closed') continue;
    const slot = `${nightDate}T${String(p.hour).padStart(2, '0')}`;
    const key = crowdPromptKey(club.id);
    const flag = await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, key) });
    if ((flag?.value as { slot?: string } | null)?.slot === slot) continue;
    await send(club, nightDate);
    await db
      .insert(platformFlags)
      .values({ key, value: { slot }, updatedBy: 'system', updatedAt: now })
      .onConflictDoUpdate({ target: platformFlags.key, set: { value: { slot }, updatedBy: 'system', updatedAt: now } });
    sent++;
  }
  return sent;
}
