import { createHmac } from 'node:crypto';
import type { webhook } from '@line/bot-sdk';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable, latestDeposit, recordSlip, requestDeposit, submitDetails } from '../src/bookings/service.js';
import { FakeSlipVerifier, verifySlip } from '../src/bookings/slip-verify.js';
import type { Db } from '../src/db/client.js';
import { handleEvent } from '../src/bot/flow.js';
import { alerts, bookings, deposits, events, messages, platformFlags, rawWebhooks, type Club } from '../src/db/schema.js';
import { DevLineGateway } from '../src/line/gateway.js';
import { fakePaymentGateway, startGatewayDeposit, type PaymentGateway } from '../src/integrations/payments/gateway.js';
import { opnGateway } from '../src/integrations/payments/opn.js';
import { featuresFlagKey } from '../src/platform/features.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let gateway: ReturnType<typeof fakePaymentGateway>;
let app: ReturnType<typeof createApp>;

const RETURN_URL = 'https://example.test/paid';

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  gateway = fakePaymentGateway();
  app = createApp(testConfig(), db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} }, payments: { fake: gateway } });
});
afterEach(async () => {
  await app.settle();
  await close();
});

async function switchOn(club: Club, on = true) {
  const value = { payment_gateway: on };
  await db.insert(platformFlags).values({ key: featuresFlagKey(club.id), value }).onConflictDoUpdate({ target: platformFlags.key, set: { value } });
}

/** A held booking on club B's S1 (deposit ฿2,000) with details given. */
async function heldBooking(club: Club, tableId: string, lineUserId?: string) {
  const guest = await makeGuest(db, { clubId: club.id, lineUserId });
  const b = await holdTable(db, club, { guestId: guest.id, tableId, nightDate: FRIDAY, pax: 2 }, FRIDAY_AFTERNOON);
  await submitDetails(db, club, b.id, { name: 'Guest', phone: '0812345678', nationality: 'TH', pax: 2 }, FRIDAY_AFTERNOON);
  return b;
}

function paidEvent(chargeId: string, o: { amount?: number; currency?: string; clubId?: string; bookingId?: string; eventId?: string; status?: string } = {}) {
  return JSON.stringify({
    object: 'event',
    id: o.eventId ?? `evnt_${chargeId}`,
    key: 'charge.complete',
    data: {
      object: 'charge',
      id: chargeId,
      amount: o.amount ?? 200_000,
      currency: o.currency ?? 'thb',
      status: o.status ?? 'successful',
      metadata: { club_id: o.clubId, booking_id: o.bookingId },
    },
  });
}

async function deliver(body: string, signature: string | undefined, provider = 'fake') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== undefined) headers['x-fake-signature'] = signature;
  return app.app.request(`/webhooks/payments/${provider}`, { method: 'POST', headers, body });
}

async function bookingRow(id: string) {
  return (await db.query.bookings.findFirst({ where: eq(bookings.id, id) }))!;
}

let seq = 0;
/** The guest taps "Confirm & pay deposit" in LINE. */
async function tapConfirm(club: Club, lineUserId: string, bookingId: string) {
  seq += 1;
  const event = {
    type: 'postback',
    mode: 'active',
    timestamp: FRIDAY_AFTERNOON.getTime(),
    webhookEventId: `ev-pay-${seq}`,
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId: lineUserId },
    replyToken: `rt-pay-${seq}`,
    postback: { data: `a=confirm&b=${bookingId}` },
  } as unknown as webhook.Event;
  const before = new Set((await db.select({ id: messages.id }).from(messages)).map((m) => m.id));
  await handleEvent(app.ctx.deps, club, new DevLineGateway(), event);
  const out = await db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.direction, 'out')));
  const sent = out.filter((m) => !before.has(m.id));
  expect(sent).toHaveLength(1);
  return sent[0]!.payload as any;
}

