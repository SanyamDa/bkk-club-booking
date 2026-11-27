import { Hono } from 'hono';
import { z } from 'zod';
import type { Alert } from '../db/schema.js';
import { infoToLine, listAlerts, openAlertCounts, resolveAlert, setInfoToLine } from '../platform/alerts.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';

const shape = (a: Alert) => ({
  id: a.id,
  level: a.level,
  kind: a.kind,
  conversationId: a.conversationId,
  bookingId: a.bookingId,
  text: { en: a.textEn, th: a.textTh },
  createdAt: a.createdAt.toISOString(),
  resolvedAt: a.resolvedAt?.toISOString() ?? null,
  sentLine: a.sentLineAt !== null,
});

/**
 * Alerts feed (spec §6.4, plan A15), mounted by `staffRoutes`. Roles: alerts are
 * `owner|manager|host|door`; the "also send to LINE" switch is `owner|manager` (plan A2 Decisions).
 */
export function staffAlertRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const staff = requireClubRole(app, 'owner', 'manager', 'host', 'door');
  const managers = requireClubRole(app, 'owner', 'manager');

  r.get('/clubs/:slug/feed', staff, async (c) => {
    const clubId = c.var.club.id;
    const [rows, counts] = await Promise.all([listAlerts(db, clubId), openAlertCounts(db, clubId)]);
    return c.json({ alerts: rows.map(shape), counts });
  });

  r.get('/clubs/:slug/feed/counts', staff, async (c) => c.json(await openAlertCounts(db, c.var.club.id)));

  r.post('/clubs/:slug/feed/:id/resolve', staff, async (c) => {
    const row = await resolveAlert(db, c.var.club.id, c.req.param('id'), app.deps.now());
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json({ alert: shape(row) });
  });

  r.get('/clubs/:slug/alert-settings', managers, async (c) => c.json({ infoToLine: await infoToLine(db, c.var.club.id) }));

  r.put('/clubs/:slug/alert-settings', managers, async (c) => {
    const body = z.object({ infoToLine: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    await setInfoToLine(db, c.var.club.id, body.data.infoToLine, c.var.user.id, app.deps.now());
    return c.json({ infoToLine: body.data.infoToLine });
  });

  return r;
}
