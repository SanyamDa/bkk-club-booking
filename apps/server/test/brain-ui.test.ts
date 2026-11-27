import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Actor } from '../src/bookings/service.js';
import { latestSnapshot } from '../src/brain/compile.js';
import { createNote } from '../src/brain/notes.js';
import { fakeLearnClient } from '../src/bot/deps.js';
import { runLearning } from '../src/brain/learn.js';
import { endEpisode, startEpisode } from '../src/chat/episodes.js';
import { brainNotes, conversations, guests, handoffEpisodes, messages } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { and, eq } from 'drizzle-orm';
import { emit } from '../src/data/events.js';
import type { Db } from '../src/db/client.js';
import type { Club } from '../src/db/schema.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const NOW = FRIDAY_AFTERNOON;
const actor: Actor = { type: 'staff', id: 'user_manager' };

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  app = createApp(testConfig(), db, { bot: { now: () => NOW, log: () => {} } });
});
afterEach(async () => {
  await close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function req(cookie: string, club: Club, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json(): Promise<any> }> {
  const init: RequestInit = { method, headers: { cookie, 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.app.request(staffUrl(club.slug, `/brain${path}`), init);
}

const draft = (club: Club, title: string, bodyMd: string, frontmatter: Record<string, unknown> = {}) =>
  createNote(db, { clubId: club.id, title, type: 'faq', bodyMd, source: 'takeover', frontmatter }, actor, NOW);

/**
 * A real B18 draft: a guest question and a host reply in a takeover on `topic`, resolved by staff,
 * then one learning run with a fake drafter returning `title`/`answer`. `priorTakeovers` earlier
 * takeovers on the same topic (timed out, nothing drafted) raise `frontmatter.takeovers`.
 */
async function learnedDraft(club: Club, o: { topic: string; question: string; hostReply: string; title: string; answer: string; priorTakeovers?: number }) {
  const episodeIn = async (withMessages: boolean) => {
    const guestId = newId();
    await db.insert(guests).values({ id: guestId, clubId: club.id, lineUserId: `U${guestId}`, displayName: 'Queue Guest' });
    const conversationId = newId();
    await db.insert(conversations).values({ id: conversationId, clubId: club.id, guestId, state: {} });
    const q = withMessages ? newId() : null;
    if (q) await db.insert(messages).values({ id: q, clubId: club.id, guestId, direction: 'in', kind: 'text', payload: { type: 'text', text: o.question }, authorType: 'guest', occurredAt: NOW });
    const ep = await db.transaction((tx) => startEpisode(tx, { clubId: club.id, conversationId, trigger: 'guest_request', reason: null, topic: o.topic, firstMessageId: q, now: NOW }));
    if (withMessages) {
      const r = newId();
      await db.insert(messages).values({ id: r, clubId: club.id, guestId, direction: 'out', kind: 'text', payload: { type: 'text', text: o.hostReply }, authorType: 'staff', authorId: 'user_host', occurredAt: NOW });
      await db.update(handoffEpisodes).set({ lastMessageId: r }).where(eq(handoffEpisodes.id, ep.id));
    }
    await db.transaction((tx) => endEpisode(tx, { episodeId: ep.id, endedBy: withMessages ? 'staff' : 'timeout', resolverUserId: 'user_host', now: NOW }));
    return ep;
  };
  for (let i = 0; i < (o.priorTakeovers ?? 0); i++) await episodeIn(false);
  const ep = await episodeIn(true);
  const learn = fakeLearnClient(() => ({
    worth_learning: true,
    kind: 'new',
    edits_slug: null,
    title: o.title,
    question_en: o.question,
    question_th: '',
    answer: o.answer,
    flags: { price_or_availability: false, personal_data: false, one_off: false },
    contradicts: [],
  }));
  await runLearning({ db, client: learn, log: () => {} }, NOW);
  return (await db.select().from(brainNotes).where(and(eq(brainNotes.clubId, club.id), eq(brainNotes.sourceEpisodeId, ep.id))))[0]!;
}

async function missed(club: Club, topic: string | null, text: string, at: Date, isTest = false) {
  await emit(db, {
    clubId: club.id,
    type: 'faq.missed',
    occurredAt: at,
    actorType: 'bot',
    dataOrigin: 'first_party',
    props: { topic },
    raw: { text },
    isTest,
  });
}

describe('B19 brain manager UI', () => {
  it('approve in one tap', async () => {
    const cookie = await staffCookie(app, clubB, 'manager');
    const note = await learnedDraft(clubB, { topic: 'dress_code', question: 'what should I wear?', hostReply: 'smart casual pls', title: 'Dress code', answer: 'Smart casual. No flip-flops.' });
    const queue = await (await req(cookie, clubB, '/queue')).json();
    expect(queue.queue).toHaveLength(1);
    expect(queue.queue[0]).toMatchObject({ id: note.id, question: 'what should I wear?', hostReply: 'smart casual pls' });

    const res = await req(cookie, clubB, `/notes/${note.id}/approve`, 'POST');
    expect(res.status).toBe(200);
    expect((await res.json()).note.status).toBe('live');
    expect((await latestSnapshot(db, clubB.id))?.compiledText).toContain('No flip-flops');
    expect((await (await req(cookie, clubB, '/queue')).json()).queue).toEqual([]);
  });

  it('edit sends validUntil: a cleared end date reaches the server and is not silently kept', async () => {
    const cookie = await staffCookie(app, clubB, 'manager');
    const note = await createNote(db, { clubId: clubB.id, title: 'Ladies night', type: 'event', bodyMd: 'Free entry for ladies before 23:00.', source: 'manual', validUntil: '2026-12-31' }, actor, NOW);
    const body = { title: 'Ladies night', bodyMd: 'Free entry for ladies before 23:00.' };
    // Clearing the date of an event note is a lint error the manager sees, not a save that keeps the old date.
    const cleared = await req(cookie, clubB, `/notes/${note.id}`, 'PATCH', { ...body, validUntil: null });
    expect(cleared.status).toBe(422);
    expect((await cleared.json()).issues.map((i: { code: string }) => i.code)).toContain('event_needs_end_date');
    const moved = await req(cookie, clubB, `/notes/${note.id}`, 'PATCH', { ...body, validUntil: '2027-01-15' });
    expect((await moved.json()).note.validUntil).toBe('2027-01-15');
    // A non-event note may drop its end date.
    const faq = await createNote(db, { clubId: clubB.id, title: 'Winter hours', type: 'faq', bodyMd: 'Open until 03:00.', source: 'manual', validUntil: '2026-12-31' }, actor, NOW);
    const faqRes = await req(cookie, clubB, `/notes/${faq.id}`, 'PATCH', { title: 'Winter hours', bodyMd: 'Open until 03:00.', validUntil: null });
    expect(faqRes.status).toBe(200);
    expect((await faqRes.json()).note.validUntil).toBeNull();
  });

  it('edit creates a version', async () => {
    const cookie = await staffCookie(app, clubB, 'manager');
    const note = await draft(clubB, 'Parking', 'Valet at the front door.');
    const res = await req(cookie, clubB, `/notes/${note.id}`, 'PATCH', { bodyMd: 'Valet at the front door, from 20:00.' });
    expect(res.status).toBe(200);
    expect((await res.json()).note.bodyMd).toBe('Valet at the front door, from 20:00.');
    const versions = (await (await req(cookie, clubB, `/notes/${note.id}/versions`)).json()).versions;
    expect(versions.map((v: { bodyMd: string }) => v.bodyMd)).toEqual(['Valet at the front door.', 'Valet at the front door, from 20:00.']);
  });

  it('gaps list shows unanswered questions', async () => {
    const cookie = await staffCookie(app, clubB, 'manager');
    await missed(clubB, 'dress_code', 'can I wear shorts?', new Date('2026-11-25T15:00:00Z'));
    await missed(clubB, 'parking', 'is there parking?', new Date('2026-11-24T15:00:00Z'));
    await missed(clubB, 'parking', 'where do I park', new Date('2026-11-26T15:00:00Z'));
    await missed(clubB, null, 'Do you have a smoking area?', new Date('2026-11-26T16:00:00Z'));
    await missed(clubB, 'parking', 'old question', new Date('2026-10-01T15:00:00Z')); // older than 30 days
    await missed(clubA, 'parking', 'other club', new Date('2026-11-26T15:00:00Z'));
    const res = await req(cookie, clubB, '/gaps');
    expect(res.status).toBe(200);
    const { gaps } = await res.json();
    expect(gaps[0]).toMatchObject({ key: 'parking', topic: 'parking', count: 2, question: 'where do I park' });
    expect(gaps.map((g: { key: string }) => g.key).sort()).toEqual(['do you have a smoking area?', 'dress_code', 'parking']);
  });

  it('writing an answer to a gap closes it', async () => {
    const cookie = await staffCookie(app, clubB, 'manager');
    await missed(clubB, 'parking', 'is there parking?', new Date('2026-11-26T15:00:00Z'));
    const res = await req(cookie, clubB, '/notes', 'POST', { title: 'Parking', type: 'faq', bodyMd: 'Valet at the front door.', gapTopic: 'parking' });
    expect(res.status).toBe(200);
    const { note } = await res.json();
    expect(note).toMatchObject({ status: 'live', source: 'manual' });
    expect((await (await req(cookie, clubB, '/gaps')).json()).gaps).toEqual([]);
    // Asked again after the answer: the gap opens again.
    await missed(clubB, 'parking', 'parking again?', new Date(NOW.getTime() + 60_000));
    expect((await (await req(cookie, clubB, '/gaps')).json()).gaps).toHaveLength(1);
  });

  it("a live club's gaps exclude test events", async () => {
    const cookieB = await staffCookie(app, clubB, 'manager');
    const cookieA = await staffCookie(app, clubA, 'manager');
    await missed(clubB, 'parking', 'tester asks', new Date('2026-11-26T15:00:00Z'), true);
    await missed(clubA, 'parking', 'demo guest asks', new Date('2026-11-26T15:00:00Z'), true);
    expect((await (await req(cookieB, clubB, '/gaps')).json()).gaps).toEqual([]);
    expect((await (await req(cookieA, clubA, '/gaps')).json()).gaps).toHaveLength(1);
  });

  it('a lint failure returns the issues', async () => {
    const cookie = await staffCookie(app, clubB, 'manager');
    const note = await draft(clubB, 'Tables', 'Ask us about tables.');
    const res = await req(cookie, clubB, `/notes/${note.id}`, 'PATCH', { bodyMd: 'Minimum spend is 5,000 baht.' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('lint');
    expect(body.fix).toBe('prices');
    expect(body.issues.map((i: { code: string }) => i.code)).toContain('price');
  });

  it('queue ranks drafts by takeovers', async () => {
    const cookie = await staffCookie(app, clubB, 'manager');
    const rare = await learnedDraft(clubB, { topic: 'birthday_cake', question: 'can I bring a cake?', hostReply: 'yes', title: 'Birthday cake', answer: 'You may bring a cake.' });
    const common = await learnedDraft(clubB, { topic: 'dress_code', question: 'dress code?', hostReply: 'smart casual', title: 'Dress code', answer: 'Smart casual.', priorTakeovers: 6 });
    expect([rare.frontmatter, common.frontmatter]).toMatchObject([{ takeovers: 1 }, { takeovers: 7 }]);
    const none = await draft(clubB, 'Lockers', 'There are lockers.');
    const { queue } = await (await req(cookie, clubB, '/queue')).json();
    expect(queue.map((q: { id: string }) => q.id)).toEqual([common.id, rare.id, none.id]);
  });

  it('host gets 403', async () => {
    const cookie = await staffCookie(app, clubB, 'host');
    const note = await draft(clubB, 'Parking', 'Valet.');
    expect((await req(cookie, clubB, '/notes')).status).toBe(403);
    expect((await req(cookie, clubB, `/notes/${note.id}/approve`, 'POST')).status).toBe(403);
  });

  it("another club's note is 404", async () => {
    const cookie = await staffCookie(app, clubA, 'manager');
    const note = await draft(clubB, 'Parking', 'Valet.');
    expect((await req(cookie, clubA, `/notes/${note.id}/approve`, 'POST')).status).toBe(404);
    expect((await req(cookie, clubA, `/notes/${note.id}`, 'PATCH', { bodyMd: 'x' })).status).toBe(404);
    expect((await req(cookie, clubA, `/notes/${note.id}/versions`)).status).toBe(404);
    const { notes } = await (await req(cookie, clubA, '/notes')).json();
    expect(notes.some((n: { id: string }) => n.id === note.id)).toBe(false);
  });
});
