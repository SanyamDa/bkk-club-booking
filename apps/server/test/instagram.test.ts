import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { channels, conversations, events, guests, messages, platformFlags, rawWebhooks, type Club } from '../src/db/schema.js';
import { emit } from '../src/data/events.js';
import { chatwootFlagKey, type ChatwootClubState } from '../src/integrations/chatwoot/provision.js';
import { instagramFlagKey, instagramState, instagramWebhookPath } from '../src/integrations/chatwoot/instagram.js';
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
    return json({ error: `unhandled ${method} ${url.pathname}` }, 404);
  }) as typeof fetch;
  return {
    fetchImpl,
    webhooks,
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

async function setup(opts: { chatwoot?: boolean; provisioned?: boolean } = {}) {
  const t = await setupTwoClubs();
  close = t.close;
  const cw = fakeChatwoot();
  const config = opts.chatwoot === false ? testConfig() : testConfig({ CHATWOOT_URL: CW_URL, CHATWOOT_PLATFORM_TOKEN: PLATFORM_TOKEN });
  const app = createApp(config, t.db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} }, chatwootFetch: cw.fetchImpl });
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

async function connected() {
  const s = await setup();
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
    expect(w.subscriptions).toEqual(['message_created']);
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

    // Raw delivery kept (direct insert until B3's raw_webhooks writer merges).
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

  it.todo('the delivery goes through B3 processDelivery / the raw_webhooks writer once B3 merges (direct insert until then)');
  it.todo("an Instagram message from a guest reaches the club's brain (B, chat capture) once B owns the messages writer");
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

  it.todo('the busyness feed leaves out instagram-origin rows (B busyness feed owns that reader)');
});
