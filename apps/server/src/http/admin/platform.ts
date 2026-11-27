import { Hono } from 'hono';
import { z } from 'zod';
import { platformLoginSummary, setPlatformLoginChannel } from '../../platform/login-channel.js';
import type { AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { freshTotpRefusal, jsonBody } from './controls.js';

const loginBody = z.object({
  channelId: z.string().trim().min(1).max(40),
  channelSecret: z.string().trim().min(1).max(200),
  liffId: z.string().trim().min(1).max(100),
});

/**
 * The platform's shared LINE Login channel and LIFF app (A4b). Saving needs a fresh TOTP;
 * `setPlatformLoginChannel` writes the audit row (last4 only) and sets the shared LIFF endpoint.
 * Mounted under /api/admin.
 */
export function platformRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;

  r.get('/platform/line-login', async (c) => {
    const s = await platformLoginSummary(db);
    return c.json({ loginChannel: s ? { liffId: s.liffId, last4: s.last4, setBy: s.setBy, setAt: s.setAt.toISOString() } : null });
  });

  r.post('/platform/line-login', async (c) => {
    const body = await jsonBody(c);
    const refused = await freshTotpRefusal(app, c, body);
    if (refused) return refused;
    const parsed = loginBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const res = await setPlatformLoginChannel(
      db,
      app.config.CREDENTIALS_KEY,
      { ...parsed.data, setBy: c.var.user.id },
      app.deps.now(),
      { publicUrl: app.config.PUBLIC_URL, update: app.updateLiffEndpoint },
    );
    return c.json({ last4: res.last4, setAt: res.setAt.toISOString() });
  });

  return r;
}
