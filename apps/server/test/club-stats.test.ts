import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb, type Db } from '../src/db/client.js';
import { DEMO_CLUB_ID, seedDemoClub } from '../src/db/seed.js';
import {
  bookings,
  channels,
  clubs,
  conversations,
  deposits,
  guests,
  handoffEpisodes,
  messages,
  platformFlags,
  posBills,
  tables,
  type Club,
} from '../src/db/schema.js';
import { emit, type EventInput } from '../src/data/events.js';
import { newId } from '../src/lib/util.js';
import { buildClubReport } from '../src/platform/club-report.js';
import { aiCostCapKey, buildClubStats } from '../src/platform/club-stats.js';
import { recordLineSetup } from '../src/platform/line-probe.js';
import { seedFixtureClub } from './fixtures/club.js';
import { setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

/** The seeded week: nights Monday 16 Nov to Sunday 22 Nov 2026. */
const FROM = '2026-11-16';
const TO = '2026-11-22';
/** Friday 20 Nov 2026, 19:00 Bangkok. */
const FRI = Date.parse('2026-11-20T12:00:00Z');
const at = (offsetMs: number) => new Date(FRI + offsetMs);
const SEC = 1000;
const MIN = 60_000;

let db: Db;
let close: () => Promise<void>;

async function guest(clubId: string, isTest: boolean) {
  const [g] = await db.insert(guests).values({ id: newId(), clubId, lineUserId: `U${newId()}`, displayName: 'G', isTest }).returning();
  return g!;
}

async function booking(
  clubId: string,
  g: { id: string },
  tableId: string,
  nightDate: string,
  status: string,
  o: { pax?: number; source?: string; isTest?: boolean; deposit?: number; bill?: number; minSpend?: number } = {},
) {
  const id = newId();
  await db.insert(bookings).values({
    id,
    clubId,
    refCode: `R${id.slice(0, 8)}`,
    guestId: g.id,
    tableId,
    nightDate,
    pax: o.pax ?? 4,
    status: status as 'confirmed',
    source: (o.source ?? 'line') as 'line',
    minSpendSatang: o.minSpend ?? 600_000,
    depositSatang: o.deposit ?? 0,
    isTest: o.isTest ?? false,
    createdAt: new Date(`${nightDate}T05:00:00Z`),
  });
  if (o.deposit) await db.insert(deposits).values({ id: newId(), clubId, bookingId: id, amountSatang: o.deposit, method: 'promptpay_slip', status: 'verified' });
  if (o.bill) await db.insert(posBills).values({ id: newId(), clubId, bookingId: id, totalSatang: o.bill });
  return id;
}

async function msg(clubId: string, g: { id: string }, when: Date, dir: 'in' | 'out', author: 'guest' | 'bot' | 'staff', channelId?: string) {
  await db.insert(messages).values({
    id: newId(),
    clubId,
    guestId: g.id,
    direction: dir,
    kind: 'text',
    payload: { text: dir === 'in' ? 'hi' : 'ok' },
    authorType: author,
    channelId: channelId ?? null,
    occurredAt: when,
    createdAt: when,
  });
}

async function takeover(clubId: string, g: { id: string }, topic: string, startedAt: Date) {
  const convId = newId();
  await db.insert(conversations).values({ id: convId, clubId, guestId: g.id });
  await db.insert(handoffEpisodes).values({ id: newId(), clubId, conversationId: convId, startedAt, trigger: 'guest_request', topic });
}

const STEP_PROPS: Partial<Record<EventInput['type'], EventInput['props']>> = {
  'pax.selected': { pax_range: '5-8' },
  'table.held': { hold_minutes: 10 },
  'details.submitted': { pax: 4 },
  'rules.accepted': { rules_version: 'v1' },
  'deposit.verified': { depositId: 'dep_1', amount_satang: 300_000 },
};
const FUNNEL: EventInput['type'][] = ['booking.started', 'night.selected', 'pax.selected', 'table.held', 'details.submitted', 'rules.accepted', 'deposit.verified', 'booking.confirmed'];

/** One booking attempt that reaches `steps` funnel steps, the last one `durationMs` after the first. */
async function attempt(clubId: string, isTest: boolean, steps: number, start: Date, durationMs: number) {
  const attemptId = newId();
  for (let i = 0; i < steps; i++) {
    const type = FUNNEL[i]!;
    const occurredAt = new Date(start.getTime() + (i === steps - 1 ? durationMs : (i * durationMs) / steps));
    await emit(db, { clubId, type, occurredAt, actorType: 'guest', dataOrigin: 'first_party', attemptId, props: STEP_PROPS[type] ?? {}, isTest, channel: 'line' });
  }
}

async function aiCall(clubId: string, isTest: boolean, when: Date, costUsdMicros: number) {
  await emit(db, {
    clubId,
    type: 'ai.call',
    occurredAt: when,
    actorType: 'bot',
    dataOrigin: 'first_party',
    props: { model: 'haiku', input_tokens: 100, output_tokens: 20, latency_ms: 900, cost_usd_micros: costUsdMicros },
    isTest,
  });
}

/**
 * Hand-counted Velora week (club_demo, status demo, so every row is a test row and counts):
 * bookings: Fri T1 completed 4 pax (deposit 3000, bill 10000), Fri B1 arrived 6 pax (deposit 5000,
 * staff message), Sat V1 no_show 8 pax (deposit 10000), Sat T2 completed 2 pax manual, Sat T3 cancelled.
 * Chats (Fri 19:00): g1 in, bot +2 s; g2 in, bot +4 s, g2 in +1 min, takeover 'dress_code' +2 min,
 * staff +5 min; g3 in, no answer; g4 in on Instagram 20:00, bot +1 s.
 * Funnel: three full attempts (1:30, 2:30, 5:00 to confirm), one to table.held, one started only;
 * one attempt the next Monday (outside). AI: 1500 + 2500 micros in the week, 1000 earlier in November.
 */
async function seedVeloraWeek() {
  const c = DEMO_CLUB_ID;
  const ig = `chan_ig_${c}`;
  await db.insert(channels).values({ id: ig, clubId: c, kind: 'instagram' });
  const [g1, g2, g3, g4] = [await guest(c, true), await guest(c, true), await guest(c, true), await guest(c, true)];
  await booking(c, g1!, 'table_demo_T1', '2026-11-20', 'completed', { pax: 4, deposit: 300_000, bill: 1_000_000, minSpend: 800_000, isTest: true });
  await booking(c, g2!, 'table_demo_B1', '2026-11-20', 'arrived', { pax: 6, deposit: 500_000, minSpend: 1_500_000, isTest: true });
  await booking(c, g3!, 'table_demo_V1', '2026-11-21', 'no_show', { pax: 8, deposit: 1_000_000, minSpend: 2_500_000, isTest: true });
  await booking(c, g4!, 'table_demo_T2', '2026-11-21', 'completed', { pax: 2, source: 'manual', minSpend: 800_000, isTest: true });
  await booking(c, g1!, 'table_demo_T3', '2026-11-21', 'cancelled', { pax: 2, minSpend: 800_000, isTest: true });

  await msg(c, g1!, at(0), 'in', 'guest');
  await msg(c, g1!, at(2 * SEC), 'out', 'bot');
  await msg(c, g2!, at(0), 'in', 'guest');
  await msg(c, g2!, at(4 * SEC), 'out', 'bot');
  await msg(c, g2!, at(1 * MIN), 'in', 'guest');
  await takeover(c, g2!, 'dress_code', at(2 * MIN));
  await msg(c, g2!, at(5 * MIN), 'out', 'staff');
  await msg(c, g3!, at(0), 'in', 'guest');
  await msg(c, g4!, at(60 * MIN), 'in', 'guest', ig);
  await msg(c, g4!, at(60 * MIN + SEC), 'out', 'bot', ig);

  await attempt(c, true, 8, at(-60 * MIN), 90 * SEC);
  await attempt(c, true, 8, at(-50 * MIN), 150 * SEC);
  await attempt(c, true, 8, at(-40 * MIN), 300 * SEC);
  await attempt(c, true, 4, at(-30 * MIN), 60 * SEC);
  await attempt(c, true, 1, at(-20 * MIN), 0);
  await attempt(c, true, 8, new Date('2026-11-23T12:00:00Z'), 60 * SEC);

  await aiCall(c, true, at(0), 1500);
  await aiCall(c, true, at(10 * MIN), 2500);
  await aiCall(c, true, new Date('2026-11-05T12:00:00Z'), 1000);
  await db.insert(platformFlags).values({ key: aiCostCapKey(c), value: { usdMicros: 20_000_000 }, updatedBy: 'test', updatedAt: at(0) });
  const club = (await db.query.clubs.findFirst({ where: eq(clubs.id, c) }))!;
  await recordLineSetup(db, club, { report: { ok: true, steps: [] }, quota: { used: 120, limit: 500 } }, { type: 'system' }, 'status', at(0));
}

describe('A16 club stats (Velora)', () => {
  beforeEach(async () => {
    ({ db, close } = await openDb({ dataDir: 'memory' }));
    // The frozen fixture club (`club_demo`, status demo, tables V1/B1/T1...): B7's seedDemoClub now
    // also seeds six weeks of Velora history, which the hand-counted week below must not mix with.
    await seedFixtureClub(db);
    await seedVeloraWeek();
  });
  afterEach(async () => close());

  // Plan A16: "figures match a hand-counted seeded Velora week". B7 seeds Velora's history
  // deterministically: seeded on Wednesday 25 Nov 2026, the week of 16 Nov is four seeded nights
  // (Wed 18 to Sat 21). The figures are pinned, and the booking ones are also counted from the raw rows.
  it('figures match the hand-counted B7-seeded Velora history week', async () => {
    const velora = await openDb({ dataDir: 'memory' });
    try {
      await seedDemoClub(velora.db, {}, new Date('2026-11-25T13:00:00Z'));
      const s = await buildClubStats(velora.db, DEMO_CLUB_ID, FROM, TO);
      expect(s.bookings).toEqual({ total: 44, bot: 39, manual: 5, cancelled: 2 });
      expect(s.deposits).toEqual({ count: 42, satang: 22_000_000 });
      expect(s.deflection).toMatchObject({ conversations: 33, deflected: 27 });
      expect(s.takeoversByTopic).toEqual([
        { topic: 'large_group', n: 2 },
        { topic: 'dress_code', n: 1 },
        { topic: 'parking', n: 1 },
        { topic: 'private_room', n: 1 },
        { topic: 'running_late', n: 1 },
      ]);
      expect(s.handoffResponse).toEqual({ medianMs: 4 * MIN, replied: 6, waiting: 0 });
      expect(s.noShowRate).toBeCloseTo(3 / 43);
      expect(s.minSpendBookedSatang).toBe(66_300_000);
      expect(s.messagesByChannel).toEqual([{ channel: 'line', in: 34, out: 6 }]);

      // The same figures counted straight from the seeded rows.
      const week = (await velora.db.select().from(bookings).where(eq(bookings.clubId, DEMO_CLUB_ID))).filter(
        (b) => b.nightDate >= FROM && b.nightDate <= TO,
      );
      const held = week.filter((b) => ['confirmed', 'arrived', 'completed', 'no_show'].includes(b.status));
      expect(held).toHaveLength(s.bookings.total);
      expect(week.filter((b) => b.status === 'cancelled')).toHaveLength(s.bookings.cancelled);
      expect(held.filter((b) => b.status === 'no_show')).toHaveLength(3);
      const paid = (await velora.db.select().from(deposits).where(eq(deposits.clubId, DEMO_CLUB_ID))).filter(
        (d) => d.status === 'verified' && held.some((b) => b.id === d.bookingId),
      );
      expect(paid).toHaveLength(s.deposits.count);
      expect(paid.reduce((sum, d) => sum + d.amountSatang, 0)).toBe(s.deposits.satang);
      const episodes = (await velora.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.clubId, DEMO_CLUB_ID))).filter(
        (e) => e.startedAt >= new Date('2026-11-16T00:00:00+07:00') && e.startedAt < new Date('2026-11-23T06:00:00+07:00'),
      );
      expect(episodes).toHaveLength(s.takeoversByTopic.reduce((sum, t) => sum + t.n, 0));
    } finally {
      await velora.close();
    }
  });

  it('figures match a hand-counted seeded Velora week', async () => {
    const s = await buildClubStats(db, DEMO_CLUB_ID, FROM, TO);
    expect(s).toMatchObject({ from: FROM, to: TO });
    expect(s.bookings).toEqual({ total: 4, bot: 3, manual: 1, cancelled: 1 });
    expect(s.noStaffHelpRate).toBeCloseTo(2 / 4);
    expect(s.deflection).toMatchObject({ conversations: 4, deflected: 3 });
    expect(s.deflection.rate).toBeCloseTo(3 / 4);
    expect(s.takeoversByTopic).toEqual([{ topic: 'dress_code', n: 1 }]);
    expect(s.firstResponse).toEqual({ medianMs: 3000, answered: 4, unanswered: 1 });
    expect(s.handoffResponse).toEqual({ medianMs: 3 * MIN, replied: 1, waiting: 0 });
    expect(s.bookingTime).toEqual({ medianMs: 150 * SEC, bookings: 3 });
    expect(s.deposits).toEqual({ count: 3, satang: 1_800_000 });
    expect(s.minSpendBookedSatang).toBe(5_600_000);
    expect(s.noShowRate).toBeCloseTo(1 / 4);
    expect(s.messagesByChannel).toEqual([
      { channel: 'line', in: 4, out: 3 },
      { channel: 'instagram', in: 1, out: 1 },
    ]);
    expect(s.pushQuota).toMatchObject({ used: 120, limit: 500, pct: 24 });
    expect(s.aiCost).toEqual({ rangeUsdMicros: 4000, monthUsdMicros: 5000, capUsdMicros: 20_000_000 });
    expect(s.funnel.map((f) => [f.step, f.n])).toEqual([
      ['started', 5],
      ['night', 4],
      ['pax', 4],
      ['table', 4],
      ['details', 3],
      ['rules', 3],
      ['paid', 3],
      ['confirmed', 3],
    ]);
    expect(s.funnel.find((f) => f.step === 'details')!.dropOff).toBe(1);
  });
});

