import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql, type SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANALYTICS_VIEWS, METABASE_ROLE, testRowsInAnalytics } from '../src/data/analytics.js';
import { emit, type EventInput } from '../src/data/events.js';
import type { Db } from '../src/db/client.js';
import { bookings, crowdRatings, doorCounts, guests, occupancySnapshots } from '../src/db/schema.js';
import type { BookingSource, BookingStatus } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { CLUB_B_ID, setupTwoClubs } from './helpers.js';
import { FIXTURE_CLUB_ID } from './fixtures/club.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const boardsDir = `${repoRoot}infra/metabase/dashboards/`;

const N1 = '2026-11-27'; // Friday
const N2 = '2026-11-28'; // Saturday
const at = (iso: string) => new Date(iso);

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await setupTwoClubs());
  await seedWeek(db);
});
afterEach(async () => close());

async function rows<T = Record<string, unknown>>(q: SQL, d: Db = db): Promise<T[]> {
  return (await d.execute(q)).rows as T[];
}

/** Runs one statement as the Metabase role, inside a transaction so the role ends with it. */
function asMetabase<T = Record<string, unknown>>(q: SQL): Promise<T[]> {
  return db
    .transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role ${METABASE_ROLE}`));
      return rows<T>(q, tx as unknown as Db);
    })
    .catch((err: unknown) => {
      // Drizzle wraps the driver error; surface Postgres's message.
      const cause = (err as { cause?: { message?: string } }).cause;
      throw new Error(cause?.message ?? String(err));
    });
}

/**
 * The seeded week. Club B (live) is the real club; the fixture club (status demo) is Velora.
 * Hand counts are in the tests below.
 */
async function seedWeek(d: Db) {
  const guest = async (clubId: string, isTest = false) => {
    const id = newId();
    await d.insert(guests).values({ id, clubId, lineUserId: `U${id}`, displayName: 'G', isTest });
    return id;
  };
  const [g1, g2, gt] = [await guest(CLUB_B_ID), await guest(CLUB_B_ID), await guest(CLUB_B_ID, true)];
  const gv = await guest(FIXTURE_CLUB_ID, true);
  const booking = (
    clubId: string, guestId: string, tableId: string, nightDate: string, pax: number,
    status: BookingStatus, createdAt: string, extra: Partial<typeof bookings.$inferInsert> = {},
  ) => ({
    id: newId(), clubId, refCode: `R${newId()}`, guestId, tableId, nightDate, pax, status,
    source: 'line' as BookingSource, minSpendSatang: 600_000, depositSatang: 200_000,
    createdAt: at(createdAt), ...extra,
  });
  await d.insert(bookings).values([
    // N1: arrived (3 days before), no-show (1 day before), completed (same day).
    booking(CLUB_B_ID, g1, 'table_b_V1', N1, 8, 'arrived', '2026-11-24T05:00:00Z', { arrivedPax: 7, arrivedAt: at('2026-11-27T16:30:00Z') }),
    booking(CLUB_B_ID, g2, 'table_b_S1', N1, 3, 'no_show', '2026-11-26T05:00:00Z'),
    booking(CLUB_B_ID, g1, 'table_b_S2', N1, 2, 'completed', '2026-11-27T05:00:00Z', { arrivedPax: 2, arrivedAt: at('2026-11-27T17:15:00Z') }),
    // N2: confirmed (3 days before); a cancelled one; an Instagram one and two test-guest ones, all left out.
    booking(CLUB_B_ID, g2, 'table_b_V1', N2, 6, 'confirmed', '2026-11-25T05:00:00Z'),
    booking(CLUB_B_ID, g1, 'table_b_S1', N2, 4, 'cancelled', '2026-11-26T05:00:00Z'),
    booking(CLUB_B_ID, g1, 'table_b_S2', N2, 2, 'confirmed', '2026-11-25T05:00:00Z', { source: 'instagram' }),
    booking(CLUB_B_ID, gt, 'table_b_V2', N2, 5, 'confirmed', '2026-11-25T05:00:00Z', { isTest: true }),
    // A test guest's booking whose own is_test flag is false: left out by guests.is_test alone.
    booking(CLUB_B_ID, gt, 'table_b_V2', N2, 5, 'no_show', '2026-11-25T05:00:00Z', { isTest: false }),
    // Velora.
    booking(FIXTURE_CLUB_ID, gv, 'table_demo_V1', N1, 4, 'confirmed', '2026-11-26T05:00:00Z', { isTest: true }),
    booking(FIXTURE_CLUB_ID, gv, 'table_demo_T1', N1, 2, 'arrived', '2026-11-26T05:00:00Z', { isTest: true, arrivedPax: 2, arrivedAt: at('2026-11-27T16:00:00Z') }),
  ]);
  await d.insert(doorCounts).values([
    { id: newId(), clubId: CLUB_B_ID, nightDate: N1, at: at('2026-11-27T16:10:00Z'), delta: 2, kind: 'walk_in' },
    { id: newId(), clubId: CLUB_B_ID, nightDate: N1, at: at('2026-11-27T16:40:00Z'), delta: 5, kind: 'table_guest' },
    { id: newId(), clubId: CLUB_B_ID, nightDate: N1, at: at('2026-11-27T17:30:00Z'), delta: -1, kind: 'walk_in' },
    { id: newId(), clubId: FIXTURE_CLUB_ID, nightDate: N1, at: at('2026-11-27T16:00:00Z'), delta: 10, kind: 'walk_in' },
  ]);
  await d.insert(crowdRatings).values([
    { id: newId(), clubId: CLUB_B_ID, nightDate: N1, at: at('2026-11-27T16:00:00Z'), level: 3 },
    { id: newId(), clubId: CLUB_B_ID, nightDate: N1, at: at('2026-11-27T16:50:00Z'), level: 5 },
    { id: newId(), clubId: FIXTURE_CLUB_ID, nightDate: N1, at: at('2026-11-27T16:00:00Z'), level: 2 },
  ]);
  const snap = (clubId: string, leadBucket: string, takenAt: string, confirmed: number) => ({
    clubId, nightDate: N1, takenAt: at(takenAt), leadBucket, tablesActive: 4, tablesHeld: 0,
    tablesConfirmed: confirmed, tablesArrived: 0, paxBooked: confirmed * 4, minSpendBookedSatang: confirmed * 600_000,
    depositsVerifiedSatang: 0,
  });
  await d.insert(occupancySnapshots).values([
    snap(CLUB_B_ID, 'd3', '2026-11-24T05:00:00Z', 1),
    snap(CLUB_B_ID, 'd1', '2026-11-26T05:00:00Z', 2),
    snap(FIXTURE_CLUB_ID, 'd1', '2026-11-26T05:00:00Z', 3),
  ]);

  let minute = 0;
  const ev = (type: EventInput['type'], over: Partial<EventInput> = {}) =>
    emit(d, {
      clubId: CLUB_B_ID, type, actorType: 'guest', dataOrigin: 'first_party', channel: 'line', isTest: false,
      occurredAt: new Date(Date.parse('2026-11-24T05:00:00Z') + minute++ * 60_000), ...over,
    });
  const steps: EventInput['type'][] = [
    'booking.started', 'night.selected', 'pax.selected', 'table.held',
    'details.submitted', 'rules.accepted', 'deposit.verified', 'booking.confirmed',
  ];
  // a1: every step, plus a search that found tables; one event carries raw text.
  for (const type of steps) await ev(type, { attemptId: 'a1', raw: { text: 'free text that must stay in operations' } });
  await ev('availability.searched', { attemptId: 'a1', props: { night_date: N1, pax_range: 'p5_8', result_count: 3 } });
  // a2: stops after pax with a zero-result search.
  for (const type of steps.slice(0, 3)) await ev(type, { attemptId: 'a2' });
  await ev('availability.searched', { attemptId: 'a2', props: { night_date: N1, pax_range: 'p5_8', result_count: 0 } });
  // a3: held a table, then the hold expired.
  for (const type of steps.slice(0, 4)) await ev(type, { attemptId: 'a3' });
  await ev('hold.expired', { attemptId: 'a3' });
  // Left out: Instagram (origin and channel), test rows, LINE chat origin.
  await ev('booking.started', { attemptId: 'a4', dataOrigin: 'instagram', channel: 'instagram' });
  await ev('availability.searched', { attemptId: 'a4', channel: 'instagram', props: { night_date: N1, pax_range: 'p5_8', result_count: 0 } });
  await ev('booking.started', { attemptId: 'a5', isTest: true });
  await ev('availability.searched', { attemptId: 'a5', isTest: true, props: { night_date: N1, pax_range: 'p5_8', result_count: 0 } });
  await ev('booking.started', { attemptId: 'a6', dataOrigin: 'line_chat' });
  // A sold-out night shown, outside any attempt.
  await ev('night.sold_out_shown', { nightDate: N2, props: { pax_range: 'p1_4' } });
  // Velora.
  await ev('booking.started', { clubId: FIXTURE_CLUB_ID, attemptId: 'v1', isTest: true });
  await ev('availability.searched', { clubId: FIXTURE_CLUB_ID, attemptId: 'v1', isTest: true, props: { night_date: N1, pax_range: 'p1_4', result_count: 0 } });
}

describe('analytics views (B14)', () => {
  it('funnel counts attempts reaching each step for a seeded week', async () => {
    const r = await rows<{ step: string; attempts: number }>(
      sql`select step, attempts from analytics.booking_funnel where club_id = ${CLUB_B_ID} and started_on = '2026-11-24' order by step_no`,
    );
    expect(r.map((x) => [x.step, x.attempts])).toEqual([
      ['started', 3], ['night', 3], ['pax', 3], ['table', 2], ['details', 1], ['rules', 1], ['paid', 1], ['confirmed', 1],
    ]);
  });

  it('booking pace counts confirmed bookings by days before the night', async () => {
    const r = await rows<{ night_date: string; days_before: number; bookings: number; pax: number; cumulative_bookings: number }>(
      sql`select night_date, days_before, bookings, pax, cumulative_bookings from analytics.booking_pace where club_id = ${CLUB_B_ID} order by night_date, days_before desc`,
    );
    expect(r).toEqual([
      { night_date: N1, days_before: 3, bookings: 1, pax: 8, cumulative_bookings: 1 },
      { night_date: N1, days_before: 1, bookings: 1, pax: 3, cumulative_bookings: 2 },
      { night_date: N1, days_before: 0, bookings: 1, pax: 2, cumulative_bookings: 3 },
      { night_date: N2, days_before: 3, bookings: 1, pax: 6, cumulative_bookings: 1 },
    ]);
  });

  it('booking curve reads occupancy snapshots', async () => {
    const r = await rows<{ lead_bucket: string; booked_share: string }>(
      sql`select lead_bucket, booked_share from analytics.booking_curve where club_id = ${CLUB_B_ID} order by taken_at`,
    );
    expect(r.map((x) => [x.lead_bucket, Number(x.booked_share)])).toEqual([['d3', 0.25], ['d1', 0.5]]);
  });

  it('demand with no table counts zero-result searches and sold-out views', async () => {
    const r = await rows(
      sql`select night_date, pax_range, zero_result_searches, sold_out_shown from analytics.demand_no_table where club_id = ${CLUB_B_ID} order by night_date`,
    );
    expect(r).toEqual([
      { night_date: N1, pax_range: 'p5_8', zero_result_searches: 1, sold_out_shown: 0 },
      { night_date: N2, pax_range: 'p1_4', zero_result_searches: 0, sold_out_shown: 1 },
    ]);
  });

  it('no-show rate, door counts against bookings and busyness by hour match the seeded week', async () => {
    const ns = await rows<{ night_date: string; due: number; arrived: number; no_shows: number; no_show_rate: string }>(
      sql`select night_date, due, arrived, no_shows, no_show_rate from analytics.no_show_rate where club_id = ${CLUB_B_ID}`,
    );
    expect(ns.map((x) => ({ ...x, no_show_rate: Number(x.no_show_rate) }))).toEqual([
      { night_date: N1, due: 3, arrived: 2, no_shows: 1, no_show_rate: 0.3333 },
    ]);
    const door = await rows(
      sql`select night_date, door_in, door_out, door_net, booked_pax, arrived_pax from analytics.door_vs_bookings where club_id = ${CLUB_B_ID} order by night_date`,
    );
    expect(door).toEqual([
      { night_date: N1, door_in: 7, door_out: 1, door_net: 6, booked_pax: 13, arrived_pax: 9 },
      { night_date: N2, door_in: 0, door_out: 0, door_net: 0, booked_pax: 6, arrived_pax: 0 },
    ]);
    const busy = await rows<{ hour: number; door_net: number; checkins: number; crowd_rating_avg: string | null }>(
      sql`select hour, door_net, checkins, crowd_rating_avg from analytics.busyness_by_hour where club_id = ${CLUB_B_ID} and night_date = ${N1} order by (hour + 12) % 24`,
    );
    expect(busy.map((x) => [x.hour, x.door_net, x.checkins, x.crowd_rating_avg === null ? null : Number(x.crowd_rating_avg)])).toEqual([
      [23, 7, 1, 4],
      [0, -1, 1, null],
    ]);
  });

  it('test rows, chat-origin and Instagram rows never appear in the analytics schema', async () => {
    const ev = await rows<{ attempt_id: string | null; data_origin: string; channel: string | null }>(
      sql`select attempt_id, data_origin, channel from analytics.events`,
    );
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.map((e) => e.attempt_id)).not.toContain('a4');
    expect(ev.map((e) => e.attempt_id)).not.toContain('a5');
    expect(ev.map((e) => e.attempt_id)).not.toContain('a6');
    expect(ev.every((e) => ['first_party', 'pos'].includes(e.data_origin) && e.channel !== 'instagram')).toBe(true);
    expect(await testRowsInAnalytics(db)).toBe(0);
  });

  it('Velora rows appear only in analytics_demo', async () => {
    for (const view of ANALYTICS_VIEWS) {
      const key = view === 'clubs' ? 'id' : 'club_id';
      const live = await rows<{ k: string }>(sql.raw(`select distinct ${key} as k from analytics.${view}`));
      const demo = await rows<{ k: string }>(sql.raw(`select distinct ${key} as k from analytics_demo.${view}`));
      expect(live.map((r) => r.k), view).not.toContain(FIXTURE_CLUB_ID);
      expect(demo.map((r) => r.k), view).toEqual([FIXTURE_CLUB_ID]);
    }
    const funnel = await rows<{ step: string; attempts: number }>(
      sql`select step, attempts from analytics_demo.booking_funnel where step_no = 1`,
    );
    expect(funnel).toEqual([{ step: 'started', attempts: 1 }]);
  });

  it('the events view has no raw column', async () => {
    for (const schema of ['analytics', 'analytics_demo']) {
      const cols = await rows<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_schema = ${schema} and table_name = 'events'`,
      );
      expect(cols.map((c) => c.column_name)).toContain('props');
      expect(cols.map((c) => c.column_name)).not.toContain('raw');
      expect(cols.map((c) => c.column_name)).not.toContain('is_test');
    }
  });
});

