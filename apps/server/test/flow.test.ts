import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { detectIntent } from '../src/bot/intents.js';
import type { Config } from '../src/config.js';
import { bookings } from '../src/db/schema.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupDb } from './helpers.js';

const config: Config = {
  API_PORT: 0,
  PUBLIC_URL: 'http://localhost:5173',
  DATABASE_URL: undefined,
  DATA_DIR: mkdtempSync(join(tmpdir(), 'club-test-')),
  APP_SECRET: 'test-secret-test-secret-test-secret',
  STAFF_PASSWORD: 'staffpass',
  DEV_SIMULATOR: true,
  NODE_ENV: 'test',
};

// Smallest valid JPEG header is enough: the bot sniffs magic bytes.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString('base64');

type Msg = { direction: 'in' | 'out'; kind: string; payload: any };

let ctx: Awaited<ReturnType<typeof setupDb>>;
let app: ReturnType<typeof createApp>;
let clock: Date;

beforeEach(async () => {
  ctx = await setupDb();
  clock = FRIDAY_AFTERNOON;
  app = createApp(config, ctx.db, { now: () => clock, log: () => {} });
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

async function sim(userId: string, body: Record<string, unknown>) {
  const res = await req('/api/dev/demo/event', json({ userId, displayName: 'Ari', ...body }));
  expect(res.status).toBe(200);
}
async function transcript(userId: string): Promise<Msg[]> {
  const res = await req(`/api/dev/demo/transcript?userId=${userId}`);
  return ((await res.json()) as { messages: Msg[] }).messages;
}
async function lastOut(userId: string): Promise<any> {
  const out = (await transcript(userId)).filter((m) => m.direction === 'out');
  return out[out.length - 1]!.payload;
}
async function staffCookie() {
  const res = await req('/api/staff/login', json({ password: 'staffpass' }));
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('guest booking flow over LINE', () => {
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
    const night = (await (await req(`/api/staff/clubs/demo/night?date=${FRIDAY}`, { headers: { cookie } })).json()) as any;
    expect(night.tables.find((t: any) => t.code === 'B1').booking.status).toBe('payment_review');
    const approve = await req(`/api/staff/bookings/${booking.id}/approve`, { ...json({}), headers: { 'content-type': 'application/json', cookie } });
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

  it('hands off to a human and then stays quiet until resolved', async () => {
    const u = 'guest3';
    await sim(u, { type: 'text', text: 'can I talk to a person please' });
    expect((await lastOut(u)).text).toBe('Got it, a host will reply here shortly.');
    const before = (await transcript(u)).filter((m) => m.direction === 'out').length;
    await sim(u, { type: 'text', text: 'hello??' });
    expect((await transcript(u)).filter((m) => m.direction === 'out').length).toBe(before);

    const cookie = await staffCookie();
    const { handoffs } = (await (await req('/api/staff/clubs/demo/handoffs', { headers: { cookie } })).json()) as any;
    expect(handoffs).toHaveLength(1);
    await req(`/api/staff/conversations/${handoffs[0].id}/resolve`, { method: 'POST', headers: { cookie } });
    await sim(u, { type: 'text', text: 'hello' });
    expect((await lastOut(u)).text).toBe('I can help you with:');
  });

  it('answers in Thai for Thai LINE users', async () => {
    await sim('th1', { type: 'text', text: 'จองโต๊ะ', lang: 'th' });
    expect((await lastOut('th1')).text).toBe('ต้องการจองคืนไหนคะ?');
  });
});

describe('security', () => {
  it('rejects the dashboard API without a session', async () => {
    expect((await req('/api/staff/clubs/demo/night')).status).toBe(401);
    expect((await req('/api/staff/login', json({ password: 'nope' }))).status).toBe(401);
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
    ['link A1B2C3', 'staff_link'],
    ['🔥🔥', 'unknown'],
  ])('%s → %s', (text, kind) => {
    expect(detectIntent(text).kind).toBe(kind);
  });
});
