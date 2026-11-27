import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expireStaleHolds, holdTable, recordSlip, requestDeposit, submitDetails } from '../src/bookings/service.js';
import {
  FakeSlipVerifier,
  parseSlipOk,
  receiverMatches,
  SlipOkVerifier,
  verifySlip,
  type SlipReading,
} from '../src/bookings/slip-verify.js';
import type { Db } from '../src/db/client.js';
import { bookings, clubs, deposits, events, type Club } from '../src/db/schema.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupTwoClubs>>;
let db: Db;
let club: Club;
let clubA: Club;
const PROMPTPAY = '0812345678';

beforeEach(async () => {
  ctx = await setupTwoClubs();
  db = ctx.db;
  await db.update(clubs).set({ promptpayId: PROMPTPAY }).where(eq(clubs.id, ctx.clubB.id));
  await db.update(clubs).set({ promptpayId: PROMPTPAY }).where(eq(clubs.id, ctx.clubA.id));
  club = (await db.query.clubs.findFirst({ where: eq(clubs.id, ctx.clubB.id) }))!;
  clubA = (await db.query.clubs.findFirst({ where: eq(clubs.id, ctx.clubA.id) }))!;
});
afterEach(async () => {
  await ctx.close();
});

const now = FRIDAY_AFTERNOON;
const min = (i: number) => new Date(now.getTime() + i * 60_000);
const details = { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6 };
const IMAGE = Buffer.from([0xff, 0xd8, 0xff]);

/** A booking of `c` in payment_review with a stored slip; the hold started at `now`. */
async function inReview(c: Club = club, tableId = 'table_b_V1') {
  const g = await makeGuest(db, { clubId: c.id });
  const b = await holdTable(db, c, { guestId: g.id, tableId, nightDate: FRIDAY, pax: 6 }, now);
  await submitDetails(db, c, b.id, details, min(1));
  await requestDeposit(db, c, b.id, min(2));
  await recordSlip(db, c, b.id, `${c.id}/slip.jpg`, min(3));
  return b;
}

function reading(over: Partial<SlipReading> = {}): SlipReading {
  return {
    transRef: 'TXN-0001',
    amountSatang: 800_000,
    receiver: { proxy: 'xxx-xxx-5678', account: null, name: 'Club B' },
    transferredAt: min(2),
    ...over,
  };
}

const statusOf = async (id: string) => (await db.query.bookings.findFirst({ where: eq(bookings.id, id) }))!.status;
const eventsOf = (id: string, type: string) =>
  db.select().from(events).where(and(eq(events.bookingId, id), eq(events.type, type))).orderBy(asc(events.seq));

async function expectReview(bookingId: string, code: string) {
  expect(await statusOf(bookingId)).toBe('payment_review');
  const [ev] = await eventsOf(bookingId, 'slip.review');
  expect(ev!.props).toMatchObject({ code });
  expect(await eventsOf(bookingId, 'slip.auto_verified')).toHaveLength(0);
}

