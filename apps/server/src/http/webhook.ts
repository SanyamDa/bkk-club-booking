import { validateSignature, type webhook } from '@line/bot-sdk';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { clubs } from '../db/schema.js';
import { handleEvent } from '../bot/flow.js';
import type { AppContext } from './context.js';

/**
 * POST /line/webhook/:slug — one webhook URL per club. Verifies LINE's signature with that
 * club's channel secret, acknowledges immediately, then processes events in the background.
 */
export function webhookRoutes(app: AppContext) {
  const r = new Hono();

  r.post('/:slug', async (c) => {
    const club = await app.deps.db.query.clubs.findFirst({ where: eq(clubs.slug, c.req.param('slug')) });
    if (!club) return c.text('Unknown club', 404);
    const channelSecret = await app.credentials.channelSecret(club);
    if (!channelSecret) return c.text('LINE is not configured for this club', 404);

    const body = await c.req.text();
    const signature = c.req.header('x-line-signature') ?? '';
    if (!validateSignature(body, channelSecret, signature)) return c.text('Bad signature', 401);

    let payload: webhook.CallbackRequest;
    try {
      payload = JSON.parse(body) as webhook.CallbackRequest;
    } catch {
      return c.text('Bad JSON', 400);
    }

    // Process in order, after responding: LINE expects a fast 200. The gateway (which may need a
    // fresh access token) is resolved here, so the signature check never waits on LINE.
    // A signed event with no access token must not fall back to the dev gateway: the guest's
    // turn would run and every reply would vanish. Log it and skip the events instead.
    const work = (async () => {
      if (!(await app.credentials.line(club))) {
        app.deps.log(`LINE access token missing for club ${club.id}: skipped ${payload.events?.length ?? 0} webhook event(s)`);
        return;
      }
      const gateway = await app.gateways.forClub(club);
      for (const event of payload.events ?? []) await handleEvent(app.deps, club, gateway, event);
    })();
    app.track(work);
    return c.text('OK');
  });

  return r;
}
