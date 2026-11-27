import { and, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { calendarDays } from '../db/schema.js';
import { CALENDAR_SEED, type CalendarKind } from './calendar-seed.js';

/** The city calendar (spec §14.3, plan B13). `calendar_days` is platform-level: no club_id. */
export const CALENDAR_KINDS: readonly CalendarKind[] = ['public_holiday', 'holy_day', 'alcohol_ban', 'election', 'city_event'];

export class CalendarDayError extends Error {
  constructor(public readonly code: 'bad_kind' | 'bad_date' | 'bad_name') {
    super(code);
  }
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function checked(input: { date: string; kind: string; name: string; notes?: string }) {
  if (!(CALENDAR_KINDS as readonly string[]).includes(input.kind)) throw new CalendarDayError('bad_kind');
  if (!validDate(input.date)) throw new CalendarDayError('bad_date');
  const name = input.name.trim();
  if (!name) throw new CalendarDayError('bad_name');
  return { date: input.date, kind: input.kind as CalendarKind, name, notes: input.notes?.trim() || null };
}

/**
 * Adds one calendar day, keyed by (date, kind, name). A repeat is a no-op; a repeat with new notes
 * updates the notes only.
 */
export async function upsertCalendarDay(db: Db, input: { date: string; kind: string; name: string; notes?: string }): Promise<void> {
  const row = checked(input);
  const set = input.notes === undefined ? null : { notes: row.notes };
  const insert = db.insert(calendarDays).values(row);
  if (set) await insert.onConflictDoUpdate({ target: [calendarDays.date, calendarDays.kind, calendarDays.name], set });
  else await insert.onConflictDoNothing();
}

/** Loads the seed (calendar-seed.ts). Existing rows are left alone, so hand-edited notes survive. Returns rows inserted. */
export async function seedCalendarDays(db: Db): Promise<number> {
  const rows = CALENDAR_SEED.map(checked);
  const inserted = await db.insert(calendarDays).values(rows).onConflictDoNothing().returning({ date: calendarDays.date });
  return inserted.length;
}

/** Dates between `from` and `to` (inclusive, YYYY-MM-DD) that are alcohol-ban days. For B8b's nights job. */
export async function alcoholBanDates(db: Db, from: string, to: string): Promise<Set<string>> {
  const rows = await db
    .select({ date: calendarDays.date })
    .from(calendarDays)
    .where(and(eq(calendarDays.kind, 'alcohol_ban'), gte(calendarDays.date, from), lte(calendarDays.date, to)));
  return new Set(rows.map((r) => r.date));
}