describe('automatic slip verification (B9)', () => {
  it('a slip that passes all four checks confirms the booking and emits slip.auto_verified', async () => {
    const b = await inReview();
    const out = await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier(reading()), min(4));
    expect(out.verified).toBe(true);
    expect(await statusOf(b.id)).toBe('confirmed');
    const dep = (await db.query.deposits.findFirst({ where: eq(deposits.bookingId, b.id) }))!;
    expect(dep).toMatchObject({ status: 'verified', verifiedBy: 'slip:fake', slipTransRef: 'TXN-0001', slipAmountSatang: 800_000, slipReceiver: 'xxx-xxx-5678' });
    const [ev] = await eventsOf(b.id, 'slip.auto_verified');
    expect(ev!.props).toEqual({ depositId: dep.id, provider: 'fake', amount_satang: 800_000 });
    expect(ev!.actorType).toBe('system');
    expect((await eventsOf(b.id, 'booking.confirmed')).length).toBe(1);
  });

  it('amount below the deposit → payment_review', async () => {
    const b = await inReview();
    const out = await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier(reading({ amountSatang: 799_999 })), min(4));
    expect(out).toEqual({ verified: false, code: 'amount_low' });
    await expectReview(b.id, 'amount_low');
  });

  it('receiver not the club PromptPay → payment_review', async () => {
    const b = await inReview();
    const out = await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier(reading({ receiver: { proxy: 'xxx-xxx-9999' } })), min(4));
    expect(out).toEqual({ verified: false, code: 'receiver_mismatch' });
    await expectReview(b.id, 'receiver_mismatch');
  });

  it('transfer before the hold started → payment_review', async () => {
    const b = await inReview();
    const out = await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier(reading({ transferredAt: min(-60) })), min(4));
    expect(out).toEqual({ verified: false, code: 'time_before_hold' });
    await expectReview(b.id, 'time_before_hold');
  });

  it('a transfer inside the clock skew before the hold still passes', async () => {
    const b = await inReview();
    const out = await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier(reading({ transferredAt: min(-2) })), min(4));
    expect(out.verified).toBe(true);
  });

  it('reused ref → payment_review', async () => {
    const first = await inReview(club, 'table_b_V1');
    expect((await verifySlip(db, club, first.id, IMAGE, new FakeSlipVerifier(reading()), min(4))).verified).toBe(true);
    const second = await inReview(club, 'table_b_V2');
    const out = await verifySlip(db, club, second.id, IMAGE, new FakeSlipVerifier(reading()), min(5));
    expect(out).toEqual({ verified: false, code: 'ref_reused' });
    await expectReview(second.id, 'ref_reused');
    const dep = (await db.query.deposits.findFirst({ where: eq(deposits.bookingId, second.id) }))!;
    expect(dep.slipTransRef).toBeNull();
    expect(dep.slipAmountSatang).toBe(800_000);
  });

  it('the same ref at another club is not a reuse', async () => {
    const a = await inReview(clubA, 'table_demo_V1');
    const depA = (await db.query.deposits.findFirst({ where: eq(deposits.bookingId, a.id) }))!;
    await verifySlip(db, clubA, a.id, IMAGE, new FakeSlipVerifier(reading({ amountSatang: depA.amountSatang })), min(4));
    const b = await inReview();
    expect((await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier(reading()), min(5))).verified).toBe(true);
  });

  it('provider timeout → payment_review', async () => {
    const b = await inReview();
    const out = await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier('timeout'), min(4), { timeoutMs: 20 });
    expect(out).toEqual({ verified: false, code: 'provider_timeout' });
    await expectReview(b.id, 'provider_timeout');
  });

  it('provider error or unreadable slip → payment_review', async () => {
    const b = await inReview();
    const out = await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier(new Error('unreadable')), min(4));
    expect(out).toEqual({ verified: false, code: 'provider_error' });
    await expectReview(b.id, 'provider_error');
  });

  it('a slip after the hold expired goes to review even when every check passes', async () => {
    const g = await makeGuest(db, { clubId: club.id });
    const b = await holdTable(db, club, { guestId: g.id, tableId: 'table_b_V1', nightDate: FRIDAY, pax: 6 }, now);
    await submitDetails(db, club, b.id, details, min(1));
    await requestDeposit(db, club, b.id, min(2));
    await expireStaleHolds(db, min(60));
    expect(await statusOf(b.id)).toBe('expired');
    await recordSlip(db, club, b.id, `${club.id}/late.jpg`, min(61));
    const out = await verifySlip(db, club, b.id, IMAGE, new FakeSlipVerifier(reading()), min(61), { lateSlip: true });
    expect(out).toEqual({ verified: false, code: 'late_slip' });
    await expectReview(b.id, 'late_slip');
  });

  it('never rejects: a booking not in review is left alone', async () => {
    const g = await makeGuest(db, { clubId: club.id });
    const b = await holdTable(db, club, { guestId: g.id, tableId: 'table_b_V1', nightDate: FRIDAY, pax: 6 }, now);
    const fake = new FakeSlipVerifier(reading());
    expect(await verifySlip(db, club, b.id, IMAGE, fake, min(1))).toEqual({ verified: false, code: 'not_in_review' });
    expect(fake.calls).toBe(0);
    expect(await statusOf(b.id)).toBe('held');
  });
});

describe('receiver matching', () => {
  it('matches masked and full forms of the club PromptPay id', () => {
    expect(receiverMatches('0812345678', { proxy: 'xxx-xxx-5678' })).toBe(true);
    expect(receiverMatches('0812345678', { proxy: '+66812345678' })).toBe(true);
    expect(receiverMatches('081-234-5678', { account: '0812345678' })).toBe(true);
    expect(receiverMatches('0812345678', { proxy: 'xxx-xxx-5679' })).toBe(false);
    expect(receiverMatches('0812345678', { proxy: 'xxx-xxx-xx78' })).toBe(false); // too few visible digits
    expect(receiverMatches(null, { proxy: '0812345678' })).toBe(false);
  });
});

describe('SlipOK adapter', () => {
  const data = {
    transRef: 'ABC123',
    transDate: '20261127',
    transTime: '15:01:02',
    amount: 8000,
    receiver: { displayName: 'Club', proxy: { value: 'xxx-xxx-5678' }, account: { value: null } },
  };

  it('parses amount in baht and Bangkok time', () => {
    expect(parseSlipOk(data)).toEqual({
      transRef: 'ABC123',
      amountSatang: 800_000,
      receiver: { proxy: 'xxx-xxx-5678', account: null, name: 'Club' },
      transferredAt: new Date('2026-11-27T08:01:02Z'),
    });
  });

  it('posts the image with the key and throws on a failed check (no real network)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new SlipOkVerifier({
      apiKey: 'k',
      branchId: '42',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ success: true, data }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const r = await ok.read(IMAGE, { signal: new AbortController().signal });
    expect(r.transRef).toBe('ABC123');
    expect(calls[0]!.url).toBe('https://api.slipok.com/api/line/apikey/42');
    expect((calls[0]!.init.headers as Record<string, string>)['x-authorization']).toBe('k');

    const bad = new SlipOkVerifier({
      apiKey: 'k',
      branchId: '42',
      fetch: (async () => new Response(JSON.stringify({ success: false, code: 1012 }), { status: 400 })) as unknown as typeof fetch,
    });
    await expect(bad.read(IMAGE, { signal: new AbortController().signal })).rejects.toThrow('slipok');
  });
});
