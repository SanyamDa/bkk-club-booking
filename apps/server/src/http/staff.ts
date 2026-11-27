import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  ACTIVE_BOOKING_STATUSES,
  bookings,
  clubs,
  conversations,
  deposits,
  guests,
  messages,
  type Booking,
  type Club,
} from '../db/schema.js';
import {
  approveDeposit,
  BookingError,
  bookingsForNight,
  cancelBooking,
  createManualBooking,
  getBookingView,
  getDepositForClub,
  listTableOptions,
  markArrived,
  markNoShow,
  rejectDeposit,
  type Actor,
} from '../bookings/service.js';
import { getConversationForClub } from '../chat/conversations.js';
import { sampleMessages } from '../line/samples.js';
import { describeLineError, runLineSetup } from '../line/setup.js';
import { currentNightDate, formatNight } from '../lib/time.js';
import { formatBaht } from '../lib/util.js';
import { revokeSession, SESSION_COOKIE } from '../platform/sessions.js';
import { checkClubAccess, clubsOfUser, requireClubRole, requireUser, type AuthEnv, type Role } from './auth.js';
import type { AppContext } from './context.js';

/** Roles per route (plan A2 Decisions). */
const STAFF_ROLES: Role[] = ['owner', 'manager', 'host', 'door'];
const MANAGER_ROLES: Role[] = ['owner', 'manager'];

/**
 * Staff dashboard API. Sign-in is per person at /api/auth (http/auth.ts, spec §4, §13); every
 * route here needs a live session and access to the club it touches: `/clubs/:slug/*` through
 * `requireClubRole`, id-addressed routes through `checkClubAccess` on the row's club. A2 moves the
 * id routes under `/clubs/:slug` and switches the lookups to the club-scoped W0 helpers only.
 */
