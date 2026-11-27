import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeLearnClient, fakeModelClient } from '../src/bot/deps.js';
import type { ModelReply, ModelRequest } from '../src/brain/answer.js';
import { compileSnapshot, latestSnapshot } from '../src/brain/compile.js';
import { listGaps } from '../src/brain/gaps.js';
import { containsPersonalData, learnClaimKey, MAX_DRAFT_ATTEMPTS, redactText, runLearning, type DraftRequest } from '../src/brain/learn.js';
import { approveNote, createNote, rejectNote, updateNote } from '../src/brain/notes.js';
import { clubTestSet } from '../src/brain/testset.js';
import { endEpisode, endOpenEpisode, recordStaffReply, startEpisode } from '../src/chat/episodes.js';
import { emit } from '../src/data/events.js';
import { alerts, brainNotes, brainTestCases, conversations, events, guests, handoffEpisodes, messages, platformFlags } from '../src/db/schema.js';
import { buildScheduler } from '../src/jobs/index.js';
import { runBrainLint } from '../src/jobs/brain-lint.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY_AFTERNOON, setupDb } from './helpers.js';
import { adminCookie, testConfig } from './helpers/track-a.js';

/** B18 learning loop (spec §8.3, §8.4). Both model clients are fakes: no test reaches Anthropic. */

const MIN = 60_000;
const DAY = 86_400_000;
const config = testConfig({ PUBLIC_URL: 'http://localhost:5173', DEV_SIMULATOR: true });

let ctx: Awaited<ReturnType<typeof setupDb>>;
let app: ReturnType<typeof createApp>;
let clock: Date;
let respond: (req: ModelRequest) => Partial<ModelReply>;
let drafting: (req: DraftRequest) => unknown;
let model: ReturnType<typeof fakeModelClient>;
let learn: ReturnType<typeof fakeLearnClient>;
let cookie: string | undefined;

beforeEach(async () => {
  ctx = await setupDb();
  clock = FRIDAY_AFTERNOON;
  respond = () => ({});
  drafting = () => {
    throw new Error('no draft expected');
  };
  model = fakeModelClient((req) => respond(req));
  learn = fakeLearnClient((req) => drafting(req));
  app = createApp(config, ctx.db, { bot: { now: () => clock, log: () => {}, ai: model, learn } });
  cookie = undefined;
});
afterEach(async () => {
  await ctx.close();
});

const replyTool = (input: Record<string, unknown>): Partial<ModelReply> => ({
  toolCalls: [{ name: 'reply', input: { answer: '', lang: 'en', notes_used: [], topic: 'other', needs_handoff: false, unclear: false, summary: '', ...input } }],
});

const goodDraft = (over: Record<string, unknown> = {}) => ({
  worth_learning: true,
  kind: 'new',
  edits_slug: null,
  title: 'Birthday cakes',
  question_en: 'Can I bring a birthday cake?',
  question_th: 'เอาเค้กวันเกิดมาได้ไหม',
  answer: 'Yes, you may bring your own birthday cake. Tell the host at the door and we keep it cold.',
  flags: { price_or_availability: false, personal_data: false, one_off: false },
  contradicts: [],
  ...over,
});

async function say(userId: string, text: string) {
  cookie ??= await adminCookie(app);
  const res = await app.app.request('/api/dev/demo/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ userId, displayName: 'Ari', type: 'text', text }),
  });
  expect(res.status).toBe(200);
}
async function convOf(userId: string) {
  const g = (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, `SIM-${userId}`) }))!;
  return (await ctx.db.query.conversations.findFirst({ where: eq(conversations.guestId, g.id) }))!;
}
const send = () => ({ outbox: app.ctx.deps.outbox, gateways: app.ctx.gateways });
const hostReply = (conversationId: string, text: string) =>
  recordStaffReply(ctx.db, { clubId: ctx.club.id, conversationId, userId: 'user_host', text, channel: 'dashboard', occurredAt: clock, externalId: null }, send());
