import { Hono } from 'hono';
import { z } from 'zod';
import {
  busynessFeed,
  busynessRateLimiter,
  issueBusynessKey,
  listBusynessKeys,
  logBusynessRead,
  revokeBusynessKey,
  rotateBusynessKey,
  verifyBusynessKey,
} from '../data/busyness.js';
import { clientIp, requirePlatformAdmin, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';

const feedQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/**
 * The busyness feed for the separate consumer app (spec §14.7, plan B21), mounted at `/data/v1`.
 * `GET /busyness?date=` with `Authorization: Bearer <key>`: rate-limited per key, and every
 * accepted read writes one access-log row.
 */
export function busynessFeedRoutes(app: AppContext) {
  const r = new Hono();
  const { db } = app.deps;
  const limiter = busynessRateLimiter();

  r.get('/busyness', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = token ? await verifyBusynessKey(db, token) : null;
    if (!key) return c.json({ error: 'invalid_key' }, 401);
    const now = app.deps.now();
    const rate = limiter(key.id, now);
    if (!rate.ok) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const q = feedQuery.safeParse({ date: c.req.query('date') });
    if (!q.success) return c.json({ error: 'bad_date' }, 400);
    const feed = await busynessFeed(db, { kind: key.kind, date: q.data.date, now });
    await logBusynessRead(db, key, now, { clubs: feed.clubs.length, date: q.data.date ?? null }, clientIp(c));
    c.header('Cache-Control', 'no-store');
    return c.json(feed);
  });
  return r;
}

const issueBody = z.object({ label: z.string().trim().min(1).max(100), kind: z.enum(['production', 'sandbox']) });

/**
 * Key management for the feed, platform admin only. Mounted under `/api/admin`:
 * `GET /busyness-keys`, `POST /busyness-keys` (token shown once), `POST /busyness-keys/:id/rotate`,
 * `DELETE /busyness-keys/:id`. The stored hash is never returned.
 */
export function busynessKeyAdminRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  r.use('/busyness-keys', requirePlatformAdmin(app));
  r.use('/busyness-keys/*', requirePlatformAdmin(app));

  r.get('/busyness-keys', async (c) => c.json({ keys: await listBusynessKeys(db) }));

  r.post('/busyness-keys', async (c) => {
    const body = issueBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body' }, 400);
    const res = await issueBusynessKey(db, body.data, c.var.user.id, app.deps.now(), clientIp(c));
    return c.json(res, 201);
  });

  r.post('/busyness-keys/:id/rotate', async (c) => {
    const res = await rotateBusynessKey(db, c.req.param('id'), c.var.user.id, app.deps.now(), clientIp(c));
    if (!res) return c.json({ error: 'not_found' }, 404);
    return c.json(res);
  });

  r.delete('/busyness-keys/:id', async (c) => {
    const key = await revokeBusynessKey(db, c.req.param('id'), c.var.user.id, app.deps.now(), clientIp(c));
    if (!key) return c.json({ error: 'not_found' }, 404);
    return c.json({ key });
  });
  return r;
}
