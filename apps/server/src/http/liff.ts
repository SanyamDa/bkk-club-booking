import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { availableTables, BookingError, getBookingView, getBookingViewByRef, listTableOptions, submitDetails, type BookingView } from '../bookings/service.js';
import { sendReview } from '../bot/flow.js';
import { DATA_NOTICE_VERSION, langOf, t } from '../bot/i18n.js';
import { checkDetailsToken } from '../bot/links.js';
import { emit, PROPS_VALUE_PATTERN, type EventInput } from '../data/events.js';
import type { EventType } from '../data/event-types.js';
import { linkLiffSub, linkPhone, phoneHashKey } from '../data/identity.js';
import { clubs, DEFAULT_REQUIRED_FIELDS, notices, type Club } from '../db/schema.js';
import { SIM_USER_PREFIX } from '../line/gateway.js';
import { formatClock, formatNight } from '../lib/time.js';
import { formatBaht, newId } from '../lib/util.js';
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
  /** Required only when the club's `requiredFields` lists it (default: nationality). */
  nationality: z.union([z.string().trim().min(2).max(40), z.literal('')]).optional(),
  pax: z.coerce.number().int().min(1).max(50),
  specialRequest: z.string().trim().max(200).optional(),
  /** §5.2 step 4, optional unless the club requires it: `YYYY-MM-DD`. */
  birthDate: z.union([z.string().regex(/^(19|20)\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Enter a valid date'), z.literal('')]).optional(),
  occasion: z.string().trim().max(60).optional(),
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
  const phoneKey = phoneHashKey(app.config.CREDENTIALS_KEY);

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
  async function checkGuest(c: Context, found: Found, idToken: string | undefined): Promise<Response | null> {
    const { view, club } = found;
    const lineUserId = view.guest.lineUserId;
    if (!lineUserId || lineUserId.startsWith(SIM_USER_PREFIX)) return null;
    // B4b: every refusal is recorded as `form.identity_rejected` with its code.
    const refuse = async (code: 'login_not_configured' | 'login_required' | 'wrong_user', status: 503 | 401 | 403) => {
      await emit(db, formEvent(found, 'form.identity_rejected', { code }));
      return c.json({ error: code }, status);
    };
    const login = await app.credentials.login(club);
    if (!login) return refuse('login_not_configured', 503);
    if (!idToken) return refuse('login_required', 401);
    const verified = await app.verifyIdToken(idToken, login.channelId);
    if (!verified) return refuse('wrong_user', 403);
    if (!login.shared) return verified.sub === lineUserId ? null : refuse('wrong_user', 403);
    // Shared platform channel: the sub is our provider's id, so it is paired with the guest on first use.
    const pair = await linkLiffSub(db, { clubId: club.id, guestId: view.guest.id, sub: verified.sub }, app.deps.now());
    return pair === 'mismatch' ? refuse('wrong_user', 403) : null;
  }

  /** B4b (§14.2): one event of the details form, on the booking behind the signed link. */
  function formEvent({ view }: Found, type: EventType, props: EventInput['props'] = {}, extra: Partial<EventInput> = {}): EventInput {
    const b = view.booking;
    return {
      clubId: b.clubId,
      type,
      occurredAt: app.deps.now(),
      actorType: 'guest',
      actorId: b.guestId,
      channel: 'liff',
      dataOrigin: 'first_party',
      guestId: b.guestId,
      bookingId: b.id,
      tableId: b.tableId,
      nightDate: b.nightDate,
      attemptId: b.attemptId ?? undefined,
      props,
      isTest: b.isTest,
      ...extra,
    };
  }

  /** The booking behind a body that failed validation, when its signed link still checks out. */
  async function foundForInvalid(body: unknown): Promise<Found | null> {
    const { ref, t } = (body ?? {}) as { ref?: unknown; t?: unknown };
    if (typeof ref !== 'string' || typeof t !== 'string') return null;
    if (checkDetailsToken(app.config.APP_SECRET, ref, t, app.deps.now()) !== 'ok') return null;
    const view = await getBookingViewByRef(db, ref);
    if (!view) return null;
    const club = await db.query.clubs.findFirst({ where: eq(clubs.id, view.booking.clubId) });
    return club ? { view, club } : null;
  }

  const fieldCode = (s: string) => (PROPS_VALUE_PATTERN.test(s) ? s : 'other');

  /** Unauthenticated: only what the page needs to start LIFF before it has an ID token. */
  r.get('/club', async (c) => {
    const slug = c.req.query('club') ?? '';
    const club = slug ? await db.query.clubs.findFirst({ where: eq(clubs.slug, slug) }) : undefined;
    if (!club) return c.json({ error: 'not_found' }, 404);
    return c.json({ name: club.name, accentColor: club.settings.accentColor, liffId: club.liffId ?? null });
  });

  /**
   * Spec §5.2 step 3 [See floor plan]: the club's tables on the floor for one night, each free or
   * taken. Unauthenticated and without guest data: only codes, zones, sizes and positions.
   */
  r.get('/floor', async (c) => {
    const slug = c.req.query('club') ?? '';
    const date = c.req.query('d') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'bad_request' }, 400);
    const club = slug ? await db.query.clubs.findFirst({ where: eq(clubs.slug, slug) }) : undefined;
    if (!club) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    // Every active booking shows as taken, real or test.
    const [options, free] = await Promise.all([listTableOptions(db, club.id, date), availableTables(db, club.id, date, { min: 0, max: 999 }, now)]);
    const freeIds = new Set(free.map((o) => o.table.id));
    return c.json({
      club: { name: club.name, accentColor: club.settings.accentColor },
      night: formatNight(date, 'en'),
      tables: options.map((o) => ({
        code: o.table.code,
        zone: o.zone.name,
        zoneTh: o.zone.nameTh,
        minPax: o.table.minPax,
        maxPax: o.table.maxPax,
        x: o.table.floorX,
        y: o.table.floorY,
        shape: o.table.shape,
        free: freeIds.has(o.table.id),
      })),
    });
  });

  r.get('/booking', async (c) => {
    const found = await load(c, c.req.query('ref') ?? '', c.req.query('t'));
    if (found instanceof Response) return found;
    const refused = await checkGuest(c, found, c.req.header(ID_TOKEN_HEADER));
    if (refused) return refused;
    const { view, club } = found;
    const lang = langOf(view.guest.lang);
    const b = view.booking;
    // B4: the details link opens the LIFF app directly (a 302 to liff.line.me is unproven on a device),
    // so its tap is counted here, at the first read of the booking; the attempt's entry tag comes along.
    await emit(db, {
      clubId: club.id,
      type: 'link.opened',
      occurredAt: app.deps.now(),
      actorType: 'guest',
      channel: 'line',
      dataOrigin: 'first_party',
      guestId: b.guestId,
      bookingId: b.id,
      tableId: b.tableId,
      nightDate: b.nightDate,
      attemptId: b.attemptId ?? undefined,
      props: { kind: 'details' },
      isTest: b.isTest,
      dedupeKey: `link.opened:details:${b.id}`,
    });
    await emit(db, formEvent(found, 'form.opened'));
    return c.json({
      lang,
      club: {
        name: club.name,
        accentColor: club.settings.accentColor,
        rules: club.settings.rules[lang],
        arrivalBy: club.settings.arrivalBy,
        liffId: club.liffId,
        requiredFields: club.settings.requiredFields ?? DEFAULT_REQUIRED_FIELDS,
      },
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
      guest: {
        name: view.guest.name ?? view.guest.displayName ?? '',
        phone: view.guest.phone ?? '',
        nationality: view.guest.nationality ?? '',
        birthDate: view.guest.birthDate ?? '',
      },
      detailsSentText: t(lang, 'detailsSentText', { ref: b.refCode }),
    });
  });

  r.post('/booking/details', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = detailsSchema.safeParse(raw);
    if (!parsed.success) {
      // B4b: recorded only when the signed link names a booking (one event per failing field).
      const invalid = await foundForInvalid(raw);
      if (invalid) {
        await db.transaction(async (tx) => {
          for (const i of parsed.error.issues) {
            await emit(tx, formEvent(invalid, 'form.validation_failed', { field: fieldCode(i.path.join('.') || 'body'), code: fieldCode(i.code) }));
          }
        });
      }
      return c.json({ error: 'invalid', issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) }, 400);
    }
    const input = parsed.data;
    const found = await load(c, input.ref, input.t);
    if (found instanceof Response) return found;
    const refused = await checkGuest(c, found, input.idToken ?? c.req.header(ID_TOKEN_HEADER));
    if (refused) return refused;
    const { view, club } = found;
    // §5.2 step 4: the club's required fields (name and phone always are).
    const missing = (club.settings.requiredFields ?? DEFAULT_REQUIRED_FIELDS).filter((f) => !input[f]);
    if (missing.length) {
      await db.transaction(async (tx) => {
        for (const f of missing) await emit(tx, formEvent(found, 'form.validation_failed', { field: f, code: 'required' }));
      });
      return c.json({ error: 'invalid', issues: missing.map((f) => ({ field: f, message: 'Required' })) }, 400);
    }
    if (input.pax < view.table.minPax || input.pax > view.table.maxPax) {
      await emit(db, formEvent(found, 'form.validation_failed', { field: 'pax', code: 'out_of_range' }));
      return c.json({ error: 'invalid', issues: [{ field: 'pax', message: `This table seats ${view.table.minPax}–${view.table.maxPax}` }] }, 400);
    }
    const now = app.deps.now();
    try {
      await submitDetails(db, club, view.booking.id, { ...input, nationality: input.nationality || null, birthDate: input.birthDate || null }, now);
    } catch (err) {
      if (err instanceof BookingError) {
        await emit(db, formEvent(found, 'form.submit_rejected', { code: err.code }));
        return c.json({ error: err.code }, 409);
      }
      throw err;
    }
    // B4b (§5.5, §14.2): the form shows the data notice and the house rules above its submit button,
    // so a submit accepts both: the notice record for the form (`liff`) gets `accepted_at`.
    await db.transaction(async (tx) => {
      const [notice] = await tx
        .insert(notices)
        .values({ id: newId(), clubId: club.id, guestId: view.guest.id, purpose: 'data', textVersion: DATA_NOTICE_VERSION, channel: 'liff', shownAt: now, acceptedAt: now })
        .onConflictDoUpdate({ target: [notices.clubId, notices.guestId, notices.purpose, notices.textVersion, notices.channel], set: { acceptedAt: now } })
        .returning({ id: notices.id });
      await emit(tx, formEvent(found, 'notice.accepted', { notice_id: notice!.id, purpose: 'data', text_version: DATA_NOTICE_VERSION }));
      await emit(tx, formEvent(found, 'rules.accepted', { rules_version: club.settings.rulesVersion }, { dedupeKey: `rules.accepted:${view.booking.id}` }));
    });
    // Cross-club phone link (B20, §14.4): only the number typed in our form, never for a test guest.
    if (!view.guest.isTest) {
      await linkPhone(db, { clubId: club.id, guestId: view.guest.id, phone: input.phone }, phoneKey, app.deps.now());
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
