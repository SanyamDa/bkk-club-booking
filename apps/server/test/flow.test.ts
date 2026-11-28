import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { detectIntent } from '../src/bot/intents.js';
import { processEvent } from '../src/bot/flow.js';
import { FakeSlipVerifier } from '../src/bookings/slip-verify.js';
import { isNightOpen } from '../src/bookings/service.js';
import { alerts, bookings, clubs, conversations, events, guests, notices, removalRequests, tables } from '../src/db/schema.js';
import { hasMarketingOptOut } from '../src/data/removal.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupDb } from './helpers.js';
import { adminCookie, staffCookie as loginStaff, staffUrl, testConfig } from './helpers/track-a.js';

const config = testConfig({ PUBLIC_URL: 'http://localhost:5173', DEV_SIMULATOR: true });

// Smallest valid JPEG header is enough: the bot sniffs magic bytes.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString('base64');

type Msg = { direction: 'in' | 'out'; kind: string; payload: any };

let ctx: Awaited<ReturnType<typeof setupDb>>;
let app: ReturnType<typeof createApp>;
let clock: Date;

beforeEach(async () => {
  ctx = await setupDb();
  clock = FRIDAY_AFTERNOON;
  app = createApp(config, ctx.db, { bot: { now: () => clock, log: () => {} } });
});
afterEach(async () => {
  await ctx.close();
});

const req = (path: string, init?: RequestInit) => app.app.request(path, init);
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// B8: the simulator needs a platform-admin session; one admin login per test (the clock never moves).
let simCookie: Promise<string> | undefined;
beforeEach(() => {
  simCookie = undefined;
});
const simAuth = async () => ({ cookie: await (simCookie ??= adminCookie(app)) });

async function sim(userId: string, body: Record<string, unknown>) {
  const res = await req('/api/dev/demo/event', json({ userId, displayName: 'Ari', ...body }, await simAuth()));
  expect(res.status).toBe(200);
}
async function transcript(userId: string): Promise<Msg[]> {
  const res = await req(`/api/dev/demo/transcript?userId=${userId}`, { headers: await simAuth() });
  return ((await res.json()) as { messages: Msg[] }).messages;
}
async function lastOut(userId: string): Promise<any> {
  const out = (await transcript(userId)).filter((m) => m.direction === 'out');
  return out[out.length - 1]!.payload;
}
const staffCookie = () => loginStaff(app, ctx.club);
async function convOf(userId: string) {
  const g = (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, `SIM-${userId}`) }))!;
  return (await ctx.db.query.conversations.findFirst({ where: eq(conversations.guestId, g.id) }))!;
}