describe('metabase_ro (B14)', () => {
  it('metabase_ro can read the analytics views and cannot write or read operations tables', async () => {
    for (const view of ANALYTICS_VIEWS) {
      await expect(asMetabase(sql.raw(`select * from analytics.${view} limit 1`))).resolves.toBeDefined();
      await expect(asMetabase(sql.raw(`select * from analytics_demo.${view} limit 1`))).resolves.toBeDefined();
    }
    for (const q of [
      'select * from public.bookings',
      'select raw from public.events',
      'select * from public.guests',
      'select * from analytics_src.events',
      "insert into public.door_counts (id, club_id, night_date, delta, kind) values ('x', 'club_test_b', '2026-11-27', 1, 'walk_in')",
      "update public.clubs set name = 'x'",
      'delete from analytics.clubs',
      'create table analytics.x (id int)',
    ]) {
      await expect(asMetabase(sql.raw(q)), q).rejects.toThrow(/permission denied/);
    }
    const [role] = await rows<{ rolcanlogin: boolean; rolconfig: string[] | null }>(
      sql`select rolcanlogin, rolconfig from pg_roles where rolname = ${METABASE_ROLE}`,
    );
    expect(role!.rolcanlogin).toBe(false);
    expect(role!.rolconfig).toContain('default_transaction_read_only=on');
  });
});

