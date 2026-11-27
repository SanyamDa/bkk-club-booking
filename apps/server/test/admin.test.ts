import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable } from '../src/bookings/service.js';
import type { IdTokenVerifier } from '../src/line/idtoken.js';
import type { Db } from '../src/db/client.js';
import {
  auditLog,
  channels,
  clubs,
  conversations,
  events,
  messages,
  opsEvents,
  platformFlags,
  rawWebhooks,
  type Club,
  priceRules,
  tables,
  zones,
} from '../src/db/schema.js';
import { VELORA } from '../src/demo/velora-content.js';
import { newId } from '../src/lib/util.js';
import { fakeSetupClients, type SetupClients } from '../src/line/setup.js';
import { totp } from '../src/platform/totp.js';
import { fixtureSettings } from './fixtures/club.js';
import { makeGuest, setupTwoClubs } from './helpers.js';
import { adminCookie, routeTable, secretLeakRecorder, staffCookie, testConfig } from './helpers/track-a.js';

const T0 = new Date('2026-11-27T08:00:00Z');
/** The TOTP secret `adminCookie` gives every admin it creates (test/helpers/track-a.ts). */
const ADMIN_TOTP_KEY = Buffer.from('12345678901234567890');

const LINE_SECRET = 'messaging-channel-secret-a5a5';
const PLATFORM_LOGIN = { channelId: '2009999999', channelSecret: 'platform-login-secret-p1f0', liffId: '2009999999-Shared' };

type FakeLine = { chatMode?: string; webhookActive?: boolean; endpoint?: string; quota?: { limit: number | null; used: number } };

/** fakeSetupClients with the switches the wizard re-checks overridden. */
function fakeLine(over: FakeLine = {}) {
  return (token: string, login: Parameters<typeof fakeSetupClients>[1]): SetupClients => {
    const base = fakeSetupClients(token, login);
    const api = base.api as unknown as Record<string, unknown>;
    let endpoint = '';
    return {
      ...base,
      api: {
        ...api,
        getBotInfo: async () => ({ userId: 'Ufake', basicId: '@fake-club', displayName: 'Fake LINE account', chatMode: over.chatMode ?? 'bot', markAsReadMode: 'auto' }),
        setWebhookEndpoint: async (req: { endpoint: string }) => {
          endpoint = req.endpoint;
          return {};
        },
        getWebhookEndpoint: async () => ({ endpoint: over.endpoint ?? endpoint, active: over.webhookActive ?? true }),
        getMessageQuota: async () => (over.quota?.limit ? { type: 'limited', value: over.quota.limit } : { type: 'none' }),
        getMessageQuotaConsumption: async () => ({ totalUsage: over.quota?.used ?? 0 }),
      } as unknown as SetupClients['api'],
    };
  };
}

const leaks = secretLeakRecorder();
leaks.track(LINE_SECRET, PLATFORM_LOGIN.channelSecret);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fn of cleanups.splice(0)) await fn();
  leaks.assertNoLeak();
});

