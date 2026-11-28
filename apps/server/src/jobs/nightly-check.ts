import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { recordOps } from '../data/ops.js';
import type { Db } from '../db/client.js';
import { testRowsInAnalytics } from '../data/analytics.js';
import { clubs, events, nights, platformFlags, type Club } from '../db/schema.js';
import { addDays, bangkokParts, currentNightDate, weekdayOf } from '../lib/time.js';

/**
 * The nightly data checks (plan B2, spec §14.2 "Nightly checks"). Each finding writes an
 * `ops_events` row `kind = 'bot_error'` with `detail.check` naming the check, which turns the
 * club's founder-console health tile red (`failures24h`). Zero tolerance.
 *
 * "That night" is the business day from 06:00 Bangkok on `nightDate` to 06:00 the next day, for the
 * history, completeness and props checks. The silent-club check uses each club's own opening hours.
 */

export type NightlyCheckResult = { missing: number; silentClubs: string[]; piiInProps: number; testInAggregates: number; deadLetters: number };

/** Hour (Bangkok) the business day starts; the nightly job runs from `NIGHTLY_RUN_HOUR`. */
const DAY_CUT_HOUR = 6;
const NIGHTLY_RUN_HOUR = 7;

/** A props value that looks like personal data: a Thai or +66 phone number, an email, or Thai script. */
const PHONE_PATTERN = '^(\\+?66|0)[0-9]{8,9}$';
const EMAIL_PATTERN = '[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+';
const THAI_PATTERN = '[฀-๿]';

