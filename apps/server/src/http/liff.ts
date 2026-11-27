import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { BookingError, getBookingView, getBookingViewByRef, submitDetails } from '../bookings/service.js';
import { sendReview } from '../bot/flow.js';
import { langOf, t } from '../bot/i18n.js';
import { clubs } from '../db/schema.js';
import { SIM_USER_PREFIX } from '../line/gateway.js';
import { formatClock, formatNight } from '../lib/time.js';
import { formatBaht, verifySignature } from '../lib/util.js';
import type { AppContext } from './context.js';

const detailsSchema = z.object({
  ref: z.string().min(4).max(16),
  t: z.string().min(10).max(64),
  name: z.string().trim().min(1).max(80),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{8,20}$/, 'Enter a valid phone number'),
  nationality: z.string().trim().min(2).max(40),
  pax: z.coerce.number().int().min(1).max(50),
  specialRequest: z.string().trim().max(200).optional(),
  acceptRules: z.literal(true, { message: 'Please accept the house rules' }),
  viaChat: z.boolean().default(false),
  /** LIFF ID token, required for real LINE guests when the club's LINE Login channel is configured. */
  idToken: z.string().max(4096).optional(),
});

/** Guest-facing API for the booking details form (opened inside LINE via LIFF). */
export function liffRoutes(app: AppContext) {
  const r = new Hono();
  const { db } = app.deps;

  async function load(ref: string, token: string | undefined) {
    if (!verifySignature(app.config.APP_SECRET, 'details', ref, token)) return null;
    const view = await getBookingViewByRef(db, ref);
    if (!view) return null;
    const club = (await db.query.clubs.findFirst({ where: eq(clubs.id, view.booking.clubId) }))!;
    return { view, club };
  }

  r.get('/booking', async (c) => {
    const found = await load(c.req.query('ref') ?? '', c.req.query('t'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const { view, club } = found;
    const lang = langOf(view.guest.lang);
    const b = view.booking;
    return c.json({
      lang,
      club: { name: club.name, accentColor: club.settings.accentColor, rules: club.settings.rules[lang], arrivalBy: club.settings.arrivalBy, liffId: club.liffId },
      booking: {
        ref: b.refCode,
        status: b.status,
        table: view.table.code,
        zone: lang === 'th' ? view.zone.nameTh : view.zone.name,
        night: formatNight(b.nightDate, lang),
        pax: b.pax,
        minPax: view.table.minPax,
        maxPax: view.table.maxPax,
        minSpend: formatBaht(b.minSpendSatang),
        deposit: b.depositSatang ? formatBaht(b.depositSatang) : null,
        holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
        holdUntil: b.holdExpiresAt ? formatClock(b.holdExpiresAt) : null,
        detailsDone: Boolean(b.rulesAcceptedAt),
      },
      guest: { name: view.guest.name ?? view.guest.displayName ?? '', phone: view.guest.phone ?? '', nationality: view.guest.nationality ?? '' },
      detailsSentText: t(lang, 'detailsSentText', { ref: b.refCode }),
    });
  });

  r.post('/booking/details', async (c) => {
    const parsed = detailsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) }, 400);
    const input = parsed.data;
    const found = await load(input.ref, input.t);
    if (!found) return c.json({ error: 'not_found' }, 404);
    const { view, club } = found;
    // Inside LINE, prove the person submitting is the LINE user who holds the table,
    // so a forwarded link can't be used by someone else.
    const login = await app.credentials.login(club);
    const lineUserId = view.guest.lineUserId;
    if (login && lineUserId && !lineUserId.startsWith(SIM_USER_PREFIX)) {
      if (!input.idToken) return c.json({ error: 'login_required' }, 401);
      const verified = await app.verifyIdToken(input.idToken, login.channelId);
      if (!verified || verified.sub !== lineUserId) return c.json({ error: 'wrong_user' }, 403);
    }
    if (input.pax < view.table.minPax || input.pax > view.table.maxPax) {
      return c.json({ error: 'invalid', issues: [{ field: 'pax', message: `This table seats ${view.table.minPax}–${view.table.maxPax}` }] }, 400);
    }
    try {
      await submitDetails(db, club, view.booking.id, input, app.deps.now());
    } catch (err) {
      if (err instanceof BookingError) return c.json({ error: err.code }, 409);
      throw err;
    }
    // Inside LINE, the page sends "Details sent · REF" from the guest's own chat, so our reply is free.
    // Outside LINE (or if that fails), push the summary instead.
    if (!input.viaChat) await pushReview(club.id, view.booking.id);
    return c.json({ ok: true });
  });

  /** Fallback when liff.sendMessages failed after a viaChat submit. */
  r.post('/booking/review', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ref?: string; t?: string };
    const found = await load(body.ref ?? '', body.t);
    if (!found) return c.json({ error: 'not_found' }, 404);
    await pushReview(found.view.booking.clubId, found.view.booking.id);
    return c.json({ ok: true });
  });

  async function pushReview(clubId: string, bookingId: string) {
    const view = await getBookingView(db, { clubId, id: bookingId });
    if (!view) return;
    const club = (await db.query.clubs.findFirst({ where: eq(clubs.id, view.booking.clubId) }))!;
    const gateway = await app.gateways.forClub(club, view.guest.lineUserId);
    await sendReview(
      { deps: app.deps, club, gateway, guest: view.guest, lang: langOf(view.guest.lang) },
      bookingId,
    );
  }

  return r;
}
