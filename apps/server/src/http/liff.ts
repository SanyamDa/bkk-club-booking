import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BookingError, getBookingView, getBookingViewByRef, submitDetails, type BookingView } from '../bookings/service.js';
import { sendReview } from '../bot/flow.js';
import { langOf, t } from '../bot/i18n.js';
import { checkDetailsToken } from '../bot/links.js';
import { linkLiffSub } from '../data/identity.js';
import { clubs, type Club } from '../db/schema.js';
import { SIM_USER_PREFIX } from '../line/gateway.js';
import { formatClock, formatNight } from '../lib/time.js';
import { formatBaht } from '../lib/util.js';
import type { AppContext } from './context.js';

/** The header the details page sends the LIFF ID token in (plan B5). */
export const ID_TOKEN_HEADER = 'X-Line-Id-Token';

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
  /** LIFF ID token (or the X-Line-Id-Token header), required for real LINE guests. */
  idToken: z.string().max(4096).optional(),
});

type Found = { view: BookingView; club: Club };

/** Guest-facing API for the booking details form (opened inside LINE via LIFF). */
export function liffRoutes(app: AppContext) {
  const r = new Hono();
  const { db } = app.deps;

  /** The booking behind a signed details link: 404 for a bad signature, 410 `link_expired` past its expiry. */
  async function load(c: Context, ref: string, token: string | undefined): Promise<Found | Response> {
    const check = checkDetailsToken(app.config.APP_SECRET, ref, token, app.deps.now());
    if (check === 'bad') return c.json({ error: 'not_found' }, 404);
    if (check === 'expired') return c.json({ error: 'link_expired' }, 410);
    const view = await getBookingViewByRef(db, ref);
    if (!view) return c.json({ error: 'not_found' }, 404);
    const club = (await db.query.clubs.findFirst({ where: eq(clubs.id, view.booking.clubId) }))!;
    return { view, club };
  }

  /**
   * Proves the person reading or submitting is the LINE user who holds the table, so a forwarded
   * link can't be used by someone else (spec §11.1.1, §13.1 #3). Exempt, as before: a simulator
   * guest (`SIM-`) and a guest with no LINE user id. A real guest at a club with no login channel
   * is refused with 503, never skipped. Returns the error response, or null when the request may go on.
   */
  async function checkGuest(c: Context, { view, club }: Found, idToken: string | undefined): Promise<Response | null> {
    const lineUserId = view.guest.lineUserId;
    if (!lineUserId || lineUserId.startsWith(SIM_USER_PREFIX)) return null;
    const login = await app.credentials.login(club);
    if (!login) return c.json({ error: 'login_not_configured' }, 503);
    if (!idToken) return c.json({ error: 'login_required' }, 401);
    const verified = await app.verifyIdToken(idToken, login.channelId);
    if (!verified) return c.json({ error: 'wrong_user' }, 403);
    if (!login.shared) return verified.sub === lineUserId ? null : c.json({ error: 'wrong_user' }, 403);
    // Shared platform channel: the sub is our provider's id, so it is paired with the guest on first use.
    const pair = await linkLiffSub(db, { clubId: club.id, guestId: view.guest.id, sub: verified.sub }, app.deps.now());
    return pair === 'mismatch' ? c.json({ error: 'wrong_user' }, 403) : null;
  }

  /** Unauthenticated: only what the page needs to start LIFF before it has an ID token. */
  r.get('/club', async (c) => {
    const slug = c.req.query('club') ?? '';
    const club = slug ? await db.query.clubs.findFirst({ where: eq(clubs.slug, slug) }) : undefined;
    if (!club) return c.json({ error: 'not_found' }, 404);
    return c.json({ name: club.name, accentColor: club.settings.accentColor, liffId: club.liffId ?? null });
  });

  r.get('/booking', async (c) => {
    const found = await load(c, c.req.query('ref') ?? '', c.req.query('t'));
    if (found instanceof Response) return found;
    const refused = await checkGuest(c, found, c.req.header(ID_TOKEN_HEADER));
    if (refused) return refused;
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
    const found = await load(c, input.ref, input.t);
    if (found instanceof Response) return found;
    const refused = await checkGuest(c, found, input.idToken ?? c.req.header(ID_TOKEN_HEADER));
    if (refused) return refused;
    const { view, club } = found;
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
    const body = (await c.req.json().catch(() => ({}))) as { ref?: string; t?: string; idToken?: string };
    const found = await load(c, body.ref ?? '', body.t);
    if (found instanceof Response) return found;
    const refused = await checkGuest(c, found, body.idToken ?? c.req.header(ID_TOKEN_HEADER));
    if (refused) return refused;
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
