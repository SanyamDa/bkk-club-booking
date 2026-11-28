import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ACTIVE_BOOKING_STATUSES,
  auditLog,
  bookingStatusHistory,
  conversations,
  deposits,
  guests,
  handoffEpisodes,
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
  REASON_CODES,
  rejectDeposit,
  type Actor,
  type Reason,
} from '../bookings/service.js';
import { getConversationForClub } from '../chat/conversations.js';
import { endOpenEpisode, recordStaffReply } from '../chat/episodes.js';
import { emit, type EventInput } from '../data/events.js';
import { sampleMessages } from '../line/samples.js';
import { describeLineError, runLineSetup } from '../line/setup.js';
import { currentNightDate, formatNight } from '../lib/time.js';
import { formatBaht } from '../lib/util.js';
import { openPosBillAtCheckIn } from '../integrations/pos/live.js';
import { issueStaffLinkCode } from '../bot/staff-link.js';
import { auditClubChange } from '../platform/club-settings.js';
import { clientIp, requireClubRole, type AuthEnv, type Role } from './auth.js';
import type { AppContext } from './context.js';
import { staffAlertRoutes } from './staff-alerts.js';
import { staffInboxRoutes } from './staff-inbox.js';
import { staffCrmRoutes } from './staff-crm.js';
import { staffExtrasRoutes } from './staff-extras.js';
import { staffPromoterRoutes } from './staff-promoters.js';
import { staffPosRoutes } from './staff-pos.js';
import { staffReportRoutes } from './staff-report.js';
import { staffSettingsRoutes } from './staff-settings.js';
import { staffBookingRoutes } from './staff-bookings.js';
import { teamRoutes } from './team.js';

/** Roles per route (plan A2 Decisions). */
const STAFF_ROLES: Role[] = ['owner', 'manager', 'host', 'door'];
const MANAGER_ROLES: Role[] = ['owner', 'manager'];

type StaffContext = Context<AuthEnv>;

/** The actor for audit rows and events: the signed-in person, or a platform user under a support grant (A5). */
function actorOf(c: StaffContext): Actor {
  const grant = c.var.supportGrant;
  return grant
    ? { type: 'platform', id: c.var.user.id, sessionId: c.var.session.idHash, supportGrantId: grant.id }
    : { type: 'staff', id: c.var.user.id, sessionId: c.var.session.idHash };
}

/**
 * Staff dashboard API, mounted at /api/staff. Sign-in is per person at /api/auth (http/auth.ts,
 * spec §4, §13). Every route lives under `/clubs/:slug/...` and goes through `requireClubRole`, so
 * the club comes from the URL and the session (spec §12.1). Every id lookup is club-scoped
 * (`getBookingView`, the booking-service mutations, `getConversationForClub`, `getDepositForClub`),
 * so another club's id answers 404 even on the user's own slug.
 */