describe('A16 club stats (real club)', () => {
  let clubA: Club;
  let clubB: Club;
  const WEEK = { from: FROM, to: TO };

  /**
   * Club B (live): real Fri V1 completed (deposit 3000) and Sat S1 arrived manual; g1 typed, bot
   * answered in 2 s; one real attempt (3 min). Test rows: a test guest's booking (deposit), chat,
   * takeover and attempt, an is_test ai.call. Club A (fixture, demo): its own booking, chat and takeover.
   */
  async function seedReal() {
    const b = clubB.id;
    const g1 = await guest(b, false);
    const g2 = await guest(b, false);
    const tg = await guest(b, true);
    await booking(b, g1, 'table_b_V1', '2026-11-20', 'completed', { pax: 6, deposit: 300_000, minSpend: 2_000_000 });
    await booking(b, g2, 'table_b_S1', '2026-11-21', 'arrived', { pax: 2, source: 'manual', minSpend: 600_000 });
    await booking(b, tg, 'table_b_V2', '2026-11-20', 'no_show', { pax: 8, isTest: true, deposit: 900_000, minSpend: 2_000_000 });
    await msg(b, g1, at(0), 'in', 'guest');
    await msg(b, g1, at(2 * SEC), 'out', 'bot');
    await msg(b, tg, at(0), 'in', 'guest');
    await takeover(b, tg, 'parking', at(MIN));
    await attempt(b, false, 8, at(-60 * MIN), 3 * MIN);
    await attempt(b, true, 8, at(-50 * MIN), 10 * MIN);
    await aiCall(b, false, at(0), 700);
    await aiCall(b, true, at(0), 99_000);

    const aTable = (await db.select().from(tables).where(eq(tables.clubId, clubA.id)))[0]!;
    const ga = await guest(clubA.id, false);
    await booking(clubA.id, ga, aTable.id, '2026-11-20', 'completed', { pax: 9, deposit: 700_000, minSpend: 5_000_000 });
    await msg(clubA.id, ga, at(0), 'in', 'guest');
    await takeover(clubA.id, ga, 'price', at(MIN));
    await attempt(clubA.id, true, 2, at(0), MIN);
    await aiCall(clubA.id, true, at(0), 5_000);
  }

  beforeEach(async () => {
    ({ db, close, clubA, clubB } = await setupTwoClubs());
    await seedReal();
  });
  afterEach(async () => close());

  it('test rows excluded for real clubs', async () => {
    const s = await buildClubStats(db, clubB.id, WEEK.from, WEEK.to);
    expect(s.bookings).toEqual({ total: 2, bot: 1, manual: 1, cancelled: 0 });
    expect(s.deposits).toEqual({ count: 1, satang: 300_000 });
    expect(s.minSpendBookedSatang).toBe(2_600_000);
    expect(s.noShowRate).toBe(0);
    expect(s.deflection).toMatchObject({ conversations: 1, deflected: 1 });
    expect(s.takeoversByTopic).toEqual([]);
    expect(s.handoffResponse).toEqual({ medianMs: null, replied: 0, waiting: 0 });
    expect(s.firstResponse).toEqual({ medianMs: 2000, answered: 1, unanswered: 0 });
    expect(s.messagesByChannel).toEqual([{ channel: 'line', in: 1, out: 1 }]);
    expect(s.bookingTime).toEqual({ medianMs: 3 * MIN, bookings: 1 });
    expect(s.funnel[0]).toMatchObject({ step: 'started', n: 1 });
    expect(s.aiCost).toEqual({ rangeUsdMicros: 700, monthUsdMicros: 700, capUsdMicros: null });
    expect(s.pushQuota).toBeNull();
  });

  it('club B data never appears in club A stats', async () => {
    const a = await buildClubStats(db, clubA.id, WEEK.from, WEEK.to);
    expect(a.bookings.total).toBe(1);
    expect(a.deposits).toEqual({ count: 1, satang: 700_000 });
    expect(a.minSpendBookedSatang).toBe(5_000_000);
    expect(a.takeoversByTopic).toEqual([{ topic: 'price', n: 1 }]);
    expect(a.funnel.map((f) => f.n)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
    expect(a.aiCost.rangeUsdMicros).toBe(5_000);
    const b = await buildClubStats(db, clubB.id, WEEK.from, WEEK.to);
    expect(b.takeoversByTopic.some((t) => t.topic === 'price')).toBe(false);
  });

  it('stats and weekly report agree on the same week', async () => {
    for (const club of [clubA, clubB]) {
      const s = await buildClubStats(db, club.id, WEEK.from, WEEK.to);
      const r = await buildClubReport(db, club.id, WEEK.from);
      expect(s.bookings.total).toBe(r.bookings);
      expect(s.bookings.cancelled).toBe(r.cancelled);
      expect(s.deposits).toEqual(r.deposits);
      expect(s.noShowRate).toBe(r.noShowRate);
      expect(s.noStaffHelpRate).toBe(r.noStaffHelpRate);
      expect(s.deflection).toEqual(r.deflection);
      expect(s.takeoversByTopic).toEqual(r.takeoversByTopic);
    }
  });

  it('GET /stats answers owner and manager with their own club only', async () => {
    const app = createApp(testConfig(), db, { bot: { now: () => new Date('2026-11-25T05:00:00Z'), log: () => {} } });
    const manager = await staffCookie(app, clubB);
    const res = await app.app.request(staffUrl(clubB.slug, `/stats?from=${FROM}&to=${TO}`), { headers: { cookie: manager } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: { from: string; to: string; bookings: { total: number } } };
    expect(body.stats).toMatchObject({ from: FROM, to: TO, bookings: { total: 2 } });

    // Without a range: the last complete week.
    const def = await app.app.request(staffUrl(clubB.slug, '/stats'), { headers: { cookie: manager } });
    expect(((await def.json()) as { stats: { from: string; to: string } }).stats).toMatchObject({ from: FROM, to: TO });

    const owner = await staffCookie(app, clubB, 'owner');
    expect((await app.app.request(staffUrl(clubB.slug, '/stats'), { headers: { cookie: owner } })).status).toBe(200);
    const host = await staffCookie(app, clubB, 'host');
    expect((await app.app.request(staffUrl(clubB.slug, '/stats'), { headers: { cookie: host } })).status).toBe(403);

    const managerA = await staffCookie(app, clubA);
    const cross = await app.app.request(staffUrl(clubB.slug, `/stats?from=${FROM}&to=${TO}`), { headers: { cookie: managerA } });
    expect([403, 404]).toContain(cross.status);

    for (const q of ['?from=nope&to=2026-11-22', `?from=${TO}&to=${FROM}`, '?from=2025-01-01&to=2026-11-22', `?from=${FROM}`]) {
      expect((await app.app.request(staffUrl(clubB.slug, `/stats${q}`), { headers: { cookie: manager } })).status).toBe(400);
    }
  });
});
