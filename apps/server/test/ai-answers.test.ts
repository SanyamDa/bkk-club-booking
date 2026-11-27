import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeModelClient } from '../src/bot/deps.js';
import { compileSnapshot } from '../src/brain/compile.js';
import { extractBookingDetails } from '../src/brain/extract.js';
import { guardAnswer } from '../src/brain/guard.js';
import { createNote } from '../src/brain/notes.js';
import { aiCostCapKey } from '../src/platform/club-stats.js';
import { emit } from '../src/data/events.js';
import { alerts, bookings, conversations, events, guests, handoffEpisodes, messages, platformFlags, tables } from '../src/db/schema.js';
import { callCostUsdMicros, type ModelReply, type ModelRequest } from '../src/brain/answer.js';
import { FRIDAY_AFTERNOON, setupDb } from './helpers.js';
import { adminCookie, testConfig } from './helpers/track-a.js';

/** B16 AI answers (spec §8.1, §8.5, §8.6). The model is always a fake: no test reaches Anthropic. */

const config = testConfig({ PUBLIC_URL: 'http://localhost:5173', DEV_SIMULATOR: true });
const SATURDAY = '2026-11-28';

type Responder = (req: ModelRequest) => Partial<ModelReply>;

let ctx: Awaited<ReturnType<typeof setupDb>>;
let app: ReturnType<typeof createApp>;
let model: ReturnType<typeof fakeModelClient>;
let respond: Responder;
let cookie: string | undefined;

beforeEach(async () => {
  ctx = await setupDb();
  respond = () => ({});
  model = fakeModelClient((req) => respond(req));
  app = createApp(config, ctx.db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {}, ai: model } });
  cookie = undefined;
});
afterEach(async () => {
  await ctx.close();
});

const reply = (input: Record<string, unknown>): Partial<ModelReply> => ({
  toolCalls: [
    {
      name: 'reply',
      input: { answer: '', lang: 'en', notes_used: [], topic: 'other', needs_handoff: false, unclear: false, summary: '', ...input },
    },
  ],
});
const tool = (name: string, input: Record<string, unknown>): Partial<ModelReply> => ({ toolCalls: [{ name, input }] });

async function say(userId: string, text: string) {
  cookie ??= await adminCookie(app);
  const res = await app.app.request('/api/dev/demo/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ userId, displayName: 'Ari', type: 'text', text }),
  });
  expect(res.status).toBe(200);
}

async function guestOf(userId: string) {
  return (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, `SIM-${userId}`) }))!;
}
async function convOf(userId: string) {
  const g = await guestOf(userId);
  return (await ctx.db.query.conversations.findFirst({ where: eq(conversations.guestId, g.id) }))!;
}
async function outTexts(userId: string): Promise<string[]> {
  const g = await guestOf(userId);
  const rows = await ctx.db.select().from(messages).where(and(eq(messages.guestId, g.id), eq(messages.direction, 'out')));
  return rows.map((r) => JSON.stringify(r.payload));
}
async function lastOut(userId: string): Promise<any> {
  const g = await guestOf(userId);
  const rows = await ctx.db.select().from(messages).where(and(eq(messages.guestId, g.id), eq(messages.direction, 'out')));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)!.payload;
}
async function staffTexts(): Promise<string[]> {
  const rows = await ctx.db.select().from(messages).where(eq(messages.target, 'staff'));
  return rows.map((r) => (r.payload as { text?: string }).text ?? '');
}
const eventsOf = (type: string) => ctx.db.select().from(events).where(eq(events.type, type as never));

async function setCap(usdMicros: number, spent: number) {
  await ctx.db.insert(platformFlags).values({ key: aiCostCapKey(ctx.club.id), value: { usdMicros }, updatedBy: 'test', updatedAt: FRIDAY_AFTERNOON });
  if (spent > 0)
    await emit(ctx.db, {
      clubId: ctx.club.id,
      type: 'ai.call',
      occurredAt: FRIDAY_AFTERNOON,
      actorType: 'bot',
      dataOrigin: 'first_party',
      isTest: true,
      props: { model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, latency_ms: 1, cost_usd_micros: spent },
    });
}

