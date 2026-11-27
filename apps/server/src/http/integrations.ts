import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clubs, rawWebhooks } from '../db/schema.js';
import { instagramState, recordInstagramMessage, verifyInstagramToken } from '../integrations/chatwoot/instagram.js';
import { applyLiveBill, loadPosAdapter } from '../integrations/pos/live.js';
import { PAPAYA_SIGNATURE_HEADER } from '../integrations/pos/papaya.js';
import { newId } from '../lib/util.js';
import { clientIp } from './auth.js';
import type { AppContext } from './context.js';

/** Bad-signature deliveries per (club, IP) per minute, and per club per minute, before 429. */
export const BAD_SIGNATURE_LIMIT_PER_IP = 20;
export const BAD_SIGNATURE_LIMIT_PER_CLUB = 60;

/** Fixed one-minute windows, in memory (one process). Bounds what unsigned callers can write. */
function minuteCounter() {
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
    const raw = await c.req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const body = parsed !== null && typeof parsed === 'object' ? parsed : { unparsed: raw.slice(0, 10_000) };
    // Direct insert until B3's raw_webhooks writer merges (plan A18 / B3 fallback).
    const rawId = newId();
    await db.insert(rawWebhooks).values({ id: rawId, clubId: club.id, channel: 'chatwoot:instagram', receivedAt: now, body, signatureOk: true, processedAt: null });
    try {
      const applied = await recordInstagramMessage(db, club, state, parsed, now);
      await db.update(rawWebhooks).set({ processedAt: now }).where(eq(rawWebhooks.id, rawId));
      return c.json({ ok: true, applied });
    } catch (err) {
      await db.update(rawWebhooks).set({ error: err instanceof Error ? err.message : String(err) }).where(eq(rawWebhooks.id, rawId));
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
    let body: object;
    if (badSignature) {
      body = { rejected: 'bad_signature', bytes: raw.length };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      // raw_webhooks.body is NOT NULL jsonb: a non-object (`null`, a number) is kept as text.
      body = parsed !== null && typeof parsed === 'object' ? parsed : { unparsed: raw.slice(0, 10_000) };
    }
    // Direct insert until B3's raw_webhooks writer merges (plan A19 / B3 fallback).
    const rawId = newId();
    await db.insert(rawWebhooks).values({
      id: rawId,
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
      await db.update(rawWebhooks).set({ processedAt: null, error: err instanceof Error ? err.message : String(err) }).where(eq(rawWebhooks.id, rawId));
      throw err;
    }
  });

  return r;
}