const at = (date: string, hour: number) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+07:00`);

function rowsOf<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? []) as T[];
}

async function report(db: Db, clubId: string | null, check: string, detail: Record<string, unknown>, now: Date) {
  await recordOps(db, clubId, 'bot_error', { check, ...detail }, now);
}

/** True when the club was open on `nightDate`: an open weekday, not a closed date, and no closed `nights` row. */
async function wasOpen(db: Db, club: Club, nightDate: string): Promise<boolean> {
  const row = await db.query.nights.findFirst({ where: and(eq(nights.clubId, club.id), eq(nights.date, nightDate)) });
  if (row) return row.status !== 'closed';
  return club.settings.openWeekdays.includes(weekdayOf(nightDate)) && !club.settings.closedDates.includes(nightDate);
}

/**
 * Runs the five nightly checks for `nightDate` and records each finding in `ops_events`:
 * - `missing`: `booking_status_history` rows of that day with no `booking.status_changed` event for
 *   the same booking, `to` status and time;
 * - `silentClubs`: live clubs that were open and wrote no event during their opening hours;
 * - `piiInProps`: events of that day with a props value that looks like a phone, email or Thai text;
 * - `testInAggregates`: `is_test` rows visible in any view of the `analytics` schema that has an
 *   `is_test` column, plus B14's `testRowsInAnalytics` (demo-club rows in any B14 view, and
 *   `analytics.events` rows whose event is `is_test`);
 * - `deadLetters`: `events_dead_letter` rows received that day (§14.2 "events_dead_letter is empty"),
 *   reported per club from the payload's `clubId`.
 */
export async function checkEventCompleteness(db: Db, nightDate: string, now: Date = new Date()): Promise<NightlyCheckResult> {
  const start = at(nightDate, DAY_CUT_HOUR);
  const end = at(addDays(nightDate, 1), DAY_CUT_HOUR);

  // 1. Every status change has its event.
  const missingRows = rowsOf<{ club_id: string; booking_id: string; to_status: string }>(
    await db.execute(sql`
      select b.club_id, h.booking_id, h.to_status
      from booking_status_history h
      join bookings b on b.id = h.booking_id
      where h.at >= ${start.toISOString()}::timestamptz and h.at < ${end.toISOString()}::timestamptz
        and not exists (
          select 1 from events e
          where e.booking_id = h.booking_id
            and e.type = 'booking.status_changed'
            and e.props->>'to' = h.to_status
            and e.occurred_at = h.at
        )`),
  );
  const missingByClub = new Map<string, { bookingId: string; to: string }[]>();
  for (const r of missingRows) {
    const list = missingByClub.get(r.club_id) ?? [];
    list.push({ bookingId: r.booking_id, to: r.to_status });
    missingByClub.set(r.club_id, list);
  }
  for (const [clubId, list] of missingByClub) {
    await report(db, clubId, 'event_completeness', { nightDate, missing: list.length, changes: list.slice(0, 50) }, now);
  }

  // 2. Every live club that was open wrote at least one event during its opening hours.
  const silentClubs: string[] = [];
  const live = await db.select().from(clubs).where(eq(clubs.status, 'live'));
  for (const club of live) {
    if (!(await wasOpen(db, club, nightDate))) continue;
    const from = at(nightDate, club.settings.nightStartHour);
    const to = at(addDays(nightDate, 1), club.settings.nightEndHour);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.clubId, club.id), gte(events.occurredAt, from), lt(events.occurredAt, to)));
    if ((row?.n ?? 0) === 0) {
      silentClubs.push(club.id);
      await report(db, club.id, 'silent_club', { nightDate }, now);
    }
  }

  // 3. No personal data in props.
  const piiRows = rowsOf<{ club_id: string; n: number }>(
    await db.execute(sql`
      select e.club_id, count(distinct e.id)::int as n
      from events e, jsonb_each_text(case when jsonb_typeof(e.props) = 'object' then e.props else '{}'::jsonb end) kv
      where e.occurred_at >= ${start.toISOString()}::timestamptz and e.occurred_at < ${end.toISOString()}::timestamptz
        and (kv.value ~ ${PHONE_PATTERN} or kv.value ~ ${EMAIL_PATTERN} or kv.value ~ ${THAI_PATTERN})
      group by e.club_id`),
  );
  let piiInProps = 0;
  for (const r of piiRows) {
    piiInProps += Number(r.n);
    await report(db, r.club_id, 'pii_in_props', { nightDate, events: Number(r.n) }, now);
  }

  // 4. No test rows in the analytics views. A view with a `club_id` column is counted per club, so
  // the finding lands on that club's health tile; a view without one is reported with no club.
  const views = rowsOf<{ table_name: string; has_club: boolean }>(
    await db.execute(sql`
      select c.table_name,
        exists (
          select 1 from information_schema.columns k
          where k.table_schema = c.table_schema and k.table_name = c.table_name and k.column_name = 'club_id'
        ) as has_club
      from information_schema.columns c
      join information_schema.views v on v.table_schema = c.table_schema and v.table_name = c.table_name
      where c.table_schema = 'analytics' and c.column_name = 'is_test'
      order by c.table_name`),
  );
  let testInAggregates = 0;
  const perClub = new Map<string | null, Record<string, number>>();
  for (const { table_name, has_club } of views) {
    const ident = `"analytics"."${table_name.replaceAll('"', '""')}"`;
    const rows = rowsOf<{ club_id: string | null; n: number }>(
      await db.execute(
        sql.raw(
          has_club
            ? `select club_id, count(*)::int as n from ${ident} where is_test group by club_id`
            : `select null as club_id, count(*)::int as n from ${ident} where is_test`,
        ),
      ),
    );
    for (const r of rows) {
      const n = Number(r.n ?? 0);
      if (n === 0) continue;
      const views = perClub.get(r.club_id) ?? {};
      views[table_name] = n;
      perClub.set(r.club_id, views);
      testInAggregates += n;
    }
  }
  for (const [clubId, perView] of perClub) {
    await report(db, clubId, 'test_in_aggregates', { nightDate, views: perView }, now);
  }
  // B14's own check over its views (which carry no `is_test` column): reported with no club.
  const leaked = await testRowsInAnalytics(db);
  if (leaked > 0) {
    testInAggregates += leaked;
    await report(db, null, 'test_in_aggregates', { nightDate, analyticsRows: leaked }, now);
  }

  // 5. events_dead_letter is empty: every event that failed validation or insert that day.
  const deadRows = rowsOf<{ club_id: string | null; n: number }>(
    await db.execute(sql`
      select payload->>'clubId' as club_id, count(*)::int as n
      from events_dead_letter
      where received_at >= ${start.toISOString()}::timestamptz and received_at < ${end.toISOString()}::timestamptz
      group by payload->>'clubId'`),
  );
  let deadLetters = 0;
  for (const r of deadRows) {
    deadLetters += Number(r.n);
    await report(db, r.club_id, 'dead_letter', { nightDate, rows: Number(r.n) }, now);
  }

  return { missing: missingRows.length, silentClubs, piiInProps, testInAggregates, deadLetters };
}

/**
 * The `nightly-check` job body: once 07:00 Bangkok has passed, checks the night before, once per
 * night (claimed with `platform_flags['nightly_check:<date>']`). Returns null when there was nothing to do.
 */
export async function runNightlyCheck(db: Db, now: Date): Promise<(NightlyCheckResult & { nightDate: string }) | null> {
  if (bangkokParts(now).hour < NIGHTLY_RUN_HOUR) return null;
  const nightDate = addDays(currentNightDate(now, DAY_CUT_HOUR), -1);
  const claimed = await db
    .insert(platformFlags)
    .values({ key: `nightly_check:${nightDate}`, value: { startedAt: now.toISOString() }, updatedBy: 'system', updatedAt: now })
    .onConflictDoNothing()
    .returning({ key: platformFlags.key });
  if (!claimed.length) return null;
  let result: NightlyCheckResult;
  try {
    result = await checkEventCompleteness(db, nightDate, now);
  } catch (err) {
    // Free the claim so the next tick retries this night; the scheduler logs the error.
    await db.delete(platformFlags).where(eq(platformFlags.key, `nightly_check:${nightDate}`));
    throw err;
  }
  await db
    .update(platformFlags)
    .set({ value: { startedAt: now.toISOString(), ...result }, updatedAt: now })
    .where(eq(platformFlags.key, `nightly_check:${nightDate}`));
  return { nightDate, ...result };
}
