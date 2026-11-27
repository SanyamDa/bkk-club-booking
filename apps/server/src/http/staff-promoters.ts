import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bookings, clubMemberships, promoters, type Promoter } from '../db/schema.js';
import { addDays, currentNightDate } from '../lib/time.js';
import {
  attributeBooking,
  createPromoter,
  listPromoters,
  promoterLink,
  promoterOwnBookings,
  PromoterError,
  promoterReport,
  removeAttribution,
  updatePromoter,
} from '../platform/promoters.js';
import { auditClubChange } from '../platform/club-settings.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import { actorOf } from './staff-settings.js';
import type { AppContext } from './context.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bps = z.number().int().min(0).max(10_000);
const createBody = z.object({ name: z.string().min(1).max(80), code: z.string().min(1).max(40), commissionBps: bps.optional(), userId: z.string().nullable().optional() });
const patchBody = z.object({ name: z.string().min(1).max(80).optional(), commissionBps: bps.optional(), userId: z.string().nullable().optional(), disabled: z.boolean().optional() });
const attributeBody = z.object({ promoterId: z.string().optional(), code: z.string().optional() }).refine((b) => b.promoterId || b.code);

const STATUS: Record<PromoterError['code'], 400 | 404 | 409> = { bad_code: 400, bad_request: 400, code_taken: 409, not_found: 404 };

function fail(c: Context<AuthEnv>, err: unknown) {
  if (err instanceof PromoterError) return c.json({ error: err.code }, STATUS[err.code]);
  throw err;
}

/**
 * Promoters (plan A20a, spec §4, §5.1, §14.10), mounted inside `staffRoutes`. Managing promoters
 * and the report: owner or manager. Attributing a booking: owner, manager or host. A promoter
 * login sees only `/promoter/me`: their link, their bookings (no guest details) and commission.
 */
export function staffPromoterRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const managers = requireClubRole(app, 'owner', 'manager');
  const desk = requireClubRole(app, 'owner', 'manager', 'host');
  const promoterOnly = requireClubRole(app, 'promoter');

  const withLink = (slug: string, p: Promoter) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    userId: p.userId,
    commissionBps: p.commissionBps,
    disabled: p.disabledAt !== null,
    link: promoterLink(app.config.PUBLIC_URL, { slug }, p.code),
  });

  /** A promoter's login must be a `promoter` member of this club. */
  async function memberOk(clubId: string, userId: string | null | undefined) {
    if (!userId) return true;
    const m = await db.query.clubMemberships.findFirst({ where: and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)) });
    return m?.role === 'promoter';
  }

  r.get('/clubs/:slug/promoters', managers, async (c) => {
    const club = c.var.club;
    return c.json({ promoters: (await listPromoters(db, club.id)).map((p) => withLink(club.slug, p)) });
  });

  r.post('/clubs/:slug/promoters', managers, async (c) => {
    const club = c.var.club;
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    if (!(await memberOk(club.id, body.data.userId))) return c.json({ error: 'bad_user' }, 400);
    try {
      const now = app.deps.now();
      const p = await createPromoter(db, club.id, body.data, now);
      await auditClubChange(db, club, actorOf(c), { action: 'promoter.created', entity: 'promoters', entityId: p.id, after: withLink(club.slug, p) }, now);
      return c.json({ promoter: withLink(club.slug, p) });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.get('/clubs/:slug/promoters/report', managers, async (c) => {
    const club = c.var.club;
    const today = currentNightDate(app.deps.now(), club.settings.nightEndHour);
    const from = c.req.query('from') ?? addDays(today, -30);
    const to = c.req.query('to') ?? today;
    if (!DATE.test(from) || !DATE.test(to) || from > to) return c.json({ error: 'bad_request' }, 400);
    return c.json({ from, to, report: await promoterReport(db, club.id, from, to) });
  });

  r.patch('/clubs/:slug/promoters/:promoterId', managers, async (c) => {
    const club = c.var.club;
    const id = c.req.param('promoterId');
    const exists = await db.query.promoters.findFirst({ where: and(eq(promoters.clubId, club.id), eq(promoters.id, id)) });
    if (!exists) return c.json({ error: 'not_found' }, 404);
    const body = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    if (!(await memberOk(club.id, body.data.userId))) return c.json({ error: 'bad_user' }, 400);
    try {
      const now = app.deps.now();
      const p = await updatePromoter(db, club.id, id, body.data, now);
      await auditClubChange(db, club, actorOf(c), { action: 'promoter.changed', entity: 'promoters', entityId: id, before: withLink(club.slug, exists), after: withLink(club.slug, p) }, now);
      return c.json({ promoter: withLink(club.slug, p) });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.put('/clubs/:slug/bookings/:id/promoter', desk, async (c) => {
    const club = c.var.club;
    // The booking is checked before the body, so another club's id is 404 whatever the body.
    const booking = await db.query.bookings.findFirst({ where: and(eq(bookings.clubId, club.id), eq(bookings.id, c.req.param('id'))) });
    if (!booking) return c.json({ error: 'not_found' }, 404);
    const body = attributeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    try {
      const now = app.deps.now();
      const a = await attributeBooking(db, club.id, booking.id, body.data, 'manual', c.var.user.id, now);
      await auditClubChange(db, club, actorOf(c), { action: 'promoter.booking_attributed', entity: 'bookings', entityId: booking.id, after: { promoterId: a.promoterId, via: a.via } }, now);
      return c.json({ attribution: { bookingId: a.bookingId, promoterId: a.promoterId, via: a.via } });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.delete('/clubs/:slug/bookings/:id/promoter', desk, async (c) => {
    try {
      await removeAttribution(db, c.var.club.id, c.req.param('id'));
      await auditClubChange(db, c.var.club, actorOf(c), { action: 'promoter.attribution_removed', entity: 'bookings', entityId: c.req.param('id') }, app.deps.now());
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.get('/clubs/:slug/promoter/me', promoterOnly, async (c) => {
    const club = c.var.club;
    const p = await db.query.promoters.findFirst({ where: and(eq(promoters.clubId, club.id), eq(promoters.userId, c.var.user.id)) });
    if (!p || p.disabledAt) return c.json({ error: 'not_found' }, 404);
    const today = currentNightDate(app.deps.now(), club.settings.nightEndHour);
    const from = addDays(today, -90);
    const to = addDays(today, 365);
    const [mine] = (await promoterReport(db, club.id, from, today)).filter((x) => x.promoterId === p.id);
    return c.json({
      promoter: { code: p.code, name: p.name, commissionBps: p.commissionBps, link: promoterLink(app.config.PUBLIC_URL, club, p.code) },
      last90Days: mine ? { bookings: mine.bookings, arrived: mine.arrived, pax: mine.pax, commissionSatang: mine.commissionSatang } : null,
      bookings: await promoterOwnBookings(db, club.id, p.id, from, to),
    });
  });

  return r;
}
