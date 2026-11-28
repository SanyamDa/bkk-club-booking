import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createManualBooking, holdTable, markArrived, recordSlip, requestDeposit, submitDetails } from '../src/bookings/service.js';
import { bookings, deposits, events, messages } from '../src/db/schema.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

/** §6.2 Bookings and Payments: search, change, cancel with forfeit, detail, slips and the deposit CSV. */
const STAFF = { type: 'staff' as const, id: 'user_sb' };
const SATURDAY = '2026-11-28';
let ctx: Awaited<ReturnType<typeof setupTwoClubs>>;
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeEach(async () => {
  ctx = await setupTwoClubs();
  app = createApp(testConfig(), ctx.db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
  cookie = await staffCookie(app, ctx.clubA);
});
afterEach(async () => {
  await ctx.close();
});

const call = (method: string, path: string, body?: unknown) =>
  app.app.request(staffUrl(ctx.clubA.slug, path), {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const manual = (over: Record<string, unknown> = {}) =>
  createManualBooking(ctx.db, ctx.clubA, { tableId: 'table_demo_B1', nightDate: FRIDAY, pax: 4, name: 'Ari Test', phone: '0812345678', depositPaid: true, ...over }, STAFF, FRIDAY_AFTERNOON);
const bookingOf = async (id: string) => (await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, id) }))!;

describe('booking search (§6.2)', () => {
  it('filters by night, status, zone, source and text, only within the club', async () => {
    const a = await manual();
    const b = await manual({ tableId: 'table_demo_V1', nightDate: SATURDAY, pax: 8, name: 'Bo Walk', source: 'manual_walkin' });
    await createManualBooking(ctx.db, ctx.clubB, { tableId: 'table_b_S1', nightDate: FRIDAY, pax: 2, name: 'Other Club', depositPaid: false }, STAFF, FRIDAY_AFTERNOON);
    const ids = async (q: string) => ((await (await call('GET', `/bookings${q}`)).json()) as any).bookings.map((x: any) => x.id);
    expect((await ids('')).sort()).toEqual([a.id, b.id].sort());
    expect(await ids(`?night=${FRIDAY}`)).toEqual([a.id]);
    expect(await ids('?source=manual_walkin')).toEqual([b.id]);
    expect(await ids('?status=confirmed&q=walk')).toEqual([b.id]);
    expect(await ids(`?q=${a.refCode}`)).toEqual([a.id]);
    const vZone = (await ctx.db.query.tables.findFirst({ where: (t, { eq }) => eq(t.id, 'table_demo_V1') }))!.zoneId;
    expect(await ids(`?zone=${vZone}`)).toEqual([b.id]);
    expect((await call('GET', '/bookings?status=bogus')).status).toBe(400);
  });
});

describe('booking changes (§6.2)', () => {
  it('changes party size, table, night and notes through the booking service', async () => {
    const b = await manual();
    expect((await call('POST', `/bookings/${b.id}/change`, { pax: 6, notes: 'VIP friend' })).status).toBe(200);
    expect(await bookingOf(b.id)).toMatchObject({ pax: 6, notes: 'VIP friend' });
    expect((await call('POST', `/bookings/${b.id}/change`, { tableId: 'table_demo_B2', nightDate: SATURDAY })).status).toBe(200);
    expect(await bookingOf(b.id)).toMatchObject({ tableId: 'table_demo_B2', nightDate: SATURDAY, status: 'confirmed' });
    const changed = await ctx.db.select().from(events).where(and(eq(events.bookingId, b.id), eq(events.type, 'booking.changed')));
    expect(changed.map((e) => (e.props as { field: string }).field).sort()).toEqual(['night', 'notes', 'pax', 'table']);
    // Too many for the table, a taken table, and another club's booking.
    expect((await call('POST', `/bookings/${b.id}/change`, { pax: 99 })).status).toBe(409);
    const other = await manual({ tableId: 'table_demo_B1', nightDate: SATURDAY });
    expect((await call('POST', `/bookings/${b.id}/change`, { tableId: other.tableId })).status).toBe(409);
    const foreign = await createManualBooking(ctx.db, ctx.clubB, { tableId: 'table_b_S1', nightDate: FRIDAY, pax: 2, name: 'X', depositPaid: false }, STAFF, FRIDAY_AFTERNOON);
    expect((await call('POST', `/bookings/${foreign.id}/change`, { pax: 3 })).status).toBe(404);
  });

  it('cancel can forfeit the deposit or mark it refunded', async () => {
    const keep = await manual();
    const refund = await manual({ tableId: 'table_demo_B2' });
    expect((await call('POST', `/bookings/${keep.id}/cancel`, { deposit: 'forfeit', reason: 'No call' })).status).toBe(200);
    expect((await call('POST', `/bookings/${refund.id}/cancel`, { deposit: 'refund' })).status).toBe(200);
    const dep = async (id: string) => (await ctx.db.query.deposits.findFirst({ where: eq(deposits.bookingId, id) }))!.status;
    expect(await dep(keep.id)).toBe('forfeited');
    expect(await dep(refund.id)).toBe('refunded_manual');
  });

  it('detail carries status history, rules version, chat summary and audit trail', async () => {
    const b = await manual();
    await markArrived(ctx.db, ctx.clubA.id, b.id, STAFF, FRIDAY_AFTERNOON, 4);
    const body = (await (await call('GET', `/bookings/${b.id}`)).json()) as any;
    expect(body.history.map((h: any) => [h.from, h.to])).toEqual([[null, 'confirmed'], ['confirmed', 'arrived']]);
    expect(body.history[1]).toMatchObject({ actorType: 'staff', actorId: STAFF.id });
    expect(body.audit.map((a: any) => a.action)).toEqual(['status:confirmed', 'status:arrived']);
    expect(body.booking).toHaveProperty('rulesVersion');
    expect(body.chatSummary).toMatchObject({ handoffs: [] });
  });
});

