import { createHmac } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { recordRawWebhook } from '../src/data/raw-webhooks.js';
import type { Db } from '../src/db/client.js';
import { alerts, bookings, clubs, conversations, events, guests, messages, opsEvents, platformFlags, rawWebhooks, type Club } from '../src/db/schema.js';
import { BAD_SIGNATURE_LIMIT_PER_IP } from '../src/http/integrations.js';
import { processDelivery, REPLAY_MAX_AGE_MS, replayUnprocessed } from '../src/http/webhook.js';
import { startBackground } from '../src/jobs/index.js';
import type { CredentialStore } from '../src/line/credentials.js';
import type { LineGateway, Message } from '../src/line/gateway.js';
import { newId } from '../src/lib/util.js';
import { GLOBAL_STOP_FLAG } from '../src/platform/support.js';
import { FRIDAY_AFTERNOON, makeGuest, setupDb } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

/** Plan B3: durable webhook pipeline, ops events, bot pause. */
const SECRET = 'durable-channel-secret';

type Sent = { via: 'reply' | 'push'; to: string; messages: Message[] };

/** A LINE gateway that records every send; each method can be overridden to fail. */
function fakeGateway(over: Partial<LineGateway> = {}): LineGateway & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    live: true,
    sent,
    reply: async (to, msgs) => void sent.push({ via: 'reply', to, messages: msgs }),
    push: async (to, msgs) => void sent.push({ via: 'push', to, messages: msgs }),
    getContent: async () => Buffer.alloc(0),
    getProfile: async () => ({ displayName: 'Durable guest', language: 'en' }),
    loading: async () => {},
    ...over,
  };
}

const credentials: CredentialStore = {
  channelSecret: async () => SECRET,
  line: async () => ({ channelSecret: SECRET, accessToken: 'fake-token' }),
  login: async () => null,
};

let db: Db;
let close: () => Promise<void>;
let club: Club;
let clock: Date;
let created: ReturnType<typeof createApp>;
let gw: ReturnType<typeof fakeGateway>;

function useGateway(g: ReturnType<typeof fakeGateway>) {
  gw = g;
  created.ctx.gateways.forClub = async () => gw;
}

beforeEach(async () => {
  ({ db, close, club } = await setupDb());
  clock = FRIDAY_AFTERNOON;
  created = createApp(testConfig(), db, { bot: { now: () => clock, log: () => {} }, credentials });
  useGateway(fakeGateway());
});
afterEach(async () => {
  await created.settle();
  await close();
});

function textBody(userId: string, text: string, eventId = newId()) {
  return {
    destination: 'Ubot',
    events: [
      {
        type: 'message',
        mode: 'active',
        timestamp: clock.getTime(),
        webhookEventId: eventId,
        deliveryContext: { isRedelivery: false },
        source: { type: 'user', userId },
        replyToken: `rt-${eventId}`,
        message: { id: `m-${eventId}`, type: 'text', text, quoteToken: 'q' },
      },
    ],
  };
}

