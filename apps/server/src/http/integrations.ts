import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { errorText, markRawError, markRawProcessed, rawBody, recordRawWebhook } from '../data/raw-webhooks.js';
import { clubs } from '../db/schema.js';
import { applyCallback, checkCallback } from '../integrations/chatwoot/callback.js';
import { instagramState, recordInstagramMessage, verifyInstagramToken } from '../integrations/chatwoot/instagram.js';
import { applyLiveBill, loadPosAdapter } from '../integrations/pos/live.js';
import { PAPAYA_SIGNATURE_HEADER } from '../integrations/pos/papaya.js';
import { clientIp } from './auth.js';
import type { AppContext } from './context.js';

/** Bad-signature deliveries per (club, IP) per minute, and per club per minute, before 429. */
export const BAD_SIGNATURE_LIMIT_PER_IP = 20;
export const BAD_SIGNATURE_LIMIT_PER_CLUB = 60;

/**
 * Fixed one-minute windows, in memory (one process). Bounds what unsigned callers can write.
 * Also used by the LINE webhook route (`http/webhook.ts`).
 */
export function minuteCounter() {
  const counts = new Map<string, { window: number; n: number }>();
  return (key: string, now: Date): number => {
    const window = Math.floor(now.getTime() / 60_000);
    if (counts.size > 10_000) for (const [k, v] of counts) if (v.window !== window) counts.delete(k);
    const cur = counts.get(key);
    const n = cur && cur.window === window ? cur.n + 1 : 1;
    counts.set(key, { window, n });
    return n;
  };
}

/**
 * Inbound vendor webhooks (plan A19), mounted at `/integrations`. Each club's webhook address is
 * `/integrations/pos/papaya/<club slug>`, entered as the address of both Papaya keys at setup.
 */
export function integrationRoutes(app: AppContext) {
  const r = new Hono();
  const db = app.deps.db;
  const badSignatures = minuteCounter();

  // A14: the LINE API inbox webhook. Staff replies typed in Chatwoot and its resolve button come
  // back here. The token set by the bridge (`ensureBridgeWebhook`) is the proof of origin; a
  // delivery whose account or conversation is not this club's is refused before anything is written.
  r.post('/chatwoot/:clubId/callback', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const club = await db.query.clubs.findFirst({ where: eq(clubs.id, c.req.param('clubId')) });
    if (!club) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    const { body, parsed } = rawBody(await c.req.text());
    const checked = await checkCallback(db, club, c.req.query('token'), parsed);
    if (!checked.ok) {
      if (checked.status === 401) {
        if (badSignatures(`${club.id}|${clientIp(c) ?? 'unknown'}`, now) > BAD_SIGNATURE_LIMIT_PER_IP) return c.json({ error: 'rate_limited' }, 429);
        if (badSignatures(club.id, now) > BAD_SIGNATURE_LIMIT_PER_CLUB) return c.json({ error: 'rate_limited' }, 429);
      }
      return c.json({ error: checked.error }, checked.status);
    }
    if (checked.kind === 'ignored') return c.json({ ok: true, applied: 'ignored' });
    const rawId = await recordRawWebhook(db, { clubId: club.id, channel: 'chatwoot:callback', receivedAt: now, body, signatureOk: true });
    try {
      const applied = await applyCallback(db, checked, { outbox: app.deps.outbox, gateways: app.gateways }, now);
      await markRawProcessed(db, rawId, now);
      return c.json({ ok: true, applied });
    } catch (err) {
      await markRawError(db, rawId, errorText(err));
      throw err;
    }
  });

  // A14: the Agent Bot's outgoing URL (A13). The bot runs from the LINE webhook, so Chatwoot's
  // agent-bot events need no action; answering 200 keeps Chatwoot from logging failures.
  r.post('/chatwoot/:clubId/bot', (c) => c.json({ ok: true, applied: 'ignored' }));

  // A18: Chatwoot account webhook (message_created) for the club's Instagram inbox. The per-club
  // token in the query string is the only proof of origin (Chatwoot does not sign these).
  r.post('/chatwoot/:clubId/instagram', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const club = await db.query.clubs.findFirst({ where: eq(clubs.id, c.req.param('clubId')) });
    if (!club) return c.json({ error: 'not_found' }, 404);
    const state = await instagramState(db, club.id);
    if (!state?.tokenHash) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    if (!verifyInstagramToken(state, c.req.query('token'))) {
      if (badSignatures(`${club.id}|${clientIp(c) ?? 'unknown'}`, now) > BAD_SIGNATURE_LIMIT_PER_IP) return c.json({ error: 'rate_limited' }, 429);
      if (badSignatures(club.id, now) > BAD_SIGNATURE_LIMIT_PER_CLUB) return c.json({ error: 'rate_limited' }, 429);
      return c.json({ error: 'bad_token' }, 401);
    }
    const { body, parsed } = rawBody(await c.req.text());
    // B3's raw_webhooks writer: stored before processing, then marked processed or errored.
    const rawId = await recordRawWebhook(db, { clubId: club.id, channel: 'chatwoot:instagram', receivedAt: now, body, signatureOk: true });
    try {
      const applied = await recordInstagramMessage(db, club, state, parsed, now);
      await markRawProcessed(db, rawId, now);
      return c.json({ ok: true, applied });
    } catch (err) {
      await markRawError(db, rawId, errorText(err));
      throw err;
    }
  });

  r.post('/pos/papaya/:slug', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const club = await db.query.clubs.findFirst({ where: eq(clubs.slug, c.req.param('slug')) });
    if (!club) return c.json({ error: 'not_found' }, 404);
    const live = await loadPosAdapter(db, app.config.CREDENTIALS_KEY, club);
    if (!live || live.creds.vendor !== 'papaya' || !('deliver' in live.adapter)) return c.json({ error: 'not_found' }, 404);

    const raw = await c.req.text();
    const result = await live.adapter.deliver(raw, c.req.header(PAPAYA_SIGNATURE_HEADER));
    const now = app.deps.now();
    const badSignature = result.status === 'bad_signature';
    if (badSignature) {
      // An unsigned caller only knows the slug: count it, and keep a summary row, never its body.
      if (badSignatures(`${club.id}|${clientIp(c) ?? 'unknown'}`, now) > BAD_SIGNATURE_LIMIT_PER_IP) return c.json({ error: 'rate_limited' }, 429);
      if (badSignatures(club.id, now) > BAD_SIGNATURE_LIMIT_PER_CLUB) return c.json({ error: 'rate_limited' }, 429);
    }
    // raw_webhooks.body is NOT NULL jsonb: a non-object (`null`, a number) is kept as text (rawBody).
    const body: object = badSignature ? { rejected: 'bad_signature', bytes: raw.length } : rawBody(raw).body;
    // B3's raw_webhooks writer.
    const rawId = await recordRawWebhook(db, {
      clubId: club.id,
      channel: 'pos:papaya',
      receivedAt: now,
      body,
      signatureOk: !badSignature,
      processedAt: badSignature ? null : now,
    });
    if (badSignature) return c.json({ error: 'bad_signature' }, 401);
    if (result.status === 'ignored' || !result.bill) return c.json({ ok: true, applied: 'ignored' });

    try {
      const applied = await applyLiveBill(db, club, result.bill, { now, source: 'live:papaya', eventId: result.event?.id });
      return c.json({ ok: true, applied });
    } catch (err) {
      await markRawError(db, rawId, errorText(err));
      throw err;
    }
  });

  return r;
}
