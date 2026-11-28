import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  addPreorderItem,
  createMenuItem,
  getPreorder,
  MAX_LINES,
  PreorderError,
  preordersForNight,
  setPreorder,
  updateMenuItem,
} from '../src/bookings/preorders.js';
import type { Db } from '../src/db/client.js';
import { bookings, clubs, events, guests, messages, staffGroups, type Club } from '../src/db/schema.js';
import type { LineGateway } from '../src/line/gateway.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { adminCookie, staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const config = testConfig({ PUBLIC_URL: 'http://localhost:5173', DEV_SIMULATOR: true });
const STAFF = { type: 'staff' as const, id: 'u1' };

let db: Db;
let close: () => Promise<void>;
let clubA: Club; // demo fixture club
let clubB: Club; // live club
let app: ReturnType<typeof createApp>;
let clock: Date;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  await db.update(clubs).set({ staffGroupId: 'Cstaff_demo' }).where(eq(clubs.id, clubA.id));
  clubA = (await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!;
  clock = FRIDAY_AFTERNOON;
  app = createApp(config, db, { bot: { now: () => clock, log: () => {} } });
});
afterEach(async () => close());

async function booking(club: Club, o: { tableId?: string; status?: string; isTest?: boolean; guestId?: string; nightDate?: string } = {}) {
  let guestId = o.guestId;
  if (!guestId) {
    guestId = newId();
    await db.insert(guests).values({ id: guestId, clubId: club.id, lineUserId: `U${guestId}`, displayName: 'G', isTest: o.isTest ?? false });
  }
  const id = newId();
  await db.insert(bookings).values({
    id, clubId: club.id, refCode: `R${id.slice(0, 10)}`, guestId, tableId: o.tableId ?? (club.id === clubB.id ? 'table_b_S1' : 'table_demo_B1'),
    nightDate: o.nightDate ?? FRIDAY, pax: 4, status: (o.status ?? 'confirmed') as 'confirmed', source: 'line',
    minSpendSatang: 600_000, depositSatang: 0, isTest: o.isTest ?? false,
  });
  return id;
}

const bottle = (club: Club, name: string, priceSatang: number, active = true) =>
  createMenuItem(db, club.id, { name, nameTh: `${name} TH`, priceSatang, active }, clock);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PreorderError) return err.code;
    throw err;
  }
  return 'ok';
}

// Simulator (demo club).
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
async function lastOut(userId: string): Promise<any> {
  const res = await req(`/api/dev/demo/transcript?userId=${userId}`, { headers: await simAuth() });
  const msgs = ((await res.json()) as { messages: { direction: string; payload: any }[] }).messages.filter((m) => m.direction === 'out');
  return msgs.at(-1)!.payload;
}
async function simBooking(u: string, tableId?: string): Promise<string> {
  await sim(u, { type: 'follow' });
  const g = (await db.query.guests.findFirst({ where: and(eq(guests.clubId, clubA.id), eq(guests.lineUserId, `SIM-${u}`)) }))!;
  return booking(clubA, { guestId: g.id, isTest: true, ...(tableId ? { tableId } : {}) });
}

