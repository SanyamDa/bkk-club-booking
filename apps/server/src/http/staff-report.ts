import { Hono } from 'hono';
import { addDays } from '../lib/time.js';
import { buildClubReport, lastCompleteWeek, mondayOf } from '../platform/club-report.js';
import { buildClubStats, MAX_STATS_NIGHTS } from '../platform/club-stats.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Weekly club report (spec §14.10, plan A16b), mounted by `staffRoutes`. `owner|manager` only.
 * `?week=YYYY-MM-DD` picks the week that date falls in; without it, the last complete week.
 * The club stats page (plan A16) lives here too: `GET /stats?from&to`, same roles.
 */
export function staffReportRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const managers = requireClubRole(app, 'owner', 'manager');

  r.get('/clubs/:slug/report', managers, async (c) => {
    const club = c.var.club;
    const week = c.req.query('week');
    if (week !== undefined && (!DATE.test(week) || Number.isNaN(Date.parse(week)))) return c.json({ error: 'bad_request' }, 400);
    const weekStart = week ? mondayOf(week) : lastCompleteWeek(club, app.deps.now());
    return c.json({ report: await buildClubReport(app.deps.db, club.id, weekStart) });
  });

  r.get('/clubs/:slug/stats', managers, async (c) => {
    const club = c.var.club;
    const from = c.req.query('from');
    const to = c.req.query('to');
    if ((from === undefined) !== (to === undefined)) return c.json({ error: 'bad_request' }, 400);
    if (from === undefined || to === undefined) {
      const start = lastCompleteWeek(club, app.deps.now());
      return c.json({ stats: await buildClubStats(app.deps.db, club.id, start, addDays(start, 6)) });
    }
    const valid = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(d));
    if (!valid(from) || !valid(to) || from > to) return c.json({ error: 'bad_request' }, 400);
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > MAX_STATS_NIGHTS) return c.json({ error: 'range_too_long' }, 400);
    return c.json({ stats: await buildClubStats(app.deps.db, club.id, from, to) });
  });

  return r;
}
