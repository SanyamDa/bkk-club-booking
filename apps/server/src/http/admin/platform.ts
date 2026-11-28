import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { auditLog, users } from '../../db/schema.js';
import { newId } from '../../lib/util.js';
import { platformLoginSummary, setPlatformLoginChannel } from '../../platform/login-channel.js';
import { clientIp, type AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { freshTotpRefusal, jsonBody } from './controls.js';

/** A LINE user id: `U` and 32 lower-case hex digits. Null clears it. */
const lineUserBody = z.object({ lineUserId: z.string().regex(/^U[0-9a-f]{32}$/).nullable() });

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

  // A5: the signed-in admin's own LINE user id, the target of debug `test-message {to: 'self'}`.
  // A LINE user id is per provider, so it reaches the founder only on OAs under the provider it came from.
  r.get('/me/line', async (c) => {
    const [u] = await db.select({ lineUserId: users.lineUserId }).from(users).where(eq(users.id, c.var.user.id)).limit(1);
    return c.json({ lineUserId: u?.lineUserId ?? null });
  });

  r.put('/me/line', async (c) => {
    const parsed = lineUserBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const { lineUserId } = parsed.data;
    await db.transaction(async (tx) => {
      await tx.update(users).set({ lineUserId }).where(eq(users.id, c.var.user.id));
      await tx.insert(auditLog).values({
        id: newId(),
        clubId: null,
        actor: 'platform',
        actorType: 'platform',
        actorId: c.var.user.id,
        sessionId: c.var.session.idHash,
        ip: clientIp(c) ?? null,
        action: lineUserId ? 'admin.line_user_set' : 'admin.line_user_cleared',
        entity: 'users',
        entityId: c.var.user.id,
        data: lineUserId ? { last4: lineUserId.slice(-4) } : null,
      });
    });
    return c.json({ lineUserId });
  });

  return r;
}
