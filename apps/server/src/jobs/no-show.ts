import { and, eq, gte, lte } from 'drizzle-orm';
import {
  autoReleaseFromPrompt,
  DEFAULT_RELEASE_PROMPT_MINUTES,
  effectiveReleaseAt,
  latestKeep,
  latestPrompt,
  releaseFromPrompt,
} from '../bookings/release-prompt.js';
import { BookingError, getBookingView, type Actor } from '../bookings/service.js';
import { alertNoShowReleased, alertReleasePrompt } from '../bot/alerts.js';
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
 * The `no-show` job (B10, B10c). For every confirmed booking past its release time (`releaseAt`,
 * moved by the newest [Keep 30 min]):
 * - no prompt since the newest Keep: the host gets the urgent `no_arrival` prompt [Release] [Keep 30 min];
 * - prompt unanswered for `releasePromptMinutes` (default 15) in a club with `autoNoShow` (default
 *   on): the booking becomes `no_show` and its table is released (`releaseNoShow`, one transaction),
 *   then the info `no_show_released` alert tells the host;
 * - with `autoNoShow` off the booking waits for the host.
 * With `only`, that one booking is released now whatever its time (demo fast-forward). Returns the
 * number released.
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
    let promptId: string | undefined;
    if (!only) {
      if ((await effectiveReleaseAt(db, club, booking)) > now) continue;
      const keep = await latestKeep(db, club.id, booking.id);
      const prompt = await latestPrompt(db, club.id, booking.id, keep?.at);
      if (!prompt) {
        const view = await getBookingView(db, { clubId: club.id, id: booking.id });
        if (view) await alertReleasePrompt(db, view, now);
        continue;
      }
      if (club.settings.autoNoShow === false) continue; // the host decides (group buttons or dashboard)
      const window = club.settings.releasePromptMinutes ?? DEFAULT_RELEASE_PROMPT_MINUTES;
      if (now.getTime() < prompt.createdAt.getTime() + window * 60_000) continue;
      promptId = prompt.id;
    }
    let after: Booking;
    try {
      // The prompt is claimed inside the release transaction, so a [Keep] tapped meanwhile wins.
      const result = promptId
        ? await autoReleaseFromPrompt(db, club.id, booking.id, promptId, SYSTEM, now)
        : await releaseFromPrompt(db, club.id, booking.id, SYSTEM, now);
      if (result === 'answered') continue;
      after = result;
    } catch (err) {
      if (err instanceof BookingError) continue; // checked in or changed meanwhile
      throw err;
    }
    released++;
    const view = await getBookingView(db, { clubId: club.id, id: after.id });
    if (view) await alertNoShowReleased(db, view, now);
  }
  return released;
}

/** Demo fast-forward to the release time for one booking. False when nothing was released. */
export async function releaseNow(ctx: AppContext, clubId: string, bookingId: string, now: Date): Promise<boolean> {
  return (await releaseNoShows(ctx, now, { clubId, bookingId })) > 0;
}
