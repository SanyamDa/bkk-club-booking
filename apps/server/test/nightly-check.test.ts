import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdTable, requestDeposit, submitDetails } from '../src/bookings/service.js';
import { emit } from '../src/data/events.js';
import type { Db } from '../src/db/client.js';
import { events, opsEvents, platformFlags, type Club } from '../src/db/schema.js';
import { checkEventCompleteness, runNightlyCheck } from '../src/jobs/nightly-check.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupTwoClubs>>;
let db: Db;
let clubA: Club;
let clubB: Club;
beforeEach(async () => {
  ctx = await setupTwoClubs();
  ({ db, clubA, clubB } = ctx);
});
afterEach(async () => {
  await ctx.close();
});

/** Friday 21:00 Bangkok: inside the fixture clubs' opening hours (18:00 to 06:00). */
const FRIDAY_NIGHT = new Date('2026-11-27T14:00:00Z');

const opsOf = (check: string) => db.select().from(opsEvents).where(sql`${opsEvents.detail}->>'check' = ${check}`);

async function rawEvent(clubId: string, props: Record<string, string | number | boolean | null>, opts: { isTest?: boolean } = {}) {
  await db.insert(events).values({
    id: newId(),
    occurredAt: FRIDAY_NIGHT,
    recordedAt: FRIDAY_NIGHT,
    clubId,
    type: 'message.received',
    v: 1,
    actorType: 'guest',
    dataOrigin: 'line_chat',
    props,
    isTest: opts.isTest ?? false,
  });
}

/** One event for clubB in opening hours, so the silent-club check stays quiet. */
const keepClubBAwake = () =>
  emit(db, { clubId: clubB.id, type: 'bot.fallback_menu', occurredAt: FRIDAY_NIGHT, actorType: 'bot', dataOrigin: 'first_party', isTest: false });

describe('nightly check (B2)', () => {
  it('nightly check finds a missing event', async () => {
    await keepClubBAwake();
    const g = await makeGuest(db, { clubId: clubA.id });
    const b = await holdTable(db, clubA, { guestId: g.id, tableId: 'table_demo_B2', nightDate: FRIDAY, pax: 6 }, FRIDAY_AFTERNOON);
    await submitDetails(db, clubA, b.id, { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6 }, FRIDAY_AFTERNOON);
    await requestDeposit(db, clubA, b.id, FRIDAY_AFTERNOON);

    expect(await checkEventCompleteness(db, FRIDAY)).toEqual({ missing: 0, silentClubs: [], piiInProps: 0, testInAggregates: 0 });
    expect(await db.select().from(opsEvents)).toEqual([]);

    const [one] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.bookingId, b.id), eq(events.type, 'booking.status_changed')))
      .limit(1);
    await db.delete(events).where(eq(events.id, one!.id));

    const result = await checkEventCompleteness(db, FRIDAY);
    expect(result.missing).toBe(1);
    const rows = await opsOf('event_completeness');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'bot_error', clubId: clubA.id });
  });

  it('live club silent during opening hours is flagged', async () => {
    const result = await checkEventCompleteness(db, FRIDAY);
    expect(result.silentClubs).toEqual([clubB.id]); // clubA is a demo club, not live
    expect(await opsOf('silent_club')).toMatchObject([{ kind: 'bot_error', clubId: clubB.id }]);

    await db.delete(opsEvents);
    await keepClubBAwake();
    expect((await checkEventCompleteness(db, FRIDAY)).silentClubs).toEqual([]);
    expect(await opsOf('silent_club')).toEqual([]);
  });

  it('a live club closed that night is not silent', async () => {
    // Sunday is closed for the fixture settings (Wed to Sat).
    expect((await checkEventCompleteness(db, '2026-11-29')).silentClubs).toEqual([]);
  });

  it('personal data pattern in props is flagged', async () => {
    await keepClubBAwake();
    await rawEvent(clubB.id, { kind: '0812345678' });
    await rawEvent(clubB.id, { kind: 'a@example.com' });
    await rawEvent(clubB.id, { kind: 'สวัสดี' });
    await rawEvent(clubB.id, { kind: 'text', count: 3 });

    const result = await checkEventCompleteness(db, FRIDAY);
    expect(result.piiInProps).toBe(3);
    expect(await opsOf('pii_in_props')).toMatchObject([{ kind: 'bot_error', clubId: clubB.id }]);
  });

  it('is_test row in an analytics view is flagged', async () => {
    await keepClubBAwake();
    await db.execute(sql`create schema if not exists analytics`);
    await db.execute(sql`create view analytics.b2_probe as select club_id, is_test from public.events`);
    await rawEvent(clubB.id, { kind: 'text' }, { isTest: true });

    const result = await checkEventCompleteness(db, FRIDAY);
    expect(result.testInAggregates).toBe(1);
    // Attributed to the club, so its health tile (failures24h) turns red.
    expect(await opsOf('test_in_aggregates')).toMatchObject([{ kind: 'bot_error', clubId: clubB.id, detail: { views: { b2_probe: 1 } } }]);
  });

  it('a demo-club row leaking into a B14 analytics view is flagged', async () => {
    await keepClubBAwake();
    // Drop the view's "real clubs only" filter, so the demo fixture club shows in analytics.clubs.
    await db.execute(sql`create or replace view analytics.clubs as select id, slug, name, status, created_at from analytics_src.clubs`);

    const result = await checkEventCompleteness(db, FRIDAY);
    expect(result.testInAggregates).toBeGreaterThan(0);
    expect(await opsOf('test_in_aggregates')).toMatchObject([{ kind: 'bot_error', clubId: null, detail: { analyticsRows: result.testInAggregates } }]);
  });

  it('a failed check frees the claim so a later tick retries the night', async () => {
    await keepClubBAwake();
    await db.execute(sql`create schema if not exists analytics`);
    await db.execute(sql`create view analytics.b2_broken as select (1 / (select count(*) from public.events where false))::int = 1 as is_test`);
    const saturdayMorning = new Date('2026-11-28T01:00:00Z'); // 08:00 Bangkok

    await expect(runNightlyCheck(db, saturdayMorning)).rejects.toThrow();
    expect(await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, `nightly_check:${FRIDAY}`) })).toBeUndefined();

    await db.execute(sql`drop view analytics.b2_broken`);
    expect(await runNightlyCheck(db, saturdayMorning)).toMatchObject({ nightDate: FRIDAY, missing: 0 });
  });

  it('the nightly job checks the previous night once', async () => {
    await keepClubBAwake();
    const saturdayMorning = new Date('2026-11-28T01:00:00Z'); // 08:00 Bangkok
    expect(await runNightlyCheck(db, saturdayMorning)).toEqual({ nightDate: FRIDAY, missing: 0, silentClubs: [], piiInProps: 0, testInAggregates: 0 });
    expect(await runNightlyCheck(db, saturdayMorning)).toBeNull();
    expect(await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, `nightly_check:${FRIDAY}`) })).toBeDefined();
    // Before 07:00 Bangkok the previous night may still be running: no check yet.
    expect(await runNightlyCheck(db, new Date('2026-11-28T22:30:00Z'))).toBeNull(); // 05:30 Sunday
  });
});
