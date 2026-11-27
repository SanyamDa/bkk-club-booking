import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { auditLog, conversations, events, messages, rawWebhooks, type Club } from '../src/db/schema.js';
import { emit } from '../src/data/events.js';
import { dataRoutes } from '../src/http/admin/data.js';
import { debugRoutes } from '../src/http/admin/debug.js';
import { supportRoutes } from '../src/http/admin/support.js';
import { recordRawWebhook } from '../src/data/raw-webhooks.js';
import { processDelivery } from '../src/http/webhook.js';
import type { LineGateway } from '../src/line/gateway.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { adminCookie, staffCookie, testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let clock: Date;

/** The app with the A5 support/debug/data routers in front, independent of `http/admin/index.ts`. */
function supportApp() {
  const created = createApp(testConfig(), db, { bot: { now: () => clock, log: () => {} } });
  const h = new Hono();
  h.route('/api/admin', supportRoutes(created.ctx));
  h.route('/api/admin', debugRoutes(created.ctx));
  h.route('/api/admin', dataRoutes(created.ctx));
  h.all('*', (c) => created.app.fetch(c.req.raw));
  return { app: h, ctx: created.ctx, settle: created.settle };
}
let app: ReturnType<typeof supportApp>;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  clock = FRIDAY_AFTERNOON;
  app = supportApp();
});
afterEach(async () => {
  await app.settle();
  await close();
});

const post = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const daysAgo = (n: number) => new Date(clock.getTime() - n * 24 * 3600_000);

async function addEvent(club: Club, at: Date, extra: { conversationId?: string; type?: 'staff.login' } = {}) {
  await emit(db, {
    clubId: club.id,
    type: extra.type ?? 'staff.login',
    occurredAt: at,
    actorType: 'system',
    dataOrigin: 'first_party',
    conversationId: extra.conversationId,
    isTest: true,
  });
}

describe('admin support sessions', () => {
  it('support session without a reason is 400', async () => {
    const cookie = await adminCookie(app);
    const none = await app.app.request('/api/admin/support', post(cookie, { clubSlug: clubA.slug }));
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: 'reason_required' });
    const blank = await app.app.request('/api/admin/support', post(cookie, { clubSlug: clubA.slug, reason: '   ' }));
    expect(blank.status).toBe(400);
  });

  it('support start and end each emit their event', async () => {
    const cookie = await adminCookie(app);
    const res = await app.app.request('/api/admin/support', post(cookie, { clubSlug: clubB.slug, reason: 'Onboarding call' }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await app.app.request(`/api/admin/support/${id}/end`, post(cookie, {}))).status).toBe(200);

    const rows = await db.select().from(events).where(eq(events.clubId, clubB.id));
    const types = rows.map((e) => e.type);
    expect(types).toContain('support.session_started');
    expect(types).toContain('support.session_ended');
    const started = rows.find((e) => e.type === 'support.session_started')!;
    expect(started).toMatchObject({ actorType: 'platform', isTest: false });
    expect(started.props).toMatchObject({ supportGrantId: id, mode: 'read' });

    // Ending twice is refused.
    expect((await app.app.request(`/api/admin/support/${id}/end`, post(cookie, {}))).status).toBe(409);
  });

  it('support routes refuse a non-admin', async () => {
    const cookie = await staffCookie(app, clubA, 'owner');
    const res = await app.app.request('/api/admin/support', post(cookie, { clubSlug: clubA.slug, reason: 'x' }));
    expect(res.status).toBe(403);
    expect((await app.app.request('/api/admin/data/health', { headers: { cookie } })).status).toBe(403);
    expect((await app.app.request('/api/admin/events', { headers: { cookie } })).status).toBe(403);
    expect((await app.app.request(`/api/admin/clubs/${clubA.slug}/messages`, { headers: { cookie } })).status).toBe(403);
  });
});