describe('bottle pre-orders (B22)', () => {
  it('pre-order prices come from the menu and do not change with it', async () => {
    const b = await booking(clubB);
    const goose = await bottle(clubB, 'Grey Goose', 450_000);
    let p = await setPreorder(db, clubB, b, [{ menuItemId: goose.id, qty: 2 }], STAFF, clock);
    expect(p.totalSatang).toBe(900_000);

    await updateMenuItem(db, clubB.id, goose.id, { priceSatang: 500_000 });
    const moet = await bottle(clubB, 'Moet', 500_000);
    p = await addPreorderItem(db, clubB, b, goose.id, 1, STAFF, clock);
    p = await addPreorderItem(db, clubB, b, moet.id, 1, STAFF, clock);
    expect(p.lines.find((l) => l.menuItemId === goose.id)).toMatchObject({ qty: 3, unitPriceSatang: 450_000, lineTotalSatang: 1_350_000 });
    expect(p.lines.find((l) => l.menuItemId === moet.id)).toMatchObject({ qty: 1, unitPriceSatang: 500_000 });
    expect(p.totalSatang).toBe(1_850_000);

    const placed = await db.select().from(events).where(and(eq(events.bookingId, b), eq(events.type, 'preorder.placed')));
    expect(placed).toHaveLength(3);
    expect(placed.map((e) => e.props)).toContainEqual({ item_count: 4, total_satang: 1_850_000 });
  });

  it('items of another club or inactive items are rejected', async () => {
    const b = await booking(clubB);
    const foreign = await bottle(clubA, 'Demo bottle', 100_000);
    const off = await bottle(clubB, 'Off menu', 100_000, false);
    expect(await code(setPreorder(db, clubB, b, [{ menuItemId: foreign.id, qty: 1 }], STAFF, clock))).toBe('bad_item');
    expect(await code(setPreorder(db, clubB, b, [{ menuItemId: off.id, qty: 1 }], STAFF, clock))).toBe('bad_item');
    expect(await code(setPreorder(db, clubB, b, [{ menuItemId: 'nope', qty: 1 }], STAFF, clock))).toBe('bad_item');
    // Another club's booking is not found.
    const a = await booking(clubA);
    expect(await code(setPreorder(db, clubB, a, [], STAFF, clock))).toBe('not_found');
    expect((await getPreorder(db, clubB.id, b)).lines).toEqual([]);
  });

  it('quantity and line limits', async () => {
    const b = await booking(clubB);
    const one = await bottle(clubB, 'One', 100_000);
    expect(await code(setPreorder(db, clubB, b, [{ menuItemId: one.id, qty: 21 }], STAFF, clock))).toBe('too_many');
    expect(await code(setPreorder(db, clubB, b, [{ menuItemId: one.id, qty: 0 }], STAFF, clock))).toBe('bad_item');
    expect(await code(setPreorder(db, clubB, b, [{ menuItemId: one.id, qty: 20 }], STAFF, clock))).toBe('ok');
    expect(await code(addPreorderItem(db, clubB, b, one.id, 1, STAFF, clock))).toBe('too_many');
    const many = [];
    for (let i = 0; i <= MAX_LINES; i++) many.push({ menuItemId: (await bottle(clubB, `B${i}`, 1000)).id, qty: 1 });
    expect(await code(setPreorder(db, clubB, b, many, STAFF, clock))).toBe('too_many');
  });

  it('pre-order closes when the booking is finished or the night passed', async () => {
    const item = await bottle(clubB, 'One', 100_000);
    for (const status of ['cancelled', 'arrived', 'completed', 'no_show']) {
      const finished = await booking(clubB, { status, tableId: 'table_b_V1' }); // `arrived` still holds its table
      expect(await code(setPreorder(db, clubB, finished, [{ menuItemId: item.id, qty: 1 }], STAFF, clock)), status).toBe('invalid_state');
      expect(await code(addPreorderItem(db, clubB, finished, item.id, 1, STAFF, clock)), status).toBe('invalid_state');
    }
    const b = await booking(clubB);
    expect(await code(setPreorder(db, clubB, b, [{ menuItemId: item.id, qty: 1 }], STAFF, new Date('2026-11-29T08:00:00Z')))).toBe('invalid_state');
  });

  it('guest adds bottles in LINE and staff get the summary on Done', async () => {
    const u = 'po1';
    const b = await simBooking(u);
    const goose = await bottle(clubA, 'Grey Goose', 450_000);
    await sim(u, { type: 'postback', data: `a=bottles&b=${b}` });
    const carousel = await lastOut(u);
    expect(carousel.type).toBe('flex');
    expect(carousel.contents.contents).toHaveLength(1);
    const add = carousel.contents.contents[0].footer.contents[0].action.data;
    expect(add).toBe(`a=bottle_add&b=${b}&i=${goose.id}`);

    await sim(u, { type: 'postback', data: add });
    await sim(u, { type: 'postback', data: add });
    const summary = await lastOut(u);
    expect(summary.text).toContain('2× Grey Goose');
    expect(summary.text).toContain('฿9,000');

    await sim(u, { type: 'postback', data: `a=bottle_done&b=${b}` });
    expect((await lastOut(u)).text).toContain('the bar has your pre-order');
    // The staff group gets "Pre-order · table · night · lines · total", with default alert settings.
    const toGroup = await db.select().from(messages).where(and(eq(messages.clubId, clubA.id), eq(messages.target, 'staff')));
    expect(toGroup).toHaveLength(1);
    const groupText = (toGroup[0]!.payload as { text: string }).text;
    expect(groupText).toContain('Pre-order');
    expect(groupText).toContain('B1');
    expect(groupText).toContain('2× Grey Goose');
    expect(groupText).toContain('฿9,000');
    expect(toGroup[0]).toMatchObject({ deliveryStatus: 'sent', sentVia: 'push' });

    // Another guest cannot touch this booking's pre-order.
    await sim('po2', { type: 'postback', data: add });
    expect((await getPreorder(db, clubA.id, b)).lines[0]!.qty).toBe(2);
  });

  it('the pre-order bar note on Done goes to the bookings group (B5b)', async () => {
    await db.insert(staffGroups).values({ id: newId(), clubId: clubA.id, lineGroupId: 'Cbookings', purpose: 'bookings', linkedAt: clock });
    const pushedTo: string[] = [];
    vi.spyOn(app.ctx.gateways.dev as LineGateway, 'push').mockImplementation(async (to: string) => void pushedTo.push(to));
    try {
      const u = 'po_group';
      const b = await simBooking(u);
      const goose = await bottle(clubA, 'Grey Goose', 450_000);
      await sim(u, { type: 'postback', data: `a=bottle_add&b=${b}&i=${goose.id}` });
      await sim(u, { type: 'postback', data: `a=bottle_done&b=${b}` });
      const note = await db.select().from(messages).where(and(eq(messages.clubId, clubA.id), eq(messages.target, 'staff')));
      expect(note).toHaveLength(1);
      expect((note[0]!.payload as { text: string }).text).toContain('Pre-order');
      expect(pushedTo).toContain('Cbookings');
      expect(pushedTo).not.toContain('Cstaff_demo');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('confirmation offers Pre-order bottles only when the club has a menu', async () => {
    const u = 'po3';
    const b = await simBooking(u);
    await sim(u, { type: 'postback', data: 'a=my' });
    expect((await lastOut(u)).type).toBe('flex'); // the confirmation card, nothing after it
    await bottle(clubA, 'Grey Goose', 450_000);
    await sim(u, { type: 'postback', data: 'a=my' });
    const prompt = await lastOut(u);
    expect(prompt.text).toContain('Pre-order');
    expect(prompt.quickReply.items[0].action).toMatchObject({ label: 'Pre-order bottles', data: `a=bottles&b=${b}` });
  });

  it('bot confirmation (no deposit) and staff approve carry Pre-order bottles only with a menu', async () => {
    const outs = async (userId: string) => {
      const res = await req(`/api/dev/demo/transcript?userId=${userId}`, { headers: await simAuth() });
      return ((await res.json()) as { messages: { direction: string; payload: any }[] }).messages.filter((m) => m.direction === 'out').map((m) => m.payload);
    };
    const hasPrompt = (msgs: any[], b: string) =>
      msgs.some((m) => (m.quickReply?.items ?? []).some((i: any) => i.action?.data === `a=bottles&b=${b}`));
    /** A held booking with details done and no deposit: the guest's Confirm tap confirms it. */
    const heldNoDeposit = async (u: string, tableId: string) => {
      const b = await simBooking(u, tableId);
      await db
        .update(bookings)
        .set({ status: 'held', depositSatang: 0, rulesAcceptedAt: clock, holdExpiresAt: new Date(clock.getTime() + 15 * 60_000) })
        .where(eq(bookings.id, b));
      return b;
    };
    const confirmCard = (msgs: any[]) => msgs.findIndex((m) => m.type === 'flex' && String(m.altText).startsWith('You’re booked'));

    // No menu yet: the bot confirmation and the staff approve send no prompt.
    const b1 = await heldNoDeposit('pc1', 'table_demo_B1');
    await sim('pc1', { type: 'postback', data: `a=confirm&b=${b1}` });
    let out = await outs('pc1');
    expect(confirmCard(out)).toBeGreaterThanOrEqual(0);
    expect(hasPrompt(out, b1)).toBe(false);
    const s1 = await simBooking('pc2', 'table_demo_B2');
    await app.ctx.notifier.confirmed(clubA.id, s1);
    out = await outs('pc2');
    expect(confirmCard(out)).toBeGreaterThanOrEqual(0);
    expect(hasPrompt(out, s1)).toBe(false);

    // With an active menu: the prompt goes with the confirmation card on both paths (same send, so no order is asserted).
    await bottle(clubA, 'Grey Goose', 450_000);
    const b2 = await heldNoDeposit('pc3', 'table_demo_B3');
    await sim('pc3', { type: 'postback', data: `a=confirm&b=${b2}` });
    out = await outs('pc3');
    expect(confirmCard(out)).toBeGreaterThanOrEqual(0);
    expect(hasPrompt(out, b2)).toBe(true);
    const s2 = await simBooking('pc4', 'table_demo_B4');
    await app.ctx.notifier.confirmed(clubA.id, s2);
    out = await outs('pc4');
    expect(confirmCard(out)).toBeGreaterThanOrEqual(0);
    expect(hasPrompt(out, s2)).toBe(true);
  });

  it("staff list the night's pre-orders; host cannot edit the menu (403)", async () => {
    const host = await staffCookie(app, clubA, 'host');
    const manager = await staffCookie(app, clubA, 'manager');
    const denied = await req(staffUrl(clubA.slug, '/menu'), { ...json({ name: 'X', nameTh: 'X', priceSatang: 1000 }), headers: { 'content-type': 'application/json', cookie: host } });
    expect(denied.status).toBe(403);
    const created = await req(staffUrl(clubA.slug, '/menu'), { ...json({ name: 'Grey Goose', nameTh: 'เกรย์ กูส', priceSatang: 450_000 }), headers: { 'content-type': 'application/json', cookie: manager } });
    expect(created.status).toBe(200);
    const item = ((await created.json()) as any).item;
    // An empty menu patch is a 400, not a SQL error; a real one changes the item.
    const patch = (body: unknown) =>
      req(staffUrl(clubA.slug, `/menu/${item.id}`), { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: manager }, body: JSON.stringify(body) });
    expect((await patch({})).status).toBe(400);
    expect((await patch({ unknown: 1 })).status).toBe(400);
    const changed = await patch({ priceSatang: 460_000 });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as any).item.priceSatang).toBe(460_000);
    expect(await updateMenuItem(db, clubA.id, item.id, {})).toMatchObject({ id: item.id, priceSatang: 460_000 });
    await patch({ priceSatang: 450_000 });

    const b = await booking(clubA, { isTest: true });
    const put = await req(staffUrl(clubA.slug, `/bookings/${b}/preorder`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: host },
      body: JSON.stringify({ items: [{ menuItemId: item.id, qty: 2 }] }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).preorder.totalSatang).toBe(900_000);

    const night = (await (await req(staffUrl(clubA.slug, `/preorders?date=${FRIDAY}`), { headers: { cookie: host } })).json()) as any;
    expect(night.preorders).toHaveLength(1);
    expect(night.preorders[0]).toMatchObject({ bookingId: b, tableCode: 'B1', preorder: { totalSatang: 900_000 } });

    // Another club's booking is 404 on the caller's own slug.
    const other = await booking(clubB);
    expect((await req(staffUrl(clubA.slug, `/bookings/${other}/preorder`), { headers: { cookie: host } })).status).toBe(404);
  });

  it('test rows hidden for a live club', async () => {
    const item = await bottle(clubB, 'One', 100_000);
    const real = await booking(clubB, { tableId: 'table_b_S1' });
    const test = await booking(clubB, { tableId: 'table_b_S2', isTest: true });
    await setPreorder(db, clubB, real, [{ menuItemId: item.id, qty: 1 }], STAFF, clock);
    await setPreorder(db, clubB, test, [{ menuItemId: item.id, qty: 1 }], STAFF, clock);
    expect((await preordersForNight(db, clubB, FRIDAY)).map((p) => p.bookingId)).toEqual([real]);
    const [ev] = await db.select().from(events).where(and(eq(events.bookingId, test), eq(events.type, 'preorder.placed')));
    expect(ev!.isTest).toBe(true);
  });
});
