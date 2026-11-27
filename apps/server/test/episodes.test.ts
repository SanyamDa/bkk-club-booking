import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { recordStaffReply, startEpisode, type StaffReplySend } from '../src/chat/episodes.js';
import type { Db } from '../src/db/client.js';
import { alerts, conversations, events, guests, handoffEpisodes, messages, type Club } from '../src/db/schema.js';
import { HANDOFF_REALERT_KIND, runHandoffTimeouts } from '../src/jobs/handoff-timeout.js';
import type { GatewayRegistry, LineGateway } from '../src/line/gateway.js';
import { Outbox } from '../src/line/outbox.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY_AFTERNOON, setupDb } from './helpers.js';
import { adminCookie, makeUser, loginAs, staffUrl, testConfig } from './helpers/track-a.js';

const MIN = 60_000;
const T0 = FRIDAY_AFTERNOON;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

let ctx: Awaited<ReturnType<typeof setupDb>>;
let db: Db;
let club: Club;

beforeEach(async () => {
  ctx = await setupDb();
  db = ctx.db;
  club = ctx.club;
});
afterEach(async () => {
  await ctx.close();
});

/** A LINE guest with a bot-mode conversation. */
async function guestWithConversation(): Promise<{ guestId: string; conversationId: string }> {
  const guestId = newId();
  await db.insert(guests).values({ id: guestId, clubId: club.id, lineUserId: `U${guestId}`, displayName: 'Episode Guest' });
  const conversationId = newId();
  await db.insert(conversations).values({ id: conversationId, clubId: club.id, guestId, state: {} });
  return { guestId, conversationId };
}

/** A fake LINE send path that counts pushes. */
function fakeSend(): StaffReplySend & { pushes: unknown[][] } {
  const pushes: unknown[][] = [];
  const gateway = {
    live: false,
    reply: async () => {},
    push: async (_to: string, msgs: unknown[]) => {
      pushes.push(msgs);
    },
    loading: async () => {},
    getContent: async () => Buffer.alloc(0),
    getProfile: async () => null,
  } as unknown as LineGateway;
  return { outbox: new Outbox(db, () => {}), gateways: { forClub: async () => gateway } as unknown as GatewayRegistry, pushes };
}

const start = (conversationId: string, now: Date) =>
  db.transaction((tx) => startEpisode(tx, { clubId: club.id, conversationId, trigger: 'guest_request', reason: 'test', firstMessageId: null, now }));

const episodesOf = (conversationId: string) => db.select().from(handoffEpisodes).where(eq(handoffEpisodes.conversationId, conversationId));
const eventsOf = (type: string) => db.select().from(events).where(and(eq(events.clubId, club.id), eq(events.type, type)));
const modeOf = async (conversationId: string) => (await db.select().from(conversations).where(eq(conversations.id, conversationId)))[0]!.mode;