describe('admin data', () => {
  it('data health shows a silent club', async () => {
    const old = daysAgo(3);
    await addEvent(clubB, old);
    await addEvent(clubA, clock);
    const cookie = await adminCookie(app);
    const res = await app.app.request('/api/admin/data/health', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      today: string;
      clubs: { slug: string; eventsToday: number; lastEventAt: string | null; eventsPerDay: { day: string; count: number }[] }[];
    };
    expect(body.today).toBe('2026-11-27');
    const b = body.clubs.find((x) => x.slug === clubB.slug)!;
    expect(b.eventsToday).toBe(0);
    expect(b.lastEventAt).toBe(old.toISOString());
    expect(b.eventsPerDay.find((d) => d.day === '2026-11-24')!.count).toBe(1);
    const a = body.clubs.find((x) => x.slug === clubA.slug)!;
    expect(a.eventsToday).toBeGreaterThanOrEqual(1);
  });

  it('event stream filters by conversation', async () => {
    await addEvent(clubA, daysAgo(2), { conversationId: 'conv_x' });
    await addEvent(clubA, daysAgo(1), { conversationId: 'conv_x' });
    await addEvent(clubA, daysAgo(1), { conversationId: 'conv_y' });
    const cookie = await adminCookie(app);
    const res = await app.app.request('/api/admin/events?conversation=conv_x', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { conversationId: string; occurredAt: string; seq: number }[] };
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e) => e.conversationId === 'conv_x')).toBe(true);
    expect(body.events[0]!.seq).toBeGreaterThan(body.events[1]!.seq); // newest first
    expect(body.events[0]!.occurredAt).toBe(daysAgo(1).toISOString());

    const page = await app.app.request(`/api/admin/events?conversation=conv_x&before=${body.events[0]!.seq}`, { headers: { cookie } });
    expect(((await page.json()) as { events: unknown[] }).events).toHaveLength(1);
  });
});