export function staffRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;

  const requireStaff = requireUser(app);
  const managerOnly = requireClubRole(app, ...MANAGER_ROLES);
  r.use('/clubs/:slug/settings', managerOnly);
  r.use('/clubs/:slug/line-setup', managerOnly);
  r.use('/clubs/:slug/line-status', managerOnly);
  r.use('/clubs/:slug/*', requireClubRole(app, ...STAFF_ROLES));
  r.use('/bookings/*', requireStaff);
  r.use('/conversations/*', requireStaff);
  r.use('/deposits/*', requireStaff);
  r.use('/me', requireStaff);

  /** The row's club when the signed-in user may use it with one of `roles`, else the refusal. */
  async function accessible(
    userId: string,
    clubId: string | undefined,
    roles: Role[] = STAFF_ROLES,
  ): Promise<{ clubId: string } | { refused: 'not_found' | 'forbidden' }> {
    if (!clubId) return { refused: 'not_found' };
    const result = await checkClubAccess(app, userId, clubId, roles);
    return result === 'ok' ? { clubId } : { refused: result };
  }

  // The web dashboard still calls these two; they match /api/auth/me and /api/auth/logout.
  r.get('/me', async (c) => c.json({ clubs: await clubsOfUser(db, c.var.user.id) }));
  r.post('/logout', async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) await revokeSession(db, sid, app.deps.now());
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  async function clubBySlug(slug: string): Promise<Club | undefined> {
    return db.query.clubs.findFirst({ where: eq(clubs.slug, slug) });
  }

  // These URLs carry no club yet, so the club comes from the row itself and `accessible` checks
  // the user's membership there. A2 moves these routes under /clubs/:slug.
  async function clubIdOfBooking(id: string): Promise<string | undefined> {
    const [row] = await db.select({ clubId: bookings.clubId }).from(bookings).where(eq(bookings.id, id)).limit(1);
    return row?.clubId;
  }
  async function clubIdOfConversation(id: string): Promise<string | undefined> {
    const [row] = await db.select({ clubId: conversations.clubId }).from(conversations).where(eq(conversations.id, id)).limit(1);
    return row?.clubId;
  }
  async function clubIdOfDeposit(id: string): Promise<string | undefined> {
    const [row] = await db.select({ clubId: deposits.clubId }).from(deposits).where(eq(deposits.id, id)).limit(1);
    return row?.clubId;
  }

  const STAFF: Actor = { type: 'staff' };

  const shape = (b: Booking) => ({
    id: b.id,
    ref: b.refCode,
    status: b.status,
    nightDate: b.nightDate,
    pax: b.pax,
    source: b.source,
    minSpend: formatBaht(b.minSpendSatang),
    deposit: formatBaht(b.depositSatang),
    holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
    specialRequest: b.specialRequest,
    notes: b.notes,
    statusReason: b.statusReason,
    createdAt: b.createdAt.toISOString(),
  });

  // ----- Tonight: table map + bookings for one night -----
  r.get('/clubs/:slug/night', async (c) => {
    const club = await clubBySlug(c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    const date = c.req.query('date') || currentNightDate(now, club.settings.nightEndHour);
    const [options, nightBookings] = await Promise.all([listTableOptions(db, club.id), bookingsForNight(db, club.id, date)]);
    const guestRows = nightBookings.length
      ? await db.select().from(guests).where(eq(guests.clubId, club.id))
      : [];
    const guestById = new Map(guestRows.map((g) => [g.id, g]));
    const active = new Set<string>(ACTIVE_BOOKING_STATUSES);
    const isLive = (b: Booking) =>
      active.has(b.status) && !((b.status === 'held' || b.status === 'awaiting_payment') && b.holdExpiresAt && b.holdExpiresAt <= now);

    const tables = options.map((o) => {
      const b = nightBookings.find((x) => x.tableId === o.table.id && isLive(x));
      const g = b ? guestById.get(b.guestId) : undefined;
      return {
        id: o.table.id,
        code: o.table.code,
        zone: o.zone.name,
        minPax: o.table.minPax,
        maxPax: o.table.maxPax,
        minSpend: formatBaht(o.minSpendSatang),
        deposit: formatBaht(o.depositSatang),
        booking: b ? { ...shape(b), guestName: g?.name ?? g?.displayName ?? 'Guest' } : null,
      };
    });
    const list = nightBookings
      .filter((b) => b.status !== 'abandoned')
      .map((b) => {
        const g = guestById.get(b.guestId);
        const tbl = options.find((o) => o.table.id === b.tableId);
        return {
          ...shape(b),
          table: tbl?.table.code ?? '?',
          zone: tbl?.zone.name ?? '',
          guestName: g?.name ?? g?.displayName ?? 'Guest',
          phone: g?.phone ?? null,
          nationality: g?.nationality ?? null,
          live: isLive(b),
        };
      });
    const handoffs = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.clubId, club.id), eq(conversations.mode, 'human')));
    return c.json({
      club: { slug: club.slug, name: club.name, accentColor: club.settings.accentColor },
      date,
      nightLabel: formatNight(date, 'en'),
      tables,
      bookings: list,
      handoffCount: handoffs.length,
    });
  });

  // ----- Booking detail + actions -----
  r.get('/bookings/:id', async (c) => {
    const id = c.req.param('id');
    const access = await accessible(c.var.user.id, await clubIdOfBooking(id));
    if ('refused' in access) return c.json({ error: access.refused }, access.refused === 'forbidden' ? 403 : 404);
    const view = await getBookingView(db, { clubId: access.clubId, id });
    if (!view) return c.json({ error: 'not_found' }, 404);
    const recent = await db
      .select()
      .from(messages)
      .where(eq(messages.guestId, view.guest.id))
      .orderBy(desc(messages.createdAt))
      .limit(30);
    const allDeposits = await db.select().from(deposits).where(eq(deposits.bookingId, view.booking.id)).orderBy(desc(deposits.createdAt));
    return c.json({
      booking: { ...shape(view.booking), table: view.table.code, zone: view.zone.name, rulesAcceptedAt: view.booking.rulesAcceptedAt?.toISOString() ?? null },
      guest: { id: view.guest.id, name: view.guest.name, displayName: view.guest.displayName, phone: view.guest.phone, nationality: view.guest.nationality, viaLine: Boolean(view.guest.lineUserId) },
      deposits: allDeposits.map((d) => ({
        id: d.id,
        amount: formatBaht(d.amountSatang),
        method: d.method,
        status: d.status,
        hasSlip: Boolean(d.slipPath),
        slipReceivedAt: d.slipReceivedAt?.toISOString() ?? null,
        verifiedBy: d.verifiedBy,
        note: d.note,
      })),
      messages: recent.reverse().map((m) => ({ direction: m.direction, kind: m.kind, payload: m.payload, at: m.createdAt.toISOString() })),
    });
  });

  const actionSchema = z.object({ reason: z.string().trim().max(200).optional() });
  const act = (name: string, roles: Role[], fn: (clubId: string, id: string, reason: string | undefined) => Promise<unknown>) =>
    r.post(`/bookings/:id/${name}`, async (c) => {
      const { reason } = actionSchema.parse(await c.req.json().catch(() => ({})));
      const id = c.req.param('id');
      const access = await accessible(c.var.user.id, await clubIdOfBooking(id), roles);
      if ('refused' in access) {
        return access.refused === 'forbidden'
          ? c.json({ error: 'forbidden' }, 403)
          : c.json({ error: 'not_found', message: 'not_found' }, 409);
      }
      try {
        await fn(access.clubId, id, reason);
        return c.json({ ok: true });
      } catch (err) {
        if (err instanceof BookingError) return c.json({ error: err.code, message: err.message }, 409);
        throw err;
      }
    });

  act('approve', MANAGER_ROLES, async (clubId, id) => {
    await approveDeposit(db, clubId, id, STAFF, app.deps.now());
    await app.notifier.confirmed(clubId, id);
  });
  act('reject', MANAGER_ROLES, async (clubId, id, reason) => {
    await rejectDeposit(db, clubId, id, STAFF, { code: 'payment_not_verified', text: reason ?? 'Payment could not be verified' }, app.deps.now());
    await app.notifier.rejected(clubId, id);
  });
  act('cancel', STAFF_ROLES, async (clubId, id, reason) => {
    await cancelBooking(db, clubId, id, STAFF, { code: 'club_cancelled', text: reason ?? 'Cancelled by the club' }, app.deps.now());
    await app.notifier.cancelled(clubId, id, reason ?? '');
  });
  act('arrived', STAFF_ROLES, (clubId, id) => markArrived(db, clubId, id, STAFF, app.deps.now()));
  act('no-show', STAFF_ROLES, (clubId, id) => markNoShow(db, clubId, id, STAFF, app.deps.now()));

  // ----- Manual booking -----
  const manualSchema = z.object({
    tableId: z.string(),
    nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    pax: z.coerce.number().int().min(1).max(50),
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(30).optional(),
    notes: z.string().trim().max(300).optional(),
    depositPaid: z.boolean().default(false),
  });
  r.post('/clubs/:slug/bookings', async (c) => {
    const club = await clubBySlug(c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const parsed = manualSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    try {
      const b = await createManualBooking(db, club, parsed.data, STAFF, app.deps.now());
      return c.json({ ok: true, id: b.id, ref: b.refCode });
    } catch (err) {
      if (err instanceof BookingError) return c.json({ error: err.code, message: err.message }, 409);
      throw err;
    }
  });

  // ----- Handoffs -----
  r.get('/clubs/:slug/handoffs', async (c) => {
    const club = await clubBySlug(c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const rows = await db
      .select({ conv: conversations, guest: guests })
      .from(conversations)
      .innerJoin(guests, eq(conversations.guestId, guests.id))
      .where(and(eq(conversations.clubId, club.id), eq(conversations.mode, 'human')))
      .orderBy(asc(conversations.handoffRequestedAt));
    const out = [];
    for (const { conv, guest } of rows) {
      const recent = await db
        .select()
        .from(messages)
        .where(eq(messages.guestId, guest.id))
        .orderBy(desc(messages.createdAt))
        .limit(12);
      out.push({
        id: conv.id,
        guestName: guest.name ?? guest.displayName ?? 'Guest',
        reason: conv.handoffReason,
        requestedAt: conv.handoffRequestedAt?.toISOString() ?? null,
        messages: recent.reverse().map((m) => ({ direction: m.direction, kind: m.kind, payload: m.payload, at: m.createdAt.toISOString() })),
      });
    }
    return c.json({ handoffs: out });
  });

  r.post('/conversations/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const access = await accessible(c.var.user.id, await clubIdOfConversation(id));
    if ('refused' in access) return c.json({ error: access.refused }, access.refused === 'forbidden' ? 403 : 404);
    const conv = await getConversationForClub(db, access.clubId, id);
    if (!conv) return c.json({ ok: true });
    await db
      .update(conversations)
      .set({ mode: 'bot', handoffRequestedAt: null, handoffReason: null, updatedAt: new Date() })
      .where(and(eq(conversations.id, conv.id), eq(conversations.clubId, conv.clubId)));
    return c.json({ ok: true });
  });

  r.post('/conversations/:id/reply', async (c) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(await c.req.json().catch(() => ({})));
    const id = c.req.param('id');
    const access = await accessible(c.var.user.id, await clubIdOfConversation(id));
    if ('refused' in access) return c.json({ error: access.refused }, access.refused === 'forbidden' ? 403 : 404);
    const conv = await getConversationForClub(db, access.clubId, id);
    if (!conv) return c.json({ error: 'not_found' }, 404);
    await app.notifier.hostReply(conv.clubId, conv.guestId, text, STAFF);
    return c.json({ ok: true });
  });

  // ----- Staff alerts feed + settings -----
  r.get('/clubs/:slug/alerts', async (c) => {
    const club = await clubBySlug(c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.clubId, club.id), isNotNull(messages.target), isNull(messages.guestId)))
      .orderBy(desc(messages.createdAt))
      .limit(30);
    return c.json({ alerts: rows.map((m) => ({ text: (m.payload as { text?: string }).text ?? '', at: m.createdAt.toISOString() })) });
  });

  r.get('/clubs/:slug/settings', async (c) => {
    const club = await clubBySlug(c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    return c.json({
      name: club.name,
      staffLinkCode: club.staffLinkCode,
      staffGroupLinked: Boolean(club.staffGroupId),
      lineConnected: (await app.credentials.line(club)) !== null,
      webhookUrl: `${app.config.PUBLIC_URL.replace(/\/$/, '')}/line/webhook/${club.slug}`,
      liffEndpoint: `${app.config.PUBLIC_URL.replace(/\/$/, '')}/liff/details`,
      liffConfigured: Boolean(club.liffId),
      promptpayConfigured: Boolean(club.promptpayId),
      settings: club.settings,
    });
  });

  // ----- LINE connection -----
  async function lineClientsFor(club: Club) {
    const creds = await app.credentials.line(club);
    return creds ? app.lineSetupClients(creds.accessToken, await app.credentials.login(club)) : null;
  }

  /** Connects the club's LINE account to this server (webhook, rich menu, LIFF) and checks every message type. */
  r.post('/clubs/:slug/line-setup', async (c) => {
    const club = await clubBySlug(c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const clients = await lineClientsFor(club);
    if (!clients) return c.json({ error: 'line_not_configured', message: 'Add the LINE channel secret and access token to .env first.' }, 400);
    const { refreshMenu } = (await c.req.json().catch(() => ({}))) as { refreshMenu?: boolean };
    const report = await runLineSetup({
      club,
      clients,
      publicUrl: app.config.PUBLIC_URL,
      sampleMessages: await sampleMessages(db, club, app.deps.links, app.deps.now()),
      refreshRichMenu: Boolean(refreshMenu),
    });
    return c.json(report);
  });

  r.get('/clubs/:slug/line-status', async (c) => {
    const club = await clubBySlug(c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const clients = await lineClientsFor(club);
    if (!clients) return c.json({ connected: false });
    const expected = `${app.config.PUBLIC_URL.replace(/\/$/, '')}/line/webhook/${club.slug}`;
    try {
      const [bot, hook, quota, used] = await Promise.all([
        clients.api.getBotInfo(),
        clients.api.getWebhookEndpoint(),
        clients.api.getMessageQuota(),
        clients.api.getMessageQuotaConsumption(),
      ]);
      return c.json({
        connected: true,
        bot: { displayName: bot.displayName, basicId: bot.basicId, chatMode: bot.chatMode, addFriendUrl: `https://line.me/R/ti/p/${encodeURIComponent(bot.basicId)}` },
        webhook: { endpoint: hook.endpoint, active: hook.active, matches: hook.endpoint === expected, expected },
        quota: { limit: quota.type === 'limited' ? quota.value ?? null : null, used: used.totalUsage },
      });
    } catch (err) {
      return c.json({ connected: false, error: describeLineError(err) });
    }
  });

  // ----- Slip images (private) -----
  r.get('/deposits/:id/slip', async (c) => {
    const id = c.req.param('id');
    const access = await accessible(c.var.user.id, await clubIdOfDeposit(id));
    if ('refused' in access) return access.refused === 'forbidden' ? c.text('Forbidden', 403) : c.text('Not found', 404);
    const d = await getDepositForClub(db, access.clubId, id);
    if (!d?.slipPath) return c.text('Not found', 404);
    const root = resolve(app.deps.uploadsDir);
    const file = resolve(root, d.slipPath);
    if (!file.startsWith(root + sep)) return c.text('Not found', 404);
    const info = await stat(file).catch(() => null);
    if (!info) return c.text('Not found', 404);
    const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: { 'content-type': type, 'content-length': String(info.size), 'cache-control': 'private, no-store' },
    });
  });

  return r;
}