describe('B16 AI answers', () => {
  it('guard strips invented price', async () => {
    // A non-booking topic: the answer is replaced by a handoff, and the gap is recorded.
    respond = () => reply({ answer: 'Sure, bring a cake! Minimum spend is ฿5,000 tonight.', topic: 'birthday_cake' });
    await say('g1', 'can i bring my own cake');
    expect((await outTexts('g1')).join('\n')).not.toContain('5,000');
    expect((await convOf('g1')).mode).toBe('human');
    expect((await eventsOf('faq.missed')).map((e) => e.props)).toEqual([{ topic: 'birthday_cake' }]);

    // A price topic: the answer is replaced by the button flow, which shows real prices.
    respond = () => reply({ answer: 'VIP minimum spend is 25,000 baht.', topic: 'min_spend' });
    await say('g2', 'how much is the vip area');
    expect((await outTexts('g2')).join('\n')).not.toContain('25,000');
    expect((await lastOut('g2')).text).toBe('Which night would you like to book?');
    expect((await convOf('g2')).mode).toBe('bot');

    // The guard itself: an amount and a table code the booking system did not produce.
    expect(guardAnswer('Deposit is ฿3,000', ['B1']).map((i) => i.code)).toEqual(['price']);
    expect(guardAnswer('Table B1 is great', ['B1']).map((i) => i.code)).toEqual(['table_code']);
    expect(guardAnswer('Dress code is smart casual. Valet parking is available.', ['B1'])).toEqual([]);
  });

  it('cost cap reached -> hand to host', async () => {
    await setCap(1_000, 1_000);
    respond = () => reply({ answer: 'Smart casual.', topic: 'dress_code' });
    await say('g1', 'what should i wear');
    expect(model.calls).toHaveLength(0);
    expect((await convOf('g1')).mode).toBe('human');
    expect((await staffTexts()).join('\n')).toContain('AI cost cap reached');
    const capAlerts = await ctx.db.select().from(alerts).where(eq(alerts.kind, 'ai_cost_cap'));
    expect(capAlerts).toHaveLength(1);
  });

  it('warning raised before cost cap reached', async () => {
    // Cap 10,000 micros, 7,900 spent; one call of 1,000 input + 50 output haiku tokens costs 125.
    await setCap(10_000, 7_900);
    respond = () => ({ ...reply({ answer: 'Smart casual.', topic: 'dress_code' }), usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    await say('g1', 'what should i wear');
    expect((await lastOut('g1')).text).toBe('Smart casual.');
    expect(await ctx.db.select().from(alerts).where(eq(alerts.kind, 'ai_cost_warning'))).toHaveLength(1);
    expect(await ctx.db.select().from(alerts).where(eq(alerts.kind, 'ai_cost_cap'))).toHaveLength(0);
    await say('g1', 'and shoes?');
    expect(await ctx.db.select().from(alerts).where(eq(alerts.kind, 'ai_cost_warning'))).toHaveLength(1); // once a month
  });

  it('Anthropic API down -> hand to host', async () => {
    respond = () => {
      throw new Error('503 overloaded');
    };
    await say('g1', 'what time do you close');
    expect(model.calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect((await convOf('g1')).mode).toBe('human');
    expect((await staffTexts()).join('\n')).toContain('AI unavailable');
    expect(await eventsOf('ai.call')).toHaveLength(0);
  });

  it('falls back to claude-sonnet-5-5 when claude-haiku-5-5 fails', async () => {
    respond = (req) => {
      if (req.model === 'claude-haiku-5-5') throw new Error('500');
      return reply({ answer: 'We close at 02:00.', topic: 'hours' });
    };
    await say('g1', 'what time do you close');
    expect((await lastOut('g1')).text).toBe('We close at 02:00.');
    const calls = await eventsOf('ai.call');
    expect(calls.map((e) => (e.props as { model: string }).model)).toEqual(['claude-sonnet-5-5']);
    // 100 input × $2 + 50 output × $10 per MTok = 700 micros.
    expect((calls[0]!.props as { cost_usd_micros: number }).cost_usd_micros).toBe(700);
  });

  it("'โต๊ะ 6 คน เสาร์นี้' pre-fills date and pax", async () => {
    await say('g1', 'โต๊ะ 6 คน เสาร์นี้');
    expect(model.calls).toHaveLength(0); // deterministic pass, no tokens spent
    expect((await convOf('g1')).state).toEqual({ nightDate: SATURDAY, paxRange: '5-8' });
    expect((await lastOut('g1')).type).toBe('flex'); // straight to the table carousel
    expect(extractBookingDetails('โต๊ะ 6 คน เสาร์นี้ ใกล้ดีเจ', { today: '2026-11-27', tableCodes: [], zones: [] })).toEqual({ date: SATURDAY, pax: 6 });
  });

  it("'ศุกร์อาทิตย์หน้า 6 คน' is Friday next week, not Sunday", () => {
    // 2026-11-27 is a Friday; อาทิตย์หน้า here means "next week", not Sunday.
    expect(extractBookingDetails('ศุกร์อาทิตย์หน้า 6 คน', { today: '2026-11-27', tableCodes: [], zones: [] })).toEqual({ date: '2026-12-04', pax: 6 });
    expect(extractBookingDetails('วันอาทิตย์ 4 คน', { today: '2026-11-27', tableCodes: [], zones: [] })).toEqual({ date: '2026-11-29', pax: 4 });
  });

  it('cache reads and writes are priced at 0.1x and 1.25x the input price', () => {
    const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(callCostUsdMicros('claude-sonnet-5-5', u)).toBe(200_000 + 2_500_000);
    expect(callCostUsdMicros('claude-haiku-5-5', u)).toBe(10_000 + 125_000);
  });

  it("'17A sat 6ppl' pre-fills table code", async () => {
    await ctx.db.insert(tables).values({ id: 'table_demo_17A', clubId: ctx.club.id, zoneId: 'zone_demo_dj', code: '17A', minPax: 4, maxPax: 8, sort: 11 });
    await say('g1', '17A sat 6ppl');
    expect(model.calls).toHaveLength(0);
    const [b] = await ctx.db.select().from(bookings).where(eq(bookings.guestId, (await guestOf('g1')).id));
    expect(b).toMatchObject({ tableId: 'table_demo_17A', nightDate: SATURDAY, pax: 6, status: 'held' });
  });

  it('tool ignores club id in model output', async () => {
    respond = () => tool('start_booking', { club_id: 'club_test_b', guest_id: 'someone_else', date: SATURDAY, pax: 6 });
    await say('g1', 'got space for my crew this weekend?');
    const conv = await convOf('g1');
    expect(conv.clubId).toBe(ctx.club.id);
    expect(conv.state).toEqual({ nightDate: SATURDAY, paxRange: '5-8' });
    const carousel = JSON.stringify(await lastOut('g1'));
    expect(carousel).toContain('table_demo_B1'); // the session club's tables
  });

  it('unclear message shows button menu and records bot.fallback_menu', async () => {
    respond = () => reply({ unclear: true });
    await say('g1', 'asdf qwer');
    expect((await lastOut('g1')).text).toBe('I can help you with:');
    expect(await eventsOf('bot.fallback_menu')).toHaveLength(1);
    expect((await convOf('g1')).mode).toBe('bot');
  });

  it('question the brain cannot answer records faq.missed with the question', async () => {
    respond = () => reply({ needs_handoff: true, topic: 'lost_property', summary: 'Guest lost a phone last Saturday.' });
    await say('g1', 'I lost my phone on saturday');
    const [missed] = await eventsOf('faq.missed');
    expect(missed!.props).toEqual({ topic: 'lost_property' });
    expect(missed!.raw).toEqual({ text: 'I lost my phone on saturday' });
    expect((await convOf('g1')).mode).toBe('human');
  });

  it('handoff carries 2-line summary', async () => {
    respond = () =>
      tool('request_handoff', { topic: 'complaint', summary: 'Guest was overcharged last Friday.\nWants a refund of the cover fee.\nThird line dropped.' });
    await say('g1', 'I want to talk about my bill from last week, not happy');
    const staff = (await staffTexts()).join('\n');
    expect(staff).toContain('Guest was overcharged last Friday.\nWants a refund of the cover fee.');
    expect(staff).not.toContain('Third line dropped.');
    const conv = await convOf('g1');
    expect(conv.mode).toBe('human');
    // B14b: the takeover is a handoff_episodes row carrying the AI topic and the 2-line summary.
    const episodes = await ctx.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.conversationId, conv.id));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ clubId: ctx.club.id, trigger: 'guest_request', topic: 'complaint', endedAt: null });
    expect(episodes[0]!.reason).toContain('Guest was overcharged last Friday.\nWants a refund of the cover fee.');
    expect(episodes[0]!.reason).not.toContain('Third line dropped.');
  });

  it('AI cost cap handoff opens an episode whose topic is the reason code', async () => {
    await setCap(1_000, 1_000);
    await say('g1', 'what should i wear');
    const conv = await convOf('g1');
    const episodes = await ctx.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.conversationId, conv.id));
    expect(episodes.map((e) => ({ trigger: e.trigger, topic: e.topic }))).toEqual([{ trigger: 'ai_cost_cap', topic: 'ai_cost_cap' }]);
  });

  it('ai.answered logs note ids', async () => {
    const note = await createNote(
      ctx.db,
      { clubId: ctx.club.id, title: 'Dress code', slug: 'dress-code', type: 'policy', bodyMd: 'Smart casual. No flip-flops.', source: 'manual', status: 'live' },
      { type: 'staff' },
      FRIDAY_AFTERNOON,
    );
    await compileSnapshot(ctx.db, ctx.club.id, FRIDAY_AFTERNOON);
    respond = () => reply({ answer: 'Smart casual, no flip-flops.', notes_used: ['dress-code', 'made-up-note'], topic: 'dress_code' });
    await say('g1', 'dress code?');
    expect(model.calls[0]!.brain).toContain('No flip-flops.');
    expect(model.calls[0]!.userContent).toContain('<guest_message>\ndress code?\n</guest_message>');
    expect((await lastOut('g1')).text).toBe('Smart casual, no flip-flops.');
    const [answered] = await eventsOf('ai.answered');
    expect(answered!.props).toEqual({ notes_used: 1, topic: 'dress_code' });
    expect((answered!.raw as { noteIds: string[] }).noteIds).toEqual([note.id]);
  });
});