describe('handoff episodes (plan B14b)', () => {
  it('handoff creates one handoff_episodes row', async () => {
    const app = createApp(testConfig({ DEV_SIMULATOR: true }), db, { bot: { now: () => T0, log: () => {} } });
    const cookie = await adminCookie(app);
    const sim = async (text: string) => {
      const res = await app.app.request('/api/dev/demo/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ userId: 'episode-guest', displayName: 'Ari', type: 'text', text }),
      });
      expect(res.status).toBe(200);
    };
    await sim('can i talk to a person');
    await sim('hello? still there, can i talk to a person'); // the bot is silent in human mode
    const conv = (await db.select().from(conversations).where(eq(conversations.clubId, club.id)))[0]!;
    expect(conv.mode).toBe('human');
    const rows = await episodesOf(conv.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clubId: club.id, trigger: 'guest_request', topic: 'guest_request', endedAt: null });
    const [first] = await db.select().from(messages).where(eq(messages.id, rows[0]!.firstMessageId!));
    expect(first).toMatchObject({ direction: 'in', guestId: conv.guestId });
    const requested = await eventsOf('handoff.requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]!.props).toEqual({ trigger: 'guest_request' });

    // A second start while one is open returns the open episode.
    const again = await start(conv.id, at(1));
    expect(again.id).toBe(rows[0]!.id);
    expect(await episodesOf(conv.id)).toHaveLength(1);
  });

  it('recordStaffReply with a repeated externalId sends once', async () => {
    const { conversationId, guestId } = await guestWithConversation();
    const send = fakeSend();
    const userId = newId();
    const input = { clubId: club.id, conversationId, userId, text: 'Hi, a host here', channel: 'chatwoot', occurredAt: at(2), externalId: 'cw-msg-1' };
    const first = await recordStaffReply(db, input, send);
    const second = await recordStaffReply(db, { ...input, occurredAt: at(3) }, send);
    expect(second.messageId).toBe(first.messageId);
    expect(send.pushes).toHaveLength(1);
    const rows = await db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.externalId, 'cw-msg-1')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guestId, authorType: 'staff', authorId: userId, deliveryStatus: 'sent', sentVia: 'push' });
    expect(await eventsOf('host.replied')).toHaveLength(1);
    // A host replying to a bot-mode chat takes it over (spec §6.3).
    const [episode] = await episodesOf(conversationId);
    expect(episode).toMatchObject({ trigger: 'staff_reply', lastMessageId: first.messageId, endedAt: null });
    expect(await modeOf(conversationId)).toBe('human');
  });

  it("the timeout job ends the episode with endedBy='timeout' and returns the conversation to bot mode", async () => {
    const { conversationId } = await guestWithConversation();
    const episode = await start(conversationId, T0);
    expect(await runHandoffTimeouts(db, at(29))).toEqual({ realerted: [episode.id], ended: [] });
    expect(await runHandoffTimeouts(db, at(30))).toEqual({ realerted: [], ended: [episode.id] });
    const [ended] = await episodesOf(conversationId);
    expect(ended).toMatchObject({ endedBy: 'timeout', endedAt: at(30) });
    expect(await modeOf(conversationId)).toBe('bot');
    const timedOut = await eventsOf('handoff.timed_out');
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({ conversationId, actorType: 'system' });
    expect(timedOut[0]!.props).toEqual({ durationSec: 1800 });
    expect(await runHandoffTimeouts(db, at(31))).toEqual({ realerted: [], ended: [] });
  });

  it('the timeout job re-alerts at half the timeout and counts from the last staff reply', async () => {
    const { conversationId } = await guestWithConversation();
    const episode = await start(conversationId, T0);
    const realerts = () => db.select().from(alerts).where(and(eq(alerts.conversationId, conversationId), eq(alerts.kind, HANDOFF_REALERT_KIND)));
    expect(await runHandoffTimeouts(db, at(14))).toEqual({ realerted: [], ended: [] });
    expect(await runHandoffTimeouts(db, at(15))).toEqual({ realerted: [episode.id], ended: [] });
    expect(await runHandoffTimeouts(db, at(16))).toEqual({ realerted: [], ended: [] });
    expect(await realerts()).toHaveLength(1);
    expect((await realerts())[0]).toMatchObject({ level: 'urgent' });

    await recordStaffReply(
      db,
      { clubId: club.id, conversationId, userId: newId(), text: 'Checking for you', channel: 'dashboard', occurredAt: at(20), externalId: null },
      fakeSend(),
    );
    expect(await runHandoffTimeouts(db, at(31))).toEqual({ realerted: [], ended: [] });
    expect(await runHandoffTimeouts(db, at(35))).toEqual({ realerted: [episode.id], ended: [] });
    expect(await runHandoffTimeouts(db, at(49))).toEqual({ realerted: [], ended: [] });
    expect(await modeOf(conversationId)).toBe('human');
    expect((await realerts()).filter((a) => a.resolvedAt === null)).toHaveLength(2);
    expect(await runHandoffTimeouts(db, at(50))).toEqual({ realerted: [], ended: [episode.id] });
    expect(await modeOf(conversationId)).toBe('bot');
    // Ending the takeover resolves its re-alerts.
    expect((await realerts()).every((a) => a.resolvedAt?.getTime() === at(50).getTime())).toBe(true);
  });

  it('no mode change happens outside chat/episodes.ts', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcDir);
    // A write of conversations.mode: an UPDATE of `conversations` whose SET names `mode`, or the
    // flow's `updateConversation(..., { mode })` helper. Seed inserts of new rows are not mode changes.
    const changesMode = (code: string) =>
      [...code.matchAll(/\.update\(conversations\)\s*\.set\(\{([^}]*)\}/g)].some((m) => /\bmode\b/.test(m[1]!)) ||
      /updateConversation\([^)]*\bmode\s*:/.test(code);
    const offenders = files.filter((f) => !f.endsWith(join('chat', 'episodes.ts'))).filter((f) => changesMode(readFileSync(f, 'utf8')));
    // The check itself finds a mode change: episodes.ts has two.
    expect(changesMode(readFileSync(join(srcDir, 'chat', 'episodes.ts'), 'utf8'))).toBe(true);
    expect(offenders.map((f) => f.slice(srcDir.length + 1))).toEqual([]);
  });

  it('dashboard resolve closes the open episode', async () => {
    const app = createApp(testConfig(), db, { bot: { now: () => at(5), log: () => {} } });
    const user = await makeUser(db, { email: 'host-episodes@test.local', clubId: club.id, role: 'host' });
    const cookie = await loginAs(app, user);
    const { conversationId } = await guestWithConversation();
    await start(conversationId, T0);

    const reply = await app.app.request(staffUrl(club.slug, `/conversations/${conversationId}/reply`), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });
    expect(reply.status).toBe(200);
    const [staffMsg] = await db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.authorType, 'staff')));
    expect(staffMsg).toMatchObject({ authorId: user.id, direction: 'out' });

    const res = await app.app.request(staffUrl(club.slug, `/conversations/${conversationId}/resolve`), { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const rows = await episodesOf(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endedBy: 'staff', resolverUserId: user.id, endedAt: at(5), lastMessageId: staffMsg!.id });
    expect(await modeOf(conversationId)).toBe('bot');
    const resolved = await eventsOf('handoff.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ conversationId, actorType: 'staff', actorId: user.id });
    expect(resolved[0]!.props).toEqual({ durationSec: 300 });
  });
});
