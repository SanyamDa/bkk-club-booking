import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { cancelBooking, holdTable } from '../src/bookings/service.js';
import { joinWaitlist, leaveWaitlist, listWaitlist, runWaitlist, WAITLIST_OFFER_MINUTES } from '../src/bookings/waitlist.js';
import type { Db } from '../src/db/client.js';
import { bookings, events, guests, nights, tables, waitlistEntries, type Club, type Guest } from '../src/db/schema.js';
import { buildScheduler } from '../src/jobs/index.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { adminCookie, staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const config = testConfig({ PUBLIC_URL: 'http://localhost:5173', DEV_SIMULATOR: true });
const STAFF = { type: 'staff' as const, id: 'u1' };

let db: Db;
let close: () => Promise<void>;
let clubA: Club; // demo fixture club: every row is a test row
let clubB: Club; // live club, tables V1, V2 (6–12) and S1, S2 (2–4)
let app: ReturnType<typeof createApp>;
let clock: Date;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  clock = FRIDAY_AFTERNOON;
  app = createApp(config, db, { bot: { now: () => clock, log: () => {} } });
});
afterEach(async () => close());

async function guest(club: Club, o: { isTest?: boolean } = {}): Promise<Guest> {
  const [g] = await db
    .insert(guests)
    .values({ id: newId(), clubId: club.id, lineUserId: `U${newId()}`, displayName: 'G', isTest: o.isTest ?? false })
    .returning();
  return g!;
}

/** A confirmed booking on every active table of the club for the night; returns them by table code. */
async function fillNight(club: Club, nightDate: string, isTest: boolean): Promise<Map<string, string>> {
  const rows = await db.select().from(tables).where(eq(tables.clubId, club.id));
  const out = new Map<string, string>();
  for (const t of rows) {
    const g = await guest(club, { isTest });
    const id = newId();
    await db.insert(bookings).values({
      id, clubId: club.id, refCode: `R${id.slice(0, 10)}`, guestId: g.id, tableId: t.id, nightDate, pax: t.minPax,
      status: 'confirmed', source: 'line', minSpendSatang: 0, depositSatang: 0, isTest,
    });
    out.set(t.code, id);
  }
  return out;
}

const entryOf = async (id: string) => (await db.select().from(waitlistEntries).where(eq(waitlistEntries.id, id)))[0]!;

// ---------- Simulator helpers (demo club) ----------

const req = (path: string, init?: RequestInit) => app.app.request(path, init);
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
let simCookie: Promise<string> | undefined;
beforeEach(() => {
  simCookie = undefined;
});
const simAuth = async () => ({ cookie: await (simCookie ??= adminCookie(app)) });
async function sim(userId: string, body: Record<string, unknown>) {
  const res = await req('/api/dev/demo/event', json({ userId, displayName: 'Ari', ...body }, await simAuth()));
  expect(res.status).toBe(200);
}
async function outs(userId: string): Promise<any[]> {
  const res = await req(`/api/dev/demo/transcript?userId=${userId}`, { headers: await simAuth() });
  return ((await res.json()) as { messages: { direction: string; payload: any }[] }).messages.filter((m) => m.direction === 'out').map((m) => m.payload);
}
const lastOut = async (u: string) => (await outs(u)).at(-1);
const simGuest = async (u: string) => (await db.query.guests.findFirst({ where: and(eq(guests.clubId, clubA.id), eq(guests.lineUserId, `SIM-${u}`)) }))!;