export function staffRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;

  const staff = requireClubRole(app, ...STAFF_ROLES);
  const managers = requireClubRole(app, ...MANAGER_ROLES);

  r.route('/', staffPosRoutes(app)); // A11 POS report import
  r.route('/', teamRoutes(app)); // A8 staff accounts and invites
  r.route('/', staffSettingsRoutes(app)); // A9 settings, prices, nights calendar, profile, quota
  r.route('/', staffReportRoutes(app)); // A16b weekly club report
  r.route('/', staffInboxRoutes(app)); // A13 Chatwoot inbox SSO and booking panel
  r.route('/', staffPromoterRoutes(app)); // A20a promoters, attribution, promoter report
  r.route('/', staffCrmRoutes(app)); // A20c guest CRM and VIP tags
  r.route('/', staffExtrasRoutes(app)); // B22 bottle menu, pre-orders, waitlist
  r.route('/', staffBookingRoutes(app)); // §6.2 booking search, change table/night/pax/notes, payments, deposit CSV

  /** A staff-surface event for the club in the URL, attributed to the signed-in person. */
  function staffEvent(c: StaffContext, e: Omit<EventInput, 'clubId' | 'occurredAt' | 'actorType' | 'actorId' | 'dataOrigin' | 'isTest'>) {
    const club = c.var.club;
    const actor = actorOf(c);
    return emit(db, {
      ...e,
      clubId: club.id,
      occurredAt: app.deps.now(),
      actorType: actor.type,
      actorId: actor.id,
      dataOrigin: 'first_party',
      isTest: club.status === 'demo',
    });
  }

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
    isTest: b.isTest,
  });

  // ----- Tonight: table map + bookings for one night -----
  r.get('/clubs/:slug/night', staff, async (c) => {
    const club = c.var.club;
    const now = app.deps.now();
    const date = c.req.query('date') || currentNightDate(now, club.settings.nightEndHour);
    // The night's price from price_rules (B9b); a malformed date falls back to column prices.
    const priceDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
    const [options, nightBookings] = await Promise.all([listTableOptions(db, club.id, priceDate), bookingsForNight(db, club.id, date)]);
    const guestRows = nightBookings.length
      ? await db.select().from(guests).where(eq(guests.clubId, club.id))
      : [];
    const guestById = new Map(guestRows.map((g) => [g.id, g]));
    const active = new Set<string>(ACTIVE_BOOKING_STATUSES);
    const isLive = (b: Booking) =>
      active.has(b.status) && !((b.status === 'held' || b.status === 'awaiting_payment') && b.holdExpiresAt && b.holdExpiresAt <= now);

    const tables = options.map((o) => {
      // A test booking may share a table with a real one (B6): the real booking is the occupancy.
      const onTable = nightBookings.filter((x) => x.tableId === o.table.id && isLive(x));
      const b = onTable.find((x) => !x.isTest) ?? onTable[0];
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
          // Spec §5.3: the guest blocked the club's LINE account and cannot be messaged.
          unfollowedAt: g?.unfollowedAt?.toISOString() ?? null,
          live: isLive(b),
        };
      });
    const handoffs = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.clubId, club.id), eq(conversations.mode, 'human')));
    // Spec §6.2 Tonight totals: deposits collected (verified) and minimum spend booked, real bookings only.
    const booked = nightBookings.filter((b) => !b.isTest && isLive(b) && ['confirmed', 'arrived', 'payment_review'].includes(b.status));
    const paid = booked.length
      ? await db
          .select({ amount: deposits.amountSatang })
          .from(deposits)
          .where(and(eq(deposits.clubId, club.id), eq(deposits.status, 'verified'), inArray(deposits.bookingId, booked.map((b) => b.id))))
      : [];
    return c.json({
      club: { slug: club.slug, name: club.name, accentColor: club.settings.accentColor },
      date,
      nightLabel: formatNight(date, 'en'),
      tables,
      bookings: list,
      handoffCount: handoffs.length,
      totals: {
        depositsCollected: formatBaht(paid.reduce((n, r) => n + r.amount, 0)),
        minSpendBooked: formatBaht(booked.reduce((n, b) => n + b.minSpendSatang, 0)),
      },
    });
  });

  // ----- Booking detail + actions -----
  r.get('/clubs/:slug/bookings/:id', staff, async (c) => {
    const club = c.var.club;
    const view = await getBookingView(db, { clubId: club.id, id: c.req.param('id') });
    if (!view) return c.json({ error: 'not_found' }, 404);
    const recent = await db
      .select()
      .from(messages)
      .where(and(eq(messages.clubId, club.id), eq(messages.guestId, view.guest.id)))
      .orderBy(desc(messages.createdAt))
      .limit(30);
    const allDeposits = await db
      .select()
      .from(deposits)
      .where(and(eq(deposits.clubId, club.id), eq(deposits.bookingId, view.booking.id)))
      .orderBy(desc(deposits.createdAt));
    // §6.2 Booking detail: history, rules accepted, chat summary and audit trail.
    const [history, audit, conv] = await Promise.all([
      db.select().from(bookingStatusHistory).where(eq(bookingStatusHistory.bookingId, view.booking.id)).orderBy(asc(bookingStatusHistory.at)),
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.clubId, club.id), eq(auditLog.entity, 'booking'), eq(auditLog.entityId, view.booking.id)))
        .orderBy(asc(auditLog.at))
        .limit(200),
      db.query.conversations.findFirst({ where: and(eq(conversations.clubId, club.id), eq(conversations.guestId, view.guest.id)) }),
    ]);
    const handoffs = conv
      ? await db
          .select()
          .from(handoffEpisodes)
          .where(and(eq(handoffEpisodes.clubId, club.id), eq(handoffEpisodes.conversationId, conv.id)))
          .orderBy(desc(handoffEpisodes.startedAt))
          .limit(5)
      : [];
    await staffEvent(c, {
      type: 'staff.booking_viewed',
      bookingId: view.booking.id,
      guestId: view.guest.id,
      tableId: view.table.id,
      zoneId: view.zone.id,
      nightDate: view.booking.nightDate,
    });
    return c.json({
      booking: {
        ...shape(view.booking),
        table: view.table.code,
        tableId: view.table.id,
        zone: view.zone.name,
        occasion: view.booking.occasion,
        rulesVersion: view.booking.rulesVersion,
        rulesAcceptedAt: view.booking.rulesAcceptedAt?.toISOString() ?? null,
      },
      history: history.map((h) => ({ from: h.fromStatus, to: h.toStatus, at: h.at.toISOString(), actorType: h.actorType, actorId: h.actorId, reasonCode: h.reasonCode })),
      audit: audit.map((a) => ({ action: a.action, at: a.at.toISOString(), actorType: a.actorType, actorId: a.actorId, reason: a.reason, before: a.before, after: a.after })),
      chatSummary: {
        mode: conv?.mode ?? null,
        handoffReason: conv?.handoffReason ?? null,
        handoffs: handoffs.map((h) => ({ startedAt: h.startedAt.toISOString(), endedAt: h.endedAt?.toISOString() ?? null, trigger: h.trigger, topic: h.topic, summary: h.reason })),
      },
      guest: { id: view.guest.id, name: view.guest.name, displayName: view.guest.displayName, phone: view.guest.phone, nationality: view.guest.nationality, viaLine: Boolean(view.guest.lineUserId), unfollowedAt: view.guest.unfollowedAt?.toISOString() ?? null },
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

  const actionSchema = z.object({
    reason: z.string().trim().max(200).optional(),
    reasonCode: z.enum(REASON_CODES).optional(),
    /** `arrived` only: the party size actually at the door (B2 `markArrived`). */
    arrivedPax: z.number().int().min(0).max(200).optional(),
    /** `cancel` only (§6.2): keep the verified deposit (`forfeit`) or refund it by hand (`refund`). */
    deposit: z.enum(['forfeit', 'refund']).optional(),
  });
  type ActionInput = z.infer<typeof actionSchema>;
  /** Builds the W0 `Reason` from the optional code and free text; `fallback` when neither is given. */
  const reasonOf = (input: ActionInput, fallback: Reason): Reason => ({
    code: input.reasonCode ?? fallback.code,
    text: input.reason ?? (input.reasonCode ? undefined : fallback.text),
  });
  const act = (
    name: string,
    roles: typeof staff,
    fn: (club: Club, id: string, actor: Actor, input: ActionInput) => Promise<unknown>,
  ) =>
    r.post(`/clubs/:slug/bookings/:id/${name}`, roles, async (c) => {
      const parsed = actionSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
      try {
        await fn(c.var.club, c.req.param('id'), actorOf(c), parsed.data);
        return c.json({ ok: true });
      } catch (err) {
        if (err instanceof BookingError) {
          return c.json({ error: err.code, message: err.message }, err.code === 'not_found' ? 404 : 409);
        }
        throw err;
      }
    });

  act('approve', managers, async (club, id, actor) => {
    await approveDeposit(db, club.id, id, actor, app.deps.now());
    await app.notifier.confirmed(club.id, id);
  });
  act('reject', managers, async (club, id, actor, input) => {
    await rejectDeposit(db, club.id, id, actor, reasonOf(input, { code: 'payment_not_verified', text: 'Payment could not be verified' }), app.deps.now());
    await app.notifier.rejected(club.id, id);
  });
  act('cancel', staff, async (club, id, actor, input) => {
    await cancelBooking(db, club.id, id, actor, reasonOf(input, { code: 'club_cancelled', text: 'Cancelled by the club' }), app.deps.now(), { deposit: input.deposit });
    await app.notifier.cancelled(club.id, id, input.reason ?? '');
  });
  act('arrived', staff, async (club, id, actor, input) => {
    await markArrived(db, club.id, id, actor, app.deps.now(), input.arrivedPax);
    // A19 L2: open the POS bill with the deposit as a prepayment (no-op without a live POS).
    app.track(openPosBillAtCheckIn(db, app.config.CREDENTIALS_KEY, club, id, { now: app.deps.now(), fetch: app.posFetch }));
  });
  act('no-show', staff, (club, id, actor) => markNoShow(db, club.id, id, actor, app.deps.now()));

  // ----- Manual booking -----
  const manualSchema = z.object({
    tableId: z.string(),
    nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    pax: z.coerce.number().int().min(1).max(50),
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(30).optional(),
    notes: z.string().trim().max(300).optional(),
    depositPaid: z.boolean().default(false),
    /** §9 source: a phone booking (`manual_phone`) or a walk-in (`manual_walkin`). */
    kind: z.enum(['phone', 'walkin']).default('phone'),
    /** §6.2: a LINE guest of this club to book for, so they can get the confirmation in LINE. */
    guestId: z.string().max(80).optional(),
    /** §6.2 "send the guest a LINE confirmation if they're linked". */
    sendLineConfirmation: z.boolean().default(false),
  });
  r.post('/clubs/:slug/bookings', staff, async (c) => {
    const parsed = manualSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    try {
      const club = c.var.club;
      const { kind, sendLineConfirmation, ...input } = parsed.data;
      const b = await createManualBooking(db, club, { ...input, source: kind === 'walkin' ? 'manual_walkin' : 'manual_phone' }, actorOf(c), app.deps.now());
      const linked = Boolean(input.guestId) && Boolean((await db.query.guests.findFirst({ where: and(eq(guests.id, b.guestId), eq(guests.clubId, club.id)) }))?.lineUserId);
      if (sendLineConfirmation && linked) await app.notifier.confirmed(club.id, b.id);
      return c.json({ ok: true, id: b.id, ref: b.refCode, lineConfirmationSent: sendLineConfirmation && linked });
    } catch (err) {
      if (err instanceof BookingError) return c.json({ error: err.code, message: err.message }, 409);
      throw err;
    }
  });

  // ----- Handoffs -----
  r.get('/clubs/:slug/handoffs', staff, async (c) => {
    const club = c.var.club;
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
        .where(and(eq(messages.clubId, club.id), eq(messages.guestId, guest.id)))
        .orderBy(desc(messages.createdAt))
        .limit(12);
      out.push({
        id: conv.id,
        guestName: guest.name ?? guest.displayName ?? 'Guest',
        reason: conv.handoffReason,
        requestedAt: conv.handoffRequestedAt?.toISOString() ?? null,
        unfollowedAt: guest.unfollowedAt?.toISOString() ?? null,
        messages: recent.reverse().map((m) => ({ direction: m.direction, kind: m.kind, payload: m.payload, at: m.createdAt.toISOString() })),
      });
    }
    return c.json({ handoffs: out });
  });

  // B14b: [Mark resolved] ends the open handoff episode (chat/episodes.ts emits handoff.resolved).
  r.post('/clubs/:slug/conversations/:id/resolve', staff, async (c) => {
    const club = c.var.club;
    const conv = await getConversationForClub(db, club.id, c.req.param('id'));
    if (!conv) return c.json({ error: 'not_found' }, 404);
    const actor = actorOf(c);
    const now = app.deps.now();
    await db.transaction((tx) => endOpenEpisode(tx, { clubId: club.id, conversationId: conv.id, resolverUserId: c.var.user.id, actor, now }));
    return c.json({ ok: true });
  });

  r.post('/clubs/:slug/conversations/:id/reply', staff, async (c) => {
    // A support session reads and fixes settings; it never messages a guest as the club (spec §16.1 q8, plan A5).
    if (c.var.supportGrant) return c.json({ error: 'support_no_guest_messages' }, 403);
    const club = c.var.club;
    // Club check first, so another club's id answers 404 whatever the body holds.
    const conv = await getConversationForClub(db, club.id, c.req.param('id'));
    if (!conv) return c.json({ error: 'not_found' }, 404);
    const parsed = z.object({ text: z.string().trim().min(1).max(1000) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    // B14b: stored with author_type='staff', recorded on the takeover episode, then sent.
    await recordStaffReply(
      db,
      { clubId: club.id, conversationId: conv.id, userId: c.var.user.id, text: parsed.data.text, channel: 'dashboard', occurredAt: app.deps.now(), externalId: null },
      { outbox: app.deps.outbox, gateways: app.gateways },
    );
    return c.json({ ok: true });
  });

  // ----- Staff alerts feed + settings -----
  r.get('/clubs/:slug/alerts', staff, async (c) => {
    const club = c.var.club;
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.clubId, club.id), isNotNull(messages.target), isNull(messages.guestId)))
      .orderBy(desc(messages.createdAt))
      .limit(30);
    return c.json({ alerts: rows.map((m) => ({ text: (m.payload as { text?: string }).text ?? '', at: m.createdAt.toISOString() })) });
  });

  r.get('/clubs/:slug/settings', managers, async (c) => {
    const club = c.var.club;
    return c.json({
      name: club.name,
      // B5: no link code here; a manager issues a fresh one with POST /staff-link-code.
      staffGroupLinked: Boolean(club.staffGroupId),
      staffGroupPending: Boolean(club.pendingStaffGroupId),
      lineConnected: (await app.credentials.line(club)) !== null,
      webhookUrl: `${app.config.PUBLIC_URL.replace(/\/$/, '')}/line/webhook/${club.slug}`,
      liffEndpoint: `${app.config.PUBLIC_URL.replace(/\/$/, '')}/liff/details`,
      liffConfigured: Boolean(club.liffId),
      promptpayConfigured: Boolean(club.promptpayId),
      // The PromptPay and greeting editors need a fresh second-factor code (spec §12.3).
      secondFactorEnrolled: Boolean(c.var.user.totpSecret),
      settings: club.settings,
    });
  });

  /**
   * B5: a fresh single-use staff link code, shown once (8 characters, 10-minute expiry, only its
   * hash stored). A founder uses this same route under a write-mode support grant.
   */
  r.post('/clubs/:slug/staff-link-code', managers, async (c) => {
    const club = c.var.club;
    const now = app.deps.now();
    const issued = await issueStaffLinkCode(db, club.id, c.var.user.id, now);
    // The code itself is never written to the audit row or a log line.
    await auditClubChange(
      db,
      club,
      { ...actorOf(c), ip: clientIp(c) },
      { action: 'staff_link_code.issued', entity: 'club', entityId: club.id, after: { expiresAt: issued.expiresAt.toISOString() } },
      now,
    );
    return c.json({ code: issued.code, expiresAt: issued.expiresAt.toISOString() });
  });

  // ----- LINE connection -----
  async function lineClientsFor(club: Club) {
    const creds = await app.credentials.line(club);
    return creds ? app.lineSetupClients(creds.accessToken, await app.credentials.login(club)) : null;
  }

  /** Connects the club's LINE account to this server (webhook, rich menu, LIFF) and checks every message type. */
  r.post('/clubs/:slug/line-setup', managers, async (c) => {
    const club = c.var.club;
    const clients = await lineClientsFor(club);
    if (!clients) return c.json({ error: 'line_not_configured', message: 'Add the LINE channel secret and access token to .env first.' }, 400);
    const { refreshMenu } = (await c.req.json().catch(() => ({}))) as { refreshMenu?: boolean };
    const report = await runLineSetup({
      club,
      clients,
      publicUrl: app.config.PUBLIC_URL,
      links: app.deps.links,
      sampleMessages: await sampleMessages(db, club, app.deps.links, app.deps.now()),
      refreshRichMenu: Boolean(refreshMenu),
    });
    return c.json(report);
  });

  r.get('/clubs/:slug/line-status', managers, async (c) => {
    const club = c.var.club;
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
  r.get('/clubs/:slug/deposits/:id/slip', staff, async (c) => {
    const d = await getDepositForClub(db, c.var.club.id, c.req.param('id'));
    if (!d?.slipPath) return c.text('Not found', 404);
    const root = resolve(app.deps.uploadsDir);
    const file = resolve(root, d.slipPath);
    if (!file.startsWith(root + sep)) return c.text('Not found', 404);
    const info = await stat(file).catch(() => null);
    if (!info) return c.text('Not found', 404);
    await staffEvent(c, { type: 'staff.slip_viewed', bookingId: d.bookingId, props: { depositId: d.id } });
    const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: { 'content-type': type, 'content-length': String(info.size), 'cache-control': 'private, no-store' },
    });
  });

  // ----- Alerts feed, counter, resolve, LINE switch (A15) -----
  r.route('/', staffAlertRoutes(app));

  return r;
}
