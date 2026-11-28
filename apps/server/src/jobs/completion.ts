import { and, eq, gte, lte } from 'drizzle-orm';
import { completeBooking, type Actor } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import { bookings, clubs, type Club } from '../db/schema.js';
import { addDays, bangkokParts, toDateString } from '../lib/time.js';

const SYSTEM: Actor = { type: 'system' };
/** §7.1: a booking completes "club's closing time + 2h". */
export const COMPLETE_AFTER_CLOSE_MS = 2 * 60 * 60_000;

/** When an arrived booking of `nightDate` becomes `completed`: the night's closing hour plus 2 hours. */
export function completeAt(club: Pick<Club, 'settings'>, nightDate: string): Date {
  // The night closes at `nightEndHour` on the next calendar day (Bangkok is UTC+7 all year).
  const [y, mo, d] = addDays(nightDate, 1).split('-').map(Number) as [number, number, number];
  const close = Date.UTC(y, mo - 1, d, club.settings.nightEndHour - 7, 0);
  return new Date(close + COMPLETE_AFTER_CLOSE_MS);
}

/**
 * The `completion` job (§7.1): every `arrived` booking whose night closed more than 2 hours ago
 * becomes `completed` through `completeBooking` (history, audit, `booking.status_changed`). A POS bill
 * close completes it earlier (`emitBookingCompleted`). Returns the number completed.
 */
export async function completeEndedNights(db: Db, now: Date): Promise<number> {
  const p = bangkokParts(now);
  const today = toDateString(p.year, p.month, p.day);
  const rows = await db
    .select({ booking: bookings, club: clubs })
    .from(bookings)
    .innerJoin(clubs, eq(bookings.clubId, clubs.id))
    .where(and(eq(bookings.status, 'arrived'), gte(bookings.nightDate, addDays(today, -7)), lte(bookings.nightDate, today)));
  let done = 0;
  for (const { booking, club } of rows) {
    if (completeAt(club, booking.nightDate) > now) continue;
    if (await completeBooking(db, club.id, booking.id, SYSTEM, now)) done++;
  }
  return done;
}