describe('waitlist (B22)', () => {
  it('joining twice keeps one open entry and one waitlist.joined event', async () => {
    const g = await guest(clubB);
    const first = await joinWaitlist(db, clubB, { guestId: g.id, nightDate: FRIDAY, paxRange: '5-8' }, clock);
    const again = await joinWaitlist(db, clubB, { guestId: g.id, nightDate: FRIDAY, paxRange: '2-4' }, clock);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.entry.id).toBe(first.entry.id);
    expect(again.entry.paxRange).toBe('2-4');
    expect(await db.select().from(waitlistEntries).where(eq(waitlistEntries.guestId, g.id))).toHaveLength(1);
    const joined = await db.select().from(events).where(and(eq(events.clubId, clubB.id), eq(events.type, 'waitlist.joined')));
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ guestId: g.id, nightDate: FRIDAY, isTest: false, props: { pax_range: 'p5_8' } });
  });

  it('no-tables reply offers Join waitlist and the tap stores the entry', async () => {
    await fillNight(clubA, FRIDAY, true);
    const u = 'wl1';
    await sim(u, { type: 'text', text: 'book a table' });
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    await sim(u, { type: 'postback', data: 'a=pax&r=5-8' });
    const none = await lastOut(u);
    expect(none.text).toContain('No tables left');
    const chip = none.quickReply.items[0].action;
    expect(chip.label).toBe('Join waitlist');
    expect(chip.data).toBe(`a=waitlist&d=${FRIDAY}&r=5-8`);

    await sim(u, { type: 'postback', data: chip.data });
    expect((await lastOut(u)).text).toContain('on the waitlist');
    const g = await simGuest(u);
    const [entry] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.guestId, g.id));
    expect(entry).toMatchObject({ clubId: clubA.id, nightDate: FRIDAY, paxRange: '5-8', status: 'waiting' });
  });

  it('a sold-out night says fully booked and still asks the party size', async () => {
    await db.insert(nights).values({ id: newId(), clubId: clubA.id, date: FRIDAY, status: 'sold_out' });
    const u = 'wl2';
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    const texts = (await outs(u)).map((m) => m.text ?? '');
    expect(texts.some((t) => t.includes('fully booked'))).toBe(true);
    expect(texts.at(-1)).toContain('How many guests?');
  });

  it('a cancelled booking frees a table and the first waiting guest is offered', async () => {
    const booked = await fillNight(clubA, FRIDAY, true);
    await sim('first', { type: 'postback', data: `a=waitlist&d=${FRIDAY}&r=5-8` });
    clock = new Date(clock.getTime() + 60_000);
    await sim('second', { type: 'postback', data: `a=waitlist&d=${FRIDAY}&r=5-8` });
    const scheduler = buildScheduler(app.ctx, () => clock);
    await scheduler.runOnce('waitlist', clock);
    expect((await lastOut('first')).text).not.toContain('just opened up');

    await cancelBooking(db, clubA.id, booked.get('B1')!, STAFF, { code: 'club_cancelled' }, clock);
    clock = new Date(clock.getTime() + 120_000);
    await scheduler.runOnce('waitlist', clock);
    const offer = await lastOut('first');
    expect(offer.text).toContain('just opened up');
    expect(offer.text).toContain(`${WAITLIST_OFFER_MINUTES} minutes`);
    expect((await lastOut('second')).text).not.toContain('just opened up');
    const firstEntry = (await db.select().from(waitlistEntries).where(eq(waitlistEntries.guestId, (await simGuest('first')).id)))[0]!;
    expect(firstEntry.status).toBe('offered');
    expect(await db.select().from(events).where(and(eq(events.type, 'waitlist.offered'), eq(events.guestId, firstEntry.guestId)))).toHaveLength(1);

    // [Book now] goes to the normal table step with the freed table.
    await sim('first', { type: 'postback', data: offer.quickReply.items[0].action.data });
    const carousel = await lastOut('first');
    expect(carousel.type).toBe('flex');
    expect(carousel.contents.contents).toHaveLength(1);
  });

  it('open offers never exceed free tables and skip entries no free table fits', async () => {
    const booked = await fillNight(clubB, FRIDAY, false);
    const small1 = await guest(clubB);
    const big = await guest(clubB);
    const small2 = await guest(clubB);
    const at = (m: number) => new Date(clock.getTime() - m * 60_000); // join order: small1, big, small2
    const e1 = (await joinWaitlist(db, clubB, { guestId: small1.id, nightDate: FRIDAY, paxRange: '2-4' }, at(3))).entry;
    const e2 = (await joinWaitlist(db, clubB, { guestId: big.id, nightDate: FRIDAY, paxRange: '5-8' }, at(2))).entry;
    const e3 = (await joinWaitlist(db, clubB, { guestId: small2.id, nightDate: FRIDAY, paxRange: '2-4' }, at(1))).entry;

    // V1 (6–12) frees: the 2–4 entries do not fit it, the 5–8 one does.
    await cancelBooking(db, clubB.id, booked.get('V1')!, STAFF, { code: 'club_cancelled' }, clock);
    let offers = await runWaitlist(db, clock);
    expect(offers.map((o) => o.entry.id)).toEqual([e2.id]);

    // S1 frees too: two free tables, one open offer, so one more offer, to the first 2–4 entry.
    await cancelBooking(db, clubB.id, booked.get('S1')!, STAFF, { code: 'club_cancelled' }, clock);
    offers = await runWaitlist(db, clock);
    expect(offers.map((o) => o.entry.id)).toEqual([e1.id]);
    expect((await entryOf(e3.id)).status).toBe('waiting');
    expect(await runWaitlist(db, clock)).toEqual([]);
  });

  it('an offer runs out after 15 minutes and the next guest is offered', async () => {
    const booked = await fillNight(clubB, FRIDAY, false);
    const g1 = await guest(clubB);
    const g2 = await guest(clubB);
    const e1 = (await joinWaitlist(db, clubB, { guestId: g1.id, nightDate: FRIDAY, paxRange: '2-4' }, new Date(clock.getTime() - 60_000))).entry;
    const e2 = (await joinWaitlist(db, clubB, { guestId: g2.id, nightDate: FRIDAY, paxRange: '2-4' }, clock)).entry;
    await cancelBooking(db, clubB.id, booked.get('S1')!, STAFF, { code: 'club_cancelled' }, clock);
    expect((await runWaitlist(db, clock)).map((o) => o.entry.id)).toEqual([e1.id]);
    expect(await runWaitlist(db, new Date(clock.getTime() + 14 * 60_000))).toEqual([]);
    const later = new Date(clock.getTime() + WAITLIST_OFFER_MINUTES * 60_000);
    expect((await runWaitlist(db, later)).map((o) => o.entry.id)).toEqual([e2.id]);
    expect((await entryOf(e1.id)).status).toBe('expired');
  });

  it('a guest who books after joining is marked booked', async () => {
    const booked = await fillNight(clubB, FRIDAY, false);
    const g = await guest(clubB);
    const e = (await joinWaitlist(db, clubB, { guestId: g.id, nightDate: FRIDAY, paxRange: '2-4' }, clock)).entry;
    await cancelBooking(db, clubB.id, booked.get('S1')!, STAFF, { code: 'club_cancelled' }, clock);
    await runWaitlist(db, clock);
    const hold = await holdTable(db, clubB, { guestId: g.id, tableId: 'table_b_S1', nightDate: FRIDAY, pax: 3 }, clock);
    await runWaitlist(db, clock);
    expect(await entryOf(e.id)).toMatchObject({ status: 'booked', bookingId: hold.id });
  });

  it('a waiting guest who books anyway (never offered) is marked booked', async () => {
    const booked = await fillNight(clubB, FRIDAY, false);
    const g = await guest(clubB);
    const e = (await joinWaitlist(db, clubB, { guestId: g.id, nightDate: FRIDAY, paxRange: '2-4' }, clock)).entry;
    await cancelBooking(db, clubB.id, booked.get('S1')!, STAFF, { code: 'club_cancelled' }, clock);
    // The guest books the freed table before the job runs: the entry is still `waiting`.
    expect(await entryOf(e.id)).toMatchObject({ status: 'waiting' });
    const hold = await holdTable(db, clubB, { guestId: g.id, tableId: 'table_b_S1', nightDate: FRIDAY, pax: 3 }, clock);
    const offers = await runWaitlist(db, clock);
    expect(offers.map((o) => o.entry.id)).not.toContain(e.id);
    expect(await entryOf(e.id)).toMatchObject({ status: 'booked', bookingId: hold.id });
  });

  it('test guests are offered only test-side tables', async () => {
    await fillNight(clubB, FRIDAY, false); // the real side is full; the test side is empty
    const real = await guest(clubB);
    const tester = await guest(clubB, { isTest: true });
    await joinWaitlist(db, clubB, { guestId: real.id, nightDate: FRIDAY, paxRange: '2-4' }, clock);
    const te = (await joinWaitlist(db, clubB, { guestId: tester.id, nightDate: FRIDAY, paxRange: '2-4' }, clock)).entry;
    const offers = await runWaitlist(db, clock);
    expect(offers.map((o) => o.entry.id)).toEqual([te.id]);
    const [ev] = await db.select().from(events).where(eq(events.type, 'waitlist.offered'));
    expect(ev!.isTest).toBe(true);
    // A live club's staff list hides the tester.
    expect((await listWaitlist(db, clubB, FRIDAY)).map((r) => r.entry.guestId)).toEqual([real.id]);
  });

  it("leave and staff delete cancel the entry; another club's entry is 404", async () => {
    const gb = await guest(clubB);
    const eb = (await joinWaitlist(db, clubB, { guestId: gb.id, nightDate: FRIDAY, paxRange: '2-4' }, clock)).entry;
    const ga = await guest(clubA);
    const ea = (await joinWaitlist(db, clubA, { guestId: ga.id, nightDate: FRIDAY, paxRange: '2-4' }, clock)).entry;

    const cookie = await staffCookie(app, clubA, 'host');
    const other = await req(staffUrl(clubA.slug, `/waitlist/${eb.id}`), { method: 'DELETE', headers: { cookie } });
    expect(other.status).toBe(404);
    expect((await entryOf(eb.id)).status).toBe('waiting');

    const list = (await (await req(staffUrl(clubA.slug, `/waitlist?date=${FRIDAY}`), { headers: { cookie } })).json()) as any;
    expect(list.entries.map((e: any) => e.id)).toEqual([ea.id]);
    const del = await req(staffUrl(clubA.slug, `/waitlist/${ea.id}`), { method: 'DELETE', headers: { cookie } });
    expect(del.status).toBe(200);
    expect((await entryOf(ea.id)).status).toBe('cancelled');

    expect(await leaveWaitlist(db, clubA.id, eb.id, { type: 'guest' }, clock)).toBeUndefined(); // wrong club
    expect((await leaveWaitlist(db, clubB.id, eb.id, { type: 'guest', id: gb.id }, clock))!.status).toBe('cancelled');
  });

  it('past nights expire', async () => {
    const g = await guest(clubB);
    const e = (await joinWaitlist(db, clubB, { guestId: g.id, nightDate: FRIDAY, paxRange: '2-4' }, clock)).entry;
    await runWaitlist(db, new Date('2026-11-30T08:00:00Z'));
    expect((await entryOf(e.id)).status).toBe('expired');
  });
});
