import { and, asc, desc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BookingError, changeBooking, type Actor } from '../bookings/service.js';
import { bookings, deposits, guests, promoterAttributions, tables, zones, type BookingStatus } from '../db/schema.js';
import { formatBaht } from '../lib/util.js';
import { requireClubRole, type AuthEnv, type Role } from './auth.js';
import type { AppContext } from './context.js';

const STAFF_ROLES: Role[] = ['owner', 'manager', 'host', 'door'];
const MANAGER_ROLES: Role[] = ['owner', 'manager'];
const BOOKING_STATUSES = [
  'held', 'awaiting_payment', 'payment_review', 'confirmed', 'arrived', 'completed', 'cancelled', 'expired', 'no_show', 'abandoned', 'rejected',
] as const satisfies readonly BookingStatus[];
const SOURCES = ['line', 'instagram', 'manual', 'manual_phone', 'manual_walkin', 'promoter', 'web'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type C = Context<AuthEnv>;

function actorOf(c: C): Actor {
  const grant = c.var.supportGrant;
  return grant
    ? { type: 'platform', id: c.var.user.id, sessionId: c.var.session.idHash, supportGrantId: grant.id }
    : { type: 'staff', id: c.var.user.id, sessionId: c.var.session.idHash };
}

const searchQuery = z.object({
  night: date.optional(),
  from: date.optional(),
  to: date.optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  zone: z.string().max(80).optional(),
  promoter: z.string().max(80).optional(),
  source: z.enum(SOURCES).optional(),
  /** Name, phone or booking ref. */
  q: z.string().trim().max(80).optional(),
});

const changeBody = z
  .object({
    pax: z.number().int().min(1).max(200),
    tableId: z.string().min(1).max(80),
    nightDate: date,
    notes: z.string().trim().max(300).nullable(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

/** One CSV field: quoted, with quotes doubled, and a leading formula character neutralised. */
function csvField(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

/**
 * Spec §6.2 Bookings and Payments (mounted from http/staff.ts under /api/staff): booking search and
 * filters, change table / night / party size / notes, the slip review list and the deposit report CSV.
 * Every query is scoped to the club in the URL.
 */
export function staffBookingRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const staff = requireClubRole(app, ...STAFF_ROLES);
  const managers = requireClubRole(app, ...MANAGER_ROLES);

  // ----- Bookings: search and filter by night, status, zone, promoter and source -----
  r.get('/clubs/:slug/bookings', staff, async (c) => {
    const club = c.var.club;
    const parsed = searchQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    const f = parsed.data;
    const where: SQL[] = [eq(bookings.clubId, club.id)];
    if (f.night) where.push(eq(bookings.nightDate, f.night));
    if (f.from) where.push(gte(bookings.nightDate, f.from));
    if (f.to) where.push(lte(bookings.nightDate, f.to));
    if (f.status) where.push(eq(bookings.status, f.status));
    if (f.zone) where.push(eq(tables.zoneId, f.zone));
    if (f.source) where.push(eq(bookings.source, f.source));
    if (f.promoter) where.push(eq(promoterAttributions.promoterId, f.promoter));
    if (f.q) {
      const like = `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      where.push(or(ilike(guests.name, like), ilike(guests.displayName, like), ilike(guests.phone, like), ilike(bookings.refCode, like))!);
    }
    const rows = await db
      .select({ booking: bookings, table: tables, zone: zones, guest: guests, promoterId: promoterAttributions.promoterId })
      .from(bookings)
      .innerJoin(tables, eq(bookings.tableId, tables.id))
      .innerJoin(zones, eq(tables.zoneId, zones.id))
      .innerJoin(guests, eq(bookings.guestId, guests.id))
      .leftJoin(promoterAttributions, and(eq(promoterAttributions.bookingId, bookings.id), eq(promoterAttributions.clubId, club.id)))
      .where(and(...where))
      .orderBy(desc(bookings.nightDate), asc(tables.sort))
      .limit(300);
    return c.json({
      bookings: rows.map(({ booking: b, table, zone, guest, promoterId }) => ({
        id: b.id,
        ref: b.refCode,
        status: b.status,
        source: b.source,
        nightDate: b.nightDate,
        pax: b.pax,
        table: table.code,
        zone: zone.name,
        zoneId: zone.id,
        promoterId: promoterId ?? null,
        guestName: guest.name ?? guest.displayName ?? 'Guest',
        minSpend: formatBaht(b.minSpendSatang),
        deposit: formatBaht(b.depositSatang),
        isTest: b.isTest,
      })),
      truncated: rows.length === 300,
    });
  });

  // ----- Change table or night, party size, notes (through the booking service) -----
  r.post('/clubs/:slug/bookings/:id/change', staff, async (c) => {
    // Another club's id is 404 before the body is looked at (spec §12.1).
    const own = await db.query.bookings.findFirst({ where: and(eq(bookings.id, c.req.param('id')), eq(bookings.clubId, c.var.club.id)) });
    if (!own) return c.json({ error: 'not_found' }, 404);
    const parsed = changeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    try {
      const b = await changeBooking(db, c.var.club, c.req.param('id'), actorOf(c), parsed.data, app.deps.now());
      return c.json({ ok: true, booking: { id: b.id, pax: b.pax, tableId: b.tableId, nightDate: b.nightDate, notes: b.notes } });
    } catch (err) {
      if (err instanceof BookingError) return c.json({ error: err.code, message: err.message }, err.code === 'not_found' ? 404 : 409);
      throw err;
    }
  });

  // ----- Payments: slips waiting for review, amount read against the amount expected -----
  r.get('/clubs/:slug/payments', staff, async (c) => {
    const club = c.var.club;
    const rows = await db
      .select({ deposit: deposits, booking: bookings, table: tables, guest: guests })
      .from(deposits)
      .innerJoin(bookings, eq(deposits.bookingId, bookings.id))
      .innerJoin(tables, eq(bookings.tableId, tables.id))
      .innerJoin(guests, eq(bookings.guestId, guests.id))
      .where(and(eq(deposits.clubId, club.id), eq(bookings.clubId, club.id), inArray(bookings.status, ['payment_review', 'awaiting_payment', 'expired']), inArray(deposits.status, ['pending', 'review'])))
      .orderBy(asc(deposits.slipReceivedAt), asc(deposits.createdAt));
    return c.json({
      payments: rows
        .filter((r) => r.deposit.slipPath || r.booking.status === 'payment_review')
        .map(({ deposit: d, booking: b, table, guest }) => ({
          depositId: d.id,
          bookingId: b.id,
          ref: b.refCode,
          nightDate: b.nightDate,
          table: table.code,
          guestName: guest.name ?? guest.displayName ?? 'Guest',
          bookingStatus: b.status,
          expected: formatBaht(d.amountSatang),
          amountRead: d.slipAmountSatang === null ? null : formatBaht(d.slipAmountSatang),
          amountMatches: d.slipAmountSatang === null ? null : d.slipAmountSatang === d.amountSatang,
          receiver: d.slipReceiver,
          slipTime: d.slipTime?.toISOString() ?? null,
          slipReceivedAt: d.slipReceivedAt?.toISOString() ?? null,
          hasSlip: Boolean(d.slipPath),
          problem: d.note,
        })),
    });
  });

  // ----- Deposit report by night, as CSV (managers) -----
  r.get('/clubs/:slug/payments/deposits.csv', managers, async (c) => {
    const club = c.var.club;
    const from = c.req.query('from');
    const to = c.req.query('to');
    if ((from && !date.safeParse(from).success) || (to && !date.safeParse(to).success)) return c.json({ error: 'invalid' }, 400);
    const where: SQL[] = [eq(deposits.clubId, club.id), eq(bookings.clubId, club.id)];
    if (from) where.push(gte(bookings.nightDate, from));
    if (to) where.push(lte(bookings.nightDate, to));
    const rows = await db
      .select({ deposit: deposits, booking: bookings, table: tables })
      .from(deposits)
      .innerJoin(bookings, eq(deposits.bookingId, bookings.id))
      .innerJoin(tables, eq(bookings.tableId, tables.id))
      .where(and(...where))
      .orderBy(asc(bookings.nightDate), asc(tables.sort), asc(deposits.createdAt));
    const head = ['night', 'booking_ref', 'table', 'booking_status', 'deposit_status', 'method', 'expected_thb', 'slip_amount_thb', 'slip_received_at', 'verified_at', 'verified_by'];
    const lines = rows.map(({ deposit: d, booking: b, table }) =>
      [
        b.nightDate,
        b.refCode,
        table.code,
        b.status,
        d.status,
        d.method,
        d.amountSatang / 100,
        d.slipAmountSatang === null ? null : d.slipAmountSatang / 100,
        d.slipReceivedAt?.toISOString() ?? null,
        d.verifiedAt?.toISOString() ?? null,
        d.verifiedBy,
      ]
        .map(csvField)
        .join(','),
    );
    const body = [head.join(','), ...lines].join('\r\n') + '\r\n';
    return c.body(body, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="deposits-${club.slug}${from ? `-${from}` : ''}${to ? `-${to}` : ''}.csv"`,
    });
  });

  return r;
}