describe('Metabase boards (B14)', () => {
  type Board = { name: string; parameters: { slug: string; default?: string }[]; cards: { name: string; sql: string }[] };
  const boards = () =>
    readdirSync(boardsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f, JSON.parse(readFileSync(boardsDir + f, 'utf8')) as Board] as const);
  const render = (q: string, dataset: 'live' | 'demo') =>
    q.replaceAll('{{dataset}}', `'${dataset}'`).replace(/\[\[[^\]]*\]\]/g, '');

  it('every §14.6 starter board has a dashboard file and cards read only analytics schemas', () => {
    expect(boards().map(([f]) => f).sort()).toEqual([
      'booking-curve.json', 'booking-funnel.json', 'busyness-by-hour.json',
      'demand-no-table.json', 'door-vs-bookings.json', 'no-show-rate.json',
    ]);
    for (const [f, b] of boards()) {
      expect(b.parameters.find((p) => p.slug === 'dataset')?.default, f).toBe('live');
      expect(b.cards.length, f).toBeGreaterThan(0);
      for (const c of b.cards) {
        const schemas = [...c.sql.matchAll(/\bfrom\s+([a-z_]+)\./gi)].map((m) => m[1]);
        expect(new Set(schemas), `${f} ${c.name}`).toEqual(new Set(['analytics', 'analytics_demo']));
      }
    }
  });

  it('every board card runs as metabase_ro for the live and demo dataset', async () => {
    for (const [f, b] of boards()) {
      for (const c of b.cards) {
        const live = await asMetabase<{ club_id?: string }>(sql.raw(render(c.sql, 'live')));
        const demo = await asMetabase<{ club_id?: string }>(sql.raw(render(c.sql, 'demo')));
        expect(live.length, `${f} ${c.name}`).toBeGreaterThan(0);
        expect(demo.length, `${f} ${c.name}`).toBeGreaterThan(0);
        expect(live.some((r) => r.club_id === FIXTURE_CLUB_ID), `${f} ${c.name}`).toBe(false);
        expect(demo.every((r) => r.club_id === undefined || r.club_id === FIXTURE_CLUB_ID), `${f} ${c.name}`).toBe(true);
      }
    }
  });

  it('compose binds Metabase to localhost and no app route reaches it', () => {
    const compose = readFileSync(`${repoRoot}docker-compose.yml`, 'utf8');
    const block = compose.slice(compose.indexOf('\n  metabase:'));
    expect(block).toMatch(/- "127\.0\.0\.1:\$\{METABASE_PORT:-3000\}:3000"/);
    expect(block).not.toMatch(/- "\$\{METABASE_PORT/);
    const init = readFileSync(`${repoRoot}infra/metabase/init-role.sh`, 'utf8');
    expect(init).toMatch(/GRANT SELECT ON ALL TABLES IN SCHEMA analytics, analytics_demo TO metabase_ro/);
    const httpDir = `${repoRoot}apps/server/src/http/`;
    const sources = readdirSync(httpDir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(httpDir + f, 'utf8'));
    expect(sources.some((s) => /metabase|:3000\b/i.test(s))).toBe(false);
  });
});
