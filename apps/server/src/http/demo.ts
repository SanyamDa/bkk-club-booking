import { Hono } from 'hono';
import { z } from 'zod';
import { clearClubWebhook, ClubDeleteError, deleteClub, isDemoSpare } from '../demo/delete-club.js';
import { DemoError, fastForward, resetDemoClub } from '../demo/reset.js';
import { requirePlatformAdmin, type AuthEnv } from './auth.js';
import { adminAudit, clubBySlug, jsonBody } from './admin/controls.js';
import type { AppContext } from './context.js';

const fastForwardBody = z.object({
  /** B7 hold expiry; B10 reminder and no-show release. */
  what: z.enum(['hold_expiry', 'reminder', 'release']),
  bookingId: z.string().trim().min(1).max(100),
});

/**
 * Demo controls (plan B7, spec §12.4), mounted at /api/admin/demo; platform admin only.
 * `POST /:slug/reset` and `POST /:slug/fast-forward` `{ what: 'hold_expiry' | 'reminder' | 'release', bookingId }`.
 * Unknown club 404; a club that is not `demo` 409 `not_demo`; a booking with nothing to do 404 `not_held`.
 * Spec §12.4: reset also deletes the clubs made in that demo's step 7 and clears their spare LINE
 * webhooks (`deletedClubs` in the answer). `POST /:slug/delete` deletes one such club directly;
 * any other club 409 `not_demo_spare`.
 */
export function demoRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  r.use('*', requirePlatformAdmin(app));

  const refusal = (err: unknown) => {
    if (err instanceof ClubDeleteError) return { status: err.code === 'not_found' ? (404 as const) : (409 as const), error: err.code };
    if (err instanceof DemoError) return { status: err.code === 'not_found' ? (404 as const) : (409 as const), error: err.code };
    throw err;
  };

  r.post('/:slug/reset', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    try {
      // Spec §12.4: also deletes the club made in demo step 7 and clears its spare LINE webhook.
      const { nightDate, deletedClubs } = await resetDemoClub(db, club.id, now, {
        actor: { type: 'platform', id: c.var.user.id, sessionId: c.var.session.idHash },
        clearWebhook: (spare) => clearClubWebhook(app, spare),
      });
      await adminAudit(db, c, { clubId: club.id, action: 'demo.reset', entity: 'clubs', entityId: club.id, after: { nightDate, deletedClubs } }, now);
      return c.json({ nightDate, deletedClubs: deletedClubs.map((d) => ({ slug: d.slug, webhook: d.webhook })) });
    } catch (err) {
      const r = refusal(err);
      return c.json({ error: r.error }, r.status);
    }
  });

  r.post('/:slug/delete', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    try {
      if (!isDemoSpare(club)) throw new ClubDeleteError('not_demo_spare');
      const webhook = await clearClubWebhook(app, club);
      const { rows } = await deleteClub(db, club.id, { type: 'platform', id: c.var.user.id, sessionId: c.var.session.idHash }, now);
      return c.json({ slug: club.slug, webhook, rows });
    } catch (err) {
      const r = refusal(err);
      return c.json({ error: r.error }, r.status);
    }
  });

  r.post('/:slug/fast-forward', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const parsed = fastForwardBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const now = app.deps.now();
    try {
      const booking = await fastForward(app, club.id, parsed.data.what, parsed.data.bookingId, now);
      if (!booking) return c.json({ error: 'not_held' }, 404);
      await adminAudit(db, c, { clubId: club.id, action: 'demo.fast_forward', entity: 'booking', entityId: booking.id, after: { what: parsed.data.what, status: booking.status } }, now);
      return c.json({ booking: { id: booking.id, status: booking.status, refCode: booking.refCode } });
    } catch (err) {
      const r = refusal(err);
      return c.json({ error: r.error }, r.status);
    }
  });

  return r;
}
