import { eq, inArray } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { clubs, type SupportGrant } from '../../db/schema.js';
import {
  activeGrantsOf,
  createSupportGrant,
  elevateSupportGrant,
  endSupportGrant,
  SupportError,
} from '../../platform/support.js';
import { clientIp, requirePlatformAdmin, type AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';

const startBody = z.object({
  clubSlug: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(500),
  ticketRef: z.string().trim().max(100).optional(),
});
const elevateBody = z.object({ reason: z.string().trim().min(1).max(500) });

const shape = (g: SupportGrant, clubSlug: string) => ({
  id: g.id,
  clubSlug,
  reason: g.reason,
  ticketRef: g.ticketRef,
  mode: g.mode,
  startedAt: g.startedAt.toISOString(),
  expiresAt: g.expiresAt.toISOString(),
  endedAt: g.endedAt?.toISOString() ?? null,
});

/**
 * Support sessions (spec §12.3, plan A5). Mounted under /api/admin:
 * `GET /support` (the caller's active sessions), `POST /support {clubSlug, reason, ticketRef?}`,
 * `POST /support/:id/elevate {reason}`, `POST /support/:id/end`.
 */
export function supportRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  r.use('/support', requirePlatformAdmin(app));
  r.use('/support/*', requirePlatformAdmin(app));

  const slugOf = async (clubId: string) =>
    (await db.query.clubs.findFirst({ where: eq(clubs.id, clubId), columns: { slug: true } }))?.slug ?? '';

  const refused = (c: Context, err: unknown) => {
    if (err instanceof SupportError) return c.json({ error: err.code }, err.code === 'not_found' ? 404 : 409);
    throw err;
  };

  r.get('/support', async (c) => {
    const grants = await activeGrantsOf(db, c.var.user.id, app.deps.now());
    const rows = grants.length
      ? await db.select({ id: clubs.id, slug: clubs.slug }).from(clubs).where(inArray(clubs.id, grants.map((g) => g.clubId)))
      : [];
    const slug = new Map(rows.map((x) => [x.id, x.slug]));
    return c.json({ sessions: grants.map((g) => shape(g, slug.get(g.clubId) ?? '')) });
  });

  r.post('/support', async (c) => {
    const parsed = startBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const missingReason = parsed.error.issues.some((i) => i.path[0] === 'reason');
      return c.json({ error: missingReason ? 'reason_required' : 'invalid_request' }, 400);
    }
    const club = await db.query.clubs.findFirst({ where: eq(clubs.slug, parsed.data.clubSlug) });
    if (!club) return c.json({ error: 'not_found' }, 404);
    const grant = await createSupportGrant(
      db,
      {
        userId: c.var.user.id,
        sessionId: c.var.session.idHash,
        club,
        reason: parsed.data.reason,
        ticketRef: parsed.data.ticketRef ?? null,
        ip: clientIp(c),
      },
      app.deps.now(),
    );
    return c.json(shape(grant, club.slug), 201);
  });

  r.post('/support/:id/elevate', async (c) => {
    const parsed = elevateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'reason_required' }, 400);
    try {
      const grant = await elevateSupportGrant(
        db,
        { id: c.req.param('id'), userId: c.var.user.id, sessionId: c.var.session.idHash, reason: parsed.data.reason, ip: clientIp(c) },
        app.deps.now(),
      );
      return c.json(shape(grant, await slugOf(grant.clubId)));
    } catch (err) {
      return refused(c, err);
    }
  });

  r.post('/support/:id/end', async (c) => {
    try {
      const grant = await endSupportGrant(
        db,
        { id: c.req.param('id'), userId: c.var.user.id, sessionId: c.var.session.idHash, ip: clientIp(c) },
        app.deps.now(),
      );
      return c.json(shape(grant, await slugOf(grant.clubId)));
    } catch (err) {
      return refused(c, err);
    }
  });

  return r;
}
