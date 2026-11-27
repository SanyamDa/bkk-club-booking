import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable } from '../src/bookings/service.js';
import type { Db } from '../src/db/client.js';
import { bookings, deposits, events, platformFlags, posBills, rawWebhooks, tables, type Club } from '../src/db/schema.js';
import { BAD_SIGNATURE_LIMIT_PER_CLUB, BAD_SIGNATURE_LIMIT_PER_IP } from '../src/http/integrations.js';
import { posBillId } from '../src/integrations/pos/csv-import.js';
import { openPosBillAtCheckIn, syncClosedBills } from '../src/integrations/pos/live.js';
import type { LoyverseCredentials } from '../src/integrations/pos/loyverse.js';
import { PAPAYA_SIGNATURE_HEADER, signPapaya, type PapayaCredentials } from '../src/integrations/pos/papaya.js';
import { newId } from '../src/lib/util.js';
import { setClubCredential } from '../src/platform/credentials.js';
import { featuresFlagKey } from '../src/platform/features.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const config = testConfig();
const KEY = config.CREDENTIALS_KEY;
const NOW = new Date('2026-11-27T15:30:00Z'); // 22:30 Bangkok, Friday night

const PAPAYA: PapayaCredentials = {
  vendor: 'papaya',
  outletId: 'OUT-1',
  reservationsKey: 'res_key_1234',
  orderDataKey: 'ord_key_5678',
  webhookSecret: 'whsec_test',
  tableChannels: { B1: 'CH-B1', T1: 'CH-T1' },
};

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
});
afterEach(async () => {
  await close();
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records each request and answers from `reply`. */
function fakeFetch(reply: (url: string) => unknown) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(reply(url)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls };
}

async function arrivedWithDeposit(club: Club, code: string, amountSatang: number, status: 'verified' | 'review' = 'verified') {
  const [table] = await db.select().from(tables).where(and(eq(tables.clubId, club.id), eq(tables.code, code)));
  const guest = await makeGuest(db, { clubId: club.id });
  const b = await holdTable(db, club, { guestId: guest.id, tableId: table!.id, nightDate: FRIDAY, pax: 6 }, FRIDAY_AFTERNOON);
  await db.update(bookings).set({ status: 'arrived', arrivedAt: NOW, holdExpiresAt: null }).where(eq(bookings.id, b.id));
  const depositId = newId();
  await db.insert(deposits).values({ id: depositId, clubId: club.id, bookingId: b.id, amountSatang, method: 'promptpay_slip', status });
  return { booking: b, depositId };
}

/** A17b: live POS sync runs only while the club's `pos_sync` switch is on (default off). */
const setPosSync = (club: Club, on: boolean) =>
  db.insert(platformFlags).values({ key: featuresFlagKey(club.id), value: { pos_sync: on }, updatedBy: 'test' }).onConflictDoUpdate({ target: platformFlags.key, set: { value: { pos_sync: on } } });
const setPos = async (club: Club, secret: object) => {
  await setClubCredential(db, KEY, { clubId: club.id, kind: 'pos', secret, setBy: 'test' }, NOW);
  await setPosSync(club, true);
};
const setPapaya = (club: Club) => setPos(club, PAPAYA);

describe('Papaya live sync (plan A19, spec §11.3 L2/L3)', () => {
  it('deposit at check-in is sent as a prepayment', async () => {
    await setPapaya(clubA);
    const { booking, depositId } = await arrivedWithDeposit(clubA, 'B1', 500_000);
    const papaya = fakeFetch(() => ({ order_id: 'ORD-1' }));

    const result = await openPosBillAtCheckIn(db, KEY, clubA, booking.id, { now: NOW, fetch: papaya.fn });
    expect(result).toEqual({ status: 'opened', ref: 'ORD-1' });

    expect(papaya.calls).toHaveLength(1);
    const call = papaya.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toMatch(/\/v1\/outlets\/OUT-1\/reservations$/);
    expect(call.headers.authorization).toBe('Bearer res_key_1234');
    expect(call.body).toMatchObject({
      reference: booking.refCode,
      channel_id: 'CH-B1',
      guest_count: 6,
      payments: [{ method: 'prepaid', amount: '5000.00', currency: 'THB', reference: depositId }],
    });

    const [bill] = await db.select().from(posBills).where(eq(posBills.clubId, clubA.id));
    expect(bill).toMatchObject({ id: posBillId(clubA.id, 'ORD-1'), bookingId: booking.id, providerBillId: 'ORD-1', tableCode: 'B1', covers: 6 });
    const opened = await db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, 'pos.bill_opened')));
    expect(opened).toHaveLength(1);
    expect(opened[0]!.props).toMatchObject({ billRef: 'ORD-1', prepaidSatang: 500_000 });
  });

  it('an unverified deposit is not sent as a payment', async () => {
    await setPapaya(clubA);
    const { booking } = await arrivedWithDeposit(clubA, 'B1', 500_000, 'review');
    const papaya = fakeFetch(() => ({ order_id: 'ORD-2' }));
    await openPosBillAtCheckIn(db, KEY, clubA, booking.id, { now: NOW, fetch: papaya.fn });
    expect((papaya.calls[0]!.body as { payments: unknown[] }).payments).toEqual([]);

    // Another club's booking id is not found from this club.
    const none = fakeFetch(() => ({}));
    expect(await openPosBillAtCheckIn(db, KEY, clubB, booking.id, { now: NOW, fetch: none.fn })).toEqual({ status: 'skipped', reason: 'not_found' });
    expect(none.calls).toHaveLength(0);
  });

  it('a club without a POS credential is skipped', async () => {
    await setPosSync(clubB, true); // switch on, but no `pos` credential stored
    const { booking } = await arrivedWithDeposit(clubB, 'V1', 300_000);
    const none = fakeFetch(() => ({}));
    expect(await openPosBillAtCheckIn(db, KEY, clubB, booking.id, { now: NOW, fetch: none.fn })).toEqual({ status: 'skipped', reason: 'no_pos' });
    expect(none.calls).toHaveLength(0);
    expect(await db.select().from(posBills).where(eq(posBills.clubId, clubB.id))).toHaveLength(0);
  });

  it('marking a booking arrived through the staff route opens the POS bill with the deposit', async () => {
    await setPapaya(clubA);
    const { booking, depositId } = await arrivedWithDeposit(clubA, 'B1', 500_000);
    await db.update(bookings).set({ status: 'confirmed', arrivedAt: null }).where(eq(bookings.id, booking.id));
    const papaya = fakeFetch(() => ({ order_id: 'ORD-7' }));
    const app = createApp(config, db, { bot: { now: () => NOW, log: () => {} }, posFetch: papaya.fn });
    const cookie = await staffCookie(app, clubA, 'host');
    const res = await app.app.request(staffUrl(clubA.slug, `/bookings/${booking.id}/arrived`), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    await app.settle();
    expect(papaya.calls).toHaveLength(1);
    expect(papaya.calls[0]!.method).toBe('POST');
    expect(papaya.calls[0]!.url).toMatch(/\/reservations$/);
    expect(papaya.calls[0]!.body).toMatchObject({ payments: [{ method: 'prepaid', amount: '5000.00', reference: depositId }] });
    const bills = await db.select().from(posBills).where(eq(posBills.clubId, clubA.id));
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ bookingId: booking.id, providerBillId: 'ORD-7' });
  });

  it('with the pos_sync switch off, check-in sends nothing to the POS', async () => {
    await setPapaya(clubA);
    await setPosSync(clubA, false);
    const { booking } = await arrivedWithDeposit(clubA, 'B1', 500_000);
    const papaya = fakeFetch(() => ({ order_id: 'ORD-3' }));
    expect(await openPosBillAtCheckIn(db, KEY, clubA, booking.id, { now: NOW, fetch: papaya.fn })).toEqual({ status: 'skipped', reason: 'no_pos' });
    expect(papaya.calls).toHaveLength(0);
    expect(await syncClosedBills(db, KEY, clubA, FRIDAY, { now: NOW, fetch: papaya.fn })).toBeNull();
    expect(await db.select().from(posBills).where(eq(posBills.clubId, clubA.id))).toHaveLength(0);
  });

  describe('webhook POST /integrations/pos/papaya/:slug', () => {
    let app: ReturnType<typeof createApp>;
    beforeEach(() => {
      app = createApp(config, db, { bot: { now: () => NOW, log: () => {} } });
    });

    const totalsUpdated = (eventId: string, total: string, closedAt: string | null = null) =>
      JSON.stringify({
        id: eventId,
        type: closedAt ? 'order.closed' : 'order.totalsUpdated',
        created_at: NOW.toISOString(),
        data: { order: { id: 'ORD-1', channel_id: 'CH-B1', guest_count: 6, opened_at: NOW.toISOString(), closed_at: closedAt, total } },
      });
    const post = (slug: string, body: string, signature: string) =>
      app.app.request(`/integrations/pos/papaya/${slug}`, { method: 'POST', headers: { 'content-type': 'application/json', [PAPAYA_SIGNATURE_HEADER]: signature }, body });

    it('repeated webhook updates totals once', async () => {
      await setPapaya(clubA);
      const { booking } = await arrivedWithDeposit(clubA, 'B1', 500_000);
      await openPosBillAtCheckIn(db, KEY, clubA, booking.id, { now: NOW, fetch: fakeFetch(() => ({ order_id: 'ORD-1' })).fn });

      const body = totalsUpdated('evt_1', '12450.00');
      const first = await post(clubA.slug, body, signPapaya(body, PAPAYA.webhookSecret));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true, applied: 'updated' });
      const again = await post(clubA.slug, body, signPapaya(body, PAPAYA.webhookSecret));
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, applied: 'unchanged' });

      const rows = await db.select().from(posBills).where(eq(posBills.clubId, clubA.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ bookingId: booking.id, totalSatang: 1_245_000 });
      const updated = await db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, 'pos.bill_updated')));
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ bookingId: booking.id, dataOrigin: 'pos', nightDate: FRIDAY });

      // A later delivery with a new total and the bill closed is applied.
      const closed = totalsUpdated('evt_2', '18000.00', '2026-11-27T19:00:00Z');
      expect(await (await post(clubA.slug, closed, signPapaya(closed, PAPAYA.webhookSecret))).json()).toEqual({ ok: true, applied: 'updated' });
      const [bill] = await db.select().from(posBills).where(eq(posBills.clubId, clubA.id));
      expect(bill).toMatchObject({ totalSatang: 1_800_000, closedAt: new Date('2026-11-27T19:00:00Z') });
      const closedEvents = await db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, 'pos.bill_closed')));
      expect(closedEvents).toHaveLength(1);
      expect(await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubA.id))).toHaveLength(3);
    });

    it('bad signature refused', async () => {
      await setPapaya(clubA);
      const body = totalsUpdated('evt_1', '12450.00');
      const res = await post(clubA.slug, body, signPapaya(body, 'not_the_secret'));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'bad_signature' });
      const missing = await app.app.request(`/integrations/pos/papaya/${clubA.slug}`, { method: 'POST', body });
      expect(missing.status).toBe(401);
      expect(await db.select().from(posBills).where(eq(posBills.clubId, clubA.id))).toHaveLength(0);
      const raws = await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubA.id));
      expect(raws).toHaveLength(2);
      expect(raws.every((r) => r.signatureOk === false && r.processedAt === null)).toBe(true);
      // An unsigned delivery's body is never stored, only a summary.
      for (const r of raws) expect(r.body).toEqual({ rejected: 'bad_signature', bytes: body.length });
    });

    it('bad-signature deliveries are rate limited per club and IP', async () => {
      await setPapaya(clubA);
      const body = totalsUpdated('evt_1', '1.00');
      const send = (ip: string) =>
        app.app.request(`/integrations/pos/papaya/${clubA.slug}`, { method: 'POST', headers: { 'x-forwarded-for': ip, [PAPAYA_SIGNATURE_HEADER]: 'sha256=00' }, body });
      for (let i = 0; i < BAD_SIGNATURE_LIMIT_PER_IP; i++) expect((await send('203.0.113.1')).status).toBe(401);
      expect((await send('203.0.113.1')).status).toBe(429);
      expect(await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubA.id))).toHaveLength(BAD_SIGNATURE_LIMIT_PER_IP);
      // Rotating the IP still hits the per-club cap.
      for (let i = 0; i < BAD_SIGNATURE_LIMIT_PER_CLUB; i++) await send(`198.51.100.${i}`);
      expect(await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubA.id))).toHaveLength(BAD_SIGNATURE_LIMIT_PER_CLUB);
    });

    it('a signed body of literal null is stored and ignored, not a 500', async () => {
      await setPapaya(clubA);
      const res = await post(clubA.slug, 'null', signPapaya('null', PAPAYA.webhookSecret));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, applied: 'ignored' });
      const [raw] = await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubA.id));
      expect(raw!.body).toEqual({ unparsed: 'null' });
    });

    it('a club with no Papaya credential, or an unknown slug, gets 404', async () => {
      const body = totalsUpdated('evt_1', '1.00');
      expect((await post(clubA.slug, body, signPapaya(body, PAPAYA.webhookSecret))).status).toBe(404);
      expect((await post('nope', body, signPapaya(body, PAPAYA.webhookSecret))).status).toBe(404);
    });
  });

  it('pulls closed orders of a night with the Order Data key and maps channels to table codes', async () => {
    await setPapaya(clubA);
    const papaya = fakeFetch((url) =>
      url.includes('page=1')
        ? { data: [{ id: 'ORD-9', channel_id: 'CH-T1', guest_count: 2, opened_at: '2026-11-27T14:00:00Z', closed_at: '2026-11-27T17:00:00Z', total: '3200.50' }], next_page: 2 }
        : { data: [{ id: 'ORD-10', table_name: 'BAR', closed_at: '2026-11-27T18:00:00Z', total: 450 }], next_page: null },
    );
    const result = await syncClosedBills(db, KEY, clubA, FRIDAY, { now: NOW, fetch: papaya.fn });
    expect(result).toMatchObject({ imported: 2, created: 2 });
    expect(papaya.calls.every((c) => c.headers.authorization === 'Bearer ord_key_5678')).toBe(true);
    expect(papaya.calls[0]!.url).toContain('status=closed');
    const byRef = new Map((await db.select().from(posBills).where(eq(posBills.clubId, clubA.id))).map((b) => [b.providerBillId, b]));
    expect(byRef.get('ORD-9')).toMatchObject({ tableCode: 'T1', covers: 2, totalSatang: 320_050 });
    expect(byRef.get('ORD-10')).toMatchObject({ tableCode: 'BAR', totalSatang: 45_000 });
  });
});