describe('payment gateway (A20b)', () => {
  it('bot sends the gateway payment link when the switch is on, the slip flow when off', async () => {
    await switchOn(clubB);
    const b = await heldBooking(clubB, 'table_b_S1', 'Upay-on');
    const card = await tapConfirm(clubB, 'Upay-on', b.id);
    expect(card.type).toBe('flex');
    const uri: string = card.contents.footer.contents[0].action.uri;
    expect(uri).toBe(`https://pay.fake.test/${gateway.charges[0]!.chargeId}`);
    expect((await latestDeposit(db, b.id))!).toMatchObject({ method: 'gateway', status: 'pending' });
    expect((await bookingRow(b.id)).status).toBe('awaiting_payment');
    // Tapping again re-sends the same charge.
    expect((await tapConfirm(clubB, 'Upay-on', b.id)).contents.footer.contents[0].action.uri).toBe(uri);
    expect(gateway.charges).toHaveLength(1);

    await switchOn(clubB, false);
    const other = await heldBooking(clubB, 'table_b_S2', 'Upay-off');
    const slip = await tapConfirm(clubB, 'Upay-off', other.id);
    expect(slip.type).toBe('text');
    expect((await latestDeposit(db, other.id))!.method).toBe('promptpay_slip');
    expect(gateway.charges).toHaveLength(1);
  });

  it('bad signature is 401 and changes nothing', async () => {
    await switchOn(clubB);
    const b = await heldBooking(clubB, 'table_b_S1');
    const charge = (await startGatewayDeposit(db, clubB, gateway, b.id, RETURN_URL, FRIDAY_AFTERNOON))!;
    const body = paidEvent(charge.chargeId, { clubId: clubB.id, bookingId: b.id });

    expect((await deliver(body, 'not-a-signature')).status).toBe(401);
    expect((await deliver(body, undefined)).status).toBe(401);
    // A signature from another secret is just as bad.
    expect((await deliver(body, fakePaymentGateway('other-secret').sign(body))).status).toBe(401);

    expect((await bookingRow(b.id)).status).toBe('awaiting_payment');
    expect((await latestDeposit(db, b.id))!.status).toBe('pending');
    expect(await db.select().from(rawWebhooks)).toHaveLength(0);
    expect((await deliver(body, gateway.sign(body), 'nope')).status).toBe(404);
  });

  it('paid webhook confirms the deposit once (replay is a no-op)', async () => {
    await switchOn(clubB);
    const b = await heldBooking(clubB, 'table_b_S1');
    const charge = (await startGatewayDeposit(db, clubB, gateway, b.id, RETURN_URL, FRIDAY_AFTERNOON))!;
    expect(charge.payUrl).toContain(charge.chargeId);
    const dep = (await latestDeposit(db, b.id))!;
    expect(dep).toMatchObject({ method: 'gateway', status: 'pending', amountSatang: 200_000, slipTransRef: `fake:${charge.chargeId}` });
    // Tapping again reuses the same charge (idempotent per deposit).
    expect(await startGatewayDeposit(db, clubB, gateway, b.id, RETURN_URL, FRIDAY_AFTERNOON)).toEqual(charge);
    expect(gateway.charges).toHaveLength(1);

    const body = paidEvent(charge.chargeId, { clubId: clubB.id, bookingId: b.id });
    const first = await deliver(body, gateway.sign(body));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, outcome: 'confirmed' });
    const second = await deliver(body, gateway.sign(body));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, outcome: 'already_confirmed' });

    expect((await bookingRow(b.id)).status).toBe('confirmed');
    expect((await latestDeposit(db, b.id))!).toMatchObject({ status: 'verified', verifiedBy: 'payments:fake' });
    const verified = await db.select().from(events).where(and(eq(events.bookingId, b.id), eq(events.type, 'deposit.verified')));
    expect(verified).toHaveLength(1);
    expect(verified[0]!.actorType).toBe('system');
    const raw = await db.select().from(rawWebhooks).where(eq(rawWebhooks.channel, 'payments:fake'));
    expect(raw).toHaveLength(2);
    expect(raw.every((r) => r.signatureOk && r.processedAt && r.clubId === clubB.id)).toBe(true);
  });

  it('a slip sent for a gateway deposit goes to review and keeps the charge reference, so the webhook still confirms', async () => {
    await switchOn(clubB);
    const b = await heldBooking(clubB, 'table_b_S1');
    const charge = (await startGatewayDeposit(db, clubB, gateway, b.id, RETURN_URL, FRIDAY_AFTERNOON))!;
    await recordSlip(db, clubB, b.id, 'slip.jpg', FRIDAY_AFTERNOON);
    const verifier = new FakeSlipVerifier({ transRef: 'BANK-REF-1', amountSatang: 200_000, receiver: { proxy: 'xxx' }, transferredAt: FRIDAY_AFTERNOON });
    const out = await verifySlip(db, clubB, b.id, Buffer.from([0xff, 0xd8, 0xff]), verifier, FRIDAY_AFTERNOON);
    expect(out).toEqual({ verified: false, code: 'gateway_deposit' });
    expect((await latestDeposit(db, b.id))!).toMatchObject({ method: 'gateway', slipTransRef: `fake:${charge.chargeId}`, slipAmountSatang: 200_000 });

    const body = paidEvent(charge.chargeId, { clubId: clubB.id, bookingId: b.id });
    const res = await deliver(body, gateway.sign(body));
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'confirmed' });
    expect((await bookingRow(b.id)).status).toBe('confirmed');
  });

  it('amount mismatch raises an alert and does not confirm', async () => {
    await switchOn(clubB);
    const b = await heldBooking(clubB, 'table_b_S1');
    const charge = (await startGatewayDeposit(db, clubB, gateway, b.id, RETURN_URL, FRIDAY_AFTERNOON))!;

    const short = paidEvent(charge.chargeId, { amount: 100_000, clubId: clubB.id, bookingId: b.id });
    const res = await deliver(short, gateway.sign(short));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'amount_mismatch' });
    const usd = paidEvent(charge.chargeId, { currency: 'usd', clubId: clubB.id, bookingId: b.id, eventId: 'evnt_usd' });
    expect(await (await deliver(usd, gateway.sign(usd))).json()).toMatchObject({ outcome: 'amount_mismatch' });

    expect((await bookingRow(b.id)).status).toBe('awaiting_payment');
    expect((await latestDeposit(db, b.id))!.status).toBe('pending');
    const raised = await db.select().from(alerts).where(and(eq(alerts.clubId, clubB.id), eq(alerts.kind, 'payment_amount_mismatch')));
    expect(raised).toHaveLength(2);
    expect(raised[0]).toMatchObject({ level: 'urgent', bookingId: b.id });
  });

  it("charge for another club's booking is rejected", async () => {
    await switchOn(clubA);
    await switchOn(clubB);
    const bookingB = await heldBooking(clubB, 'table_b_S1');
    // Club A cannot open a charge on club B's booking.
    await expect(startGatewayDeposit(db, clubA, gateway, bookingB.id, RETURN_URL, FRIDAY_AFTERNOON)).rejects.toMatchObject({ code: 'not_found' });
    expect(gateway.charges).toHaveLength(0);
    expect((await bookingRow(bookingB.id)).status).toBe('held');

    // A paid charge of club A's booking whose metadata names club B's booking confirms neither.
    const bookingA = await heldBooking(clubA, 'table_demo_T1');
    const chargeA = (await startGatewayDeposit(db, clubA, gateway, bookingA.id, RETURN_URL, FRIDAY_AFTERNOON))!;
    const depA = (await latestDeposit(db, bookingA.id))!;
    const forged = paidEvent(chargeA.chargeId, { amount: depA.amountSatang, clubId: clubB.id, bookingId: bookingB.id });
    const res = await deliver(forged, gateway.sign(forged));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'charge_mismatch' });
    expect((await bookingRow(bookingA.id)).status).toBe('awaiting_payment');
    expect((await bookingRow(bookingB.id)).status).toBe('held');
    expect((await latestDeposit(db, bookingA.id))!.status).toBe('pending');
    // The provider retries a 409; staff still get one alert.
    expect((await deliver(forged, gateway.sign(forged))).status).toBe(409);
    expect(await db.select().from(alerts).where(eq(alerts.kind, 'payment_charge_mismatch'))).toHaveLength(1);
  });

  it('switch off means slip flow only', async () => {
    const b = await heldBooking(clubB, 'table_b_S1');
    // Default off: no charge, the booking is untouched and the caller keeps the slip flow.
    expect(await startGatewayDeposit(db, clubB, gateway, b.id, RETURN_URL, FRIDAY_AFTERNOON)).toBeNull();
    expect(gateway.charges).toHaveLength(0);
    expect((await bookingRow(b.id)).status).toBe('held');
    await requestDeposit(db, clubB, b.id, FRIDAY_AFTERNOON);
    expect((await latestDeposit(db, b.id))!.method).toBe('promptpay_slip');

    // Switched on then off again: still the slip flow.
    const other = await heldBooking(clubB, 'table_b_S2');
    await switchOn(clubB);
    await switchOn(clubB, false);
    expect(await startGatewayDeposit(db, clubB, gateway, other.id, RETURN_URL, FRIDAY_AFTERNOON)).toBeNull();
    expect(await db.select().from(deposits).where(eq(deposits.method, 'gateway'))).toHaveLength(0);
  });

  it('opn adapter signs and parses like Omise', async () => {
    const secret = Buffer.from('opn-webhook-secret').toString('base64');
    const calls: { url: string; init: RequestInit }[] = [];
    const opn: PaymentGateway = opnGateway({
      secretKey: 'skey_test_123',
      webhookSecret: secret,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ object: 'charge', id: 'chrg_test_1', authorize_uri: 'https://pay.opn.test/chrg_test_1' }), { status: 200 });
      },
    });
    const charge = await opn.createCharge(clubB, { bookingId: 'bk1', depositId: 'dep1', amountSatang: 200_000, returnUrl: RETURN_URL });
    expect(charge).toEqual({ chargeId: 'chrg_test_1', payUrl: 'https://pay.opn.test/chrg_test_1' });
    expect(calls[0]!.url).toBe('https://api.omise.co/charges');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('skey_test_123:').toString('base64')}`);
    expect(headers.get('idempotency-key')).toBe('dep1');
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('amount')).toBe('200000');
    expect(form.get('currency')).toBe('thb');
    expect(form.get('source[type]')).toBe('promptpay');
    expect(form.get('metadata[club_id]')).toBe(clubB.id);
    expect(form.get('metadata[booking_id]')).toBe('bk1');

    const body = paidEvent('chrg_test_1', { clubId: clubB.id, bookingId: 'bk1' });
    const ts = '1764230400';
    const sig = createHmac('sha256', Buffer.from(secret, 'base64')).update(`${ts}.${body}`).digest('hex');
    const header = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];
    const signature = opn.signatureOf(header({ 'omise-signature': `deadbeef,${sig}`, 'omise-signature-timestamp': ts }));
    expect(opn.verifyWebhook(body, signature)).toMatchObject({ chargeId: 'chrg_test_1', status: 'successful', amountSatang: 200_000, currency: 'THB', clubId: clubB.id, bookingId: 'bk1' });
    expect(opn.verifyWebhook(body, opn.signatureOf(header({ 'omise-signature': sig, 'omise-signature-timestamp': '1' })))).toBeNull();
    expect(opn.verifyWebhook(body, undefined)).toBeNull();
  });
});
