import { validateSignature, type webhook } from '@line/bot-sdk';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { clubs } from '../db/schema.js';
import { handleEvent } from '../bot/flow.js';
import { clubCredentials } from '../line/gateway.js';
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
    const creds = clubCredentials(club);
    if (!creds) return c.text('LINE is not configured for this club', 404);

    const body = await c.req.text();
    const signature = c.req.header('x-line-signature') ?? '';
    if (!validateSignature(body, creds.channelSecret, signature)) return c.text('Bad signature', 401);

    let payload: webhook.CallbackRequest;
    try {
      payload = JSON.parse(body) as webhook.CallbackRequest;
    } catch {
      return c.text('Bad JSON', 400);
    }

    const gateway = app.gateways.forClub(club);
    // Process in order, after responding: LINE expects a fast 200.
    const work = (async () => {
      for (const event of payload.events ?? []) await handleEvent(app.deps, club, gateway, event);
    })();
    app.track(work);
    return c.text('OK');
  });

  return r;
}