const resolve = (conversationId: string) =>
  ctx.db.transaction((tx) => endOpenEpisode(tx, { clubId: ctx.club.id, conversationId, resolverUserId: 'user_host', now: clock }));
const runJob = () => buildScheduler(app.ctx, () => clock).runOnce('brain-draft', clock);
const drafts = () => ctx.db.select().from(brainNotes).where(and(eq(brainNotes.clubId, ctx.club.id), eq(brainNotes.status, 'draft')));

/** A guest asks, the bot cannot answer, a host replies through the inbox and resolves. */
async function takeover(userId: string, question: string, answer: string) {
  respond = () => replyTool({ needs_handoff: true, topic: 'birthday_cake', summary: 'Guest asks about a cake.' });
  await say(userId, question);
  const conv = await convOf(userId);
  expect(conv.mode).toBe('human');
  await hostReply(conv.id, answer);
  await resolve(conv.id);
  return conv;
}

const learnedBodyOf = (q: string, answer: string) => `Q: ${q}\n\n${answer}`;

/** A message row made directly. Returns its id. */
async function message(guestId: string, direction: 'in' | 'out', authorType: 'guest' | 'bot' | 'staff', text: string, at: Date, authorId: string | null = null) {
  const id = newId();
  await ctx.db.insert(messages).values({ id, clubId: ctx.club.id, guestId, direction, kind: 'text', payload: { text }, authorType, authorId, createdAt: at });
  return id;
}

/** A bot-mode conversation made directly. */
async function conversation(): Promise<{ guestId: string; conversationId: string }> {
  const guestId = newId();
  await ctx.db.insert(guests).values({ id: guestId, clubId: ctx.club.id, lineUserId: `U${guestId}`, displayName: 'Flag Guest' });
  const conversationId = newId();
  await ctx.db.insert(conversations).values({ id: conversationId, clubId: ctx.club.id, guestId, state: {} });
  return { guestId, conversationId };
}

