import { validateSignature, type webhook } from '@line/bot-sdk';
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { buildBotDeps } from '../bot/deps.js';
import { processEvent, recordBotError } from '../bot/flow.js';
import { alertBotError } from '../bot/alerts.js';
import { emit, type EventInput } from '../data/events.js';
import { recordOps } from '../data/ops.js';
import { isTestContext } from '../data/test-flag.js';
import { errorText, markRawError, markRawProcessed, rawBody, recordRawWebhook } from '../data/raw-webhooks.js';
import { detectIntent } from '../bot/intents.js';
import type { Db } from '../db/client.js';
import { clubs, rawWebhooks, type Club } from '../db/schema.js';
import type { LineGateway, Message } from '../line/gateway.js';
import { clientIp } from './auth.js';
import type { AppContext } from './context.js';
import { BAD_SIGNATURE_LIMIT_PER_CLUB, BAD_SIGNATURE_LIMIT_PER_IP, minuteCounter } from './integrations.js';

/** Unprocessed deliveries younger than this are still in flight; start-up replay leaves them alone. */
const REPLAY_MIN_AGE_MS = 10_000;
/**
 * Unprocessed deliveries older than this are abandoned, not replayed: a turn hours old would push
 * replies to old messages (the reply token is long expired).
 */
export const REPLAY_MAX_AGE_MS = 6 * 60 * 60_000;

/** B4b (§14.2): a delivery the webhook refused, for the club its URL names. Capped with the ops row. */
function rejectedEvent(club: Club, reason: 'bad_signature' | 'bad_json', now: Date): EventInput {
  return { clubId: club.id, type: 'line.webhook.rejected', occurredAt: now, actorType: 'system', channel: 'line', dataOrigin: 'first_party', props: { reason }, isTest: isTestContext({ club }) };
}

/**
 * POST /line/webhook/:slug — one webhook URL per club (plan B3 order): find club (unknown → ops
 * `webhook_unknown_club`, 404) → read body → verify the signature with the club's channel secret
 * (bad → `raw_webhooks` row with `signature_ok=false` and ops `webhook_bad_signature`, 401) →
 * store the raw delivery → answer 200 → process in the background (`processDelivery`).
 */
export function webhookRoutes(app: AppContext) {
  const r = new Hono();
  const db = app.deps.db;
  // Unauthenticated writes (ops rows, bad-signature raw rows) are capped per minute, as in
  // http/integrations.ts, so an anonymous caller cannot grow those tables without bound.
  const unknownSlugs = minuteCounter();
  const badSignatures = minuteCounter();

  r.post('/:slug', async (c) => {
    const now = app.deps.now();
    const slug = c.req.param('slug');
    const ip = clientIp(c) ?? 'unknown';
    const club = await db.query.clubs.findFirst({ where: eq(clubs.slug, slug) });
    if (!club) {
      if (unknownSlugs(ip, now) <= BAD_SIGNATURE_LIMIT_PER_IP) {
        await recordOps(db, null, 'webhook_unknown_club', { slug: slug.slice(0, 100) }, now);
      }
      return c.text('Unknown club', 404);
    }
    const channelSecret = await app.credentials.channelSecret(club);
    if (!channelSecret) return c.text('LINE is not configured for this club', 404);

    const text = await c.req.text();
    const signature = c.req.header('x-line-signature') ?? '';
    if (!validateSignature(text, channelSecret, signature)) {
      if (badSignatures(`${club.id}|${ip}`, now) > BAD_SIGNATURE_LIMIT_PER_IP) return c.text('Rate limited', 429);
      if (badSignatures(club.id, now) > BAD_SIGNATURE_LIMIT_PER_CLUB) return c.text('Rate limited', 429);
      // An unsigned caller only knows the slug: keep a summary row, never its body.
      const summary = { rejected: 'bad_signature', bytes: text.length };
      await recordRawWebhook(db, { clubId: club.id, channel: 'line', body: summary, signatureOk: false, receivedAt: now });
      await recordOps(db, club.id, 'webhook_bad_signature', summary, now);
      await emit(db, rejectedEvent(club, 'bad_signature', now));
      return c.text('Bad signature', 401);
    }

    const { body, parsed } = rawBody(text);
    if (parsed === null || typeof parsed !== 'object') {
      await recordRawWebhook(db, { clubId: club.id, channel: 'line', body, signatureOk: true, receivedAt: now, error: 'bad_json' });
      await emit(db, rejectedEvent(club, 'bad_json', now));
      return c.text('Bad JSON', 400);
    }
    // Stored before the 200: a crash after the answer loses nothing (start-up replays it).
    const rawId = await recordRawWebhook(db, { clubId: club.id, channel: 'line', body, signatureOk: true, receivedAt: now });
    app.track(processDelivery(app, rawId));
    return c.text('OK');
  });

  return r;
}

/** A gateway that sends nothing and collects every reply and push (dry-run replay). */
function collectingGateway(base: LineGateway, replies: unknown[]): LineGateway {
  return {
    live: false,
    reply: async (replyToken: string, messages: Message[]) => {
      replies.push({ via: 'reply', replyToken, messages });
    },
    push: async (to: string, messages: Message[]) => {
      replies.push({ via: 'push', to, messages });
    },
    getContent: (id) => base.getContent(id),
    getProfile: (id) => base.getProfile(id),
    loading: async () => {},
  };
}

class DryRunRollback extends Error {}

