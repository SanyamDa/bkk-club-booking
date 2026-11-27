import { Hono } from 'hono';
import { z } from 'zod';
import { CrowdRatingError, recordCrowdRating } from '../jobs/snapshots.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';

/**
 * Door-screen API under `/api/staff/clubs/:slug/door` (spec §6.2 door mode, §14.3). Mounted at
 * `/api/staff` by one line in `app.ts`. B12: the staff crowd rating ("how full now?" 1–5).
 * B11 adds check-in and the clicker to this file.
 */
export function crowdRatingRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const staff = requireClubRole(app, 'owner', 'manager', 'host', 'door');

  r.post('/clubs/:slug/door/crowd-rating', staff, async (c) => {
    const body = z.object({ level: z.number().int() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    try {
      const row = await recordCrowdRating(
        app.deps.db,
        c.var.club,
        { level: body.data.level, userId: c.var.user.id, actorType: c.var.supportGrant ? 'platform' : 'staff' },
        app.deps.now(),
      );
      return c.json({ rating: { id: row.id, nightDate: row.nightDate, level: row.level, at: row.at.toISOString() } }, 201);
    } catch (err) {
      if (err instanceof CrowdRatingError) return c.json({ error: err.code }, 400);
      throw err;
    }
  });

  return r;
}