async function post(body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  const sig = signature ?? createHmac('sha256', SECRET).update(raw).digest('base64');
  const res = await created.app.request(`/line/webhook/${club.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sig },
    body: raw,
  });
  await created.settle();
  return res;
}

const raws = () => db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, club.id));
const inbound = () => db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.direction, 'in')));
/** The turn's own replies: B4's one-time data notice line (asserted in chat-capture.test.ts) is left out. */
const guestOut = async () =>
  (await db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.direction, 'out'), isNull(messages.target)))).filter(
    (m) => !String((m.payload as { text?: string }).text ?? '').startsWith('Chats and bookings with'),
  );
const staffOut = () => db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.target, 'staff')));
const ops = (kind: (typeof opsEvents.$inferSelect)['kind']) => db.select().from(opsEvents).where(eq(opsEvents.kind, kind));
const ago = (ms: number) => new Date(clock.getTime() - ms);

async function counts() {
  return {
    messages: (await db.select().from(messages)).length,
    events: (await db.select().from(events)).length,
    bookings: (await db.select().from(bookings)).length,
    conversations: (await db.select().from(conversations)).length,
    raws: (await db.select().from(rawWebhooks)).length,
    ops: (await db.select().from(opsEvents)).length,
  };
}

async function pause(at: Date | null) {
  await db.update(clubs).set({ botPaused: at !== null, botPausedAt: at }).where(eq(clubs.id, club.id));
}

describe('durable webhook pipeline (B3)', () => {
  it('raw webhook stored before processing', async () => {
    useGateway(fakeGateway({ getProfile: async () => { throw new Error('profile lookup exploded'); } }));
    const res = await post(textBody('Ucrash1', 'hello'));
    expect(res.status).toBe(200);
    const [row] = await raws();
    expect(row).toMatchObject({ channel: 'line', signatureOk: true, processedAt: null });
    expect(row!.error).toContain('profile lookup exploded');
    expect((row!.body as { events: unknown[] }).events).toHaveLength(1);
    expect(await ops('bot_error')).toHaveLength(1);
  });

  it('unprocessed raw webhook is replayed on startup', async () => {
    const old = await recordRawWebhook(db, { clubId: club.id, channel: 'line', body: textBody('Ureplay1', 'hello'), signatureOk: true, receivedAt: ago(60_000) });
    // Younger than 10 s: still in flight, left alone.
    const fresh = await recordRawWebhook(db, { clubId: club.id, channel: 'line', body: textBody('Ureplay2', 'hello'), signatureOk: true, receivedAt: ago(2_000) });
    // Unsigned and non-LINE rows are never replayed.
    await recordRawWebhook(db, { clubId: club.id, channel: 'line', body: { rejected: 'bad_signature' }, signatureOk: false, receivedAt: ago(60_000) });
    await recordRawWebhook(db, { clubId: club.id, channel: 'pos:papaya', body: {}, signatureOk: true, receivedAt: ago(60_000) });

    expect(await replayUnprocessed(created.ctx, clock)).toBe(1);
    const rows = await raws();
    expect(rows.find((r) => r.id === old)!.processedAt).not.toBeNull();
    expect(rows.find((r) => r.id === fresh)!.processedAt).toBeNull();
    expect(gw.sent.filter((s) => s.via === 'reply')).toHaveLength(1);
    expect(await inbound()).toHaveLength(1);
  });

  it('an unprocessed delivery older than the replay window is abandoned, not replayed', async () => {
    const stale = await recordRawWebhook(db, {
      clubId: club.id, channel: 'line', body: textBody('Ustale1', 'hello'), signatureOk: true,
      receivedAt: ago(REPLAY_MAX_AGE_MS + 60_000), error: 'LINE access token missing',
    });
    const recent = await recordRawWebhook(db, { clubId: club.id, channel: 'line', body: textBody('Urecent1', 'hello'), signatureOk: true, receivedAt: ago(60_000) });
    expect(await replayUnprocessed(created.ctx, clock)).toBe(1);
    const rows = await raws();
    const s = rows.find((r) => r.id === stale)!;
    expect(s.processedAt).toEqual(clock);
    expect(s.error).toMatch(/^abandoned: .*LINE access token missing$/);
    expect(rows.find((r) => r.id === recent)!.processedAt).not.toBeNull();
    // Only the recent delivery ran a turn.
    expect(gw.sent).toHaveLength(1);
    expect(await inbound()).toHaveLength(1);
    // A second start-up runs nothing.
    expect(await replayUnprocessed(created.ctx, clock)).toBe(0);
  });

  it('unauthenticated writes are rate limited: bad signatures get 429 and unknown slugs stop writing ops rows', async () => {
    const body = textBody('Uflood1', 'hello');
    let limited = 0;
    for (let i = 0; i < BAD_SIGNATURE_LIMIT_PER_IP + 5; i++) if ((await post(body, 'forged')).status === 429) limited++;
    expect(limited).toBe(5);
    expect(await raws()).toHaveLength(BAD_SIGNATURE_LIMIT_PER_IP);
    expect(await ops('webhook_bad_signature')).toHaveLength(BAD_SIGNATURE_LIMIT_PER_IP);

    for (let i = 0; i < BAD_SIGNATURE_LIMIT_PER_IP + 5; i++) {
      const res = await created.app.request(`/line/webhook/nope-${i}`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(404);
    }
    expect(await ops('webhook_unknown_club')).toHaveLength(BAD_SIGNATURE_LIMIT_PER_IP);
  });

  it('startBackground replays unprocessed deliveries before it returns', async () => {
    const old = await recordRawWebhook(db, { clubId: club.id, channel: 'line', body: textBody('Ureplay3', 'hello'), signatureOk: true, receivedAt: ago(60_000) });
    const stop = await startBackground(created.ctx, () => clock);
    try {
      const row = (await raws()).find((r) => r.id === old)!;
      expect(row.processedAt).not.toBeNull();
      expect(gw.sent.filter((s) => s.via === 'reply')).toHaveLength(1);
    } finally {
      await stop();
    }
  });

  it('delivery that crashed after the inbound row was stored is replied to on replay', async () => {
    const eventId = newId();
    const guest = await makeGuest(db, { clubId: club.id, lineUserId: 'Ucrashed1' });
    const rawId = await recordRawWebhook(db, { clubId: club.id, channel: 'line', body: textBody('Ucrashed1', 'hello', eventId), signatureOk: true, receivedAt: ago(60_000) });
    await db.insert(messages).values({ id: newId(), clubId: club.id, guestId: guest.id, direction: 'in', kind: 'text', payload: { text: 'hello' }, lineMessageId: eventId });

    expect(await replayUnprocessed(created.ctx, clock)).toBe(1);
    expect(gw.sent).toHaveLength(1);
    const [raw] = await db.select().from(rawWebhooks).where(eq(rawWebhooks.id, rawId));
    expect(raw!.processedAt).not.toBeNull();
    const ins = await inbound();
    expect(ins).toHaveLength(1); // the crashed turn's row is reused
    expect(ins[0]!.processedAt).not.toBeNull();
    expect(await guestOut()).toHaveLength(1);
  });

  it('redelivered webhook event id is processed once', async () => {
    const body = textBody('Uredeliver1', 'hello');
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect(await inbound()).toHaveLength(1);
    expect(await guestOut()).toHaveLength(1);
    expect(gw.sent).toHaveLength(1);
    const rows = await raws();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.processedAt !== null && r.error === null)).toBe(true);
    // A replay of a finished delivery is a no-op too.
    await processDelivery(created.ctx, rows[0]!.id);
    expect(gw.sent).toHaveLength(1);
  });

  it('bad signature is recorded, not processed', async () => {
    const res = await post(textBody('Uforged1', 'hello'), 'forged');
    expect(res.status).toBe(401);
    const [row] = await raws();
    expect(row).toMatchObject({ signatureOk: false, processedAt: null });
    expect(JSON.stringify(row!.body)).not.toContain('Uforged1'); // an unsigned body is not kept
    expect(await ops('webhook_bad_signature')).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(0);
    expect(gw.sent).toHaveLength(0);
    expect(await replayUnprocessed(created.ctx, new Date(clock.getTime() + 60_000))).toBe(0);

    // Unknown club: an ops row with no club, 404, nothing stored.
    const unknown = await created.app.request('/line/webhook/no-such-club', { method: 'POST', body: '{}' });
    expect(unknown.status).toBe(404);
    const [u] = await ops('webhook_unknown_club');
    expect(u).toMatchObject({ clubId: null, detail: { slug: 'no-such-club' } });
  });

  it('failed send records delivery_status failed and an ops event', async () => {
    useGateway(
      fakeGateway({
        reply: async () => { throw new Error('Invalid reply token'); },
        push: async () => { throw new Error('429 monthly quota reached'); },
      }),
    );
    await post(textBody('Ufail1', 'hello'));
    const [out] = await guestOut();
    expect(out).toMatchObject({ deliveryStatus: 'failed', sentVia: 'push' });
    expect(out!.error).toContain('429 monthly quota reached');
    const [op] = await ops('send_failed');
    // The batch also holds B4's data notice line, sent with the reply.
    expect(op).toMatchObject({ clubId: club.id, detail: { target: 'guest', messageIds: expect.arrayContaining([out!.id]) } });

    // A successful send says sent, with how it went out.
    useGateway(fakeGateway());
    await post(textBody('Uok1', 'hello'));
    const ok = (await guestOut()).find((m) => m.id !== out!.id)!;
    expect(ok).toMatchObject({ deliveryStatus: 'sent', sentVia: 'reply', error: null });
  });

  it('paused club stores inbound and sends nothing', async () => {
    await pause(clock);
    expect((await post(textBody('Upaused1', 'book a table'))).status).toBe(200);
    expect(await inbound()).toHaveLength(1);
    expect(await guestOut()).toHaveLength(0);
    expect(gw.sent.filter((s) => s.to !== club.staffGroupId)).toHaveLength(0);
    const [raw] = await raws();
    expect(raw!.processedAt).not.toBeNull();
  });

  it('paused club alerts the staff group once per conversation per pause, and again after a new pause', async () => {
    await pause(clock);
    await post(textBody('Upa1', 'hello'));
    await post(textBody('Upa1', 'anyone there?'));
    expect(await staffOut()).toHaveLength(1);
    expect(((await staffOut())[0]!.payload as { text: string }).text).toContain('Bot is paused');
    await post(textBody('Upa2', 'hello')); // another conversation: its own alert
    expect(await staffOut()).toHaveLength(2);

    // Resume, then a new pause: the first guest alerts again, once.
    await pause(null);
    await pause(new Date(clock.getTime() + 3_600_000));
    await post(textBody('Upa1', 'hello again'));
    await post(textBody('Upa1', 'hello?'));
    expect(await staffOut()).toHaveLength(3);

    // The platform-wide stop is a pause too, with its own identity.
    await pause(null);
    await db.insert(platformFlags).values({ key: GLOBAL_STOP_FLAG, value: { stopped: true }, updatedAt: clock });
    await post(textBody('Upa1', 'still there?'));
    await post(textBody('Upa1', 'hello??'));
    expect(await staffOut()).toHaveLength(4);
    expect(await guestOut()).toHaveLength(0);
    expect(await inbound()).toHaveLength(7);

    // B19b: each of those staff messages is one urgent `bot_paused` alert, carrying its conversation.
    const convOf = async (lineUserId: string) => {
      const [row] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .innerJoin(guests, eq(guests.id, conversations.guestId))
        .where(and(eq(conversations.clubId, club.id), eq(guests.lineUserId, lineUserId)));
      return row!.id;
    };
    const paused = await db.select().from(alerts).where(and(eq(alerts.clubId, club.id), eq(alerts.kind, 'bot_paused')));
    expect(paused).toHaveLength(4);
    for (const a of paused) expect(a.level).toBe('urgent');
    const [c1, c2] = [await convOf('Upa1'), await convOf('Upa2')];
    expect(paused.map((a) => a.conversationId).sort()).toEqual([c1, c1, c1, c2].sort());
  });

  it('dry run replay sends nothing and writes nothing', async () => {
    const rawId = await recordRawWebhook(db, { clubId: club.id, channel: 'line', body: textBody('Udry1', 'book a table'), signatureOk: true, receivedAt: ago(60_000) });
    const before = await counts();
    const result = await processDelivery(created.ctx, rawId, { dryRun: true });
    expect(result.events).toBe(1);
    expect(result.replies.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.replies)).toContain('Which night');
    expect(await counts()).toEqual(before);
    expect(gw.sent).toHaveLength(0);
    const [raw] = await db.select().from(rawWebhooks).where(eq(rawWebhooks.id, rawId));
    expect(raw).toMatchObject({ processedAt: null, error: null });
  });

  it('dry run replay of an already processed delivery returns the replies and writes nothing', async () => {
    await post(textBody('Udry2', 'book a table'));
    const [raw] = await raws();
    expect(raw!.processedAt).not.toBeNull();
    expect(gw.sent).toHaveLength(1);
    const before = await counts();
    const result = await processDelivery(created.ctx, raw!.id, { dryRun: true });
    expect(JSON.stringify(result.replies)).toContain('Which night');
    expect(await counts()).toEqual(before);
    expect(gw.sent).toHaveLength(1);
  });
});
