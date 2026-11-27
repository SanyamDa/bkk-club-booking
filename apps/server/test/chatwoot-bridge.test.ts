import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { StaffReplySend } from '../src/chat/episodes.js';
import type { Db } from '../src/db/client.js';
import { conversations, events, guests, handoffEpisodes, messages, platformFlags, rawWebhooks, type Club } from '../src/db/schema.js';
import { bridgeState, mirrorClub } from '../src/integrations/chatwoot/bridge.js';
import { applyCallback, checkCallback } from '../src/integrations/chatwoot/callback.js';
import { chatwootClient, chatwootFlagKey, type ChatwootClubState } from '../src/integrations/chatwoot/provision.js';
import type { GatewayRegistry, LineGateway } from '../src/line/gateway.js';
import { Outbox } from '../src/line/outbox.js';
import { newId } from '../src/lib/util.js';
import { encryptSecret } from '../src/platform/crypto.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { adminCookie, makeUser, loginAs, staffUrl, testConfig } from './helpers/track-a.js';

const CW_URL = 'http://chatwoot.test';
const PLATFORM_TOKEN = 'platform-app-token-a14';
const T0 = FRIDAY_AFTERNOON;
const ACCOUNT = { a: 501, b: 601 };
const INBOX = { a: 11, b: 21 };

type CwMessage = { accountId: number; conversationId: number; id: number; content: string; messageType: string; token: string | null };
type CwConversation = { accountId: number; id: number; contactId: number; sourceId: string; status: string };

/** In-memory Chatwoot account API (contacts, conversations, messages, status, inbox webhook). No network. */
function fakeChatwoot() {
  let seq = 100;
  const state = {
    down: false,
    webhookUrls: new Map<number, string>(),
    contacts: [] as { accountId: number; id: number; identifier: string; name: string }[],
    conversations: [] as CwConversation[],
    messages: [] as CwMessage[],
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (state.down) return json({ error: 'unavailable' }, 503);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const token = new Headers(init.headers).get('api_access_token');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/v1\/accounts\/(\d+)\/inboxes\/(\d+)$/.exec(url.pathname)) && method === 'PATCH') {
      state.webhookUrls.set(Number(m[1]), body.channel.webhook_url);
      return json({ id: Number(m[2]) });
    }
    if ((m = /^\/api\/v1\/accounts\/(\d+)\/contacts$/.exec(url.pathname)) && method === 'POST') {
      const c = { accountId: Number(m[1]), id: ++seq, identifier: body.identifier, name: body.name };
      state.contacts.push(c);
      return json({ payload: { contact: { id: c.id }, contact_inbox: { source_id: `src-${c.id}` } } });
    }
    if ((m = /^\/api\/v1\/accounts\/(\d+)\/conversations$/.exec(url.pathname)) && method === 'POST') {
      const c = { accountId: Number(m[1]), id: ++seq, contactId: body.contact_id, sourceId: body.source_id, status: body.status };
      state.conversations.push(c);
      return json({ id: c.id });
    }
    if ((m = /^\/api\/v1\/accounts\/(\d+)\/conversations\/(\d+)\/messages$/.exec(url.pathname)) && method === 'POST') {
      const msg = { accountId: Number(m[1]), conversationId: Number(m[2]), id: ++seq, content: body.content, messageType: body.message_type, token };
      state.messages.push(msg);
      return json({ id: msg.id });
    }
    if ((m = /^\/api\/v1\/accounts\/(\d+)\/conversations\/(\d+)\/toggle_status$/.exec(url.pathname)) && method === 'POST') {
      const c = state.conversations.find((x) => x.accountId === Number(m![1]) && x.id === Number(m![2]));
      if (!c) return json({ error: 'not found' }, 404);
      c.status = body.status;
      return json({ payload: { current_status: body.status } });
    }
    return json({ error: `unhandled ${method} ${url.pathname}` }, 404);
  }) as typeof fetch;
  return { ...state, state, fetchImpl, tokenFor: (accountId: number) => new URL(state.webhookUrls.get(accountId)!).searchParams.get('token')! };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const adminToken = (club: Club) => `admin-token-${club.id}`;
