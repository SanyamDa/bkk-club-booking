import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { rawWebhooks } from '../db/schema.js';
import { applyPaymentEvent } from '../integrations/payments/gateway.js';
import { newId } from '../lib/util.js';
import type { AppContext } from './context.js';

/**
 * Payment gateway webhooks (plan A20b), mounted at `/webhooks/payments`. The address entered in the
 * provider's dashboard is `<PUBLIC_URL>/webhooks/payments/<provider>`. Unsigned or badly signed
 * deliveries are 401 and write nothing; a verified one is stored in `raw_webhooks` before it is applied.
 */
export function paymentWebhookRoutes(app: AppContext) {
  const r = new Hono();
  const db = app.deps.db;

  r.post('/:provider', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const provider = c.req.param('provider');
    const gateway = Object.hasOwn(app.payments, provider) ? app.payments[provider] : undefined;
    if (!gateway) return c.json({ error: 'not_found' }, 404);
    const raw = await c.req.text();
    const event = gateway.verifyWebhook(raw, gateway.signatureOf((name) => c.req.header(name)));
    if (!event) return c.json({ error: 'bad_signature' }, 401);

    const now = app.deps.now();
    const rawId = newId();
    await db.insert(rawWebhooks).values({ id: rawId, clubId: null, channel: `payments:${provider}`, receivedAt: now, body: JSON.parse(raw), signatureOk: true, processedAt: null });
    let result;
    try {
      result = await applyPaymentEvent(db, provider, event, now);
      await db.update(rawWebhooks).set({ processedAt: now, clubId: result.clubId ?? null }).where(eq(rawWebhooks.id, rawId));
    } catch (err) {
      await db.update(rawWebhooks).set({ error: err instanceof Error ? err.message : String(err) }).where(eq(rawWebhooks.id, rawId));
      throw err;
    }
    if (result.outcome === 'confirmed') app.track(app.notifier.confirmed(result.clubId!, result.bookingId!));
    if (result.outcome === 'charge_mismatch') return c.json({ error: 'charge_mismatch' }, 409);
    return c.json({ ok: true, outcome: result.outcome });
  });

  return r;
}