/**
 * Processes one stored LINE delivery (plan B3). Each event runs through `processEvent`; a throw
 * sets `raw_webhooks.error` and leaves `processed_at` NULL, then the next event runs. When every
 * event succeeds, `processed_at` is set.
 *
 * Dry run (founder replay, A5): runs inside one transaction with fresh deps on `tx`, the dev
 * gateway (wrapped to collect what would be sent), no dedupe check, then always rolls back.
 * Nothing on that path may touch the root db.
 */
export async function processDelivery(ctx: AppContext, rawId: string, opts: { dryRun?: boolean } = {}): Promise<{ events: number; replies: unknown[] }> {
  const db = ctx.deps.db;
  const [raw] = await db.select().from(rawWebhooks).where(eq(rawWebhooks.id, rawId)).limit(1);
  if (!raw || !raw.signatureOk || raw.channel !== 'line' || !raw.clubId) return { events: 0, replies: [] };
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, raw.clubId) });
  if (!club) return { events: 0, replies: [] };
  const events = ((raw.body as Partial<webhook.CallbackRequest>).events ?? []) as webhook.Event[];

  if (opts.dryRun) {
    const replies: unknown[] = [];
    try {
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        // Never call the slip provider, a payment gateway or a model from a dry run: the call would
        // be real and its cost events would roll back with the transaction.
        const deps = buildBotDeps(ctx.config, tx, { now: ctx.deps.now, log: ctx.deps.log, slipVerifier: null, payments: {}, ai: null, learn: null, judge: null });
        const gateway = collectingGateway(ctx.gateways.dev, replies);
        for (const event of events) await processEvent(deps, club, gateway, event, { ignoreDedupe: true });
        throw new DryRunRollback();
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
    return { events: events.length, replies };
  }

  // A signed event with no access token must not fall back to the dev gateway: the guest's turn
  // would run and every reply would vanish. Record it; a later replay retries.
  let gateway: LineGateway;
  try {
    if (!(await ctx.credentials.line(club))) throw new Error('LINE access token missing');
    gateway = await ctx.gateways.forClub(club);
  } catch (err) {
    ctx.deps.log(`${errorText(err)} for club ${club.id}: skipped ${events.length} webhook event(s)`);
    await markRawError(db, rawId, errorText(err));
    return { events: 0, replies: [] };
  }

  const errors: string[] = [];
  for (const event of events) {
    try {
      await processEvent(ctx.deps, club, gateway, event);
    } catch (err) {
      ctx.deps.log(`Bot error for club ${club.id}`, err);
      const error = errorText(err);
      errors.push(error);
      await recordOps(db, club.id, 'bot_error', { rawWebhookId: rawId, webhookEventId: event.webhookEventId, error }, ctx.deps.now());
      await recordBotError(db, club, event, err, ctx.deps.now()).catch((e) => ctx.deps.log(`bot.error event failed for club ${club.id}`, e));
      // B19b: urgent (§6.4), one open per club; an alert failure must not hide the recorded error.
      await alertBotError(db, club.id, ctx.deps.now()).catch((e) => ctx.deps.log(`bot_error alert failed for club ${club.id}`, e));
    }
  }
  if (errors.length) await markRawError(db, rawId, errors.join('; '));
  else await markRawProcessed(db, rawId, ctx.deps.now(), staffChatterStripped(raw.body));
  return { events: events.length, replies: [] };
}

/**
 * Spec §14.2: once processed, messages from a staff group are dropped from the stored copy, except
 * the bot's own command (`link <code>`). Returns no body when nothing changes.
 */
export function staffChatterStripped(body: unknown): { body?: object } {
  const b = body as Partial<webhook.CallbackRequest> | null;
  if (!b || !Array.isArray(b.events)) return {};
  const kept = b.events.filter((e) => {
    if (e.source?.type !== 'group' || e.type !== 'message') return true;
    return e.message.type === 'text' && detectIntent(e.message.text).kind === 'staff_link';
  });
  return kept.length === b.events.length ? {} : { body: { ...b, events: kept } };
}

/**
 * Start-up replay (plan B3): every signed LINE delivery with `processed_at` NULL that is older
 * than 10 s and younger than `REPLAY_MAX_AGE_MS`, oldest first. Older unprocessed deliveries are
 * abandoned: `processed_at` set (so retention purges them) and `error` prefixed `abandoned:`.
 * Returns how many deliveries it ran.
 */
export async function replayUnprocessed(ctx: AppContext, now: Date): Promise<number> {
  const db = ctx.deps.db;
  const base = and(isNull(rawWebhooks.processedAt), eq(rawWebhooks.signatureOk, true), eq(rawWebhooks.channel, 'line'));
  const cutoff = new Date(now.getTime() - REPLAY_MAX_AGE_MS);
  await db
    .update(rawWebhooks)
    .set({
      processedAt: now,
      error: sql`left('abandoned: not replayed after ' || ${REPLAY_MAX_AGE_MS / 3_600_000} || ' h' || coalesce('; ' || ${rawWebhooks.error}, ''), 2000)`,
    })
    .where(and(base, lt(rawWebhooks.receivedAt, cutoff)));
  const rows = await db
    .select({ id: rawWebhooks.id })
    .from(rawWebhooks)
    .where(and(base, gte(rawWebhooks.receivedAt, cutoff), lt(rawWebhooks.receivedAt, new Date(now.getTime() - REPLAY_MIN_AGE_MS))))
    .orderBy(asc(rawWebhooks.receivedAt));
  for (const row of rows) {
    try {
      await processDelivery(ctx, row.id);
    } catch (err) {
      ctx.deps.log(`Replay of raw webhook ${row.id} failed`, err);
    }
  }
  return rows.length;
}