describe('manual booking source and LINE confirmation (§6.2, §9)', () => {
  it('stores manual_phone or manual_walkin, and confirms in LINE for a linked guest', async () => {
    const phone = ((await (await call('POST', '/bookings', { tableId: 'table_demo_B1', nightDate: FRIDAY, pax: 4, name: 'Ari' })).json()) as any).id;
    expect((await bookingOf(phone)).source).toBe('manual_phone');
    const walk = ((await (await call('POST', '/bookings', { tableId: 'table_demo_B2', nightDate: FRIDAY, pax: 4, name: 'Bo', kind: 'walkin' })).json()) as any).id;
    expect((await bookingOf(walk)).source).toBe('manual_walkin');

    const g = await makeGuest(ctx.db, { clubId: ctx.clubA.id });
    const res = (await (
      await call('POST', '/bookings', { tableId: 'table_demo_B3', nightDate: FRIDAY, pax: 4, name: 'Line Guest', guestId: g.id, sendLineConfirmation: true })
    ).json()) as any;
    expect(res.lineConfirmationSent).toBe(true);
    expect((await bookingOf(res.id)).guestId).toBe(g.id);
    const out = await ctx.db.select().from(messages).where(and(eq(messages.guestId, g.id), eq(messages.direction, 'out')));
    expect(out.length).toBeGreaterThan(0);
    // Another club's guest is refused.
    const foreign = await makeGuest(ctx.db, { clubId: ctx.clubB.id });
    expect((await call('POST', '/bookings', { tableId: 'table_demo_B4', nightDate: FRIDAY, pax: 4, name: 'X', guestId: foreign.id })).status).toBe(409);
  });
});

describe('payments (§6.2)', () => {
  it('lists slips in review with amount read against expected, and exports deposits as CSV', async () => {
    const g = await makeGuest(ctx.db, { clubId: ctx.clubA.id });
    const held = await holdTable(ctx.db, ctx.clubA, { guestId: g.id, tableId: 'table_demo_V1', nightDate: FRIDAY, pax: 8 }, FRIDAY_AFTERNOON);
    await submitDetails(ctx.db, ctx.clubA, held.id, { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 8 }, FRIDAY_AFTERNOON);
    await requestDeposit(ctx.db, ctx.clubA, held.id, FRIDAY_AFTERNOON);
    await recordSlip(ctx.db, ctx.clubA, held.id, 'slips/x.jpg', FRIDAY_AFTERNOON);
    await ctx.db.update(deposits).set({ slipAmountSatang: 100_000, note: 'amount_mismatch' }).where(eq(deposits.bookingId, held.id));
    const { payments } = (await (await call('GET', '/payments')).json()) as any;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ bookingId: held.id, amountRead: '฿1,000', amountMatches: false, problem: 'amount_mismatch', hasSlip: true });

    await manual();
    const csv = await call('GET', `/payments/deposits.csv?from=${FRIDAY}&to=${FRIDAY}`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const lines = (await csv.text()).trim().split('\r\n');
    expect(lines[0]).toBe('night,booking_ref,table,booking_status,deposit_status,method,expected_thb,slip_amount_thb,slip_received_at,verified_at,verified_by');
    expect(lines).toHaveLength(3);
    const host = await staffCookie(app, ctx.clubA, 'host');
    expect((await app.app.request(staffUrl(ctx.clubA.slug, '/payments/deposits.csv'), { headers: { cookie: host } })).status).toBe(403);
  });
});
