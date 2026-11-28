import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ModelClient, ModelReply, ModelRequest } from '../src/brain/answer.js';
import { compileSnapshot } from '../src/brain/compile.js';
import { createNote } from '../src/brain/notes.js';
import { fakeModelClient } from '../src/bot/deps.js';
import { featuresFlagKey } from '../src/platform/features.js';
import type { Db } from '../src/db/client.js';
import { alerts, channels, conversations, events, guests, handoffEpisodes, messages, occupancySnapshots, platformFlags, rawWebhooks, type Club } from '../src/db/schema.js';
import { issueBusynessKey } from '../src/data/busyness.js';
import { emit } from '../src/data/events.js';
import { chatwootFlagKey, type ChatwootClubState } from '../src/integrations/chatwoot/provision.js';
import { instagramFlagKey, instagramState, instagramWebhookPath } from '../src/integrations/chatwoot/instagram.js';
import { replayUnprocessed } from '../src/http/webhook.js';
import { runHandoffTimeouts, HANDOFF_REALERT_KIND } from '../src/jobs/handoff-timeout.js';
import { encryptSecret } from '../src/platform/crypto.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { adminCookie, testConfig } from './helpers/track-a.js';

const CW_URL = 'http://chatwoot.test';
const PLATFORM_TOKEN = 'platform-app-token-ig01';

type Inbox = { id: number; name: string; channel_type: string; instagram_id?: string | null };

/** In-memory Chatwoot account API: inbox listing (the Instagram inbox appears once OAuth is done in Chatwoot's UI) and account webhooks. */
function fakeChatwoot() {
  let seq = 900;
  const inboxes = new Map<number, Inbox[]>();
  const webhooks: { id: number; accountId: number; url: string; subscriptions: string[]; token: string | null }[] = [];
  const posts: { id: number; accountId: number; conversationId: number; content: string; messageType: string; token: string | null }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const token = new Headers(init.headers).get('api_access_token');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/v1\/accounts\/(\d+)\/inboxes$/.exec(url.pathname)) && method === 'GET') {
      return json({ payload: inboxes.get(Number(m[1])) ?? [] });
    }
    if ((m = /^\/api\/v1\/accounts\/(\d+)\/webhooks$/.exec(url.pathname)) && method === 'POST') {
      const w = { id: ++seq, accountId: Number(m[1]), url: body.url, subscriptions: body.subscriptions, token };
      webhooks.push(w);
      return json({ payload: { webhook: { id: w.id, url: w.url, subscriptions: w.subscriptions } } });
    }
    if ((m = /^\/api\/v1\/accounts\/(\d+)\/conversations\/(\d+)\/messages$/.exec(url.pathname)) && method === 'POST') {
      const posted = { id: ++seq, accountId: Number(m[1]), conversationId: Number(m[2]), content: body.content as string, messageType: body.message_type as string, token };
      posts.push(posted);
      return json({ id: posted.id });
    }
    return json({ error: `unhandled ${method} ${url.pathname}` }, 404);
  }) as typeof fetch;
  return {
    fetchImpl,
    webhooks,
    /** Messages we posted into Chatwoot conversations (the bot's Instagram replies). */
    posts,
    /** What finishing Instagram's login screen inside Chatwoot leaves behind. */
    addInstagramInbox(accountId: number, id: number, instagramId = `1784${id}`) {
      const list = inboxes.get(accountId) ?? [];
      list.push({ id, name: 'Instagram', channel_type: 'Channel::Instagram', instagram_id: instagramId });
      inboxes.set(accountId, list);
    },
    addApiInbox(accountId: number, id: number) {
      const list = inboxes.get(accountId) ?? [];
      list.push({ id, name: 'LINE', channel_type: 'Channel::Api' });
      inboxes.set(accountId, list);
    },
  };
}

const ACCOUNT = { a: 501, b: 601 };
const LINE_INBOX = { a: 11, b: 21 };
const IG_INBOX = { a: 12, b: 22 };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function seedProvisioned(db: Db, key: Buffer, club: Club, accountId: number, lineInboxId: number) {
  const state: ChatwootClubState = {
    accountId,
    adminUserId: accountId + 1,
    adminTokenEnc: encryptSecret(`admin-token-${club.id}`, key),
    adminLinked: true,
    inboxId: lineInboxId,
    agentBotId: accountId + 2,
    botAttached: true,
    dashboardAppId: accountId + 3,
    provisionedAt: FRIDAY_AFTERNOON.toISOString(),
  };
  await db.insert(platformFlags).values({ key: chatwootFlagKey(club.id), value: state, updatedBy: 'test', updatedAt: FRIDAY_AFTERNOON });
}

