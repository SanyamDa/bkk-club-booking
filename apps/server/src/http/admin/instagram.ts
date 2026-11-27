import { Hono } from 'hono';
import { z } from 'zod';
import { ChatwootError, InboxNotProvisioned } from '../../integrations/chatwoot/provision.js';
import { connectInstagram, instagramFlagKey, instagramState, instagramSummary, InstagramInboxMissing } from '../../integrations/chatwoot/instagram.js';
import type { AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { adminAudit, clubBySlug } from './controls.js';

const connectBody = z.object({ inboxId: z.number().int().positive().optional() }).strict();

/**
 * Instagram connection (plan A18, spec §11.5). Mounted under /api/admin.
 * - `GET /clubs/:slug/instagram`: connection summary.
 * - `POST /clubs/:slug/instagram/connect` `{ inboxId? }`: links the Chatwoot Instagram inbox the
 *   club's Instagram login (done inside Chatwoot) created; idempotent.
 */
export function instagramAdminRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;

  r.get('/clubs/:slug/instagram', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    return c.json({ instagram: instagramSummary(await instagramState(db, club.id)) });
  });

  r.post('/clubs/:slug/instagram/connect', async (c) => {
    if (!app.chatwoot) return c.json({ error: 'inbox_not_configured' }, 503);
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const raw = await c.req.json().catch(() => ({}));
    const body = connectBody.safeParse(raw ?? {});
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    const now = app.deps.now();
    try {
      const state = await connectInstagram(db, app.chatwoot, app.config.CREDENTIALS_KEY, club, { inboxId: body.data.inboxId, publicUrl: app.config.PUBLIC_URL, by: c.var.user.id, now });
      const instagram = instagramSummary(state);
      await adminAudit(db, c, { clubId: club.id, action: 'club.instagram_connected', entity: 'platform_flags', entityId: instagramFlagKey(club.id), after: instagram }, now);
      return c.json({ instagram });
    } catch (err) {
      if (err instanceof InboxNotProvisioned) return c.json({ error: 'inbox_not_provisioned' }, 409);
      if (err instanceof InstagramInboxMissing) return c.json({ error: 'instagram_inbox_missing', hint: 'Log in to the club Instagram account inside the club inbox (Chatwoot), then connect again.' }, 409);
      if (err instanceof ChatwootError) return c.json({ error: `chatwoot_${err.status}` }, 502);
      throw err;
    }
  });

  return r;
}
