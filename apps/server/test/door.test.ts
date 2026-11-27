import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createManualBooking, type Actor } from '../src/bookings/service.js';
import type { Db } from '../src/db/client.js';
import { bookings, doorCounts, events, guests, tables, type Club } from '../src/db/schema.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const STAFF: Actor = { type: 'staff', id: 'test-staff' };

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

async function confirmed(club: Club, opts: { nightDate?: string; pax?: number; name?: string; phone?: string; code?: string } = {}) {
  const all = await db.select().from(tables).where(eq(tables.clubId, club.id));
  const table = all.find((t) => t.code === (opts.code ?? 'V1')) ?? all[0]!;
  return createManualBooking(
    db,
    club,
    { tableId: table.id, nightDate: opts.nightDate ?? FRIDAY, pax: opts.pax ?? table.minPax, name: opts.name ?? 'Door Guest', phone: opts.phone, depositPaid: true },
    STAFF,
    FRIDAY_AFTERNOON,
  );
}

function post(url: string, body: unknown, cookie: string) {
  return app.app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}
const get = (url: string, cookie: string) => app.app.request(url, { headers: { cookie } });
const doorUrl = (club: Club, path = '') => staffUrl(club.slug, `/door${path}`);

describe('door screen (plan B11)', () => {
  it('check-in records arrived_pax and emits booking.checked_in', async () => {
    const b = await confirmed(clubB, { pax: 6 });
    const cookie = await staffCookie(app, clubB, 'door');
    const res = await post(doorUrl(clubB, `/bookings/${b.id}/check-in`), { arrivedPax: 5 }, cookie);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row!.status).toBe('arrived');
    expect(row!.arrivedPax).toBe(5);
    const evs = await db.select().from(events).where(and(eq(events.bookingId, b.id), eq(events.type, 'booking.checked_in')));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.props).toMatchObject({ arrived_pax: 5 });
  });

  it('check-in without a party size records the booked pax', async () => {
    const b = await confirmed(clubB, { pax: 7 });
    const cookie = await staffCookie(app, clubB, 'door');
    expect((await post(doorUrl(clubB, `/bookings/${b.id}/check-in`), {}, cookie)).status).toBe(200);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row!.arrivedPax).toBe(7);
  });

  it("check-in of another club's booking is 404 and changes nothing", async () => {
    const b = await confirmed(clubB);
    const cookie = await staffCookie(app, clubA, 'door');
    const res = await post(doorUrl(clubA, `/bookings/${b.id}/check-in`), { arrivedPax: 2 }, cookie);
    expect(res.status).toBe(404);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row!.status).toBe('confirmed');
    expect(row!.arrivedPax).toBeNull();
  });

  it('check-in of a booking for another night is refused', async () => {
    const b = await confirmed(clubB, { nightDate: '2026-11-28' });
    const cookie = await staffCookie(app, clubB, 'door');
    const res = await post(doorUrl(clubB, `/bookings/${b.id}/check-in`), {}, cookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('wrong_night');
    const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row!.status).toBe('confirmed');
  });

  it('clicker writes door_counts by kind with the user and emits door.count', async () => {
    const cookie = await staffCookie(app, clubB, 'door');
    for (const body of [
      { kind: 'walk_in', delta: 1 },
      { kind: 'walk_in', delta: 1 },
      { kind: 'guestlist', delta: 1 },
      { kind: 'walk_in', delta: -1 },
    ]) {
      expect((await post(doorUrl(clubB, '/count'), body, cookie)).status).toBe(200);
    }
    const rows = await db.select().from(doorCounts).where(eq(doorCounts.clubId, clubB.id));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.nightDate === FRIDAY && r.userId)).toBe(true);
    expect(rows.filter((r) => r.kind === 'walk_in').map((r) => r.delta).sort()).toEqual([-1, 1, 1]);
    const evs = await db.select().from(events).where(and(eq(events.clubId, clubB.id), eq(events.type, 'door.count')));
    expect(evs).toHaveLength(4);
    expect(evs.every((e) => e.channel === 'door' && e.dataOrigin === 'first_party' && e.isTest === false && e.nightDate === FRIDAY)).toBe(true);
    const last = evs.find((e) => (e.props as { count_out: number }).count_out === 1)!;
    expect(last.props).toMatchObject({ kind: 'walk_in', count_in: 0, count_out: 1, total: 2 });
    const screen = (await (await get(doorUrl(clubB), cookie)).json()) as { counts: { byKind: Record<string, number>; total: number } };
    expect(screen.counts).toEqual({ byKind: { table_guest: 0, guestlist: 1, walk_in: 1, ticket: 0 }, total: 2 });

    // A demo club's door events are test rows.
    const demoCookie = await staffCookie(app, clubA, 'door');
    expect((await post(doorUrl(clubA, '/count'), { kind: 'ticket', delta: 1 }, demoCookie)).status).toBe(200);
    const [demo] = await db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, 'door.count')));
    expect(demo!.isTest).toBe(true);
  });

  it('clicker minus never takes a kind below zero', async () => {
    const cookie = await staffCookie(app, clubB, 'door');
    expect((await post(doorUrl(clubB, '/count'), { kind: 'walk_in', delta: 1 }, cookie)).status).toBe(200);
    const res = await post(doorUrl(clubB, '/count'), { kind: 'guestlist', delta: -1 }, cookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('below_zero');
    expect((await post(doorUrl(clubB, '/count'), { kind: 'walk_in', delta: 2 }, cookie)).status).toBe(400);
    expect((await post(doorUrl(clubB, '/count'), { kind: 'vip', delta: 1 }, cookie)).status).toBe(400);
    expect(await db.select().from(doorCounts).where(eq(doorCounts.clubId, clubB.id))).toHaveLength(1);
  });

  it('a repeated clickId writes one row and one event', async () => {
    const cookie = await staffCookie(app, clubB, 'door');
    const body = { kind: 'ticket', delta: 1, clickId: 'c0ffee-1234' };
    expect((await post(doorUrl(clubB, '/count'), body, cookie)).status).toBe(200);
    const again = await post(doorUrl(clubB, '/count'), body, cookie);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { counts: { total: number } }).counts.total).toBe(1);
    expect(await db.select().from(doorCounts).where(eq(doorCounts.clubId, clubB.id))).toHaveLength(1);
    expect(await db.select().from(events).where(and(eq(events.clubId, clubB.id), eq(events.type, 'door.count')))).toHaveLength(1);
  });

  it("find matches the QR ref and the guest name, only in the caller's club", async () => {
    const mine = await confirmed(clubB, { name: 'Somchai Jaidee', phone: '0812345678' });
    await confirmed(clubB, { name: 'Other Person', code: 'S2' });
    const theirs = await confirmed(clubA, { name: 'Somchai Elsewhere' });
    const cookie = await staffCookie(app, clubB, 'door');
    type Found = { results: { id: string; ref: string; guestName: string; table: string; pax: number; status: string }[] };
    const byRef = (await (await get(doorUrl(clubB, `/find?q=${mine.refCode.toLowerCase()}`), cookie)).json()) as Found;
    expect(byRef.results.map((r) => r.id)).toEqual([mine.id]);
    const byName = (await (await get(doorUrl(clubB, '/find?q=somchai'), cookie)).json()) as Found;
    expect(byName.results.map((r) => r.id)).toEqual([mine.id]);
    expect(byName.results[0]).toMatchObject({ ref: mine.refCode, guestName: 'Somchai Jaidee', status: 'confirmed' });
    const byPhone = (await (await get(doorUrl(clubB, '/find?q=2345678'), cookie)).json()) as Found;
    expect(byPhone.results.map((r) => r.id)).toEqual([mine.id]);
    const otherRef = (await (await get(doorUrl(clubB, `/find?q=${theirs.refCode}`), cookie)).json()) as Found;
    expect(otherRef.results).toEqual([]);
  });

  it('find matches the LINE display name of a guest who has a name, and no route sends the phone', async () => {
    const b = await confirmed(clubB, { name: 'Somchai Jaidee', phone: '0812345678' });
    await db.update(guests).set({ displayName: 'NightOwl99' }).where(eq(guests.id, b.guestId));
    const cookie = await staffCookie(app, clubB, 'door');
    const found = (await (await get(doorUrl(clubB, '/find?q=nightowl'), cookie)).json()) as { results: Record<string, unknown>[] };
    expect(found.results.map((r) => r.id)).toEqual([b.id]);
    expect(found.results[0]).toMatchObject({ guestName: 'Somchai Jaidee' });
    expect(found.results[0]).not.toHaveProperty('phone');
    expect(found.results[0]).not.toHaveProperty('displayName');
    const screen = (await (await get(doorUrl(clubB), cookie)).json()) as { arrivals: Record<string, unknown>[] };
    expect(screen.arrivals).toHaveLength(1);
    expect(screen.arrivals[0]).not.toHaveProperty('phone');
    expect(JSON.stringify(screen)).not.toContain('0812345678');
  });

  it("door screen shows tonight's arrivals and counts by kind", async () => {
    const a = await confirmed(clubB, { name: 'Tonight One', pax: 6 });
    const b = await confirmed(clubB, { name: 'Tonight Two', code: 'S1', pax: 2 });
    await confirmed(clubB, { name: 'Tomorrow', nightDate: '2026-11-28' });
    const cookie = await staffCookie(app, clubB, 'door');
    await post(doorUrl(clubB, `/bookings/${a.id}/check-in`), { arrivedPax: 4 }, cookie);
    await post(doorUrl(clubB, '/count'), { kind: 'table_guest', delta: 1 }, cookie);
    const res = await get(doorUrl(clubB), cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nightDate: string;
      arrivals: { id: string; status: string; arrivedPax: number | null; guestName: string; table: string }[];
      counts: { byKind: Record<string, number>; total: number };
    };
    expect(body.nightDate).toBe(FRIDAY);
    expect(body.arrivals.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(body.arrivals.find((x) => x.id === a.id)).toMatchObject({ status: 'arrived', arrivedPax: 4, guestName: 'Tonight One' });
    expect(body.arrivals.find((x) => x.id === b.id)).toMatchObject({ status: 'confirmed', arrivedPax: null, table: 'S1' });
    expect(body.counts).toEqual({ byKind: { table_guest: 1, guestlist: 0, walk_in: 0, ticket: 0 }, total: 1 });
  });

  it('works with a door-role account only: door can use every door route, a promoter gets 403', async () => {
    const b = await confirmed(clubB);
    const door = await staffCookie(app, clubB, 'door');
    expect((await get(doorUrl(clubB), door)).status).toBe(200);
    expect((await get(doorUrl(clubB, '/find?q=Door'), door)).status).toBe(200);
    expect((await post(doorUrl(clubB, '/count'), { kind: 'walk_in', delta: 1 }, door)).status).toBe(200);
    expect((await post(doorUrl(clubB, `/bookings/${b.id}/check-in`), {}, door)).status).toBe(200);

    const promoter = await staffCookie(app, clubB, 'promoter');
    expect((await get(doorUrl(clubB), promoter)).status).toBe(403);
    expect((await get(doorUrl(clubB, '/find?q=Door'), promoter)).status).toBe(403);
    expect((await post(doorUrl(clubB, '/count'), { kind: 'walk_in', delta: 1 }, promoter)).status).toBe(403);
    expect((await post(doorUrl(clubB, `/bookings/${b.id}/check-in`), {}, promoter)).status).toBe(403);
    expect(await db.select().from(doorCounts).where(eq(doorCounts.clubId, clubB.id))).toHaveLength(1);
  });
});
