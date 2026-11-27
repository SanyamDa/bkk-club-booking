import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { auditLog, bookings, clubMemberships, guests, posBills, promoterAttributions, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { buildClubReport } from '../src/platform/club-report.js';
import {
  attributeBooking,
  createPromoter,
  PromoterError,
  promoterLink,
  promoterReport,
  topPromoters,
} from '../src/platform/promoters.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { loginAs, makeUser, staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const WEEK = '2026-11-16';
const NOW = new Date('2026-11-23T04:00:00Z');

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  app = createApp(testConfig(), db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
});
afterEach(async () => {
  await close();
});

async function guest(club: Club, o: { isTest?: boolean; name?: string; phone?: string } = {}) {
  const [g] = await db
    .insert(guests)
    .values({ id: newId(), clubId: club.id, lineUserId: `U${newId()}`, displayName: 'G', name: o.name ?? 'Guest Name', phone: o.phone ?? '0812345678', isTest: o.isTest ?? false })
    .returning();
  return g!;
}

async function booking(club: Club, tableId: string, nightDate: string, status: string, o: { pax?: number; isTest?: boolean; bill?: number; minSpend?: number } = {}) {
  const g = await guest(club, { isTest: o.isTest });
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
    source: 'line',
    minSpendSatang: o.minSpend ?? 600_000,
    depositSatang: 0,
    isTest: o.isTest ?? false,
  });
  if (o.bill) await db.insert(posBills).values({ id: newId(), clubId: club.id, bookingId: id, totalSatang: o.bill });
  return id;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('promoters (plan A20a)', () => {
  it('code is unique per club and lowercase', async () => {
    const p = await createPromoter(db, clubB.id, { name: 'Ann', code: 'Ann-01' }, NOW);
    expect(p.code).toBe('ann-01');
    await expect(createPromoter(db, clubB.id, { name: 'Other', code: 'ANN-01' }, NOW)).rejects.toMatchObject({ code: 'code_taken' });
    await expect(createPromoter(db, clubB.id, { name: 'Bad', code: 'a b' }, NOW)).rejects.toBeInstanceOf(PromoterError);
    // The same code in another club is fine.
    const other = await createPromoter(db, clubA.id, { name: 'Ann A', code: 'ann-01' }, NOW);
    expect(other.clubId).toBe(clubA.id);
    expect(promoterLink('https://x.test', clubB, p.code)).toBe('https://x.test/r/p/test-b/ann-01');
  });

  it('manual attribution is club-scoped', async () => {
    const pA = await createPromoter(db, clubA.id, { name: 'A', code: 'pa' }, NOW);
    const pB = await createPromoter(db, clubB.id, { name: 'B', code: 'pb' }, NOW);
    const bB = await booking(clubB, 'table_b_V1', '2026-11-20', 'confirmed');
    // club B booking with club A promoter, and club A with club B booking: both not_found.
    await expect(attributeBooking(db, clubB.id, bB, { promoterId: pA.id }, 'manual', null, NOW)).rejects.toMatchObject({ code: 'not_found' });
    await expect(attributeBooking(db, clubA.id, bB, { promoterId: pA.id }, 'manual', null, NOW)).rejects.toMatchObject({ code: 'not_found' });

    const cookie = await staffCookie(app, clubA, 'manager');
    const res = await app.app.request(staffUrl(clubA.slug, `/bookings/${bB}/promoter`), { ...json({ promoterId: pB.id }), method: 'PUT', headers: { 'content-type': 'application/json', cookie } });
    expect(res.status).toBe(404);
    expect(await db.select().from(promoterAttributions)).toEqual([]);

    const cookieB = await staffCookie(app, clubB, 'host');
    const ok = await app.app.request(staffUrl(clubB.slug, `/bookings/${bB}/promoter`), { method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookieB }, body: JSON.stringify({ code: 'PB' }) });
    expect(ok.status).toBe(200);
    const [row] = await db.select().from(promoterAttributions);
    expect(row).toMatchObject({ bookingId: bB, promoterId: pB.id, via: 'manual', clubId: clubB.id });
  });

  it('link attribution never replaces a manual one', async () => {
    const p1 = await createPromoter(db, clubB.id, { name: 'One', code: 'one' }, NOW);
    const p2 = await createPromoter(db, clubB.id, { name: 'Two', code: 'two' }, NOW);
    const b = await booking(clubB, 'table_b_V1', '2026-11-20', 'confirmed');
    await attributeBooking(db, clubB.id, b, { promoterId: p1.id }, 'manual', 'staff-1', NOW);
    const after = await attributeBooking(db, clubB.id, b, { code: 'two' }, 'link', null, NOW);
    expect(after.promoterId).toBe(p1.id);
    // A manual change does replace.
    const changed = await attributeBooking(db, clubB.id, b, { promoterId: p2.id }, 'manual', 'staff-1', NOW);
    expect(changed.promoterId).toBe(p2.id);
    // A disabled promoter's code is not accepted.
    const b2 = await booking(clubB, 'table_b_V2', '2026-11-20', 'confirmed');
    const cookie = await staffCookie(app, clubB, 'manager');
    const dis = await app.app.request(staffUrl(clubB.slug, `/promoters/${p1.id}`), { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ disabled: true }) });
    expect(dis.status).toBe(200);
    await expect(attributeBooking(db, clubB.id, b2, { code: 'one' }, 'link', null, NOW)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('report counts held bookings, arrivals, pax and commission per promoter', async () => {
    const p = await createPromoter(db, clubB.id, { name: 'Ann', code: 'ann', commissionBps: 1000 }, NOW);
    const q = await createPromoter(db, clubB.id, { name: 'Bo', code: 'bo', commissionBps: 500 }, NOW);
    const b1 = await booking(clubB, 'table_b_V1', '2026-11-20', 'completed', { pax: 6, bill: 1_200_000 }); // 10% of 12000 = 1200
    const b2 = await booking(clubB, 'table_b_S1', '2026-11-20', 'arrived', { pax: 4, minSpend: 600_000 }); // no bill: 10% of 6000 = 600
    const b3 = await booking(clubB, 'table_b_V2', '2026-11-21', 'no_show', { pax: 5 }); // held, no commission
    const b4 = await booking(clubB, 'table_b_S2', '2026-11-21', 'cancelled', { pax: 2 }); // not held
    const b5 = await booking(clubB, 'table_b_S1', '2026-11-21', 'confirmed', { pax: 3 }); // Bo
    for (const id of [b1, b2, b3, b4]) await attributeBooking(db, clubB.id, id, { promoterId: p.id }, 'manual', null, NOW);
    await attributeBooking(db, clubB.id, b5, { promoterId: q.id }, 'link', null, NOW);

    const r = await promoterReport(db, clubB.id, '2026-11-16', '2026-11-22');
    const ann = r.find((x) => x.promoterId === p.id)!;
    expect(ann).toMatchObject({ bookings: 3, arrived: 2, noShows: 1, pax: 15, spendSatang: 1_200_000, commissionSatang: 180_000 });
    const bo = r.find((x) => x.promoterId === q.id)!;
    expect(bo).toMatchObject({ bookings: 1, arrived: 0, pax: 3, commissionSatang: 0 });
    expect(r[0]!.promoterId).toBe(p.id);

    const cookie = await staffCookie(app, clubB, 'manager');
    const res = await app.app.request(staffUrl(clubB.slug, '/promoters/report?from=2026-11-16&to=2026-11-22'), { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { promoterId: string; commissionSatang: number }[] };
    expect(body.report.find((x) => x.promoterId === p.id)!.commissionSatang).toBe(180_000);
  });

  it('test rows excluded for a live club', async () => {
    const p = await createPromoter(db, clubB.id, { name: 'Ann', code: 'ann', commissionBps: 1000 }, NOW);
    const real = await booking(clubB, 'table_b_V1', '2026-11-20', 'completed', { bill: 1_000_000 });
    const test = await booking(clubB, 'table_b_V2', '2026-11-20', 'completed', { isTest: true, bill: 9_999_900 });
    await attributeBooking(db, clubB.id, real, { promoterId: p.id }, 'manual', null, NOW);
    await attributeBooking(db, clubB.id, test, { promoterId: p.id }, 'manual', null, NOW);
    const [row] = await promoterReport(db, clubB.id, '2026-11-16', '2026-11-22');
    expect(row).toMatchObject({ bookings: 1, spendSatang: 1_000_000 });
  });

  it('promoter sees only their own bookings, no guest name or phone', async () => {
    const user = await makeUser(db, { email: 'promo@test.local', clubId: clubB.id, role: 'promoter' });
    const p = await createPromoter(db, clubB.id, { name: 'Ann', code: 'ann', userId: user.id, commissionBps: 1000 }, NOW);
    const q = await createPromoter(db, clubB.id, { name: 'Bo', code: 'bo' }, NOW);
    const mine = await booking(clubB, 'table_b_V1', '2026-11-27', 'confirmed');
    const theirs = await booking(clubB, 'table_b_V2', '2026-11-27', 'confirmed');
    await attributeBooking(db, clubB.id, mine, { promoterId: p.id }, 'link', null, NOW);
    await attributeBooking(db, clubB.id, theirs, { promoterId: q.id }, 'link', null, NOW);

    const cookie = await loginAs(app, user);
    const res = await app.app.request(staffUrl(clubB.slug, '/promoter/me'), { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { promoter: { code: string; link: string }; bookings: { id: string }[] };
    expect(body.promoter.code).toBe('ann');
    expect(body.promoter.link).toContain('/r/p/test-b/ann');
    expect(body.bookings.map((b) => b.id)).toEqual([mine]);
    expect(text).not.toContain('Guest Name');
    expect(text).not.toContain('0812345678');
    // A promoter cannot reach the staff booking routes.
    const night = await app.app.request(staffUrl(clubB.slug, '/night'), { headers: { cookie } });
    expect(night.status).toBe(403);
    const list = await app.app.request(staffUrl(clubB.slug, '/promoters'), { headers: { cookie } });
    expect(list.status).toBe(403);
  });

  it('host cannot create a promoter (403)', async () => {
    const cookie = await staffCookie(app, clubB, 'host');
    const res = await app.app.request(staffUrl(clubB.slug, '/promoters'), { ...json({ name: 'X', code: 'xx1' }), headers: { 'content-type': 'application/json', cookie } });
    expect(res.status).toBe(403);
    const mgr = await staffCookie(app, clubB, 'manager');
    const ok = await app.app.request(staffUrl(clubB.slug, '/promoters'), { ...json({ name: 'X', code: 'xx1', commissionBps: 1000 }), headers: { 'content-type': 'application/json', cookie: mgr } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { promoter: { code: string; link: string } };
    expect(body.promoter.code).toBe('xx1');
    expect(body.promoter.link).toBe('http://localhost:5173/r/p/test-b/xx1');
    const dup = await app.app.request(staffUrl(clubB.slug, '/promoters'), { ...json({ name: 'Y', code: 'XX1' }), headers: { 'content-type': 'application/json', cookie: mgr } });
    expect(dup.status).toBe(409);
  });

  it('weekly report lists top promoters, null with no promoters', async () => {
    expect((await buildClubReport(db, clubB.id, WEEK)).topPromoters).toBeNull();
    expect(await topPromoters(db, clubB.id, WEEK)).toBeNull();
    const p = await createPromoter(db, clubB.id, { name: 'Ann', code: 'ann' }, NOW);
    const b = await booking(clubB, 'table_b_V1', '2026-11-20', 'completed', { pax: 6 });
    await booking(clubB, 'table_b_V2', '2026-11-20', 'completed'); // not attributed
    await attributeBooking(db, clubB.id, b, { promoterId: p.id }, 'manual', null, NOW);
    const r = await buildClubReport(db, clubB.id, WEEK);
    expect(r.topPromoters).toEqual([{ promoterId: p.id, name: 'Ann', code: 'ann', bookings: 1, pax: 6 }]);
    // Club A sees none of club B's promoters.
    expect((await buildClubReport(db, clubA.id, WEEK)).topPromoters).toBeNull();
  });

  it('promoter membership without a promoter row gets 404', async () => {
    const user = await makeUser(db, { email: 'promo2@test.local', clubId: clubB.id, role: 'promoter' });
    const cookie = await loginAs(app, user);
    const res = await app.app.request(staffUrl(clubB.slug, '/promoter/me'), { headers: { cookie } });
    expect(res.status).toBe(404);
    expect((await db.select().from(clubMemberships).where(eq(clubMemberships.userId, user.id))).length).toBe(1);
  });

  it('promoter and attribution changes write club-scoped audit rows', async () => {
    const cookie = await staffCookie(app, clubB, 'manager');
    const h = { 'content-type': 'application/json', cookie };
    const made = await app.app.request(staffUrl(clubB.slug, '/promoters'), { method: 'POST', headers: h, body: JSON.stringify({ name: 'Ann', code: 'ann' }) });
    expect(made.status).toBe(200);
    const { promoter } = (await made.json()) as { promoter: { id: string } };
    expect((await app.app.request(staffUrl(clubB.slug, `/promoters/${promoter.id}`), { method: 'PATCH', headers: h, body: JSON.stringify({ commissionBps: 500 }) })).status).toBe(200);
    const b = await booking(clubB, 'table_b_V1', '2026-11-20', 'confirmed');
    expect((await app.app.request(staffUrl(clubB.slug, `/bookings/${b}/promoter`), { method: 'PUT', headers: h, body: JSON.stringify({ code: 'ann' }) })).status).toBe(200);
    expect((await app.app.request(staffUrl(clubB.slug, `/bookings/${b}/promoter`), { method: 'DELETE', headers: { cookie } })).status).toBe(200);
    const rows = await db.select().from(auditLog).where(eq(auditLog.clubId, clubB.id));
    expect(rows.map((r) => r.action).filter((a) => a.startsWith('promoter.')).sort()).toEqual(
      ['promoter.attribution_removed', 'promoter.booking_attributed', 'promoter.changed', 'promoter.created'],
    );
    expect(rows.every((r) => r.actorType === 'staff' && r.actorId)).toBe(true);
    expect(await db.select().from(auditLog).where(eq(auditLog.clubId, clubA.id))).toEqual([]);
  });
});