const botToken = (club: Club) => `bot-token-${club.id}`;

async function seedProvisioned(db: Db, key: Buffer, club: Club, accountId: number, inboxId: number) {
  const state: ChatwootClubState = {
    accountId,
    adminUserId: accountId + 1,
    adminTokenEnc: encryptSecret(adminToken(club), key),
    adminLinked: true,
    inboxId,
    agentBotId: accountId + 2,
    botTokenEnc: encryptSecret(botToken(club), key),
    botAttached: true,
    dashboardAppId: accountId + 3,
    provisionedAt: T0.toISOString(),
  };
  await db.insert(platformFlags).values({ key: chatwootFlagKey(club.id), value: state, updatedBy: 'test', updatedAt: T0 });
}

async function setup() {
  const t = await setupTwoClubs();
  close = t.close;
  const cw = fakeChatwoot();
  const config = testConfig({ CHATWOOT_URL: CW_URL, CHATWOOT_PLATFORM_TOKEN: PLATFORM_TOKEN, DEV_SIMULATOR: true });
  const app = createApp(config, t.db, { bot: { now: () => T0, log: () => {} }, chatwootFetch: cw.fetchImpl });
  await seedProvisioned(t.db, config.CREDENTIALS_KEY, t.clubA, ACCOUNT.a, INBOX.a);
  await seedProvisioned(t.db, config.CREDENTIALS_KEY, t.clubB, ACCOUNT.b, INBOX.b);
  const cookie = await adminCookie(app);
  const client = chatwootClient(config, cw.fetchImpl)!;
  const mirror = (club: Club, now = T0) => mirrorClub(t.db, client, config.CREDENTIALS_KEY, club, { now, publicUrl: config.PUBLIC_URL, settleMs: 0 });
  /** A guest message through the LINE simulator: the real webhook path and bot. */
  const sim = async (text: string, userId = 'bridge-guest') => {
    const res = await app.app.request(`/api/dev/${t.clubA.slug}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ userId, displayName: 'Ari', type: 'text', text }),
    });
    expect(res.status).toBe(200);
  };
  const callback = (clubId: string, token: string | null, body: unknown) =>
    app.app.request(`/integrations/chatwoot/${clubId}/callback${token === null ? '' : `?token=${encodeURIComponent(token)}`}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { ...t, cw, app, config, mirror, sim, callback };
}

const convOf = async (db: Db, clubId: string) => (await db.select().from(conversations).where(eq(conversations.clubId, clubId)))[0]!;
const cwIdOf = (conv: { externalRef: string | null }) => Number(conv.externalRef!.split(':')[2]);

function staffReply(over: { accountId: number; conversationId: number; id?: number; content?: string; sender?: { id: number; type: string } }) {
  return {
    event: 'message_created',
    id: over.id ?? 9001,
    content: over.content ?? 'Yes, we have a table for you',
    message_type: 'outgoing',
    private: false,
    created_at: T0.toISOString(),
    sender: { name: 'Host', ...(over.sender ?? { id: 77, type: 'user' }) },
    conversation: { id: over.conversationId, display_id: over.conversationId },
    inbox: { id: INBOX.a },
    account: { id: over.accountId },
  };
}

/** A fake LINE send path that counts pushes. */
function fakeSend(db: Db): StaffReplySend & { pushes: unknown[][] } {
  const pushes: unknown[][] = [];
  const gateway = { live: false, reply: async () => {}, push: async (_to: string, msgs: unknown[]) => void pushes.push(msgs) } as unknown as LineGateway;
  return { outbox: new Outbox(db, () => {}), gateways: { forClub: async () => gateway } as unknown as GatewayRegistry, pushes };
}

const staffRows = (db: Db, clubId: string) => db.select().from(messages).where(and(eq(messages.clubId, clubId), eq(messages.authorType, 'staff')));
const eventsOf = (db: Db, clubId: string, type: string) => db.select().from(events).where(and(eq(events.clubId, clubId), eq(events.type, type)));

describe('A14 LINE <-> Chatwoot bridge (spec §6.3)', () => {
  it('guest message appears in Chatwoot', async () => {
    const s = await setup();
    await s.sim('hello, do you have tables tonight?');
    const result = await s.mirror(s.clubA);
    expect(result.pending).toBe(false);
    expect(result.mirrored).toBeGreaterThan(0);

    const conv = await convOf(s.db, s.clubA.id);
    expect(conv.externalRef).toMatch(/^cw:501:\d+$/);
    const cwConv = s.cw.state.conversations.find((c) => c.id === cwIdOf(conv))!;
    expect(cwConv).toMatchObject({ accountId: ACCOUNT.a });
    const guest = (await s.db.select().from(guests).where(eq(guests.id, conv.guestId)))[0]!;
    expect(s.cw.state.contacts).toEqual([expect.objectContaining({ accountId: ACCOUNT.a, identifier: guest.id, name: 'Ari' })]);
    const first = s.cw.state.messages[0]!;
    expect(first).toMatchObject({ conversationId: cwConv.id, content: 'hello, do you have tables tonight?', messageType: 'incoming', token: adminToken(s.clubA) });

    // The inbox webhook now carries a secret token; only its hash is stored.
    const url = new URL(s.cw.state.webhookUrls.get(ACCOUNT.a)!);
    expect(url.pathname).toBe(`/integrations/chatwoot/${s.clubA.id}/callback`);
    expect(s.cw.tokenFor(ACCOUNT.a).length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(await bridgeState(s.db, s.clubA.id))).not.toContain(s.cw.tokenFor(ACCOUNT.a));

    // A second run posts nothing again.
    const before = s.cw.state.messages.length;
    expect((await s.mirror(s.clubA)).mirrored).toBe(0);
    expect(s.cw.state.messages).toHaveLength(before);
  });

  it('bot messages shown as bot', async () => {
    const s = await setup();
    await s.sim('hello');
    await s.mirror(s.clubA);
    const outbound = await s.db.select().from(messages).where(and(eq(messages.clubId, s.clubA.id), eq(messages.direction, 'out')));
    expect(outbound.length).toBeGreaterThan(0);
    const outgoing = s.cw.state.messages.filter((m) => m.messageType === 'outgoing');
    expect(outgoing).toHaveLength(outbound.length);
    expect(outgoing.every((m) => m.token === botToken(s.clubA))).toBe(true);
    // Creation order is kept: the guest's message comes first.
    expect(s.cw.state.messages[0]!.messageType).toBe('incoming');
  });

  it('staff reply reaches the guest once (callback redelivery deduped)', async () => {
    const s = await setup();
    await s.sim('hello');
    await s.mirror(s.clubA);
    const conv = await convOf(s.db, s.clubA.id);
    const token = s.cw.tokenFor(ACCOUNT.a);
    const body = staffReply({ accountId: ACCOUNT.a, conversationId: cwIdOf(conv) });

    const first = await s.callback(s.clubA.id, token, body);
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).applied).toBe('recorded');
    const again = await s.callback(s.clubA.id, token, body);
    expect(again.status).toBe(200);

    const rows = await staffRows(s.db, s.clubA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: `cw:${ACCOUNT.a}:9001`, authorId: 'chatwoot:77', direction: 'out', payload: { type: 'text', text: 'Yes, we have a table for you' } });
    expect(await eventsOf(s.db, s.clubA.id, 'host.replied')).toHaveLength(1);
    expect((await eventsOf(s.db, s.clubA.id, 'host.replied'))[0]!.source).toBe('chatwoot');
    expect(await s.db.select().from(rawWebhooks).where(eq(rawWebhooks.channel, 'chatwoot:callback'))).toHaveLength(2);

    // The send path itself: two deliveries of one Chatwoot message push once.
    const send = fakeSend(s.db);
    const body2 = staffReply({ accountId: ACCOUNT.a, conversationId: cwIdOf(conv), id: 9002, content: 'See you at 10' });
    for (let i = 0; i < 2; i++) {
      const checked = await checkCallback(s.db, s.clubA, token, body2);
      if (!checked.ok || checked.kind === 'ignored') throw new Error('expected a message callback');
      await applyCallback(s.db, checked, send, T0);
    }
    expect(send.pushes).toEqual([[{ type: 'text', text: 'See you at 10' }]]);

    // A reply that came from Chatwoot is not posted back into Chatwoot.
    const posted = s.cw.state.messages.length;
    await s.mirror(s.clubA);
    expect(s.cw.state.messages).toHaveLength(posted);
  });

  it('a staff reply from a mapped Chatwoot user is recorded as that user', async () => {
    const s = await setup();
    await s.sim('hello');
    await s.mirror(s.clubA);
    const user = await makeUser(s.db, { email: 'host-cw@test.local', clubId: s.clubA.id, role: 'host' });
    await s.db.insert(platformFlags).values({ key: `chatwoot:${s.clubA.id}:user:${user.id}`, value: { chatwootUserId: 4242, role: 'agent', accountId: ACCOUNT.a, grantId: null }, updatedBy: 'test', updatedAt: T0 });
    const conv = await convOf(s.db, s.clubA.id);
    const res = await s.callback(s.clubA.id, s.cw.tokenFor(ACCOUNT.a), staffReply({ accountId: ACCOUNT.a, conversationId: cwIdOf(conv), sender: { id: 4242, type: 'user' } }));
    expect(res.status).toBe(200);
    expect((await staffRows(s.db, s.clubA.id))[0]!.authorId).toBe(user.id);
  });

  it('inbox down: bot still answers and messages queue for mirroring', async () => {
    const s = await setup();
    s.cw.state.down = true;
    await s.sim('hello while the inbox is down');
    // The bot answered on LINE regardless.
    const outbound = await s.db.select().from(messages).where(and(eq(messages.clubId, s.clubA.id), eq(messages.direction, 'out')));
    expect(outbound.length).toBeGreaterThan(0);

    const down = await s.mirror(s.clubA);
    expect(down).toMatchObject({ mirrored: 0, pending: true, error: 'chatwoot_503' });
    expect(s.cw.state.messages).toHaveLength(0);
    await s.sim('anyone there?');

    s.cw.state.down = false;
    const up = await s.mirror(s.clubA);
    expect(up.pending).toBe(false);
    const all = await s.db.select().from(messages).where(eq(messages.clubId, s.clubA.id));
    expect(s.cw.state.messages).toHaveLength(all.length);
    const incoming = s.cw.state.messages.filter((m) => m.messageType === 'incoming').map((m) => m.content);
    expect(incoming).toEqual(['hello while the inbox is down', 'anyone there?']);
  });

  it('dashboard resolve closes the open episode', async () => {
    const s = await setup();
    await s.sim('can i talk to a person');
    expect((await convOf(s.db, s.clubA.id)).mode).toBe('human');
    await s.mirror(s.clubA);
    const conv = await convOf(s.db, s.clubA.id);
    const cwConv = s.cw.state.conversations.find((c) => c.id === cwIdOf(conv))!;
    expect(cwConv.status).toBe('open');

    const user = await makeUser(s.db, { email: 'host-a14@test.local', clubId: s.clubA.id, role: 'host' });
    const cookie = await loginAs(s.app, user);
    const res = await s.app.app.request(staffUrl(s.clubA.slug, `/conversations/${conv.id}/resolve`), { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const [episode] = await s.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.conversationId, conv.id));
    expect(episode).toMatchObject({ endedBy: 'staff', resolverUserId: user.id });
    expect((await convOf(s.db, s.clubA.id)).mode).toBe('bot');

    // The next mirror run hands the Chatwoot conversation back to the bot.
    await s.mirror(s.clubA);
    expect(cwConv.status).toBe('pending');
  });

  it('Chatwoot resolve closes the open episode', async () => {
    const s = await setup();
    await s.sim('can i talk to a person');
    await s.mirror(s.clubA);
    const conv = await convOf(s.db, s.clubA.id);
    const res = await s.callback(s.clubA.id, s.cw.tokenFor(ACCOUNT.a), {
      event: 'conversation_status_changed',
      id: cwIdOf(conv),
      status: 'resolved',
      account: { id: ACCOUNT.a },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).applied).toBe('resolved');
    const [episode] = await s.db.select().from(handoffEpisodes).where(eq(handoffEpisodes.conversationId, conv.id));
    expect(episode).toMatchObject({ endedBy: 'staff', resolverUserId: 'chatwoot' });
    expect((await convOf(s.db, s.clubA.id)).mode).toBe('bot');
    expect(await eventsOf(s.db, s.clubA.id, 'handoff.resolved')).toHaveLength(1);
  });

  it("a message_created callback carrying club A's Chatwoot account token and a club B conversation id is rejected and writes nothing", async () => {
    const s = await setup();
    await s.sim('hello');
    // Club B: a LINE guest with one message, mirrored into club B's account.
    const guestId = newId();
    await s.db.insert(guests).values({ id: guestId, clubId: s.clubB.id, lineUserId: `U${guestId}`, displayName: 'Bea' });
    await s.db.insert(messages).values({ id: newId(), clubId: s.clubB.id, guestId, direction: 'in', kind: 'text', payload: { text: 'hi B' } });
    await s.mirror(s.clubA);
    await s.mirror(s.clubB);
    const convB = await convOf(s.db, s.clubB.id);
    const cwB = cwIdOf(convB);
    expect(s.cw.state.conversations.find((c) => c.id === cwB)!.accountId).toBe(ACCOUNT.b);

    const count = async () => ({
      messages: (await s.db.select().from(messages)).length,
      events: (await s.db.select().from(events)).length,
      raw: (await s.db.select().from(rawWebhooks)).length,
      episodes: (await s.db.select().from(handoffEpisodes)).length,
    });
    const before = await count();
    const tokenA = s.cw.tokenFor(ACCOUNT.a);
    // Club A's URL and token, club B's conversation id.
    const asA = await s.callback(s.clubA.id, tokenA, staffReply({ accountId: ACCOUNT.a, conversationId: cwB }));
    expect(asA.status).toBe(404);
    // Club A's URL and token, club B's account and conversation.
    const accountB = await s.callback(s.clubA.id, tokenA, staffReply({ accountId: ACCOUNT.b, conversationId: cwB }));
    expect(accountB.status).toBe(403);
    // Club B's URL with club A's token.
    const urlB = await s.callback(s.clubB.id, tokenA, staffReply({ accountId: ACCOUNT.b, conversationId: cwB }));
    expect(urlB.status).toBe(401);
    // No token at all.
    expect((await s.callback(s.clubB.id, null, staffReply({ accountId: ACCOUNT.b, conversationId: cwB }))).status).toBe(401);
    expect(await count()).toEqual(before);
    expect(await staffRows(s.db, s.clubB.id)).toHaveLength(0);
  });

  it('echoes of our own posts are ignored', async () => {
    const s = await setup();
    await s.sim('hello');
    await s.mirror(s.clubA);
    const conv = await convOf(s.db, s.clubA.id);
    const token = s.cw.tokenFor(ACCOUNT.a);
    const bot = await s.callback(s.clubA.id, token, staffReply({ accountId: ACCOUNT.a, conversationId: cwIdOf(conv), id: 9101, sender: { id: ACCOUNT.a + 2, type: 'agent_bot' } }));
    expect(((await bot.json()) as any).applied).toBe('echo');
    const admin = await s.callback(s.clubA.id, token, staffReply({ accountId: ACCOUNT.a, conversationId: cwIdOf(conv), id: 9102, sender: { id: ACCOUNT.a + 1, type: 'user' } }));
    expect(((await admin.json()) as any).applied).toBe('echo');
    const incoming = await s.callback(s.clubA.id, token, { ...staffReply({ accountId: ACCOUNT.a, conversationId: cwIdOf(conv), id: 9103 }), message_type: 'incoming' });
    expect(((await incoming.json()) as any).applied).toBe('ignored');
    expect(await staffRows(s.db, s.clubA.id)).toHaveLength(0);
    expect((await convOf(s.db, s.clubA.id)).mode).toBe('bot');
  });

  it('the agent bot URL answers 200 and does nothing', async () => {
    const s = await setup();
    const res = await s.app.app.request(`/integrations/chatwoot/${s.clubA.id}/bot`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
  });
});