async function setup(opts: { chatwoot?: boolean; provisioned?: boolean; ai?: ModelClient } = {}) {
  const t = await setupTwoClubs();
  close = t.close;
  const cw = fakeChatwoot();
  const config = opts.chatwoot === false ? testConfig() : testConfig({ CHATWOOT_URL: CW_URL, CHATWOOT_PLATFORM_TOKEN: PLATFORM_TOKEN });
  const app = createApp(config, t.db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {}, ...(opts.ai ? { ai: opts.ai } : {}) }, chatwootFetch: cw.fetchImpl });
  if (opts.provisioned !== false) {
    await seedProvisioned(t.db, config.CREDENTIALS_KEY, t.clubA, ACCOUNT.a, LINE_INBOX.a);
    await seedProvisioned(t.db, config.CREDENTIALS_KEY, t.clubB, ACCOUNT.b, LINE_INBOX.b);
    cw.addApiInbox(ACCOUNT.a, LINE_INBOX.a);
    cw.addApiInbox(ACCOUNT.b, LINE_INBOX.b);
  }
  const cookie = await adminCookie(app);
  return { ...t, cw, app, cookie };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const connect = (s: Setup, slug: string, body: unknown = {}) =>
  s.app.app.request(`/api/admin/clubs/${slug}/instagram/connect`, {
    method: 'POST',
    headers: { cookie: s.cookie, 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
  });

/** The token Chatwoot was given in the webhook URL for this account. */
function webhookToken(s: Setup, accountId: number): string {
  const w = s.cw.webhooks.find((x) => x.accountId === accountId);
  if (!w) throw new Error(`no webhook for account ${accountId}`);
  return new URL(w.url).searchParams.get('token')!;
}

function messageCreated(over: { accountId: number; inboxId: number; id?: number; content?: string | null; type?: string; attachments?: unknown[]; sourceId?: string }) {
  return {
    event: 'message_created',
    id: over.id ?? 7001,
    content: over.content === undefined ? 'Do you have a table for 6 on Friday?' : over.content,
    message_type: over.type ?? 'incoming',
    content_type: 'text',
    private: false,
    created_at: '2026-11-27T08:00:00.000Z',
    source_id: `ig-mid-${over.id ?? 7001}`,
    sender: { id: 3301, name: 'nightowl.bkk', type: 'contact' },
    attachments: over.attachments ?? [],
    conversation: { id: 44, inbox_id: over.inboxId, contact_inbox: { source_id: over.sourceId ?? 'igsid-555' } },
    inbox: { id: over.inboxId, name: 'Instagram' },
    account: { id: over.accountId, name: 'Club' },
  };
}

const deliver = (s: Setup, clubId: string, token: string | null, body: unknown) =>
  s.app.app.request(`${instagramWebhookPath(clubId)}${token === null ? '' : `?token=${encodeURIComponent(token)}`}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function connected(opts: { ai?: ModelClient } = {}) {
  const s = await setup(opts);
  s.cw.addInstagramInbox(ACCOUNT.a, IG_INBOX.a, '17841400000001');
  s.cw.addInstagramInbox(ACCOUNT.b, IG_INBOX.b, '17841400000002');
  expect((await connect(s, s.clubA.slug)).status).toBe(200);
  expect((await connect(s, s.clubB.slug)).status).toBe(200);
  return s;
}

const igEvents = (db: Db, clubId: string) => db.select().from(events).where(and(eq(events.clubId, clubId), eq(events.dataOrigin, 'instagram')));

describe('A18 Instagram connect (spec §11.5)', () => {
  it("connect links the club's Chatwoot Instagram inbox, registers a token webhook and marks the channels row", async () => {
    const s = await setup();
    s.cw.addInstagramInbox(ACCOUNT.a, IG_INBOX.a, '17841400000001');
    const res = await connect(s, s.clubA.slug);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.instagram).toMatchObject({ status: 'connected', inboxId: IG_INBOX.a, instagramId: '17841400000001' });
    expect(JSON.stringify(body)).not.toContain('token');

    expect(s.cw.webhooks).toHaveLength(1);
    const w = s.cw.webhooks[0]!;
    expect(w.accountId).toBe(ACCOUNT.a);
    expect(w.subscriptions).toEqual(['message_created', 'conversation_status_changed']);
    expect(w.token).toBe(`admin-token-${s.clubA.id}`);
    expect(new URL(w.url).pathname).toBe(instagramWebhookPath(s.clubA.id));
    expect(webhookToken(s, ACCOUNT.a).length).toBeGreaterThanOrEqual(32);

    const [ch] = await s.db.select().from(channels).where(and(eq(channels.clubId, s.clubA.id), eq(channels.kind, 'instagram')));
    expect(ch).toMatchObject({ externalId: '17841400000001', status: 'connected' });
    expect(ch!.connectedAt?.toISOString()).toBe(FRIDAY_AFTERNOON.toISOString());

    const state = await instagramState(s.db, s.clubA.id);
    expect(state?.inboxId).toBe(IG_INBOX.a);
    // Only a hash of the webhook token is stored.
    expect(JSON.stringify(state)).not.toContain(webhookToken(s, ACCOUNT.a));
    expect(await instagramState(s.db, s.clubB.id)).toBeNull();
  });

  it('connect is idempotent: a second call registers no second webhook', async () => {
    const s = await setup();
    s.cw.addInstagramInbox(ACCOUNT.a, IG_INBOX.a);
    expect((await connect(s, s.clubA.slug)).status).toBe(200);
    expect((await connect(s, s.clubA.slug)).status).toBe(200);
    expect(s.cw.webhooks).toHaveLength(1);
    const rows = await s.db.select().from(channels).where(eq(channels.clubId, s.clubA.id));
    expect(rows.filter((r) => r.kind === 'instagram')).toHaveLength(1);
  });

  it('connect answers 409 instagram_inbox_missing until Instagram login is finished in Chatwoot', async () => {
    const s = await setup();
    const res = await connect(s, s.clubA.slug);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('instagram_inbox_missing');
    expect(s.cw.webhooks).toHaveLength(0);
    expect(await s.db.select().from(channels).where(and(eq(channels.clubId, s.clubA.id), eq(channels.kind, 'instagram')))).toHaveLength(0);
  });

  it('connect with an inboxId that is not an Instagram inbox of this account answers 409', async () => {
    const s = await setup();
    s.cw.addInstagramInbox(ACCOUNT.b, IG_INBOX.b);
    expect((await connect(s, s.clubA.slug, { inboxId: IG_INBOX.b })).status).toBe(409);
    expect((await connect(s, s.clubA.slug, { inboxId: LINE_INBOX.a })).status).toBe(409);
  });

  it('connect answers 409 inbox_not_provisioned without an A13 account, and 503 when Chatwoot is not configured', async () => {
    const s = await setup({ provisioned: false });
    const res = await connect(s, s.clubA.slug);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('inbox_not_provisioned');
    await close?.();
    const s2 = await setup({ chatwoot: false });
    expect((await connect(s2, s2.clubA.slug)).status).toBe(503);
  });

  it('GET instagram status shows not_connected, then connected', async () => {
    const s = await setup();
    const get = () => s.app.app.request(`/api/admin/clubs/${s.clubA.slug}/instagram`, { headers: { cookie: s.cookie } });
    expect((await (await get()).json() as any).instagram.status).toBe('not_connected');
    s.cw.addInstagramInbox(ACCOUNT.a, IG_INBOX.a);
    await connect(s, s.clubA.slug);
    expect((await (await get()).json() as any).instagram).toMatchObject({ status: 'connected', inboxId: IG_INBOX.a });
  });
});

describe('A18 Instagram webhook (message_created)', () => {
  it("an incoming Instagram message lands as a message and an instagram-origin message.received event of that club only", async () => {
    const s = await connected();
    const res = await deliver(s, s.clubA.id, webhookToken(s, ACCOUNT.a), messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a }));
    expect(res.status).toBe(200);
    expect((await res.json() as any).applied).toBe('recorded');

    const msgs = await s.db.select().from(messages).where(eq(messages.clubId, s.clubA.id));
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(m).toMatchObject({ direction: 'in', kind: 'text', authorType: 'guest', externalId: `cw:${ACCOUNT.a}:7001` });
    expect((m.payload as any).text).toBe('Do you have a table for 6 on Friday?');

    const [ch] = await s.db.select().from(channels).where(and(eq(channels.clubId, s.clubA.id), eq(channels.kind, 'instagram')));
    expect(m.channelId).toBe(ch!.id);
    const [guest] = await s.db.select().from(guests).where(eq(guests.id, m.guestId!));
    expect(guest).toMatchObject({ clubId: s.clubA.id, channelId: ch!.id, externalUserId: 'igsid-555', lineUserId: null });
    const [conv] = await s.db.select().from(conversations).where(eq(conversations.guestId, guest!.id));
    expect(conv?.externalRef).toBe(`cw:${ACCOUNT.a}:44`);

    const evs = await igEvents(s.db, s.clubA.id);
    const received = evs.filter((e) => e.type === 'message.received');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ channel: 'instagram', dataOrigin: 'instagram', actorType: 'guest', guestId: guest!.id, conversationId: conv!.id });
    // Every event this delivery wrote is tagged instagram at the source (§14.8).
    const all = await s.db.select().from(events).where(eq(events.guestId, guest!.id));
    expect(all.every((e) => e.dataOrigin === 'instagram' && e.channel === 'instagram')).toBe(true);
    expect(await s.db.select().from(messages).where(eq(messages.clubId, s.clubB.id))).toHaveLength(0);
    expect(await igEvents(s.db, s.clubB.id)).toHaveLength(0);

    // Raw delivery kept (B3's raw_webhooks writer).
    const raws = await s.db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, s.clubA.id));
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ channel: 'chatwoot:instagram', signatureOk: true });
  });

  it('an attachment-only message is recorded with its attachments', async () => {
    const s = await connected();
    const attachments = [{ file_type: 'image', data_url: 'https://cdn.example/ig/1.jpg' }];
    await deliver(s, s.clubA.id, webhookToken(s, ACCOUNT.a), messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a, content: null, attachments }));
    const [m] = await s.db.select().from(messages).where(eq(messages.clubId, s.clubA.id));
    expect(m?.kind).toBe('attachment');
    expect((m!.payload as any).attachments).toEqual([{ type: 'image', url: 'https://cdn.example/ig/1.jpg' }]);
  });

  it('a redelivered message is recorded once', async () => {
    const s = await connected();
    const token = webhookToken(s, ACCOUNT.a);
    const body = messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a });
    expect((await (await deliver(s, s.clubA.id, token, body)).json() as any).applied).toBe('recorded');
    expect((await (await deliver(s, s.clubA.id, token, body)).json() as any).applied).toBe('duplicate');
    expect(await s.db.select().from(messages).where(eq(messages.clubId, s.clubA.id))).toHaveLength(1);
    expect((await igEvents(s.db, s.clubA.id)).filter((e) => e.type === 'message.received')).toHaveLength(1);
    // A second message from the same contact reuses the guest and conversation.
    await deliver(s, s.clubA.id, token, messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a, id: 7002 }));
    expect(await s.db.select().from(guests).where(and(eq(guests.clubId, s.clubA.id), eq(guests.externalUserId, 'igsid-555')))).toHaveLength(1);
  });

  it('a missing or wrong token is 401 and records nothing; club B token does not open club A', async () => {
    const s = await connected();
    const body = messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a });
    expect((await deliver(s, s.clubA.id, null, body)).status).toBe(401);
    expect((await deliver(s, s.clubA.id, 'x'.repeat(43), body)).status).toBe(401);
    expect((await deliver(s, s.clubA.id, webhookToken(s, ACCOUNT.b), body)).status).toBe(401);
    expect(await s.db.select().from(messages)).toHaveLength(0);
    expect(await s.db.select().from(events).where(eq(events.dataOrigin, 'instagram'))).toHaveLength(0);
  });

  it('an unknown club, or a club with no Instagram connection, is 404', async () => {
    const s = await setup();
    expect((await deliver(s, 'club_nope', 'x', {})).status).toBe(404);
    expect((await deliver(s, s.clubA.id, 'x', {})).status).toBe(404);
  });

  it("events of another inbox (the LINE API inbox), another account, outgoing or private messages are ignored", async () => {
    const s = await connected();
    const token = webhookToken(s, ACCOUNT.a);
    const ignored = [
      messageCreated({ accountId: ACCOUNT.a, inboxId: LINE_INBOX.a }),
      messageCreated({ accountId: ACCOUNT.b, inboxId: IG_INBOX.a }),
      messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a, type: 'outgoing' }),
      { ...messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a }), private: true },
      { ...messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a }), event: 'conversation_updated' },
    ];
    for (const body of ignored) {
      const res = await deliver(s, s.clubA.id, token, body);
      expect(res.status).toBe(200);
      expect((await res.json() as any).applied).toBe('ignored');
    }
    expect(await s.db.select().from(messages)).toHaveLength(0);
  });

  it('the delivery goes through the B3 raw_webhooks writer and is marked processed', async () => {
    const s = await connected();
    const token = webhookToken(s, ACCOUNT.a);
    await deliver(s, s.clubA.id, token, messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a }));
    await deliver(s, s.clubA.id, token, messageCreated({ accountId: ACCOUNT.a, inboxId: LINE_INBOX.a })); // ignored, still processed
    const raws = await s.db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, s.clubA.id));
    expect(raws).toHaveLength(2);
    expect(raws.every((r) => r.channel === 'chatwoot:instagram' && r.signatureOk && r.processedAt !== null && r.error === null)).toBe(true);
    // Not a LINE delivery: start-up replay never picks it up.
    expect(await replayUnprocessed(s.app.ctx, new Date(Date.now() + 3_600_000))).toBe(0);
  });
});

describe('A18 + B16: an Instagram message from a guest reaches the club brain', () => {
  const reply = (input: Record<string, unknown>): Partial<ModelReply> => ({
    toolCalls: [{ name: 'reply', input: { answer: '', lang: 'en', notes_used: [], topic: 'other', needs_handoff: false, unclear: false, summary: '', ...input } }],
  });

  async function aiConnected(respond: (req: ModelRequest) => Partial<ModelReply>) {
    const model = fakeModelClient(respond);
    const s = await connected({ ai: model });
    await s.db.insert(platformFlags).values({ key: featuresFlagKey(s.clubA.id), value: { instagram: true, ai_answers: true } });
    await s.db.update(channels).set({ externalId: '@velora' }).where(and(eq(channels.clubId, s.clubA.id), eq(channels.kind, 'line')));
    await createNote(
      s.db,
      { clubId: s.clubA.id, title: 'Dress code', slug: 'dress-code', type: 'policy', bodyMd: 'Smart casual. No flip-flops.', source: 'manual', status: 'live' },
      { type: 'staff' },
      FRIDAY_AFTERNOON,
    );
    await compileSnapshot(s.db, s.clubA.id, FRIDAY_AFTERNOON);
    const say = async (id: number, content: string) => {
      const res = await deliver(s, s.clubA.id, webhookToken(s, ACCOUNT.a), messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a, id, content }));
      expect(res.status).toBe(200);
      return (await res.json()) as { applied: string; answer?: string };
    };
    return { ...s, model, say };
  }

  it("answers from the club's brain snapshot and sends the reply back through Chatwoot, tagged instagram", async () => {
    const s = await aiConnected(() => reply({ answer: 'Smart casual, please. No flip-flops.', notes_used: ['dress-code'], topic: 'dress_code' }));
    expect(await s.say(7101, 'What is the dress code?')).toMatchObject({ applied: 'recorded', answer: 'answered' });

    expect(s.model.calls).toHaveLength(1);
    expect(s.model.calls[0]!.brain).toContain('No flip-flops');
    expect(s.model.calls[0]!.userContent).toContain('What is the dress code?');

    // Posted into the guest's Chatwoot conversation (44) of club A's account, as the bot.
    expect(s.cw.posts).toEqual([expect.objectContaining({ accountId: ACCOUNT.a, conversationId: 44, content: 'Smart casual, please. No flip-flops.', messageType: 'outgoing' })]);
    const [ig] = await s.db.select().from(channels).where(and(eq(channels.clubId, s.clubA.id), eq(channels.kind, 'instagram')));
    const out = await s.db.select().from(messages).where(and(eq(messages.clubId, s.clubA.id), eq(messages.direction, 'out')));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ authorType: 'bot', channelId: ig!.id, deliveryStatus: 'sent', externalId: `cw:${ACCOUNT.a}:${s.cw.posts[0]!.id}` });

    const evs = await s.db.select().from(events).where(eq(events.clubId, s.clubA.id));
    const answered = evs.filter((e) => e.type === 'ai.answered');
    expect(answered).toHaveLength(1);
    expect((answered[0]!.raw as { noteIds: string[] }).noteIds).toHaveLength(1);
    expect(evs.filter((e) => e.type === 'ai.call')).toHaveLength(1);
    // Every event of the Instagram guest is tagged instagram at the source (§14.8).
    const guestEvents = evs.filter((e) => e.guestId === out[0]!.guestId);
    expect(guestEvents.length).toBeGreaterThan(2);
    expect(guestEvents.every((e) => e.dataOrigin === 'instagram' && e.channel === 'instagram')).toBe(true);
    // Chatwoot's echo of our own reply comes back as outgoing and is ignored.
    const echo = await deliver(s, s.clubA.id, webhookToken(s, ACCOUNT.a), messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a, id: s.cw.posts[0]!.id, type: 'outgoing' }));
    // Its row already exists (same Chatwoot message id), so nothing new is stored.
    expect(((await echo.json()) as { applied: string }).applied).toBe('duplicate');
    expect(await s.db.select().from(messages).where(and(eq(messages.clubId, s.clubA.id), eq(messages.direction, 'out')))).toHaveLength(1);
  });

  it('no answer in the brain: faq.missed, a takeover with an urgent alert, the ack through Chatwoot, then quiet', async () => {
    const s = await aiConnected(() => reply({ needs_handoff: true, topic: 'private_room', summary: 'Asks about private room hire.' }));
    expect((await s.say(7201, 'Can I rent a private room for 20?')).answer).toBe('handoff');

    const evs = await s.db.select().from(events).where(eq(events.clubId, s.clubA.id));
    const missed = evs.filter((e) => e.type === 'faq.missed');
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ dataOrigin: 'instagram', channel: 'instagram', props: { topic: 'private_room' } });
    expect(evs.find((e) => e.type === 'handoff.requested')).toMatchObject({ dataOrigin: 'instagram', channel: 'instagram' });

    const [ep] = await s.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.clubId, s.clubA.id));
    expect(ep).toMatchObject({ trigger: 'faq_missed', topic: 'private_room', endedAt: null });
    const [conv] = await s.db.select().from(conversations).where(eq(conversations.id, ep!.conversationId));
    expect(conv!.mode).toBe('human');
    const [alert] = await s.db.select().from(alerts).where(eq(alerts.clubId, s.clubA.id));
    expect(alert).toMatchObject({ level: 'urgent', kind: 'bot_unanswered', conversationId: conv!.id });
    expect(alert!.textEn).toContain('Asks about private room hire.');
    expect(s.cw.posts.map((p) => p.content)).toEqual(['Got it, a host will reply here shortly.']);

    // A host has the chat: the next message gets no bot reply and no model call.
    expect((await s.say(7202, 'Hello?')).answer).toBe('quiet');
    expect(s.model.calls).toHaveLength(1);
    expect(s.cw.posts).toHaveLength(1);
  });

  it('a host reply on Instagram is recorded as staff activity: no false re-alert, no timeout; resolving ends the takeover', async () => {
    const s = await aiConnected(() => reply({ needs_handoff: true, topic: 'private_room', summary: 'Asks about private room hire.' }));
    expect((await s.say(7211, 'Can I rent a private room for 20?')).answer).toBe('handoff');
    const [ep] = await s.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.clubId, s.clubA.id));
    const timeoutMs = s.clubA.settings.handoffTimeoutMinutes * 60_000;
    const token = webhookToken(s, ACCOUNT.a);

    // Our own bot post (the ack) coming back as an echo is not a host reply.
    const echo = { ...messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a, id: 7212, content: 'Got it', type: 'outgoing' }), sender: { id: 1, type: 'agent_bot' } };
    expect(((await (await deliver(s, s.clubA.id, token, echo)).json()) as any).applied).toBe('ignored');

    // A host replies from Chatwoot late in the takeover.
    const hostAt = new Date(FRIDAY_AFTERNOON.getTime() + timeoutMs * 0.8);
    const host = {
      ...messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a, id: 7213, content: 'Yes, the private room fits 20.', type: 'outgoing' }),
      sender: { id: 4401, name: 'Host', type: 'user' },
      created_at: hostAt.toISOString(),
    };
    expect(((await (await deliver(s, s.clubA.id, token, host)).json()) as any).applied).toBe('recorded');
    expect(((await (await deliver(s, s.clubA.id, token, host)).json()) as any).applied).toBe('duplicate');
    const staff = await s.db.select().from(messages).where(and(eq(messages.clubId, s.clubA.id), eq(messages.authorType, 'staff')));
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ direction: 'out', externalId: `cw:${ACCOUNT.a}:7213` });
    const replied = await s.db.select().from(events).where(and(eq(events.clubId, s.clubA.id), eq(events.type, 'host.replied')));
    expect(replied).toHaveLength(1);
    expect(replied[0]).toMatchObject({ channel: 'instagram', dataOrigin: 'instagram' });
    expect(s.cw.posts).toHaveLength(1); // the reply is never re-sent through Chatwoot

    // Past the half and full timeout counted from the episode start, but inside it from the host reply.
    const later = new Date(FRIDAY_AFTERNOON.getTime() + timeoutMs * 1.2);
    expect(await runHandoffTimeouts(s.db, later)).toEqual({ realerted: [], ended: [] });
    expect(await s.db.select().from(alerts).where(and(eq(alerts.clubId, s.clubA.id), eq(alerts.kind, HANDOFF_REALERT_KIND)))).toHaveLength(0);
    const [still] = await s.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.id, ep!.id));
    expect(still!.endedAt).toBeNull();

    // Resolving in Chatwoot gives the chat back to the bot.
    const resolved = { event: 'conversation_status_changed', id: 44, status: 'resolved', inbox_id: IG_INBOX.a, account: { id: ACCOUNT.a } };
    expect(((await (await deliver(s, s.clubA.id, token, resolved)).json()) as any).applied).toBe('resolved');
    const [done] = await s.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.id, ep!.id));
    expect(done!.endedAt).not.toBeNull();
    const [conv] = await s.db.select().from(conversations).where(eq(conversations.id, ep!.conversationId));
    expect(conv!.mode).toBe('bot');
  });

  it("a booking request gets the counted link to the club's LINE account, with no model call", async () => {
    const s = await aiConnected(() => reply({ answer: 'unused' }));
    expect((await s.say(7301, 'book a table')).answer).toBe('line_link');
    expect(s.model.calls).toHaveLength(0);
    const text = s.cw.posts[0]!.content;
    const url = /http\S+\/r\/\S+/.exec(text)?.[0];
    expect(url).toBeTruthy();
    const res = await s.app.app.request(new URL(url!).pathname);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://line.me/R/ti/p/%40velora');
    const opened = await s.db.select().from(events).where(and(eq(events.clubId, s.clubA.id), eq(events.type, 'link.opened')));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ source: 'instagram', props: { kind: 'line' } });
  });

  it("the guard keeps an invented price out of an Instagram answer", async () => {
    const s = await aiConnected(() => reply({ answer: 'The VIP table is 15,000 baht minimum spend.', topic: 'vip_price' }));
    expect((await s.say(7401, 'how much is vip?')).answer).toBe('line_link');
    expect(s.cw.posts).toHaveLength(1);
    expect(s.cw.posts[0]!.content).not.toContain('15,000');
    expect(s.cw.posts[0]!.content).toContain('LINE');
  });

  it("with the club's instagram switch off the message is recorded and the bot stays quiet", async () => {
    const s = await aiConnected(() => reply({ answer: 'Hi' }));
    await s.db.update(platformFlags).set({ value: { instagram: false } }).where(eq(platformFlags.key, featuresFlagKey(s.clubA.id)));
    expect(await s.say(7501, 'hello')).toMatchObject({ applied: 'recorded', answer: 'off' });
    expect(s.model.calls).toHaveLength(0);
    expect(s.cw.posts).toHaveLength(0);
  });

  it("with the club's ai_answers switch off the message is recorded and no model call is made", async () => {
    const s = await aiConnected(() => reply({ answer: 'Hi' }));
    await s.db.update(platformFlags).set({ value: { instagram: true } }).where(eq(platformFlags.key, featuresFlagKey(s.clubA.id)));
    expect(await s.say(7551, 'hello')).toMatchObject({ applied: 'recorded', answer: 'off' });
    expect(s.model.calls).toHaveLength(0);
    expect(s.cw.posts).toHaveLength(0);
  });

  it('with no model client the message is recorded and the bot stays quiet, with no alert', async () => {
    const s = await connected();
    await s.db.insert(platformFlags).values({ key: featuresFlagKey(s.clubA.id), value: { instagram: true, ai_answers: true } });
    const res = await deliver(s, s.clubA.id, webhookToken(s, ACCOUNT.a), messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a, id: 7601, content: 'What is the dress code?' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: 'recorded', answer: 'off' });
    expect(s.cw.posts).toHaveLength(0);
    expect(await s.db.select().from(alerts).where(eq(alerts.clubId, s.clubA.id))).toHaveLength(0);
    const inbound = await s.db.select().from(messages).where(and(eq(messages.clubId, s.clubA.id), eq(messages.direction, 'in')));
    expect(inbound).toHaveLength(1);
  });
});

describe('A18 §14.8: Instagram data stays with its club', () => {
  it('data health and the cross-club event stream leave out instagram-origin events; the club-scoped stream keeps them', async () => {
    const s = await connected();
    await deliver(s, s.clubA.id, webhookToken(s, ACCOUNT.a), messageCreated({ accountId: ACCOUNT.a, inboxId: IG_INBOX.a }));
    // One first-party event in club A, so the club is not silent.
    await emit(s.db, { clubId: s.clubA.id, type: 'availability.searched', occurredAt: FRIDAY_AFTERNOON, actorType: 'guest', channel: 'liff', dataOrigin: 'first_party', isTest: false });
    // Club B only has Instagram events: health must show it as silent.
    await deliver(s, s.clubB.id, webhookToken(s, ACCOUNT.b), messageCreated({ accountId: ACCOUNT.b, inboxId: IG_INBOX.b, id: 8001 }));
    expect((await igEvents(s.db, s.clubB.id)).length).toBeGreaterThan(0);

    const health = await (await s.app.app.request('/api/admin/data/health', { headers: { cookie: s.cookie } })).json() as any;
    const a = health.clubs.find((c: any) => c.slug === s.clubA.slug);
    const b = health.clubs.find((c: any) => c.slug === s.clubB.slug);
    expect(a.eventsToday).toBe(1);
    expect(a.eventsPerDay.reduce((n: number, d: any) => n + d.count, 0)).toBe(1);
    expect(b.eventsToday).toBe(0);
    expect(b.lastEventAt).toBeNull();
    // Club B's only guests come from Instagram: they are not counted, so there is no notice share.
    expect((await s.db.select().from(guests).where(eq(guests.clubId, s.clubB.id))).length).toBeGreaterThan(0);
    expect(b.noticeShare).toBeNull();

    // The cross-club club list does not show Instagram-only inbound activity.
    const list = await (await s.app.app.request('/api/admin/clubs', { headers: { cookie: s.cookie } })).json() as any;
    expect(list.clubs.find((c: any) => c.slug === s.clubB.slug).lastInboundAt).toBeNull();

    const cross = await (await s.app.app.request('/api/admin/events', { headers: { cookie: s.cookie } })).json() as any;
    expect(cross.events.length).toBeGreaterThan(0);
    expect(cross.events.some((e: any) => e.dataOrigin === 'instagram')).toBe(false);

    const scoped = await (await s.app.app.request(`/api/admin/events?club=${s.clubA.slug}`, { headers: { cookie: s.cookie } })).json() as any;
    expect(scoped.events.some((e: any) => e.dataOrigin === 'instagram')).toBe(true);
  });

  it('the Metabase analytics view leaves out instagram-origin rows (B14)', async () => {
    const s = await connected();
    await deliver(s, s.clubB.id, webhookToken(s, ACCOUNT.b), messageCreated({ accountId: ACCOUNT.b, inboxId: IG_INBOX.b, id: 8101 }));
    await emit(s.db, { clubId: s.clubB.id, type: 'availability.searched', occurredAt: FRIDAY_AFTERNOON, actorType: 'guest', channel: 'liff', dataOrigin: 'first_party', isTest: false });
    const ig = await igEvents(s.db, s.clubB.id);
    expect(ig.length).toBeGreaterThan(0);
    const seen = (await s.db.execute(sql`select id, data_origin, channel from analytics.events where club_id = ${s.clubB.id}`)).rows as { id: string; data_origin: string; channel: string | null }[];
    expect(seen.map((r) => r.data_origin)).toEqual(['first_party']);
    expect(seen.some((r) => ig.some((e) => e.id === r.id))).toBe(false);
  });

  it('the busyness feed leaves out instagram-origin rows', async () => {
    const { db, close, clubB } = await setupTwoClubs();
    try {
      const night = '2026-12-11'; // a Friday, open
      const now = new Date('2026-12-11T23:10:00+07:00');
      const app = createApp(testConfig(), db, { bot: { now: () => now, log: () => {} } });
      await db.insert(occupancySnapshots).values({
        clubId: clubB.id,
        nightDate: night,
        takenAt: new Date('2026-12-11T23:00:00+07:00'),
        leadBucket: 'live_2300',
        tablesActive: 4,
        tablesHeld: 0,
        tablesConfirmed: 2,
        tablesArrived: 0,
        paxBooked: 20,
        minSpendBookedSatang: 0,
        depositsVerifiedSatang: 0,
      });
      const { token } = await issueBusynessKey(db, { label: 'app', kind: 'production' }, 'user_admin', now);
      const read = async () => {
        const res = await app.app.request('/data/v1/busyness', { headers: { authorization: `Bearer ${token}` } });
        const body = (await res.json()) as any;
        return { ...body, generatedAt: null };
      };
      const before = await read();
      // Instagram demand for the same night (a table search made in an Instagram DM).
      await emit(db, {
        clubId: clubB.id,
        type: 'availability.searched',
        occurredAt: new Date('2026-12-11T20:00:00+07:00'),
        actorType: 'guest',
        channel: 'instagram',
        dataOrigin: 'instagram',
        nightDate: night,
        props: { night_date: night, pax_range: '2-4', result_count: 0, tables_shown: 0 },
        isTest: false,
      });
      const after = await read();
      expect(after).toEqual(before);
      const b = after.clubs.find((c: any) => c.slug === clubB.slug);
      expect(b.buckets.some((x: any) => x.inputs.includes('searches'))).toBe(false);
    } finally {
      await close();
    }
  });
});
