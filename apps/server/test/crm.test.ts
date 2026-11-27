import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { bookings, guestNotes, guests, guestTags, posBills, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { buildClubReport } from '../src/platform/club-report.js';
import { addNote, addTag, CrmError, guestProfile, normalizeTag, removeTag, searchGuests, vipSummary } from '../src/platform/crm.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

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

async function guest(club: Club, o: { name?: string; phone?: string; displayName?: string; isTest?: boolean } = {}) {
  const [g] = await db
    .insert(guests)
    .values({ id: newId(), clubId: club.id, lineUserId: `U${newId()}`, displayName: o.displayName ?? 'LINE name', name: o.name ?? null, phone: o.phone ?? null, isTest: o.isTest ?? false })
    .returning();
  return g!;
}

async function booking(club: Club, guestId: string, tableId: string, nightDate: string, status: string, bill?: number) {
  const id = newId();
  await db.insert(bookings).values({
    id,
    clubId: club.id,
    refCode: `R${id.slice(0, 8)}`,
    guestId,
    tableId,
    nightDate,
    pax: 4,
    status: status as 'confirmed',
    source: 'line',
    minSpendSatang: 600_000,
    depositSatang: 0,
  });
  if (bill) await db.insert(posBills).values({ id: newId(), clubId: club.id, bookingId: id, totalSatang: bill });
  return id;
}

const post = (cookie: string, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

describe('guest CRM and VIP tags (plan A20c)', () => {
  it('search by name, phone or tag', async () => {
    const somchai = await guest(clubB, { name: 'Somchai Jaidee', phone: '0811111111' });
    const anna = await guest(clubB, { name: 'Anna Lee', phone: '0822222222' });
    await guest(clubA, { name: 'Somchai Other', phone: '0811111111' });
    await addTag(db, clubB.id, anna.id, 'VIP', 'u1', NOW);

    expect((await searchGuests(db, clubB, { q: 'somch' })).map((g) => g.id)).toEqual([somchai.id]);
    expect((await searchGuests(db, clubB, { q: '082222' })).map((g) => g.id)).toEqual([anna.id]);
    expect((await searchGuests(db, clubB, { tag: 'vip' })).map((g) => g.id)).toEqual([anna.id]);
    const all = await searchGuests(db, clubB, {});
    expect(all.map((g) => g.id).sort()).toEqual([somchai.id, anna.id].sort());
    expect(all.find((g) => g.id === anna.id)!.tags).toEqual(['vip']);

    const cookie = await staffCookie(app, clubB, 'host');
    const res = await app.app.request(staffUrl(clubB.slug, '/guests?q=somchai'), { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { guests: { id: string }[] };
    expect(body.guests.map((g) => g.id)).toEqual([somchai.id]);
    // A fractional limit is truncated, not passed to Postgres as a bigint (was a 500).
    const frac = await app.app.request(staffUrl(clubB.slug, '/guests?limit=1.5'), { headers: { cookie } });
    expect(frac.status).toBe(200);
    expect(((await frac.json()) as { guests: unknown[] }).guests).toHaveLength(1);
  });

  it('tags are normalised and idempotent', async () => {
    expect(normalizeTag('  Big   Spender ')).toBe('big-spender');
    expect(normalizeTag('VIP')).toBe('vip');
    expect(normalizeTag('ลูกค้าประจำ')).toBe('ลูกค้าประจำ');
    expect(() => normalizeTag('')).toThrow(CrmError);
    expect(() => normalizeTag('x'.repeat(33))).toThrow(CrmError);
    const g = await guest(clubB, { name: 'A' });
    await addTag(db, clubB.id, g.id, 'VIP', 'u1', NOW);
    await addTag(db, clubB.id, g.id, ' vip ', 'u1', NOW);
    expect((await db.select().from(guestTags)).length).toBe(1);
    await removeTag(db, clubB.id, g.id, 'VIP');
    expect((await db.select().from(guestTags)).length).toBe(0);

    const cookie = await staffCookie(app, clubB, 'manager');
    const add = await app.app.request(staffUrl(clubB.slug, `/guests/${g.id}/tags`), post(cookie, { tag: 'VIP' }));
    expect(add.status).toBe(200);
    expect(((await add.json()) as { tags: string[] }).tags).toEqual(['vip']);
    const bad = await app.app.request(staffUrl(clubB.slug, `/guests/${g.id}/tags`), post(cookie, { tag: '' }));
    expect(bad.status).toBe(400);
    const del = await app.app.request(staffUrl(clubB.slug, `/guests/${g.id}/tags/vip`), { method: 'DELETE', headers: { cookie } });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { tags: string[] }).tags).toEqual([]);
  });

  it('profile shows bookings, visits, no-shows, spend, tags and notes', async () => {
    const g = await guest(clubB, { name: 'Somchai', phone: '0811111111' });
    await booking(clubB, g.id, 'table_b_V1', '2026-11-13', 'completed', 1_500_000);
    await booking(clubB, g.id, 'table_b_V1', '2026-11-20', 'arrived');
    await booking(clubB, g.id, 'table_b_V2', '2026-11-21', 'no_show');
    await booking(clubB, g.id, 'table_b_S1', '2026-11-28', 'confirmed');
    await addTag(db, clubB.id, g.id, 'vip', 'u1', NOW);
    await addNote(db, clubB.id, g.id, 'Likes the booth by the DJ', 'u1', NOW);

    const p = (await guestProfile(db, clubB, g.id))!;
    expect(p.guest).toMatchObject({ id: g.id, name: 'Somchai', phone: '0811111111' });
    expect(p.stats).toEqual({ bookings: 4, visits: 2, noShows: 1, spendSatang: 1_500_000, lastVisit: '2026-11-20' });
    expect(p.tags).toEqual(['vip']);
    expect(p.notes.map((n) => n.text)).toEqual(['Likes the booth by the DJ']);
    expect(p.bookings.map((b) => b.nightDate)).toEqual(['2026-11-28', '2026-11-21', '2026-11-20', '2026-11-13']);
    expect(p.bookings[3]).toMatchObject({ tableCode: 'V1', status: 'completed', spendSatang: 1_500_000 });

    const cookie = await staffCookie(app, clubB, 'host');
    const res = await app.app.request(staffUrl(clubB.slug, `/guests/${g.id}`), { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: { stats: { visits: number } } };
    expect(body.profile.stats.visits).toBe(2);
  });

  it('notes are append-only with author', async () => {
    const g = await guest(clubB, { name: 'A' });
    const cookie = await staffCookie(app, clubB, 'host');
    const r1 = await app.app.request(staffUrl(clubB.slug, `/guests/${g.id}/notes`), post(cookie, { text: 'first' }));
    expect(r1.status).toBe(200);
    await app.app.request(staffUrl(clubB.slug, `/guests/${g.id}/notes`), post(cookie, { text: 'second' }));
    const empty = await app.app.request(staffUrl(clubB.slug, `/guests/${g.id}/notes`), post(cookie, { text: '   ' }));
    expect(empty.status).toBe(400);
    const rows = await db.select().from(guestNotes);
    expect(rows.map((n) => n.text).sort()).toEqual(['first', 'second']);
    expect(rows.every((n) => n.authorId && n.clubId === clubB.id)).toBe(true);
    const p = (await guestProfile(db, clubB, g.id))!;
    expect(p.notes.map((n) => n.text)).toEqual(['second', 'first']);
    expect(p.notes[0]!.author).toBe('Test host');
  });

  it("another club's guest is 404", async () => {
    const gB = await guest(clubB, { name: 'B guest' });
    expect(await guestProfile(db, clubA, gB.id)).toBeUndefined();
    await expect(addTag(db, clubA.id, gB.id, 'vip', 'u', NOW)).rejects.toMatchObject({ code: 'not_found' });
    await expect(addNote(db, clubA.id, gB.id, 'x', 'u', NOW)).rejects.toMatchObject({ code: 'not_found' });
    const cookie = await staffCookie(app, clubA, 'manager');
    for (const [method, path, body] of [
      ['GET', `/guests/${gB.id}`, undefined],
      ['POST', `/guests/${gB.id}/tags`, { tag: 'vip' }],
      ['DELETE', `/guests/${gB.id}/tags/vip`, undefined],
      ['POST', `/guests/${gB.id}/notes`, { text: 'x' }],
    ] as const) {
      const res = await app.app.request(staffUrl(clubA.slug, path), { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(await db.select().from(guestTags)).toEqual([]);
    expect(await db.select().from(guestNotes)).toEqual([]);
    expect((await searchGuests(db, clubA, { q: 'B guest' })).length).toBe(0);
  });

  it('test guests hidden for a live club', async () => {
    const real = await guest(clubB, { name: 'Real' });
    const test = await guest(clubB, { name: 'Tester', isTest: true });
    expect((await searchGuests(db, clubB, {})).map((g) => g.id)).toEqual([real.id]);
    expect(await guestProfile(db, clubB, test.id)).toBeUndefined();
    // The demo fixture club shows its test guests.
    const demo = await guest(clubA, { name: 'Demo tester', isTest: true });
    expect((await searchGuests(db, clubA, { q: 'demo tester' })).map((g) => g.id)).toEqual([demo.id]);
  });

  it('door role gets 403', async () => {
    const g = await guest(clubB, { name: 'A' });
    const cookie = await staffCookie(app, clubB, 'door');
    const list = await app.app.request(staffUrl(clubB.slug, '/guests'), { headers: { cookie } });
    expect(list.status).toBe(403);
    const tag = await app.app.request(staffUrl(clubB.slug, `/guests/${g.id}/tags`), post(cookie, { tag: 'vip' }));
    expect(tag.status).toBe(403);
  });

  it('weekly report has a VIP section', async () => {
    const vip = await guest(clubB, { name: 'V' });
    const plain = await guest(clubB, { name: 'P' });
    await addTag(db, clubB.id, vip.id, 'vip', 'u', NOW);
    await booking(clubB, vip.id, 'table_b_V1', '2026-11-20', 'completed', 2_000_000);
    await booking(clubB, vip.id, 'table_b_V2', '2026-11-21', 'no_show');
    await booking(clubB, plain.id, 'table_b_S1', '2026-11-20', 'completed', 500_000);
    await booking(clubB, vip.id, 'table_b_V1', '2026-11-27', 'completed'); // next week
    expect(await vipSummary(db, clubB.id, WEEK)).toEqual({ guests: 1, bookings: 2, arrived: 1, spendSatang: 2_000_000 });
    const r = await buildClubReport(db, clubB.id, WEEK);
    expect(r.vip).toEqual({ guests: 1, bookings: 2, arrived: 1, spendSatang: 2_000_000 });
    expect((await buildClubReport(db, clubA.id, WEEK)).vip).toEqual({ guests: 0, bookings: 0, arrived: 0, spendSatang: 0 });
  });
});
