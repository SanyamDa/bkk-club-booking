import { sql } from 'drizzle-orm';
import { alcoholBanDates } from '../data/calendar.js';
import type { Db } from '../db/client.js';
import { clubs, nights, type Club } from '../db/schema.js';
import { addDays, currentNightDate, weekdayOf } from '../lib/time.js';
import { newId } from '../lib/util.js';

/** Why the job closed a night (`nights.closed_reason`, plan B8b). */
export type NightClosedReason = 'weekday' | 'closed_date' | 'alcohol_ban';

/** The status the club's settings and the city calendar give a date, before any person edits it. */
export function defaultNight(club: Club, date: string, banDates: Set<string>): { status: 'open' | 'closed'; closedReason: NightClosedReason | null } {
  const s = club.settings;
  if (!s.openWeekdays.includes(weekdayOf(date))) return { status: 'closed', closedReason: 'weekday' };
  if (s.closedDates.includes(date)) return { status: 'closed', closedReason: 'closed_date' };
  if (banDates.has(date)) return { status: 'closed', closedReason: 'alcohol_ban' };
  return { status: 'open', closedReason: null };
}

/**
 * Writes one `nights` row per date from `from` for `days` dates (spec §14.3 "Every night, open or
 * closed"). Missing rows are inserted; existing rows are refreshed only when nobody edited them
 * (`edited_by` is null) and the settings now say something else. A `sold_out` night the settings
 * still call open stays `sold_out` (the booking service reopens it when a table frees up).
 * Returns the rows written (inserted or changed). Pass the transaction handle when inside one.
 */
export async function ensureNights(tx: Db, club: Club, from: string, days: number, _now: Date): Promise<number> {
  if (days <= 0) return 0;
  const to = addDays(from, days - 1);
  const bans = await alcoholBanDates(tx, from, to);
  const rows = Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    return { id: newId(), clubId: club.id, date, ...defaultNight(club, date, bans) };
  });
  const status = sql`CASE WHEN ${nights.status} = 'sold_out' AND excluded.status = 'open' THEN 'sold_out' ELSE excluded.status END`;
  const written = await tx
    .insert(nights)
    .values(rows)
    .onConflictDoUpdate({
      target: [nights.clubId, nights.date],
      set: { status, closedReason: sql`excluded.closed_reason` },
      setWhere: sql`${nights.editedBy} IS NULL AND (${nights.status}, ${nights.closedReason}) IS DISTINCT FROM (${status}, excluded.closed_reason)`,
    })
    .returning({ id: nights.id });
  return written.length;
}

/**
 * The hourly `nights` job (registered in `jobs/index.ts`): every club gets its rows from tonight
 * across its booking window, so a new club has them within the hour. Returns the rows written.
 */
export async function runNightsJob(db: Db, now: Date): Promise<number> {
  const all = await db.select().from(clubs);
  let total = 0;
  for (const club of all) {
    const from = currentNightDate(now, club.settings.nightEndHour);
    total += await ensureNights(db, club, from, club.settings.bookingWindowDays + 1, now);
  }
  return total;
}