describe('B18 learning loop', () => {
  it('approved note answers the same question next time', async () => {
    drafting = () => goodDraft();
    const conv = await takeover('g1', 'can I bring a birthday cake?', 'Yes you can bring your own cake, just tell the door host.');
    await runJob();

    const [draft] = await drafts();
    expect(draft).toMatchObject({ type: 'learned', source: 'takeover', status: 'draft', title: 'Birthday cakes' });
    const [episode] = await ctx.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.conversationId, conv.id));
    expect(draft!.sourceEpisodeId).toBe(episode!.id);
    expect(draft!.frontmatter).toMatchObject({
      question: 'can I bring a birthday cake?',
      hostReply: 'Yes you can bring your own cake, just tell the door host.',
      takeovers: 1,
      topic: 'birthday_cake',
    });
    expect(learn.drafts[0]!.transcript).toContain('Host: Yes you can bring your own cake');
    // The B19 queue shows the real draft with its question, host reply and takeover count.
    // (Ranking is covered in brain-ui.test.ts.)

    await approveNote(ctx.db, ctx.club.id, draft!.id, { type: 'staff', id: 'user_manager' }, clock);
    expect((await latestSnapshot(ctx.db, ctx.club.id))!.compiledText).toContain('you may bring your own birthday cake');

    // Next time the same question is answered from the note, not handed to a host.
    respond = (req) =>
      req.brain.includes(`note: ${draft!.slug}`)
        ? replyTool({ answer: 'Yes, you may bring your own birthday cake.', notes_used: [draft!.slug], topic: 'birthday_cake' })
        : replyTool({ needs_handoff: true, topic: 'birthday_cake' });
    clock = new Date(clock.getTime() + 60 * MIN);
    await say('g2', 'can I bring a birthday cake?');
    expect((await convOf('g2')).mode).toBe('bot');
    const answered = (await ctx.db.select().from(events).where(eq(events.type, 'ai.answered'))).at(-1)!;
    expect((answered.raw as { noteIds: string[] }).noteIds).toEqual([draft!.id]);
  });

  it('draft with a phone number is discarded', async () => {
    drafting = () => goodDraft({ answer: 'Yes, bring your cake. Call our manager on 081-234-5678 first.' });
    await takeover('g1', 'can I bring a birthday cake?', 'yes, call our manager on 081-234-5678 first');
    await runJob();
    expect(await drafts()).toHaveLength(0);
    expect(containsPersonalData('call 081-234-5678')).toBe(true);
    expect(containsPersonalData('doors open at 21:00 on 2026-11-28')).toBe(false);
  });

  it('price, one-off and personal-data flags discard the draft', async () => {
    const flags = ['price_or_availability', 'one_off', 'personal_data'] as const;
    drafting = (req) => {
      const flag = flags.find((f) => req.transcript.includes(`case ${f}`));
      if (flag) return goodDraft({ flags: { price_or_availability: false, personal_data: false, one_off: false, [flag]: true } });
      return goodDraft({ answer: 'Yes, but the minimum spend is 5,000 baht.' });
    };
    for (const flag of flags) await takeover(`g-${flag}`, `can I bring a birthday cake? case ${flag}`, 'sure, for you only');
    await takeover('g-lint', 'can I bring a birthday cake? case lint', 'yes min spend 5000 baht');
    const res = await runLearning({ db: ctx.db, client: learn, log: () => {} }, clock);
    expect(res.episodes.map((e) => e.outcome).sort()).toEqual(['one_off', 'personal_data', 'price', 'price']);
    expect(await drafts()).toHaveLength(0);
  });

  it('the transcript is redacted before the model sees it', async () => {
    drafting = () => goodDraft();
    respond = () => replyTool({ needs_handoff: true, topic: 'birthday_cake', summary: 'Guest asks about a cake.' });
    await say('g1', 'can I bring a birthday cake?');
    const conv = await convOf('g1');
    await say('g1', "it's Ari, my number is 0812345678, line id: ari_bkk, booking VE-7KQ2"); // human mode: the bot is silent
    await hostReply(conv.id, 'Hi Ari, yes you can.');
    await resolve(conv.id);
    await runJob();
    const t = learn.drafts[0]!.transcript;
    for (const leaked of ['Ari', '0812345678', 'ari_bkk', 'VE-7KQ2']) expect(t).not.toContain(leaked);
    expect(t).toContain('[phone]');
    expect(t).toContain('[booking-ref]');
    expect(redactText('mail me at a.b@example.com', [])).toBe('mail me at [email]');
  });

  it('a timed-out takeover, or one without a host reply, drafts nothing', async () => {
    const { conversationId } = await conversation();
    const ep = await ctx.db.transaction((tx) =>
      startEpisode(tx, { clubId: ctx.club.id, conversationId, trigger: 'guest_request', reason: null, firstMessageId: null, now: clock }),
    );
    await ctx.db.transaction((tx) => endEpisode(tx, { episodeId: ep.id, endedBy: 'timeout', now: clock }));
    const res = await runLearning({ db: ctx.db, client: learn, log: () => {} }, clock);
    expect(res.episodes).toEqual([{ episodeId: ep.id, outcome: 'timed_out', noteId: undefined, flagged: [] }]);
    expect(learn.drafts).toHaveLength(0);
    // Each episode is handled once.
    expect((await runLearning({ db: ctx.db, client: learn, log: () => {} }, clock)).episodes).toHaveLength(0);

    // Ended by staff, but no host wrote in it (only the guest and the bot): nothing to learn from.
    const second = await conversation();
    const guestMsg = await message(second.guestId, 'in', 'guest', 'can I bring a cake?', clock);
    await message(second.guestId, 'out', 'bot', 'A host will reply soon.', new Date(clock.getTime() + 1000));
    const ep2 = await ctx.db.transaction((tx) =>
      startEpisode(tx, { clubId: ctx.club.id, conversationId: second.conversationId, trigger: 'guest_request', reason: null, firstMessageId: guestMsg, now: clock }),
    );
    await ctx.db.transaction((tx) => endEpisode(tx, { episodeId: ep2.id, endedBy: 'staff', now: clock }));
    const res2 = await runLearning({ db: ctx.db, client: learn, log: () => {} }, clock);
    expect(res2.episodes).toEqual([{ episodeId: ep2.id, outcome: 'no_host_reply', noteId: undefined, flagged: [] }]);
    expect(learn.drafts).toHaveLength(0);
  });

  it('a failed model call is retried on the next run', async () => {
    drafting = () => {
      throw new Error('API down');
    };
    await takeover('g1', 'can I bring a birthday cake?', 'yes you can');
    await runJob();
    expect(await drafts()).toHaveLength(0);
    // Before the backoff has passed: not asked again.
    await runJob();
    expect(learn.drafts).toHaveLength(1);
    drafting = () => goodDraft();
    clock = new Date(clock.getTime() + MIN);
    await runJob();
    expect(await drafts()).toHaveLength(1);
    expect(learn.drafts).toHaveLength(2);
  });

  it('a draft that keeps failing stops after the last attempt, and a refusal stops at once', async () => {
    drafting = () => {
      throw new Error('API down');
    };
    await takeover('g1', 'can I bring a birthday cake?', 'yes you can');
    for (let i = 0; i < MAX_DRAFT_ATTEMPTS + 3; i++) {
      await runLearning({ db: ctx.db, client: learn, log: () => {} }, clock);
      clock = new Date(clock.getTime() + 3 * 60 * MIN); // past every backoff
    }
    expect(learn.drafts).toHaveLength(MAX_DRAFT_ATTEMPTS);
    const [episode] = await ctx.db.select().from(handoffEpisodes);
    const claim = await ctx.db.query.platformFlags.findFirst({ where: eq(platformFlags.key, learnClaimKey(episode!.id)) });
    expect(claim!.value).toMatchObject({ outcome: 'invalid' });

    // A refusal is billed and would fail again: claimed invalid on the first try.
    const refusing: typeof learn = {
      ...learn,
      draft: async (reqs) =>
        reqs.map((r) => ({ id: r.id, output: null, usage: { inputTokens: 900, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, error: new Error('model refusal'), permanent: true })),
    };
    cookie = undefined; // the admin session ran out over the simulated day
    await takeover('g2', 'can I bring a birthday cake?', 'yes you can');
    const res = await runLearning({ db: ctx.db, client: refusing, log: () => {} }, clock);
    expect(res.episodes.map((e) => e.outcome)).toEqual(['invalid']);
    expect((await runLearning({ db: ctx.db, client: refusing, log: () => {} }, new Date(clock.getTime() + DAY))).episodes).toHaveLength(0);
  });

  it('the transcript starts at the guest question when the takeover started on a host reply', async () => {
    drafting = () => goodDraft();
    const { guestId, conversationId } = await conversation();
    const t = (s: number) => new Date(clock.getTime() + s * 1000);
    await message(guestId, 'in', 'guest', 'can I bring a birthday cake?', t(0));
    const hostId = await message(guestId, 'out', 'staff', 'Yes, tell the door host and we keep it cold.', t(10), 'user_host');
    const lastId = await message(guestId, 'in', 'guest', 'ok thanks', t(20));
    const ep = await ctx.db.transaction((tx) =>
      startEpisode(tx, { clubId: ctx.club.id, conversationId, trigger: 'staff_reply', reason: null, firstMessageId: hostId, now: t(10) }),
    );
    await ctx.db.update(handoffEpisodes).set({ lastMessageId: lastId }).where(eq(handoffEpisodes.id, ep.id));
    await ctx.db.transaction((tx) => endEpisode(tx, { episodeId: ep.id, endedBy: 'staff', now: t(30) }));
    clock = t(40);
    await runLearning({ db: ctx.db, client: learn, log: () => {} }, clock);
    expect(learn.drafts[0]!.transcript.split('\n')).toEqual(['Guest: can I bring a birthday cake?', 'Host: Yes, tell the door host and we keep it cold.', 'Guest: ok thanks']);
    const [draft] = await drafts();
    expect((draft!.frontmatter as Record<string, unknown>).question).toBe('can I bring a birthday cake?');
  });

  it("a test guest's drafting cost is test data and names the guest", async () => {
    drafting = () => goodDraft();
    const conv = await takeover('g1', 'can I bring a birthday cake?', 'yes you can'); // a simulator guest
    await runJob();
    const opus = (await ctx.db.select().from(events).where(eq(events.type, 'ai.call'))).find((c) => c.props.model === 'claude-opus-5-5')!;
    expect(opus).toMatchObject({ isTest: true, guestId: conv.guestId, conversationId: conv.id });
  });

  it('a takeover within 10 minutes of a bot answer flags the notes that answer used, and one after 11 minutes does not', async () => {
    const note = await createNote(
      ctx.db,
      { clubId: ctx.club.id, title: 'Dress code', slug: 'dress-code', type: 'faq', bodyMd: 'Smart casual.', source: 'manual', status: 'live' },
      { type: 'staff' },
      clock,
    );
    const answerAt = clock;
    const scenario = async (minutesAfter: number) => {
      const { guestId, conversationId } = await conversation();
      await emit(ctx.db, {
        clubId: ctx.club.id,
        type: 'ai.answered',
        occurredAt: answerAt,
        actorType: 'bot',
        dataOrigin: 'first_party',
        guestId,
        conversationId,
        props: { notes_used: 1, topic: 'dress_code' },
        raw: { noteIds: [note.id], snapshotVersion: 1, question: 'dress code?', answer: 'Smart casual.' },
        isTest: true,
      });
      const startAt = new Date(answerAt.getTime() + minutesAfter * MIN);
      const ep = await ctx.db.transaction((tx) =>
        startEpisode(tx, { clubId: ctx.club.id, conversationId, trigger: 'guest_request', reason: null, firstMessageId: null, now: startAt }),
      );
      await ctx.db.transaction((tx) => endEpisode(tx, { episodeId: ep.id, endedBy: 'timeout', now: new Date(startAt.getTime() + MIN) }));
      clock = new Date(startAt.getTime() + 2 * MIN);
      return (await runLearning({ db: ctx.db, client: learn, log: () => {} }, clock)).episodes[0]!;
    };

    expect((await scenario(11)).flagged).toEqual([]);
    let row = (await ctx.db.select().from(brainNotes).where(eq(brainNotes.id, note.id)))[0]!;
    expect((row.frontmatter as Record<string, unknown>).flaggedForReview).toBeUndefined();

    const within = await scenario(10);
    expect(within.flagged).toEqual([note.id]);
    row = (await ctx.db.select().from(brainNotes).where(eq(brainNotes.id, note.id)))[0]!;
    expect((row.frontmatter as Record<string, unknown>).flaggedForReview).toMatchObject({ episodeId: within.episodeId });
    expect(row.reviewBy).toBe('2026-11-27'); // pulled into review today (club night date)
  });

  it('an approved note adds its question to the club test set', async () => {
    drafting = () => goodDraft();
    await takeover('g1', 'can I bring a birthday cake?', 'yes you can');
    await runJob();
    const [draft] = await drafts();
    expect(await clubTestSet(ctx.db, ctx.club.id)).toEqual([]);
    await approveNote(ctx.db, ctx.club.id, draft!.id, { type: 'staff', id: 'user_manager' }, clock);
    const set = await clubTestSet(ctx.db, ctx.club.id);
    expect(set.map((q) => q.question).sort()).toEqual(['Can I bring a birthday cake?', 'can I bring a birthday cake?', 'เอาเค้กวันเกิดมาได้ไหม'].sort());
    expect(set.every((q) => q.noteId === draft!.id && q.source === 'learned')).toBe(true);
  });

  it('a draft unreviewed for 4 weeks expires', async () => {
    drafting = () => goodDraft();
    await takeover('g1', 'can I bring a birthday cake?', 'yes you can');
    await runJob();
    const [draft] = await drafts();
    clock = new Date(clock.getTime() + 27 * DAY);
    await runJob();
    expect(await drafts()).toHaveLength(1);
    clock = new Date(FRIDAY_AFTERNOON.getTime() + 28 * DAY);
    await runJob();
    expect(await drafts()).toHaveLength(0);
    const row = (await ctx.db.select().from(brainNotes).where(eq(brainNotes.id, draft!.id)))[0]!;
    expect(row.status).toBe('retired');
    expect((row.frontmatter as Record<string, unknown>).retiredReason).toBe('unreviewed');
  });

  it('drafting cost is an ai.call event at the claude-opus-5-5 price', async () => {
    drafting = () => goodDraft();
    await takeover('g1', 'can I bring a birthday cake?', 'yes you can');
    await runJob();
    const calls = await ctx.db.select().from(events).where(eq(events.type, 'ai.call'));
    const opus = calls.find((c) => c.props.model === 'claude-opus-5-5')!;
    // 1000 input x $4 + 200 output x $20 per MTok = 8,000 micro-dollars.
    expect(opus.props).toMatchObject({ input_tokens: 1000, output_tokens: 200, cost_usd_micros: 8000 });
  });

  it('a draft on an open gap topic closes the gap once approved', async () => {
    drafting = () => goodDraft();
    // A real (non-test) guest's missed question opens the gap.
    await emit(ctx.db, {
      clubId: ctx.club.id,
      type: 'faq.missed',
      occurredAt: new Date(clock.getTime() - 60 * MIN),
      actorType: 'bot',
      dataOrigin: 'first_party',
      props: { topic: 'birthday_cake' },
      raw: { text: 'can I bring a birthday cake?' },
      isTest: false,
    });
    expect((await listGaps(ctx.db, ctx.club, clock)).map((g) => g.key)).toContain('birthday_cake');
    await takeover('g1', 'can I bring a birthday cake?', 'yes you can');
    await runJob();
    const [draft] = await drafts();
    expect((draft!.frontmatter as Record<string, unknown>).gapTopic).toBe('birthday_cake');
    // Still open while the note is a draft.
    expect((await listGaps(ctx.db, ctx.club, clock)).map((g) => g.key)).toContain('birthday_cake');
    await approveNote(ctx.db, ctx.club.id, draft!.id, { type: 'staff', id: 'user_manager' }, clock);
    expect((await listGaps(ctx.db, ctx.club, clock)).map((g) => g.key)).not.toContain('birthday_cake');
  });

  it('a superseded or rejected learned note stops its test cases, and the newer answer becomes the reference', async () => {
    drafting = () => goodDraft({ title: 'Dress code', question_en: 'dress code?', question_th: '', answer: 'Smart casual.' });
    await takeover('g1', 'dress code?', 'smart casual');
    await runJob();
    const [first] = await drafts();
    await approveNote(ctx.db, ctx.club.id, first!.id, { type: 'staff', id: 'user_manager' }, clock);
    const cases = () => ctx.db.select().from(brainTestCases).where(eq(brainTestCases.clubId, ctx.club.id));
    expect((await cases()).map((c) => [c.question, c.reference, c.sourceNoteId, c.active])).toEqual([['dress code?', learnedBodyOf('dress code?', 'Smart casual.'), first!.id, true]]);

    // A later takeover edits the note: same question, new answer.
    drafting = () => goodDraft({ title: 'Dress code', kind: 'edit', edits_slug: first!.slug, question_en: 'dress code?', question_th: '', answer: 'All black.' });
    clock = new Date(clock.getTime() + 60 * MIN);
    await takeover('g2', 'dress code?', 'all black tonight and every night');
    await runJob();
    const [second] = await drafts();
    expect(second!.supersedesId).toBe(first!.id);
    await approveNote(ctx.db, ctx.club.id, second!.id, { type: 'staff', id: 'user_manager' }, clock);
    expect((await cases()).map((c) => [c.question, c.reference, c.sourceNoteId, c.active])).toEqual([['dress code?', learnedBodyOf('dress code?', 'All black.'), second!.id, true]]);

    // A live edit refreshes the reference; withdrawing the note stops the case.
    await updateNote(ctx.db, ctx.club.id, second!.id, { bodyMd: 'Q: dress code?\n\nAll black, no sneakers.' }, { type: 'staff', id: 'user_manager' }, clock);
    expect((await cases())[0]!.reference).toBe('Q: dress code?\n\nAll black, no sneakers.');
    await rejectNote(ctx.db, ctx.club.id, second!.id, { type: 'staff', id: 'user_manager' }, clock);
    expect((await cases())[0]!.active).toBe(false);
    expect(await clubTestSet(ctx.db, ctx.club.id)).toEqual([]);
  });

  it('a very long guest question can still be approved (stored cut to 500 characters)', async () => {
    drafting = () => goodDraft();
    // A LINE message can be up to 5000 characters (3 bytes each in Thai): past the btree row limit.
    const long = `เอาเค้กวันเกิดมาได้ไหม ${'ก'.repeat(3000)}`;
    const { guestId, conversationId } = await conversation();
    const firstId = await message(guestId, 'in', 'guest', long, clock);
    const lastId = await message(guestId, 'out', 'staff', 'Yes you can.', new Date(clock.getTime() + 1000), 'user_host');
    const ep = await ctx.db.transaction((tx) =>
      startEpisode(tx, { clubId: ctx.club.id, conversationId, trigger: 'guest_request', reason: null, firstMessageId: firstId, now: clock }),
    );
    await ctx.db.update(handoffEpisodes).set({ lastMessageId: lastId }).where(eq(handoffEpisodes.id, ep.id));
    await ctx.db.transaction((tx) => endEpisode(tx, { episodeId: ep.id, endedBy: 'staff', now: clock }));
    await runLearning({ db: ctx.db, client: learn, log: () => {} }, clock);
    const [draft] = await drafts();
    await approveNote(ctx.db, ctx.club.id, draft!.id, { type: 'staff', id: 'user_manager' }, clock);
    const set = await clubTestSet(ctx.db, ctx.club.id);
    expect(set.some((q) => q.question === long.slice(0, 500))).toBe(true);
  });

  it('weekly lint flags a leaked phone number and a contradiction the model finds', async () => {
    const mk = (title: string, slug: string, bodyMd: string) =>
      createNote(ctx.db, { clubId: ctx.club.id, title, slug, type: 'faq', bodyMd, source: 'manual', status: 'live' }, { type: 'staff' }, clock);
    await mk('Dress code', 'dress-code', 'Smart casual.');
    await mk('Shoes', 'shoes', 'Sneakers are fine.');
    await ctx.db.update(brainNotes).set({ bodyMd: 'Ask Joy on 081-234-5678.' }).where(eq(brainNotes.slug, 'shoes'));
    await compileSnapshot(ctx.db, ctx.club.id, clock);
    const lint = fakeLearnClient(
      () => null,
      () => ({ issues: [{ kind: 'contradiction', slugs: ['dress-code', 'shoes', 'made-up'], detail: 'Dress code and shoes disagree.' }] }),
    );
    const monday = new Date('2026-11-30T04:00:00Z'); // Monday 11:00 Bangkok
    await runBrainLint({ db: ctx.db, learn: lint, log: () => {} }, monday);
    await runBrainLint({ db: ctx.db, learn: lint, log: () => {} }, monday); // once per week
    expect(lint.checks).toHaveLength(1);
    const shoes = (await ctx.db.select().from(brainNotes).where(eq(brainNotes.slug, 'shoes')))[0]!;
    const kinds = ((shoes.frontmatter as { lintIssues: { kind: string }[] }).lintIssues ?? []).map((i) => i.kind).sort();
    expect(kinds).toEqual(['contradiction', 'personal_data']);
    const raised = await ctx.db.select().from(alerts).where(and(eq(alerts.clubId, ctx.club.id), eq(alerts.kind, 'brain_lint')));
    expect(raised).toHaveLength(1);
  });
});