async function setup(opts: { line?: FakeLine; publicUrl?: string; verifyIdToken?: IdTokenVerifier } = {}) {
  const h = await setupTwoClubs();
  cleanups.push(h.close);
  const clock = { now: T0 };
  const config = testConfig({ LINE_FAKE: true, PUBLIC_URL: opts.publicUrl ?? 'https://club.test' });
  const created = createApp(config, h.db, {
    bot: { now: () => clock.now, log: () => {} },
    lineSetupClients: fakeLine(opts.line),
    onResponse: leaks.onResponse,
    ...(opts.verifyIdToken ? { verifyIdToken: opts.verifyIdToken } : {}),
  });
  const cookie = await adminCookie(created);
  const req = (method: string, path: string, body?: unknown, cookieOverride?: string) =>
    created.app.request(path, {
      method,
      headers: { cookie: cookieOverride ?? cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const code = () => totp(ADMIN_TOTP_KEY, clock.now);
  return { ...h, created, clock, cookie, req, code, db: h.db as Db };
}

const reload = async (db: Db, slug: string) => (await db.query.clubs.findFirst({ where: eq(clubs.slug, slug) }))!;

function signedWebhook(secret: string, body: unknown) {
  const raw = JSON.stringify(body);
  return { raw, signature: createHmac('sha256', secret).update(raw).digest('base64') };
}

function textEvent(userId: string, text: string, id = newId()) {
  return {
    destination: 'Ubot',
    events: [
      {
        type: 'message',
        mode: 'active',
        timestamp: T0.getTime(),
        webhookEventId: id,
        deliveryContext: { isRedelivery: false },
        source: { type: 'user', userId },
        replyToken: `rt-${id}`,
        message: { id: `m-${id}`, type: 'text', text, quoteToken: 'q' },
      },
    ],
  };
}

/** LINE's API is never called for real: the token issuer is fake, and any SDK fetch gets 200 {}. */
function stubLineFetch() {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
}

async function createClub(s: Awaited<ReturnType<typeof setup>>, slug: string, template: 'blank' | 'velora-like' = 'blank') {
  return s.req('POST', '/api/admin/clubs', { name: `Club ${slug}`, slug, template });
}

async function connectLine(s: Awaited<ReturnType<typeof setup>>, slug: string) {
  return s.req('POST', `/api/admin/clubs/${slug}/line`, { channelId: '1650000000', channelSecret: LINE_SECRET, totp: s.code() });
}

describe('founder console API (A5)', () => {
  it('non-admin gets 403 on every ADMIN_ROUTES entry', async () => {
    const s = await setup();
    const ADMIN_ROUTES = routeTable(s.created.app, '/api/admin');
    expect(ADMIN_ROUTES.length).toBeGreaterThan(10);
    const manager = await staffCookie(s.created, s.clubA, 'owner');
    for (const route of ADMIN_ROUTES) {
      const path = route.path.replace(':slug', s.clubA.slug).replace(/:[a-zA-Z]+/g, 'x');
      const res = await s.req(route.method, path, route.method === 'GET' ? undefined : {}, manager);
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('create club then receive a signed webhook with no restart', async () => {
    stubLineFetch();
    const s = await setup();
    expect((await createClub(s, 'new-club')).status).toBe(201);
    const setupRes = await connectLine(s, 'new-club');
    expect(setupRes.status).toBe(200);
    expect(((await setupRes.json()) as { steps: unknown[] }).steps.length).toBeGreaterThan(0);

    const { raw, signature } = signedWebhook(LINE_SECRET, textEvent('Unewguest1', 'hello'));
    const res = await s.created.app.request('/line/webhook/new-club', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      body: raw,
    });
    expect(res.status).toBe(200);
    await s.created.settle();
    const club = await reload(s.db, 'new-club');
    const inbound = await s.db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.direction, 'in')));
    expect(inbound).toHaveLength(1);
    // Phase 1b gate (B3): the delivery is stored in raw_webhooks for that club and processed.
    const raws = await s.db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, club.id));
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ channel: 'line', signatureOk: true, error: null });
    expect(raws[0]!.processedAt).not.toBeNull();
  });

  it('credential change needs fresh totp', async () => {
    const s = await setup();
    await createClub(s, 'new-club');
    const res = await s.req('POST', '/api/admin/clubs/new-club/line', { channelId: '1650000000', channelSecret: LINE_SECRET });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'totp_required' });
    const wrong = await s.req('POST', '/api/admin/clubs/new-club/line', { channelId: '1650000000', channelSecret: LINE_SECRET, totp: '000000' });
    expect(wrong.status).toBe(401);
    for (const [path, body] of [
      ['/api/admin/clubs/new-club/promptpay', { promptpayId: '0812345678' }],
      ['/api/admin/clubs/new-club/greeting', { mapUrl: 'https://maps.example/x' }],
      ['/api/admin/platform/line-login', PLATFORM_LOGIN],
    ] as const) {
      const r = await s.req(path.includes('platform') ? 'POST' : 'PUT', path, body);
      expect(r.status, path).toBe(401);
      expect(await r.json()).toEqual({ error: 'totp_required' });
    }
  });

  it('pause route sets bot_paused_at, clears it on resume, and sends one notice to the staff group each time', async () => {
    const s = await setup();
    const staffMsgs = async () => (await s.db.select().from(messages).where(and(eq(messages.clubId, s.clubB.id), eq(messages.target, 'staff')))).length;
    expect((await s.req('POST', '/api/admin/clubs/test-b/pause', { paused: true })).status).toBe(200);
    let club = await reload(s.db, 'test-b');
    expect(club.botPaused).toBe(true);
    expect(club.botPausedAt).toEqual(T0);
    expect(await staffMsgs()).toBe(1);
    await s.req('POST', '/api/admin/clubs/test-b/pause', { paused: true }); // no change, no second notice
    expect(await staffMsgs()).toBe(1);
    expect((await s.req('POST', '/api/admin/clubs/test-b/pause', { paused: false })).status).toBe(200);
    club = await reload(s.db, 'test-b');
    expect(club.botPaused).toBe(false);
    expect(club.botPausedAt).toBeNull();
    expect(await staffMsgs()).toBe(2);
  });

  it('pause stops replies within one message', async () => {
    stubLineFetch();
    const s = await setup();
    await createClub(s, 'new-club');
    expect((await connectLine(s, 'new-club')).status).toBe(200);
    const club = await reload(s.db, 'new-club');
    const staffBefore = (await s.db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.target, 'staff')))).length;
    // Set directly, not through the route (whose own notice is a staff-group message too).
    await s.db.update(clubs).set({ botPaused: true, botPausedAt: T0 }).where(eq(clubs.id, club.id));
    for (const text of ['hello', 'book a table']) {
      const { raw, signature } = signedWebhook(LINE_SECRET, textEvent('Upausedguest', text));
      const res = await s.created.app.request('/line/webhook/new-club', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-line-signature': signature },
        body: raw,
      });
      expect(res.status).toBe(200);
      await s.created.settle();
    }
    const rows = await s.db.select().from(messages).where(eq(messages.clubId, club.id));
    expect(rows.filter((m) => m.direction === 'in')).toHaveLength(2);
    expect(rows.filter((m) => m.direction === 'out' && m.target === null)).toHaveLength(0);
    expect(rows.filter((m) => m.target === 'staff').length - staffBefore).toBe(1);
  });

  it('console-created club has the shared liff_id and a resolvable login channel with no env var set', async () => {
    const s = await setup();
    const saved = await s.req('POST', '/api/admin/platform/line-login', { ...PLATFORM_LOGIN, totp: s.code() });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { last4: string }).last4).toBe('p1f0');
    const summary = (await (await s.req('GET', '/api/admin/platform/line-login')).json()) as { loginChannel: { liffId: string; last4: string } };
    expect(summary.loginChannel).toMatchObject({ liffId: PLATFORM_LOGIN.liffId, last4: 'p1f0' });
    const audit = await s.db.select().from(auditLog).where(eq(auditLog.action, 'platform_login_channel.set'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain(PLATFORM_LOGIN.channelSecret);

    await createClub(s, 'shared-club');
    const club = await reload(s.db, 'shared-club');
    expect(club.liffId).toBe(PLATFORM_LOGIN.liffId);
    expect(club.lineLoginChannelIdEnv).toBeNull();
    expect(await s.created.ctx.credentials.login(club)).toMatchObject({ channelId: PLATFORM_LOGIN.channelId, liffId: PLATFORM_LOGIN.liffId, shared: true });
  });

  // Phase 1b gate item (A4b + B5): the shared platform channel and the first-use sub pair.
  it('console-created club: details read with a valid ID token is 200, with no token it is refused', async () => {
    const verify = vi.fn(async (token: string) => (token === 'shared-token' ? { sub: 'Uplatform-sub' } : null));
    const s = await setup({ verifyIdToken: verify });
    expect((await s.req('POST', '/api/admin/platform/line-login', { ...PLATFORM_LOGIN, totp: s.code() })).status).toBe(200);
    expect((await createClub(s, 'shared-club', 'velora-like')).status).toBe(201);
    const club = await reload(s.db, 'shared-club');
    expect(club.lineLoginChannelIdEnv).toBeNull();
    const guest = await makeGuest(s.db, { clubId: club.id, lineUserId: 'Uwebhook-id' });
    const [table] = await s.db.select().from(tables).where(eq(tables.clubId, club.id)).limit(1);
    const booking = await holdTable(s.db, club, { guestId: guest.id, tableId: table!.id, nightDate: '2026-11-27', pax: table!.minPax }, T0);
    const link = new URL(s.created.ctx.deps.links.details(club, booking, T0));
    expect(link.host).toBe('liff.line.me');
    const path = `/api/liff/booking?ref=${link.searchParams.get('ref')}&t=${link.searchParams.get('t')}`;
    const none = await s.created.app.request(path);
    expect(none.status).toBe(401);
    const ok = await s.created.app.request(path, { headers: { 'X-Line-Id-Token': 'shared-token' } });
    expect(ok.status).toBe(200);
    expect(verify).toHaveBeenCalledWith('shared-token', PLATFORM_LOGIN.channelId);
  });

  it('line/status reports the webhook switch and chat mode from the fake LINE client', async () => {
    const s = await setup({ line: { chatMode: 'chat', webhookActive: false, endpoint: 'https://club.test/line/webhook/new-club' } });
    await createClub(s, 'new-club');
    await connectLine(s, 'new-club');
    const res = await s.req('GET', '/api/admin/clubs/new-club/line/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhookActive: boolean; chatMode: string; liveTest: string };
    expect(body.webhookActive).toBe(false);
    expect(body.chatMode).toBe('chat');
    expect(body.liveTest).toBe('pending');
    const club = await reload(s.db, 'new-club');
    const rows = await s.db.select().from(opsEvents).where(and(eq(opsEvents.clubId, club.id), eq(opsEvents.kind, 'line_setup')));
    expect(rows).toHaveLength(2); // one for the setup run, one for the status check
  });

  it('live test passes on one inbound with one outbound, fails on none, and does not pass on two replies', async () => {
    const s = await setup();
    await createClub(s, 'new-club');
    await connectLine(s, 'new-club');
    const club = await reload(s.db, 'new-club');
    const status = async () => ((await (await s.req('GET', '/api/admin/clubs/new-club/line/status')).json()) as { liveTest: string }).liveTest;
    const msg = (guestId: string, direction: 'in' | 'out', at: Date) =>
      s.db.insert(messages).values({ id: newId(), clubId: club.id, guestId, direction, kind: 'text', payload: {}, createdAt: at });

    // Window 1: nothing yet → pending; one inbound with one reply → pass.
    await s.req('POST', '/api/admin/clubs/new-club/line/live-test');
    expect(await status()).toBe('pending');
    const g1 = await makeGuest(s.db, { clubId: club.id });
    await msg(g1.id, 'in', new Date(T0.getTime() + 1_000));
    await msg(g1.id, 'out', new Date(T0.getTime() + 2_000));
    expect(await status()).toBe('pass');

    // Window 2: one inbound and no reply → fail once the reply is overdue.
    s.clock.now = new Date(T0.getTime() + 10 * 60_000);
    await s.req('POST', '/api/admin/clubs/new-club/line/live-test');
    const g2 = await makeGuest(s.db, { clubId: club.id });
    await msg(g2.id, 'in', new Date(s.clock.now.getTime() + 1_000));
    s.clock.now = new Date(s.clock.now.getTime() + 61_000);
    expect(await status()).toBe('fail');

    // Window 3: one inbound with two replies (LINE auto-reply plus the bot) → not a pass.
    s.clock.now = new Date(s.clock.now.getTime() + 10 * 60_000);
    await s.req('POST', '/api/admin/clubs/new-club/line/live-test');
    const g3 = await makeGuest(s.db, { clubId: club.id });
    await msg(g3.id, 'in', new Date(s.clock.now.getTime() + 1_000));
    await msg(g3.id, 'out', new Date(s.clock.now.getTime() + 2_000));
    await msg(g3.id, 'out', new Date(s.clock.now.getTime() + 3_000));
    s.clock.now = new Date(s.clock.now.getTime() + 30_000);
    expect(await status()).not.toBe('pass');
  });

  it('plan check recommends an upgrade when expected pushes exceed the plan limit; quota.warn is true at 80% used', async () => {
    const s = await setup({ line: { quota: { limit: 1000, used: 800 } } });
    await createClub(s, 'new-club');
    await connectLine(s, 'new-club');
    // 300 bookings × 2 + 100 host replies + 50 alerts × 5 people = 950 (under 1000).
    let body = (await (await s.req('GET', '/api/admin/clubs/new-club/line/status?expectedBookings=300&hostReplies=100&staffAlerts=50&groupSize=5')).json()) as {
      quota: { limit: number; used: number; pct: number; warn: boolean };
      planCheck: { expectedMonthlyPushes: number; recommendUpgrade: boolean };
    };
    expect(body.quota).toEqual({ limit: 1000, used: 800, pct: 80, warn: true });
    expect(body.planCheck).toEqual({ expectedMonthlyPushes: 950, recommendUpgrade: false });
    body = (await (await s.req('GET', '/api/admin/clubs/new-club/line/status?expectedBookings=400&hostReplies=100&staffAlerts=50&groupSize=5')).json()) as typeof body;
    expect(body.planCheck).toEqual({ expectedMonthlyPushes: 1150, recommendUpgrade: true });
  });

  it('club cannot go live without a profile', async () => {
    const s = await setup();
    await s.req('POST', '/api/admin/platform/line-login', { ...PLATFORM_LOGIN, totp: s.code() });
    await createClub(s, 'new-club');
    const res = await s.req('PATCH', '/api/admin/clubs/new-club', { status: 'live' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'profile_missing' });
    expect((await s.req('PUT', '/api/admin/clubs/new-club/profile', { capacityStanding: 400, district: 'Thonglor', genres: ['house'] })).status).toBe(200);
    const ok = await s.req('PATCH', '/api/admin/clubs/new-club', { status: 'live' });
    expect(ok.status).toBe(200);
    expect((await reload(s.db, 'new-club')).status).toBe('live');
  });

  it('club cannot go live without a LIFF id and a resolvable login channel', async () => {
    const s = await setup();
    await createClub(s, 'new-club'); // no platform channel saved yet: liff_id stays null
    await s.req('PUT', '/api/admin/clubs/new-club/profile', { capacityStanding: 400 });
    const res = await s.req('PATCH', '/api/admin/clubs/new-club', { status: 'live' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'login_not_configured' });
    expect((await reload(s.db, 'new-club')).status).toBe('onboarding');

    // A LIFF id alone is not enough: with no platform channel and no own line_login credential,
    // credentials.login(club) is null.
    await s.db.update(clubs).set({ liffId: '2009999999-Own' }).where(eq(clubs.slug, 'new-club'));
    expect(await s.created.ctx.credentials.login(await reload(s.db, 'new-club'))).toBeNull();
    const noLogin = await s.req('PATCH', '/api/admin/clubs/new-club', { status: 'live' });
    expect(noLogin.status).toBe(409);
    expect(await noLogin.json()).toEqual({ error: 'login_not_configured' });
    expect((await reload(s.db, 'new-club')).status).toBe('onboarding');
  });

  /** Creates and connects `new-club`, then delivers one signed text message from `userId`. */
  async function deliverToNewClub(s: Awaited<ReturnType<typeof setup>>, userId: string) {
    await createClub(s, 'new-club');
    expect((await connectLine(s, 'new-club')).status).toBe(200);
    const { raw, signature } = signedWebhook(LINE_SECRET, textEvent(userId, 'hello'));
    const res = await s.created.app.request('/line/webhook/new-club', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      body: raw,
    });
    expect(res.status).toBe(200);
    await s.created.settle();
    return reload(s.db, 'new-club');
  }

  it('one guest message is traceable end to end', async () => {
    stubLineFetch();
    const s = await setup();
    const club = await deliverToNewClub(s, 'Utraceguest');
    const [conv] = await s.db.select().from(conversations).where(eq(conversations.clubId, club.id));
    const res = await s.req('GET', `/api/admin/clubs/new-club/conversations/${conv!.id}/timeline`);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { kind: string; result?: string; direction?: string; deliveryStatus?: string }[] };
    expect(items.find((i) => i.kind === 'raw_webhook')).toMatchObject({ result: 'processed' });
    const msgs = items.filter((i) => i.kind === 'message');
    expect(msgs.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(msgs[1]).toMatchObject({ deliveryStatus: 'sent' });
  });

  it("failed send shows in the message log with LINE's error", async () => {
    // LINE refuses every reply and push with 429; other calls answer 200 {}.
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/message\/(reply|push)/.test(url)) {
        return new Response(JSON.stringify({ message: 'You have reached your monthly limit.' }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const s = await setup();
    const club = await deliverToNewClub(s, 'Ufailguest');
    const res = await s.req('GET', '/api/admin/clubs/new-club/messages');
    expect(res.status).toBe(200);
    const { messages: log } = (await res.json()) as { messages: { direction: string; target: string | null; deliveryStatus: string; error: string }[] };
    const out = log.find((m) => m.direction === 'out' && m.target === null)!;
    expect(out.deliveryStatus).toBe('failed');
    expect(out.error).toContain('429');
    expect(out.error).toContain('monthly limit');
    const failed = await s.db.select().from(opsEvents).where(and(eq(opsEvents.clubId, club.id), eq(opsEvents.kind, 'send_failed')));
    expect(failed.length).toBeGreaterThan(0);
  });

  it('credential change notifies the owner', async () => {
    stubLineFetch();
    const s = await setup();
    await createClub(s, 'new-club');
    const club = await reload(s.db, 'new-club');
    expect((await connectLine(s, 'new-club')).status).toBe(200);
    const second = await s.req('POST', '/api/admin/clubs/new-club/line', { channelId: '1650000000', channelSecret: 'second-secret-b2b2', totp: s.code() });
    expect(second.status).toBe(200);
    const staff = await s.db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.target, 'staff')));
    expect(staff).toHaveLength(2); // one per credential change
    const rows = await s.db.select().from(auditLog).where(and(eq(auditLog.clubId, club.id), eq(auditLog.action, 'credential.set')));
    const changed = rows.find((r) => (r.before as { last4?: string } | null)?.last4 === 'a5a5');
    expect(changed?.after).toEqual({ kind: 'line_messaging', last4: 'b2b2' });
    leaks.track('second-secret-b2b2');

    // PromptPay: before/after and one more staff notice.
    expect((await s.req('PUT', '/api/admin/clubs/new-club/promptpay', { promptpayId: '0812345678', totp: s.code() })).status).toBe(200);
    const [pp] = await s.db.select().from(auditLog).where(and(eq(auditLog.clubId, club.id), eq(auditLog.action, 'club.promptpay_changed')));
    expect(pp!.before).toMatchObject({ promptpayId: null });
    expect(pp!.after).toMatchObject({ promptpayId: '0812345678' });
    expect(await s.db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.target, 'staff')))).toHaveLength(3);
  });

  it('wrong fresh totp codes are counted: the fifth revokes the session and locks the account', async () => {
    const s = await setup();
    const put = () => s.req('PUT', '/api/admin/clubs/test-b/promptpay', { promptpayId: '0899999999', totp: '000000' });
    for (let i = 0; i < 4; i++) expect(await (await put()).json()).toEqual({ error: 'invalid_totp' });
    expect(await (await put()).json()).toEqual({ error: 'totp_locked' });
    // The session that guessed is gone, even with a valid code now.
    const after = await s.req('PUT', '/api/admin/clubs/test-b/promptpay', { promptpayId: '0899999999', totp: s.code() });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: 'unauthorized' });
    expect((await reload(s.db, 'test-b')).promptpayId).not.toBe('0899999999');
  });

  it('a mistyped LINE secret is refused before it is saved and the working credential stays', async () => {
    stubLineFetch();
    const s = await setup();
    await createClub(s, 'new-club');
    expect((await connectLine(s, 'new-club')).status).toBe(200);
    const club = await reload(s.db, 'new-club');
    const original = s.created.ctx.lineTokens;
    s.created.ctx.lineTokens = { accessToken: async () => { throw new Error('LINE token request failed: 400'); } };
    const res = await s.req('POST', '/api/admin/clubs/new-club/line', { channelId: '1650000000', channelSecret: 'typo-secret-zzzz', totp: s.code() });
    s.created.ctx.lineTokens = original;
    leaks.track('typo-secret-zzzz');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, steps: [{ name: 'LINE credentials', ok: false, detail: 'LINE token request failed: 400' }] });
    const summary = (await (await s.req('GET', '/api/admin/clubs/new-club/credentials')).json()) as { credentials: { kind: string; last4: string }[] };
    expect(summary.credentials.find((c) => c.kind === 'line_messaging')?.last4).toBe('a5a5');
    const staff = await s.db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.target, 'staff')));
    expect(staff).toHaveLength(1); // only the first, successful change
  });

  it('a committed change still answers 200 and records its staff notice when the club LINE token cannot be issued', async () => {
    const s = await setup();
    const failing = { line: async () => { throw new Error('LINE token request failed: 400'); }, login: s.created.ctx.credentials.login, channelSecret: s.created.ctx.credentials.channelSecret };
    const created = createApp(testConfig({ LINE_FAKE: true, PUBLIC_URL: 'https://club.test' }), s.db, { bot: { now: () => s.clock.now, log: () => {} }, credentials: failing, onResponse: leaks.onResponse });
    const cookie = await adminCookie(created);
    const req = (method: string, path: string, body: unknown) =>
      created.app.request(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await req('POST', '/api/admin/clubs/test-b/pause', { paused: true })).status).toBe(200);
    expect((await req('PUT', '/api/admin/clubs/test-b/promptpay', { promptpayId: '0812345678', totp: s.code() })).status).toBe(200);
    const staff = await s.db.select().from(messages).where(and(eq(messages.clubId, s.clubB.id), eq(messages.target, 'staff')));
    expect(staff).toHaveLength(2);
    const status = await created.app.request('/api/admin/clubs/test-b/line/status', { headers: { cookie } });
    expect(status.status).toBe(502);
    expect(await status.json()).toMatchObject({ error: 'line_error', message: 'LINE token request failed: 400' });
  });

  it('support session without a reason is 400', async () => {
    const s = await setup();
    const res = await s.req('POST', '/api/admin/support', { clubSlug: 'test-b' });
    expect(res.status).toBe(400);
  });

  it('data health shows a silent club', async () => {
    const s = await setup();
    await s.db.insert(events).values({
      id: newId(),
      occurredAt: new Date(T0.getTime() - 3 * 86_400_000),
      clubId: s.clubB.id,
      type: 'guest.first_seen',
      actorType: 'guest',
      dataOrigin: 'line_chat',
    });
    const body = (await (await s.req('GET', '/api/admin/data/health')).json()) as {
      clubs: { slug: string; eventsToday: number; lastEventAt: string | null }[];
    };
    const b = body.clubs.find((c) => c.slug === 'test-b')!;
    expect(b.eventsToday).toBe(0);
    expect(new Date(b.lastEventAt!).getTime()).toBeLessThan(T0.getTime() - 86_400_000);
  });

  it('event stream filters by conversation', async () => {
    const s = await setup();
    const g = await makeGuest(s.db, { clubId: s.clubB.id });
    const [conv] = await s.db.insert(conversations).values({ id: newId(), clubId: s.clubB.id, guestId: g.id }).returning();
    const ev = (conversationId?: string) =>
      s.db.insert(events).values({ id: newId(), occurredAt: T0, clubId: s.clubB.id, type: 'message.received', actorType: 'guest', dataOrigin: 'line_chat', conversationId });
    await ev(conv!.id);
    await ev(conv!.id);
    await ev();
    const body = (await (await s.req('GET', `/api/admin/events?conversation=${conv!.id}`)).json()) as { events: { conversationId: string }[] };
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e) => e.conversationId === conv!.id)).toBe(true);
  });

  it('club creation, LINE setup run, and support start and end each emit their event', async () => {
    const s = await setup();
    await createClub(s, 'new-club');
    await connectLine(s, 'new-club');
    const club = await reload(s.db, 'new-club');
    const started = await s.req('POST', '/api/admin/support', { clubSlug: 'new-club', reason: 'Onboarding call' });
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };
    expect((await s.req('POST', `/api/admin/support/${id}/end`)).status).toBe(200);
    const types = (await s.db.select({ type: events.type }).from(events).where(eq(events.clubId, club.id))).map((e) => e.type);
    for (const t of ['club.created', 'line.setup_run', 'support.session_started', 'support.session_ended']) expect(types, t).toContain(t);
  });

  it('a blank club gets complete settings, a channels row and a refPrefix no other club has', async () => {
    const s = await setup();
    // clubB uses TB; "tb" must get TB2, and "tester" / "testing" must not share TES.
    for (const slug of ['tb', 'tester', 'testing']) expect((await createClub(s, slug)).status).toBe(201);
    const created = await Promise.all(['tb', 'tester', 'testing'].map((slug) => reload(s.db, slug)));
    expect(created.map((c) => c.settings.refPrefix)).toEqual(['TB2', 'TES', 'TES2']);
    const all = await s.db.select().from(clubs);
    const prefixes = all.map((c) => c.settings.refPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const c of created) {
      expect(Object.keys(c.settings).sort()).toEqual(expect.arrayContaining(Object.keys(fixtureSettings).filter((k) => k !== 'drinksMenuUrl').sort()));
      expect(c.settings).toMatchObject({ openWeekdays: [3, 4, 5, 6], bookingWindowDays: 30, holdMinutes: 10, nightStartHour: 18, nightEndHour: 6, arrivalBy: '23:30', handoffTimeoutMinutes: 30, rulesVersion: '2026-11-27', mapUrl: '', address: '' });
      expect(c.status).toBe('onboarding');
      expect(c.id.startsWith('club_')).toBe(true);
      expect(c.staffLinkCode).toBeNull();
      expect(await s.db.select().from(channels).where(and(eq(channels.clubId, c.id), eq(channels.kind, 'line')))).toHaveLength(1);
    }
  });

  it('a velora-like club gets complete settings, a channels row, a refPrefix no other club has, and Velora tables and prices', async () => {
    const s = await setup();
    const res = await createClub(s, 'velora-two', 'velora-like');
    expect(res.status).toBe(201);
    const c = await reload(s.db, 'velora-two');
    const prefixes = (await s.db.select().from(clubs)).map((x) => x.settings.refPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(Object.keys(c.settings).sort()).toEqual(expect.arrayContaining(Object.keys(fixtureSettings).filter((k) => k !== 'drinksMenuUrl').sort()));
    expect(c.settings).toMatchObject({ openWeekdays: [3, 4, 5, 6], bookingWindowDays: 30, holdMinutes: 10, arrivalBy: '23:30', rulesVersion: '2026-11-27' });
    expect(c.settings.rules).toEqual({ en: VELORA.policies.map((p) => p.en), th: VELORA.policies.map((p) => p.th) });
    expect(c.status).toBe('onboarding');
    expect(await s.db.select().from(channels).where(and(eq(channels.clubId, c.id), eq(channels.kind, 'line')))).toHaveLength(1);
    const zs = await s.db.select().from(zones).where(eq(zones.clubId, c.id));
    expect(zs.map((z) => [z.name, z.minSpendSatang, z.depositSatang]).sort()).toEqual(VELORA.zones.map((z) => [z.name_en, z.minSpendSatang, z.depositSatang]).sort());
    const ts = await s.db.select().from(tables).where(eq(tables.clubId, c.id));
    expect(ts.map((t) => t.code).sort()).toEqual(VELORA.tables.map((t) => t.code).sort());
    expect(await s.db.select().from(priceRules).where(eq(priceRules.clubId, c.id))).toHaveLength(VELORA.priceRules.length);
    // A blank club still gets no content.
    expect((await createClub(s, 'blank-two')).status).toBe(201);
    const blank = await reload(s.db, 'blank-two');
    expect(await s.db.select().from(tables).where(eq(tables.clubId, blank.id))).toHaveLength(0);
  });

  it('the health tile reads LINE status and quota from the newest line_setup row, and shows not connected when there is none', async () => {
    const s = await setup();
    const report = (ok: boolean) => ({ ok, steps: [{ name: 'LINE credentials', ok, detail: '' }, { name: 'Webhook', ok, detail: '' }] });
    const row = (club: Club, ok: boolean, at: Date, quota: { used: number; limit: number } | null) =>
      s.db.insert(opsEvents).values({ id: newId(), clubId: club.id, kind: 'line_setup', detail: { report: report(ok), quota }, at });
    await row(s.clubB, false, new Date(T0.getTime() - 3_600_000), null);
    await row(s.clubB, true, new Date(T0.getTime() - 60_000), { used: 850, limit: 1000 });
    await s.db.insert(opsEvents).values({ id: newId(), clubId: s.clubB.id, kind: 'send_failed', detail: {}, at: new Date(T0.getTime() - 3_600_000) });
    const body = (await (await s.req('GET', '/api/admin/clubs')).json()) as {
      clubs: { slug: string; lineConnected: boolean; webhookOk: boolean; quota: { warn: boolean; pct: number } | null; failures24h: number; botPaused: boolean }[];
    };
    const b = body.clubs.find((c) => c.slug === 'test-b')!;
    expect(b).toMatchObject({ lineConnected: true, webhookOk: true, quota: { warn: true, pct: 85 }, failures24h: 1, botPaused: false });
    const a = body.clubs.find((c) => c.slug === s.clubA.slug)!;
    expect(a).toMatchObject({ lineConnected: false, webhookOk: false, quota: null });
  });

  it('tester-code route returns the code once', async () => {
    const s = await setup();
    const res = await s.req('POST', '/api/admin/clubs/test-b/tester-code');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expiresAt: string };
    expect(body.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(new Date(body.expiresAt).getTime()).toBe(T0.getTime() + 10 * 60_000);
    // Only the hash is stored, and the audit row does not carry the code.
    const flag = await s.db.query.platformFlags.findFirst({ where: eq(platformFlags.key, `tester_code:${s.clubB.id}`) });
    expect(flag).toBeTruthy();
    expect(JSON.stringify(flag)).not.toContain(body.code);
    const audits = await s.db.select().from(auditLog).where(eq(auditLog.action, 'line.tester_code_issued'));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(body.code);
    // A second call issues a different code; nothing reads the old one back.
    const again = (await (await s.req('POST', '/api/admin/clubs/test-b/tester-code')).json()) as { code: string };
    expect(again.code).not.toBe(body.code);
  });
});
