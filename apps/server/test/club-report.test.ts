import { eq, like } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import {
  bookings,
  clubs,
  conversations,
  deposits,
  doorCounts,
  guests,
  handoffEpisodes,
  messages,
  platformFlags,
  posBills,
  tables,
  type Club,
} from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { buildClubReport, sendWeeklyReports } from '../src/platform/club-report.js';
import { setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

/** The seeded week: Monday 16 Nov to Sunday 22 Nov 2026 (nights). */
const WEEK = '2026-11-16';
/** Monday 23 Nov 2026, 11:00 Bangkok: after the weekly send time. */
const MON_SEND = new Date('2026-11-23T04:00:00Z');
/** Monday 23 Nov 2026, 08:00 Bangkok: before the weekly send time. */
const MON_EARLY = new Date('2026-11-23T01:00:00Z');
/** Friday 20 Nov 2026, 19:00 Bangkok: chat time inside the week. */
const FRI_CHAT = new Date('2026-11-20T12:00:00Z');

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let app: ReturnType<typeof createApp>;
let pushes: { to: string; text: string }[];

async function guest(club: Club, isTest = false) {
  const [g] = await db
    .insert(guests)
    .values({ id: newId(), clubId: club.id, lineUserId: `U${newId()}`, displayName: 'G', isTest })
    .returning();
  return g!;
}

async function booking(
  club: Club,
  g: { id: string },
  tableId: string,
  nightDate: string,
  status: string,
  o: { pax?: number; source?: string; isTest?: boolean; deposit?: number; bill?: number } = {},
) {
  const id = newId();
  await db.insert(bookings).values({
    id,
    clubId: club.id,
    refCode: `R${id.slice(0, 8)}`,
    guestId: g.id,
    tableId,
    nightDate,
    pax: o.pax ?? 4,
    status: status as 'confirmed',
    source: (o.source ?? 'line') as 'line',
    minSpendSatang: 600_000,
    depositSatang: o.deposit ?? 0,
    isTest: o.isTest ?? false,
    createdAt: new Date(`${nightDate}T05:00:00Z`),
  });
  if (o.deposit) {
    await db.insert(deposits).values({ id: newId(), clubId: club.id, bookingId: id, amountSatang: o.deposit, method: 'promptpay_slip', status: 'verified' });
  }
  if (o.bill) {
    await db.insert(posBills).values({ id: newId(), clubId: club.id, bookingId: id, totalSatang: o.bill });
  }
  return id;
}

async function inbound(club: Club, g: { id: string }, at = FRI_CHAT) {
  await db.insert(messages).values({ id: newId(), clubId: club.id, guestId: g.id, direction: 'in', kind: 'text', payload: { text: 'hi' }, authorType: 'guest', occurredAt: at, createdAt: at });
}

async function staffMessage(club: Club, g: { id: string }, at = FRI_CHAT) {
  await db.insert(messages).values({ id: newId(), clubId: club.id, guestId: g.id, direction: 'out', kind: 'text', payload: { text: 'ok' }, authorType: 'staff', occurredAt: at, createdAt: at });
}

async function takeover(club: Club, g: { id: string }, topic: string, at = FRI_CHAT) {
  const convId = newId();
  await db.insert(conversations).values({ id: convId, clubId: club.id, guestId: g.id });
  await db.insert(handoffEpisodes).values({ id: newId(), clubId: club.id, conversationId: convId, startedAt: new Date(at.getTime() + 60_000), trigger: 'guest_request', topic });
}

async function door(club: Club, nightDate: string, at: string, delta: number) {
  await db.insert(doorCounts).values({ id: newId(), clubId: club.id, nightDate, at: new Date(at), delta, kind: 'walk_in' });
}

/**
 * Hand-counted week for club B (live):
 * real bookings: Fri V1 completed 6 pax (deposit 3000, bill 12000), Fri S1 arrived 4 pax (deposit 2000,
 * staff message), Sat V2 no_show 5 pax (deposit 3000), Sat S2 completed 2 pax manual (bill 4000),
 * Sat V1 confirmed 3 pax, Sat S1 cancelled, next Monday V1 completed (outside the week).
 * Test rows: Fri V2 completed is_test (deposit, bill 99999), a test guest's chat and takeover.
 * Chats: g1, g2, g3 typed; g2 had a takeover on 'dress_code'.
 * Door: Fri 23:00 +6, 23:30 +4, 23:45 +12, Sat 00:10 +5 (Bangkok).
 */
async function seedWeek() {
  const g1 = await guest(clubB);
  const g2 = await guest(clubB);
  const g3 = await guest(clubB);
  const g4 = await guest(clubB);
  const tg = await guest(clubB, true);
  await booking(clubB, g1, 'table_b_V1', '2026-11-20', 'completed', { pax: 6, deposit: 300_000, bill: 1_200_000 });
  await booking(clubB, g2, 'table_b_S1', '2026-11-20', 'arrived', { pax: 4, deposit: 200_000 });
  await booking(clubB, g3, 'table_b_V2', '2026-11-21', 'no_show', { pax: 5, deposit: 300_000 });
  await booking(clubB, g4, 'table_b_S2', '2026-11-21', 'completed', { pax: 2, source: 'manual', bill: 400_000 });
  await booking(clubB, g1, 'table_b_V1', '2026-11-21', 'confirmed', { pax: 3 });
  await booking(clubB, g3, 'table_b_S1', '2026-11-21', 'cancelled', { pax: 2 });
  await booking(clubB, g1, 'table_b_V1', '2026-11-23', 'completed', { pax: 6, deposit: 300_000 });
  await booking(clubB, tg, 'table_b_V2', '2026-11-20', 'completed', { pax: 8, isTest: true, deposit: 500_000, bill: 9_999_900 });
  await db.insert(posBills).values({ id: newId(), clubId: clubB.id, bookingId: null, totalSatang: 50_000 });
  await staffMessage(clubB, g2);
  await inbound(clubB, g1);
  await inbound(clubB, g2);
  await inbound(clubB, g3);
  await inbound(clubB, tg);
  await takeover(clubB, g2, 'dress_code');
  await takeover(clubB, tg, 'parking');
  await door(clubB, '2026-11-20', '2026-11-20T16:00:00Z', 6);
  await door(clubB, '2026-11-20', '2026-11-20T16:30:00Z', 4);
  await door(clubB, '2026-11-20', '2026-11-20T16:45:00Z', 12);
  await door(clubB, '2026-11-20', '2026-11-20T17:10:00Z', 5);

  // Club A (the fixture club) activity in the same week: must never reach club B's report.
  const aTable = (await db.select().from(tables).where(eq(tables.clubId, clubA.id)))[0]!;
  const ga = await guest(clubA);
  await booking(clubA, ga, aTable.id, '2026-11-20', 'completed', { pax: 9, deposit: 700_000, bill: 5_000_000 });
  await inbound(clubA, ga);
  await takeover(clubA, ga, 'price');
  await door(clubA, '2026-11-20', '2026-11-20T15:00:00Z', 40);
}

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  await db.update(clubs).set({ staffGroupId: 'Cgroup_b' }).where(eq(clubs.id, clubB.id));
  await db.update(clubs).set({ staffGroupId: 'Cgroup_a' }).where(eq(clubs.id, clubA.id));
  clubA = (await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!;
  clubB = (await db.query.clubs.findFirst({ where: eq(clubs.id, clubB.id) }))!;
  app = createApp(testConfig(), db, { bot: { now: () => MON_SEND, log: () => {} } });
  pushes = [];
  const dev = app.ctx.gateways.dev as unknown as { push: (to: string, msgs: { type: string; text?: string }[]) => Promise<void> };
  vi.spyOn(dev, 'push').mockImplementation(async (to, msgs) => {
    for (const m of msgs) pushes.push({ to, text: m.text ?? '' });
  });
  await seedWeek();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

describe('A16b weekly club report', () => {
  // Plan A16b: "report figures match hand-counted seeded Velora week". B7's Velora history seed
  // is not on this branch yet; until it is, the figures are checked against the hand-seeded
  // fixture week above (club B), and the Velora case waits on B7.
  it.todo('report figures match the hand-counted B7-seeded Velora week (waits on B7 seed)');

  it('report figures match the hand-counted fixture week (club B, stand-in for the Velora seed)', async () => {
    const r = await buildClubReport(db, clubB.id, WEEK);
    expect(r.weekStart).toBe(WEEK);
    expect(r.weekEnd).toBe('2026-11-22');
    expect(r.bookings).toBe(5);
    expect(r.cancelled).toBe(1);
    expect(r.deposits).toEqual({ count: 3, satang: 800_000 });
    expect(r.noShowRate).toBeCloseTo(1 / 4);
    expect(r.noStaffHelpRate).toBeCloseTo(3 / 5);
    expect(r.busiestNights).toEqual([
      { nightDate: '2026-11-21', bookings: 3 },
      { nightDate: '2026-11-20', bookings: 2 },
    ]);
    expect(r.zones.map((z) => [z.name, z.bookings])).toEqual([
      ['VIP', 3],
      ['Standard', 2],
    ]);
    expect(r.averageSpendSatang).toBe(800_000);
    expect(r.topPromoters).toBeNull();
    expect(r.deflection).toMatchObject({ conversations: 3, deflected: 2 });
    expect(r.deflection.rate).toBeCloseTo(2 / 3);
    expect(r.takeoversByTopic).toEqual([{ topic: 'dress_code', n: 1 }]);
    expect(r.door).toEqual({ count: 27, bookedPax: 20, peakHour: 23 });
  });

  it('club B data never appears in club A report', async () => {
    const a = await buildClubReport(db, clubA.id, WEEK);
    expect(a.bookings).toBe(1);
    expect(a.deposits).toEqual({ count: 1, satang: 700_000 });
    expect(a.averageSpendSatang).toBe(5_000_000);
    expect(a.takeoversByTopic).toEqual([{ topic: 'price', n: 1 }]);
    expect(a.deflection).toMatchObject({ conversations: 1, deflected: 0 });
    expect(a.door).toEqual({ count: 40, bookedPax: 9, peakHour: 22 });
    expect(a.zones.every((z) => !z.zoneId.startsWith('zone_b_'))).toBe(true);
    const b = await buildClubReport(db, clubB.id, WEEK);
    expect(b.takeoversByTopic.some((t) => t.topic === 'price')).toBe(false);
  });

  it('a demo club report counts its own test rows', async () => {
    const aTable = (await db.select().from(tables).where(eq(tables.clubId, clubA.id)))[0]!;
    const tg = await guest(clubA, true);
    await booking(clubA, tg, aTable.id, '2026-11-21', 'completed', { pax: 3, isTest: true });
    const a = await buildClubReport(db, clubA.id, WEEK);
    expect(a.bookings).toBe(2);
  });

  it('sent once per week per club', async () => {
    await sendWeeklyReports(app.ctx, MON_EARLY);
    expect(pushes).toHaveLength(0);

    await sendWeeklyReports(app.ctx, MON_SEND);
    const toB = pushes.filter((p) => p.to === 'Cgroup_b');
    expect(toB).toHaveLength(1);
    expect(toB[0]!.text).toContain('2026-11-16');
    expect(toB[0]!.text).toContain('Bookings 5');
    expect(toB[0]!.text).toContain('การจอง 5');
    expect(pushes.filter((p) => p.to === 'Cgroup_a')).toHaveLength(1);
    expect(pushes.find((p) => p.to === 'Cgroup_a')!.text).not.toContain('Bookings 5');

    await sendWeeklyReports(app.ctx, new Date(MON_SEND.getTime() + 3600_000));
    await sendWeeklyReports(app.ctx, new Date('2026-11-27T04:00:00Z'));
    expect(pushes.filter((p) => p.to === 'Cgroup_b')).toHaveLength(1);
    const flags = await db.select().from(platformFlags).where(like(platformFlags.key, 'club-report:%'));
    expect(flags.map((f) => f.key).sort()).toEqual([`club-report:${clubA.id}:${WEEK}`, `club-report:${clubB.id}:${WEEK}`]);

    // The next week is sent once, on its own Monday.
    await sendWeeklyReports(app.ctx, new Date('2026-11-30T04:00:00Z'));
    expect(pushes.filter((p) => p.to === 'Cgroup_b')).toHaveLength(2);
  });

  it('GET /report answers owner and manager with their own club only', async () => {
    const manager = await staffCookie(app, clubB);
    const res = await app.app.request(staffUrl(clubB.slug, `/report?week=${WEEK}`), { headers: { cookie: manager } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { bookings: number; weekStart: string } };
    expect(body.report).toMatchObject({ bookings: 5, weekStart: WEEK });

    // A mid-week date means that date's week.
    const mid = await app.app.request(staffUrl(clubB.slug, '/report?week=2026-11-19'), { headers: { cookie: manager } });
    expect(((await mid.json()) as { report: { weekStart: string } }).report.weekStart).toBe(WEEK);

    const host = await staffCookie(app, clubB, 'host');
    expect((await app.app.request(staffUrl(clubB.slug, '/report'), { headers: { cookie: host } })).status).toBe(403);

    const managerA = await staffCookie(app, clubA);
    const cross = await app.app.request(staffUrl(clubB.slug, `/report?week=${WEEK}`), { headers: { cookie: managerA } });
    expect([403, 404]).toContain(cross.status);

    const bad = await app.app.request(staffUrl(clubB.slug, '/report?week=nope'), { headers: { cookie: manager } });
    expect(bad.status).toBe(400);
  });
});
