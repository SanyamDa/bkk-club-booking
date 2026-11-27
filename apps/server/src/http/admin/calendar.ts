import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { listNights, nightBody, nightsRange, SettingsError, upsertNight, type SettingsActor } from '../../platform/club-settings.js';
import { clientIp, type AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { clubBySlug, jsonBody } from './controls.js';

/** Founder-entered city calendar days (spec §14.3); the seed holds the rest (B13). */
export const calendarDayBody = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(['election', 'city_event']),
    name: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

const founder = (c: Context<AuthEnv>): SettingsActor => ({ type: 'platform', id: c.var.user.id, sessionId: c.var.session.idHash, ip: clientIp(c) });

/**
 * Event calendar from the console (plan A9, spec §12.3 Club data): the same nights writes as the
 * staff Calendar page, attributed to the founder, plus the founder-only city calendar entry.
 * Mounted under /api/admin.
 */
export function calendarRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;

  r.get('/clubs/:slug/nights', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const { from, days } = nightsRange(club, app.deps.now(), { from: c.req.query('from'), days: c.req.query('days') });
    return c.json({ from, days, nights: await listNights(db, club, from, days) });
  });

  r.put('/clubs/:slug/nights', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const parsed = nightBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400);
    try {
      return c.json(await upsertNight(db, club, parsed.data, founder(c), app.deps.now()));
    } catch (err) {
      if (err instanceof SettingsError) return c.json({ error: err.code }, err.status);
      throw err;
    }
  });

  /**
   * Election and city-event days. Needs B13's `upsertCalendarDay` (data/calendar.ts), which is not
   * merged yet: until then the route validates and answers 503 `not_ready`.
   */
  r.post('/calendar-days', async (c) => {
    const parsed = calendarDayBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400);
    return c.json({ error: 'not_ready', message: 'City calendar entry needs Track B task B13 (upsertCalendarDay).' }, 503);
  });

  return r;
}