describe('admin debug', () => {
  it('conversation timeline orders messages by time and logs the view', async () => {
    const guest = await makeGuest(db, { clubId: clubA.id });
    const convId = newId();
    await db.insert(conversations).values({ id: convId, clubId: clubA.id, guestId: guest.id });
    await db.insert(messages).values([
      { id: newId(), clubId: clubA.id, guestId: guest.id, direction: 'in', kind: 'text', payload: { text: 'hi' }, createdAt: daysAgo(1) },
      {
        id: newId(),
        clubId: clubA.id,
        guestId: guest.id,
        direction: 'out',
        kind: 'text',
        payload: { text: 'hello' },
        deliveryStatus: 'failed',
        error: '429 quota',
        createdAt: clock,
      },
    ]);
    const cookie = await adminCookie(app);
    const res = await app.app.request(`/api/admin/clubs/${clubA.slug}/conversations/${convId}/timeline`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { kind: string; direction?: string; deliveryStatus?: string; error?: string }[] };
    const msgs = body.items.filter((i) => i.kind === 'message');
    expect(msgs.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(msgs[1]).toMatchObject({ deliveryStatus: 'failed', error: '429 quota' });

    const views = await db.select().from(auditLog).where(and(eq(auditLog.action, 'debug.view'), eq(auditLog.entityId, convId)));
    expect(views).toHaveLength(1);

    // Another club's slug does not reveal the conversation.
    const cross = await app.app.request(`/api/admin/clubs/${clubB.slug}/conversations/${convId}/timeline`, { headers: { cookie } });
    expect(cross.status).toBe(404);
  });

  it('webhook replay is a dry run: it shows the replies and writes nothing', async () => {
    const rawId = await recordRawWebhook(db, { clubId: clubA.id, channel: 'line', body: lineText('Ureplayguest', 'book a table'), signatureOk: true, receivedAt: clock });
    const cookie = await adminCookie(app);
    const before = (await db.select().from(messages)).length;
    const res = await app.app.request(`/api/admin/clubs/${clubA.slug}/webhooks/${rawId}/replay`, post(cookie, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; events: number; replies: unknown[] };
    expect(body).toMatchObject({ dryRun: true, events: 1 });
    expect(JSON.stringify(body.replies)).toContain('Which night');
    expect((await db.select().from(messages)).length).toBe(before);
    const [raw] = await db.select().from(rawWebhooks).where(eq(rawWebhooks.id, rawId));
    expect(raw!.processedAt).toBeNull();
    const cross = await app.app.request(`/api/admin/clubs/${clubB.slug}/webhooks/${rawId}/replay`, post(cookie, {}));
    expect(cross.status).toBe(404);
    // An unsigned delivery is never replayed.
    const forged = await recordRawWebhook(db, { clubId: clubA.id, channel: 'line', body: { rejected: 'bad_signature' }, signatureOk: false, receivedAt: clock });
    expect((await app.app.request(`/api/admin/clubs/${clubA.slug}/webhooks/${forged}/replay`, post(cookie, {}))).status).toBe(409);
  });

  it('opening the webhook and message lists writes an audit row each', async () => {
    const cookie = await adminCookie(app);
    for (const list of ['webhooks', 'messages']) {
      const res = await app.app.request(`/api/admin/clubs/${clubA.slug}/${list}?limit=10`, { headers: { cookie } });
      expect(res.status, list).toBe(200);
    }
    const views = await db.select().from(auditLog).where(and(eq(auditLog.action, 'debug.view'), eq(auditLog.clubId, clubA.id)));
    expect(views.map((v) => v.entity).sort()).toEqual(['messages', 'raw_webhooks']);
    expect(views.every((v) => v.entityId === clubA.id)).toBe(true);
    expect(views[0]!.data).toMatchObject({ method: 'GET', query: { limit: '10' } });
  });

  // Deferred (sync/track-a.md, A5): no founder LINE user id is stored, so `to: 'self'` answers 501.
  it.todo("test-message {to: 'self'} pushes to the founder's own LINE account (needs a stored founder LINE user id)");

  it('one guest message is traceable end to end', async () => {
    useLine();
    const rawId = await recordRawWebhook(db, { clubId: clubA.id, channel: 'line', body: lineText('Utraceguest', 'hello'), signatureOk: true, receivedAt: clock });
    await processDelivery(app.ctx, rawId);
    const [conv] = await db.select().from(conversations).where(eq(conversations.clubId, clubA.id));
    const cookie = await adminCookie(app);
    const res = await app.app.request(`/api/admin/clubs/${clubA.slug}/conversations/${conv!.id}/timeline`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { kind: string; id: string; result?: string; direction?: string; deliveryStatus?: string }[] };
    expect(items.find((i) => i.kind === 'raw_webhook')).toMatchObject({ id: rawId, result: 'processed' });
    const msgs = items.filter((i) => i.kind === 'message');
    expect(msgs.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(msgs[1]).toMatchObject({ deliveryStatus: 'sent' });
  });

  it("failed send shows in the message log with LINE's error", async () => {
    useLine(new Error('LINE API 429: You have reached your monthly limit.'));
    const rawId = await recordRawWebhook(db, { clubId: clubA.id, channel: 'line', body: lineText('Ufailguest', 'hello'), signatureOk: true, receivedAt: clock });
    await processDelivery(app.ctx, rawId);
    const cookie = await adminCookie(app);
    const res = await app.app.request(`/api/admin/clubs/${clubA.slug}/messages`, { headers: { cookie } });
    const { messages: log } = (await res.json()) as { messages: { direction: string; target: string | null; deliveryStatus: string; error: string }[] };
    expect(log.find((m) => m.direction === 'out' && m.target === null)).toMatchObject({
      deliveryStatus: 'failed',
      error: 'LINE API 429: You have reached your monthly limit.',
    });
  });
});

/** A signed-looking LINE text delivery body (signatures are checked by the route, not here). */
function lineText(userId: string, text: string) {
  const id = newId();
  return {
    destination: 'Ubot',
    events: [
      {
        type: 'message',
        mode: 'active',
        timestamp: clock.getTime(),
        webhookEventId: id,
        deliveryContext: { isRedelivery: false },
        source: { type: 'user', userId },
        replyToken: `rt-${id}`,
        message: { id: `m-${id}`, type: 'text', text, quoteToken: 'q' },
      },
    ],
  };
}

/** Gives clubA a fake LINE connection: every send succeeds, or fails with `sendError`. */
function useLine(sendError?: Error) {
  const send = async () => {
    if (sendError) throw sendError;
  };
  app.ctx.credentials.line = async () => ({ channelSecret: 's', accessToken: 't' });
  const gateway: LineGateway = {
    live: true,
    reply: send,
    push: send,
    getContent: async () => Buffer.alloc(0),
    getProfile: async () => ({ displayName: 'Guest', language: 'en' }),
    loading: async () => {},
  };
  app.ctx.gateways.forClub = async () => gateway;
}
