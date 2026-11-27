import { Hono } from 'hono';
import { buildClubReport, lastCompleteWeek, mondayOf } from '../platform/club-report.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Weekly club report (spec §14.10, plan A16b), mounted by `staffRoutes`. `owner|manager` only.
 * `?week=YYYY-MM-DD` picks the week that date falls in; without it, the last complete week.
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

  return r;
}
