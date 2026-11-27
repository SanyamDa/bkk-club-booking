import { and, eq, gte, lte } from 'drizzle-orm';
import { BookingError, getBookingView, releaseNoShow, type Actor } from '../bookings/service.js';
import { alertNoArrival } from '../bot/alerts.js';
import { bookings, clubs, type Booking, type Club } from '../db/schema.js';
import type { AppContext } from '../http/context.js';
import { addDays, bangkokParts, toDateString } from '../lib/time.js';

const SYSTEM: Actor = { type: 'system' };
export const DEFAULT_ARRIVAL_GRACE_MINUTES = 30;

/**
 * The instant of a club wall-clock time (`HH:MM`, Bangkok) on a night. Only a time in the
 * after-midnight part of the night (hour before `nightEndHour`) falls on the next calendar day
 * (00:30 on Saturday night is Sunday 00:30); any other time, an afternoon reminder included, is on
 * the night's own date.
 */
export function atNightTime(club: Pick<Club, 'settings'>, nightDate: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const date = h < club.settings.nightEndHour ? addDays(nightDate, 1) : nightDate;
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h - 7, m)); // Bangkok is UTC+7 all year
}

/**
 * When an unarrived booking's table is released (spec §5.2 step 9, §7.2): `arrivalBy`, plus the
 * guest's running-late minutes when the club lets those move it, plus the grace period.
 */
export function releaseAt(club: Pick<Club, 'settings'>, booking: Pick<Booking, 'nightDate' | 'runningLateMinutes'>): Date {
  const s = club.settings;
  const late = s.runningLateExtendsRelease === false ? 0 : booking.runningLateMinutes ?? 0;
  const grace = s.arrivalGraceMinutes ?? DEFAULT_ARRIVAL_GRACE_MINUTES;
  return new Date(atNightTime(club, booking.nightDate, s.arrivalBy).getTime() + (late + grace) * 60_000);
}

/** Bangkok calendar date of an instant. */
function bangkokDate(at: Date): string {
  const p = bangkokParts(at);
  return toDateString(p.year, p.month, p.day);
}

/**
 * The `no-show` job (B10): every confirmed booking past its release time, in a club with
 * `autoNoShow` (default on), becomes `no_show` and its table is released (`releaseNoShow`, one
 * transaction), then an urgent `no_arrival` alert is raised. With `only`, that one booking is released now
 * whatever its time (demo fast-forward). Returns the number released.
 */
export async function releaseNoShows(ctx: AppContext, now: Date, only?: { clubId: string; bookingId: string }): Promise<number> {
  const db = ctx.deps.db;
  const today = bangkokDate(now);
  const where = only
    ? and(eq(bookings.id, only.bookingId), eq(bookings.clubId, only.clubId), eq(bookings.status, 'confirmed'))
    : and(eq(bookings.status, 'confirmed'), gte(bookings.nightDate, addDays(today, -2)), lte(bookings.nightDate, today));
  const rows = await db.select({ booking: bookings, club: clubs }).from(bookings).innerJoin(clubs, eq(bookings.clubId, clubs.id)).where(where);
  let released = 0;
  for (const { booking, club } of rows) {
    if (!only && (club.settings.autoNoShow === false || releaseAt(club, booking) > now)) continue;
    let after: Booking;
    try {
      after = await releaseNoShow(db, club.id, booking.id, SYSTEM, now);
    } catch (err) {
      if (err instanceof BookingError) continue; // checked in or changed meanwhile
      throw err;
    }
    released++;
    // B19b: urgent `no_arrival` through raiseAlert (inbox feed and staff group, §6.4).
    const view = await getBookingView(db, { clubId: club.id, id: after.id });
    if (view) await alertNoArrival(db, view, now);
  }
  return released;
}

/** Demo fast-forward to the release time for one booking. False when nothing was released. */
export async function releaseNow(ctx: AppContext, clubId: string, bookingId: string, now: Date): Promise<boolean> {
  return (await releaseNoShows(ctx, now, { clubId, bookingId })) > 0;
}