describe('guest booking flow over LINE', () => {
  it('a guest with an upcoming booking who blocks the OA is flagged to the host (spec §5.3)', async () => {
    const u = 'blocker';
    await sim(u, { type: 'text', text: 'book' });
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    await sim(u, { type: 'postback', data: 'a=pax&r=2-4' });
    await sim(u, { type: 'postback', data: `a=table&t=table_demo_T1&d=${FRIDAY}` });
    const g = (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, `SIM-${u}`) }))!;
    const [b] = await ctx.db.select().from(bookings).where(eq(bookings.guestId, g.id));
    // The simulator has no unfollow; the event goes straight through the bot as a LINE webhook would.
    await processEvent(app.ctx.deps, ctx.club, app.ctx.gateways.dev, {
      type: 'unfollow',
      mode: 'active',
      timestamp: clock.getTime(),
      webhookEventId: 'evt-unfollow-1',
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId: `SIM-${u}` },
    } as never);
    const flagged = await ctx.db.select().from(alerts).where(and(eq(alerts.kind, 'guest_unfollowed'), eq(alerts.bookingId, b!.id)));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.textEn).toContain("can't be messaged");
    const cookie = await staffCookie();
    const detail = (await (await req(staffUrl(ctx.club.slug, `/bookings/${b!.id}`), { headers: { cookie } })).json()) as any;
    expect(detail.guest.unfollowedAt).not.toBeNull();
    const night = (await (await req(staffUrl(ctx.club.slug, `/night?date=${FRIDAY}`), { headers: { cookie } })).json()) as any;
    expect(night.bookings.find((x: { id: string }) => x.id === b!.id).unfollowedAt).not.toBeNull();
  });

  it('max bookings per guest per night: another night is bookable, the same night is not (spec §7.2)', async () => {
    const u = 'pernight';
    await sim(u, { type: 'follow' });
    const g = (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, `SIM-${u}`) }))!;
    await ctx.db.insert(bookings).values({
      id: 'bk_pernight', clubId: ctx.club.id, refCode: 'VL-PN1', guestId: g.id, tableId: 'table_demo_B1', nightDate: FRIDAY, pax: 4,
      status: 'confirmed', source: 'line', minSpendSatang: 0, depositSatang: 0,
    });
    await sim(u, { type: 'text', text: 'book a table' });
    const already = await lastOut(u);
    expect(already.text).toContain('You already have a booking');
    const other = already.quickReply.items.find((i: { action: { data?: string } }) => i.action.data?.startsWith('a=book_other'));
    expect(other).toBeTruthy();
    await sim(u, { type: 'postback', data: other.action.data });
    expect((await lastOut(u)).text).toBe('Which night would you like to book?');
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    expect(JSON.stringify(await transcript(u))).toContain('You already have a booking on');
    const rejected = await ctx.db.select().from(events).where(eq(events.type, 'night.rejected'));
    expect(rejected.map((e) => e.props)).toEqual([{ reason: 'guest_limit' }]);
    await sim(u, { type: 'postback', data: 'a=night&d=2026-11-28' });
    expect((await convOf(u)).state.nightDate).toBe('2026-11-28');

    // The limit is the club's: two a night lets the same night through.
    await ctx.db.update(clubs).set({ settings: { ...ctx.club.settings, maxBookingsPerGuestPerNight: 2 } }).where(eq(clubs.id, ctx.club.id));
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    expect((await convOf(u)).state.nightDate).toBe(FRIDAY);
  });

  it('the same-night cut-off hour is the club setting (spec §7.2)', async () => {
    const at0130 = new Date('2026-11-27T18:30:00Z'); // 01:30 Bangkok, still Friday night
    expect(await isNightOpen(ctx.db, ctx.club, FRIDAY, at0130)).toBe(false); // default cut-off 01:00
    const later = { ...ctx.club, settings: { ...ctx.club.settings, sameNightCutoffHour: 2 } };
    expect(await isNightOpen(ctx.db, later, FRIDAY, at0130)).toBe(true);
  });

  it('table cards offer [See floor plan]; the page shows free and taken tables with no guest data (spec §5.2 step 3)', async () => {
    await ctx.db.update(tables).set({ floorX: 0.2, floorY: 0.3 }).where(eq(tables.clubId, ctx.club.id));
    await sim('floorother', { type: 'follow' });
    const other = (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, 'SIM-floorother') }))!;
    await ctx.db.insert(bookings).values({
      id: 'bk_floor', clubId: ctx.club.id, refCode: 'VL-FL1', guestId: other.id,
      tableId: 'table_demo_T1', nightDate: FRIDAY, pax: 2, status: 'confirmed', source: 'line', minSpendSatang: 0, depositSatang: 0,
    });
    const u = 'floorguest';
    await sim(u, { type: 'text', text: 'book' });
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    await sim(u, { type: 'postback', data: 'a=pax&r=2-4' });
    const carousel = await lastOut(u);
    const chip = carousel.quickReply.items.find((i: { action: { label: string } }) => i.action.label === 'See floor plan');
    expect(chip.action.uri).toBe(`http://localhost:5173/liff/floor?club=${ctx.club.slug}&d=${FRIDAY}`);

    const res = await req(`/api/liff/floor?club=${ctx.club.slug}&d=${FRIDAY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: { code: string; free: boolean; x: number }[] };
    expect(body.tables.find((t) => t.code === 'T1')!.free).toBe(false);
    expect(body.tables.find((t) => t.code === 'V1')!.free).toBe(true);
    expect(JSON.stringify(body)).not.toContain('VL-FL1');
    expect((await req(`/api/liff/floor?club=${ctx.club.slug}&d=bad`)).status).toBe(400);
  });

  it('the menu has a Thai/English switch that sets the guest language (spec §5.3)', async () => {
    const u = 'langguest';
    await sim(u, { type: 'text', text: 'menu' });
    const items = ((await lastOut(u)).quickReply?.items ?? []) as { action: { label: string; data?: string } }[];
    const sw = items.find((i) => i.action.data?.startsWith('a=lang'));
    expect(sw?.action.label).toBe('ภาษาไทย');
    await sim(u, { type: 'postback', data: sw!.action.data! });
    const g = await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, `SIM-${u}`) });
    expect(g!.lang).toBe('th');
    const after = await lastOut(u);
    expect(after.text).toBe('เลือกสิ่งที่ต้องการได้เลย:');
    expect(after.quickReply.items.some((i: { action: { label: string } }) => i.action.label === 'English')).toBe(true);
  });

  it('goes from "book a table" to a confirmed booking', async () => {
    const u = 'guest1';
    await sim(u, { type: 'follow' });
    expect((await lastOut(u)).text).toContain('Welcome to Velora');

    await sim(u, { type: 'text', text: 'hi I want to book a table' });
    const ask = await lastOut(u);
    expect(ask.text).toBe('Which night would you like to book?');
    expect(ask.quickReply.items.map((i: any) => i.action.label)).toContain('Tonight');

    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    expect((await lastOut(u)).text).toContain('How many guests?');

    await sim(u, { type: 'postback', data: 'a=pax&r=5-8' });
    const carousel = await lastOut(u);
    expect(carousel.type).toBe('flex');
    expect(carousel.contents.contents.length).toBe(6); // V1, V2, B1–B4 fit 5–8

    await sim(u, { type: 'postback', data: `a=table&t=table_demo_B1&d=${FRIDAY}` });
    const held = await lastOut(u);
    const uri: string = held.contents.footer.contents[0].action.uri;
    expect(uri).toContain('/liff/details?ref=VL-');
    const url = new URL(uri);
    const ref = url.searchParams.get('ref')!;
    const token = url.searchParams.get('t')!;

    // Guest form (LIFF page)
    const form = (await (await req(`/api/liff/booking?ref=${ref}&t=${token}`)).json()) as any;
    expect(form.booking.table).toBe('B1');
    const bad = await req('/api/liff/booking/details', json({ ref, t: 'wrong-token-wrong-token', name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6, acceptRules: true }));
    expect(bad.status).toBe(404);
    const ok = await req('/api/liff/booking/details', json({ ref, t: token, name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6, acceptRules: true, viaChat: false }));
    expect(ok.status).toBe(200);
    await app.settle();
    const review = await lastOut(u);
    expect(review.altText).toBe('Review your booking');

    const booking = (await ctx.db.query.bookings.findFirst({ where: eq(bookings.refCode, ref) }))!;
    await sim(u, { type: 'postback', data: `a=confirm&b=${booking.id}` });
    expect((await lastOut(u)).text).toContain('DEMO MODE');

    await sim(u, { type: 'image', imageBase64: FAKE_JPEG });
    expect((await lastOut(u)).text).toContain('checking your payment');
    expect((await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) }))!.status).toBe('payment_review');

    // Staff approve in the dashboard → guest gets the confirmation card with the door QR.
    const cookie = await staffCookie();
    const night = (await (await req(staffUrl('demo', `/night?date=${FRIDAY}`), { headers: { cookie } })).json()) as any;
    expect(night.tables.find((t: any) => t.code === 'B1').booking.status).toBe('payment_review');
    const approve = await req(staffUrl('demo', `/bookings/${booking.id}/approve`), { ...json({}), headers: { 'content-type': 'application/json', cookie } });
    expect(approve.status).toBe(200);
    const confirmation = await lastOut(u);
    expect(confirmation.altText).toContain('You’re booked');
    expect(confirmation.contents.hero.url).toContain(`/media/pass/${ref}.png`);

    // The pass image is served, but only with a valid signature.
    const passUrl = new URL(confirmation.contents.hero.url);
    expect((await req(passUrl.pathname + passUrl.search)).headers.get('content-type')).toBe('image/png');
    expect((await req(passUrl.pathname + '?s=forged')).status).toBe(404);

    // Asking to book again shows the existing booking instead of starting a second one.
    await sim(u, { type: 'text', text: 'book a table' });
    expect((await lastOut(u)).text).toContain('You already have a booking: B1');
  });

  it('never ignores a repeated "book a table" mid-booking', async () => {
    const u = 'guest2';
    await sim(u, { type: 'text', text: 'book' });
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    await sim(u, { type: 'postback', data: 'a=pax&r=2-4' });
    await sim(u, { type: 'postback', data: `a=table&t=table_demo_T1&d=${FRIDAY}` });
    await sim(u, { type: 'text', text: 'I want to book a table' });
    const msg = await lastOut(u);
    expect(msg.text).toContain('You were booking T1');
    expect(msg.quickReply.items.map((i: any) => i.action.label)).toEqual(['Continue', 'Start over']);
  });

  it('tells the second guest when a table was just taken', async () => {
    for (const u of ['a', 'b']) {
      await sim(u, { type: 'text', text: 'book' });
      await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
      await sim(u, { type: 'postback', data: 'a=pax&r=9-12' });
    }
    await sim('a', { type: 'postback', data: `a=table&t=table_demo_V1&d=${FRIDAY}` });
    await sim('b', { type: 'postback', data: `a=table&t=table_demo_V1&d=${FRIDAY}` });
    const out = (await transcript('b')).filter((m) => m.direction === 'out');
    // Reply is: "taken" notice, intro line, then the cards of what's left.
    expect(out.at(-3)!.payload.text).toContain('Someone just booked V1');
    expect(out.at(-1)!.payload.contents.contents).toHaveLength(1); // only V2 left
  });

  it('outside host hours the handoff reply says when hosts are online (§5.3)', async () => {
    // FRIDAY_AFTERNOON is 15:00 Bangkok.
    await ctx.db.update(clubs).set({ settings: { ...ctx.club.settings, hostHours: { from: '18:00', to: '03:00' } } }).where(eq(clubs.id, ctx.club.id));
    await sim('offhours', { type: 'text', text: 'can I talk to a person please' });
    expect((await lastOut('offhours')).text).toBe('Got it, a host will reply here. Our hosts are online from 18:00.');
    clock = new Date('2026-11-27T19:00:00Z'); // 02:00 Saturday: inside the window across midnight
    simCookie = undefined; // a new admin session at the new time
    await sim('inhours', { type: 'text', text: 'can I talk to a person please' });
    expect((await lastOut('inhours')).text).toBe('Got it, a host will reply here shortly.');
  });

  it('hands off to a human and then stays quiet until resolved', async () => {
    const u = 'guest3';
    await sim(u, { type: 'text', text: 'can I talk to a person please' });
    expect((await lastOut(u)).text).toBe('Got it, a host will reply here shortly.');
    const before = (await transcript(u)).filter((m) => m.direction === 'out').length;
    await sim(u, { type: 'text', text: 'hello??' });
    expect((await transcript(u)).filter((m) => m.direction === 'out').length).toBe(before);

    const cookie = await staffCookie();
    const { handoffs } = (await (await req(staffUrl('demo', '/handoffs'), { headers: { cookie } })).json()) as any;
    expect(handoffs).toHaveLength(1);
    await req(staffUrl('demo', `/conversations/${handoffs[0].id}/resolve`), { method: 'POST', headers: { cookie } });
    await sim(u, { type: 'text', text: 'hello' });
    expect((await lastOut(u)).text).toBe('I can help you with:');
  });

  it('answers in Thai for Thai LINE users', async () => {
    await sim('th1', { type: 'text', text: 'จองโต๊ะ', lang: 'th' });
    expect((await lastOut('th1')).text).toBe('ต้องการจองคืนไหนคะ?');
  });
});

describe('guest details fields (§5.2 step 4)', () => {
  async function detailsLink(u: string, table = 'B1') {
    await sim(u, { type: 'text', text: 'book a table' });
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    await sim(u, { type: 'postback', data: 'a=pax&r=5-8' });
    await sim(u, { type: 'postback', data: `a=table&t=table_demo_${table}&d=${FRIDAY}` });
    const url = new URL((await lastOut(u)).contents.footer.contents[0].action.uri);
    return { ref: url.searchParams.get('ref')!, t: url.searchParams.get('t')! };
  }
  const base = { name: 'Ari', phone: '0812345678', pax: 6, acceptRules: true, viaChat: false };

  it('stores the optional date of birth and occasion', async () => {
    const { ref, t } = await detailsLink('dob1');
    const page = (await (await req(`/api/liff/booking?ref=${ref}&t=${t}`)).json()) as any;
    expect(page.club.requiredFields).toEqual(['nationality']);
    const ok = await req('/api/liff/booking/details', json({ ref, t, ...base, nationality: 'Thai', birthDate: '1998-04-02', occasion: 'Birthday' }));
    expect(ok.status).toBe(200);
    const booking = (await ctx.db.query.bookings.findFirst({ where: eq(bookings.refCode, ref) }))!;
    expect(booking.occasion).toBe('Birthday');
    const guest = (await ctx.db.query.guests.findFirst({ where: eq(guests.id, booking.guestId) }))!;
    expect(guest.birthDate).toBe('1998-04-02');
  });

  it("follows the club's required fields", async () => {
    // Default: nationality is required.
    const first = await detailsLink('req1');
    const missing = await req('/api/liff/booking/details', json({ ...first, ...base, nationality: '' }));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as any).issues).toEqual([{ field: 'nationality', message: 'Required' }]);
    // A club that requires date of birth instead.
    await ctx.db.update(clubs).set({ settings: { ...ctx.club.settings, requiredFields: ['birthDate'] } }).where(eq(clubs.id, ctx.club.id));
    const second = await detailsLink('req2', 'B2');
    expect((await req('/api/liff/booking/details', json({ ...second, ...base }))).status).toBe(400);
    expect((await req('/api/liff/booking/details', json({ ...second, ...base, birthDate: '1990-01-01' }))).status).toBe(200);
  });
});

describe('automatic slip verification in the bot (B9)', () => {
  let verifier: FakeSlipVerifier;
  beforeEach(async () => {
    await ctx.db.update(clubs).set({ promptpayId: '0812345678' }).where(eq(clubs.id, ctx.club.id));
    verifier = new FakeSlipVerifier(new Error('unset'));
    app = createApp(config, ctx.db, { bot: { now: () => clock, log: () => {}, slipVerifier: verifier } });
  });

  async function toAwaitingPayment(u: string) {
    await sim(u, { type: 'text', text: 'book a table' });
    await sim(u, { type: 'postback', data: `a=night&d=${FRIDAY}` });
    await sim(u, { type: 'postback', data: 'a=pax&r=5-8' });
    await sim(u, { type: 'postback', data: `a=table&t=table_demo_B1&d=${FRIDAY}` });
    const uri: string = (await lastOut(u)).contents.footer.contents[0].action.uri;
    const url = new URL(uri);
    const ref = url.searchParams.get('ref')!;
    const t = url.searchParams.get('t')!;
    const ok = await req('/api/liff/booking/details', json({ ref, t, name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6, acceptRules: true, viaChat: false }));
    expect(ok.status).toBe(200);
    await app.settle();
    const booking = (await ctx.db.query.bookings.findFirst({ where: eq(bookings.refCode, ref) }))!;
    await sim(u, { type: 'postback', data: `a=confirm&b=${booking.id}` });
    return booking;
  }

  it('a slip that passes every check confirms the booking and sends the confirmation card', async () => {
    const booking = await toAwaitingPayment('auto1');
    verifier.result = {
      transRef: 'FLOW-1',
      amountSatang: booking.depositSatang,
      receiver: { proxy: 'xxx-xxx-5678' },
      transferredAt: clock,
    };
    await sim('auto1', { type: 'image', imageBase64: FAKE_JPEG });
    expect(verifier.calls).toBe(1);
    expect((await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) }))!.status).toBe('confirmed');
    expect((await lastOut('auto1')).altText).toContain('You’re booked');
  });

  it('a failed check leaves the booking in payment_review with the usual reply', async () => {
    const booking = await toAwaitingPayment('auto2');
    verifier.result = { transRef: 'FLOW-2', amountSatang: 1, receiver: { proxy: 'xxx-xxx-5678' }, transferredAt: clock };
    await sim('auto2', { type: 'image', imageBase64: FAKE_JPEG });
    expect((await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) }))!.status).toBe('payment_review');
    expect((await lastOut('auto2')).text).toContain('checking your payment');
  });

  it('a passing slip after the hold ran out goes to review as late_slip, before the expiry sweep ran', async () => {
    const booking = await toAwaitingPayment('auto3');
    const paidAt = clock;
    const held = (await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) }))!;
    expect(held.status).toBe('awaiting_payment');
    // Past the hold, but no hold-expiry sweep has run: the booking is still awaiting_payment.
    clock = new Date(held.holdExpiresAt!.getTime() + 60_000);
    verifier.result = { transRef: 'FLOW-3', amountSatang: booking.depositSatang, receiver: { proxy: 'xxx-xxx-5678' }, transferredAt: paidAt };
    await sim('auto3', { type: 'image', imageBase64: FAKE_JPEG });
    expect(verifier.calls).toBe(1);
    expect((await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) }))!.status).toBe('payment_review');
    const review = await ctx.db.select().from(events).where(and(eq(events.bookingId, booking.id), eq(events.type, 'slip.review')));
    expect(review.map((e) => (e.props as { code: string }).code)).toEqual(['late_slip']);
  });
});

describe('security', () => {
  it('rejects the dashboard API without a session', async () => {
    expect((await req(staffUrl('demo', '/night'))).status).toBe(401);
    expect((await req('/api/auth/login', json({ email: 'nobody@test.local', password: 'nope' }))).status).toBe(401);
  });

  it('verifies the LINE webhook signature', async () => {
    process.env.DEMO_LINE_CHANNEL_SECRET = 'line-secret';
    process.env.DEMO_LINE_ACCESS_TOKEN = 'line-token';
    try {
      const body = JSON.stringify({ destination: 'x', events: [] });
      const good = createHmac('sha256', 'line-secret').update(body).digest('base64');
      const send = (sig: string) => req('/line/webhook/demo', { method: 'POST', headers: { 'x-line-signature': sig }, body });
      expect((await send('forged')).status).toBe(401);
      expect((await send(good)).status).toBe(200);
    } finally {
      delete process.env.DEMO_LINE_CHANNEL_SECRET;
      delete process.env.DEMO_LINE_ACCESS_TOKEN;
    }
  });
});

describe('intents', () => {
  it.each([
    ['I want to book a table', 'book'],
    ['โต๊ะ 6 คน เสาร์นี้', 'book'],
    ['can i talk to a person', 'handoff'],
    ['ขอคุยกับแอดมิน', 'handoff'],
    ['my booking', 'my_booking'],
    ['where are you located? need the map', 'location'],
    ['Details sent · VL-7K2Q', 'details_sent'],
    ['link A1B2C3D4', 'staff_link'],
    ['link A1B2C3', 'unknown'], // B5: the old 6-character code no longer links
    ['🔥🔥', 'unknown'],
    ['please delete my data', 'remove_data'], // B10b
    ['ขอลบข้อมูลของฉัน', 'remove_data'],
    ['STOP', 'stop_marketing'],
    ['ยกเลิกรับข่าวสาร', 'stop_marketing'],
    ['I can’t stop dancing, book a table', 'book'],
  ])('%s → %s', (text, kind) => {
    expect(detectIntent(text).kind).toBe(kind);
  });
});

describe('guest data removal and marketing opt-out (B10b)', () => {
  const labels = (msg: any): string[] => msg.quickReply.items.map((i: any) => i.action.data ?? i.action.uri);
  const pendingRemovals = () => ctx.db.select().from(removalRequests).where(eq(removalRequests.clubId, ctx.club.id));
  const eventsOf = (type: string) => ctx.db.select().from(events).where(eq(events.type, type));

  it('removal keyword and menu item create a removal request', async () => {
    // Keyword: one confirm prompt, and nothing is written until the tap.
    await sim('rm1', { type: 'text', text: 'please delete my data' });
    expect(labels(await lastOut('rm1'))).toEqual(['a=remove_confirm']);
    expect(await pendingRemovals()).toHaveLength(0);
    await sim('rm1', { type: 'postback', data: 'a=remove_confirm' });
    expect((await lastOut('rm1')).text).toContain('removed within a day');
    expect(await pendingRemovals()).toHaveLength(1);

    // Menu item: "My data" on the main menu, then "Remove my data", then the same confirm tap.
    await sim('rm2', { type: 'text', text: 'hello' });
    expect(labels(await lastOut('rm2'))).toContain('a=privacy');
    await sim('rm2', { type: 'postback', data: 'a=privacy' });
    expect(labels(await lastOut('rm2'))).toEqual(['a=stop', 'a=remove']);
    await sim('rm2', { type: 'postback', data: 'a=remove' });
    expect(labels(await lastOut('rm2'))).toEqual(['a=remove_confirm']);
    await sim('rm2', { type: 'postback', data: 'a=remove_confirm' });
    await sim('rm2', { type: 'postback', data: 'a=remove_confirm' }); // a second tap adds no row

    const rows = await pendingRemovals();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.guestId)).size).toBe(2);
    expect(rows.every((r) => r.channel === 'line' && r.completedAt === null)).toBe(true);
    expect(await eventsOf('guest.removal_requested')).toHaveLength(2);
  });

  it('stop keyword records the opt-out and emits marketing.opted_out', async () => {
    await sim('st1', { type: 'text', text: 'stop' });
    expect((await lastOut('st1')).text).toContain('won’t get promotional messages');
    const rows = await ctx.db.select().from(notices).where(eq(notices.clubId, ctx.club.id));
    const optOut = rows.filter((r) => r.purpose === 'marketing');
    expect(optOut).toHaveLength(1);
    expect(optOut[0]).toMatchObject({ purpose: 'marketing', channel: 'line' });
    expect(optOut[0]!.withdrawnAt).toEqual(clock);
    const guestId = optOut[0]!.guestId;
    expect(await hasMarketingOptOut(ctx.db, ctx.club.id, guestId)).toBe(true);
    const evs = await eventsOf('marketing.opted_out');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.guestId).toBe(guestId);

    // Typed again, or from the menu: no second row or event.
    await sim('st1', { type: 'text', text: 'STOP' });
    await sim('st1', { type: 'postback', data: 'a=stop' });
    expect(await eventsOf('marketing.opted_out')).toHaveLength(1);
    // Another guest is not opted out.
    await sim('st2', { type: 'text', text: 'hello' });
    const other = (await eventsOf('guest.first_seen')).find((e) => e.guestId !== guestId)!;
    expect(await hasMarketingOptOut(ctx.db, ctx.club.id, other.guestId!)).toBe(false);
  });

  it('during a human handoff a typed stop still opts out at once, and the bot stays quiet', async () => {
    await sim('st3', { type: 'text', text: 'can i talk to a person' });
    const conv = (await ctx.db.query.conversations.findFirst({ where: eq(conversations.clubId, ctx.club.id) }))!;
    expect(conv.mode).toBe('human');
    const outBefore = (await transcript('st3')).filter((m) => m.direction === 'out').length;
    await sim('st3', { type: 'text', text: 'stop' });
    expect((await transcript('st3')).filter((m) => m.direction === 'out').length).toBe(outBefore);
    expect(await hasMarketingOptOut(ctx.db, ctx.club.id, conv.guestId)).toBe(true);
    expect(await eventsOf('marketing.opted_out')).toHaveLength(1);
    // A tap on the bot's remove-confirm button still files the request.
    await sim('st3', { type: 'postback', data: 'a=remove_confirm' });
    expect(await pendingRemovals()).toHaveLength(1);
  });
});