describe('Loyverse closed receipts pull (plan A19, spec §11.3 L1)', () => {
  it('pulls paid receipts of the night across pages, skipping refunds and cancelled receipts', async () => {
    const creds: LoyverseCredentials = { vendor: 'loyverse', token: 'lv_token_abcd' };
    await setPos(clubA, creds);
    const loyverse = fakeFetch((url) =>
      url.includes('cursor=')
        ? { receipts: [{ receipt_number: '1-1003', receipt_type: 'SALE', receipt_date: '2026-11-27T19:10:00Z', total_money: 900, order: 'T1' }] }
        : {
            receipts: [
              { receipt_number: '1-1001', receipt_type: 'SALE', receipt_date: '2026-11-27T18:00:00Z', total_money: 18450, order: 'B1' },
              { receipt_number: '1-1002', receipt_type: 'REFUND', receipt_date: '2026-11-27T18:05:00Z', total_money: 100 },
              { receipt_number: '1-1004', receipt_type: 'SALE', receipt_date: '2026-11-27T18:10:00Z', total_money: 50, cancelled_at: '2026-11-27T18:11:00Z' },
            ],
            cursor: 'next1',
          },
    );
    const result = await syncClosedBills(db, KEY, clubA, FRIDAY, { now: NOW, fetch: loyverse.fn });
    expect(result).toMatchObject({ imported: 2, created: 2 });
    expect(loyverse.calls).toHaveLength(2);
    expect(loyverse.calls[0]!.url).toMatch(/^https:\/\/api\.loyverse\.com\/v1\.0\/receipts\?/);
    expect(loyverse.calls[0]!.headers.authorization).toBe('Bearer lv_token_abcd');
    expect(loyverse.calls[1]!.url).toContain('cursor=next1');
    const rows = await db.select().from(posBills).where(eq(posBills.clubId, clubA.id));
    expect(rows.map((r) => r.providerBillId).sort()).toEqual(['1-1001', '1-1003']);
    expect(rows.find((r) => r.providerBillId === '1-1001')).toMatchObject({ tableCode: 'B1', totalSatang: 1_845_000, openedAt: null });
  });

  it('Loyverse cannot open bills: check-in is skipped', async () => {
    await setPos(clubA, { vendor: 'loyverse', token: 't' });
    const { booking } = await arrivedWithDeposit(clubA, 'B1', 500_000);
    const f = fakeFetch(() => ({}));
    expect(await openPosBillAtCheckIn(db, KEY, clubA, booking.id, { now: NOW, fetch: f.fn })).toEqual({ status: 'skipped', reason: 'not_supported' });
    expect(f.calls).toHaveLength(0);
  });
});
