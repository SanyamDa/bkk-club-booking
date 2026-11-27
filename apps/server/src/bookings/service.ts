import { and, asc, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { isUniqueViolation } from '../db/client.js';
import {
  ACTIVE_BOOKING_STATUSES,
  auditLog,
  bookings,
  deposits,
  guests,
  tables,
  zones,
  type Booking,
  type BookingStatus,
  type Club,
  type Deposit,
  type Guest,
  type Table,
  type Zone,
} from '../db/schema.js';
import { addDays, bangkokParts, currentNightDate, weekdayOf } from '../lib/time.js';
import { newId, newRefCode } from '../lib/util.js';

// ---------- Party sizes ----------

export const PAX_RANGES = [
  { key: '2-4', min: 2, max: 4 },
  { key: '5-8', min: 5, max: 8 },
  { key: '9-12', min: 9, max: 12 },
  { key: '13+', min: 13, max: 99 },
] as const;
export type PaxRangeKey = (typeof PAX_RANGES)[number]['key'];

export function paxRange(key: string | undefined) {
  return PAX_RANGES.find((r) => r.key === key);
}

/** Ranges above this go to a host instead of self-booking (spec §5.2 step 2). */
export const SELF_BOOK_MAX_PAX = 12;

// ---------- Nights ----------

/** Same-night bookings close at 01:00 Bangkok time (spec §7.2). */
const SAME_NIGHT_CUTOFF_HOUR = 1;

export function isNightBookable(club: Club, date: string, now: Date): boolean {
  const s = club.settings;
  const tonight = currentNightDate(now, s.nightEndHour);
  if (date < tonight) return false;
  if (date > addDays(tonight, s.bookingWindowDays)) return false;
  if (!s.openWeekdays.includes(weekdayOf(date))) return false;
  if (s.closedDates.includes(date)) return false;
  if (date === tonight) {
    const hour = bangkokParts(now).hour;
    if (hour >= SAME_NIGHT_CUTOFF_HOUR && hour < s.nightEndHour) return false;
  }
  return true;
}

export function upcomingNights(club: Club, now: Date, count: number): string[] {
  const tonight = currentNightDate(now, club.settings.nightEndHour);
  const out: string[] = [];
  for (let i = 0; i <= club.settings.bookingWindowDays && out.length < count; i++) {
    const d = addDays(tonight, i);
    if (isNightBookable(club, d, now)) out.push(d);
  }
  return out;
}

// ---------- Availability ----------

export interface TableOption {
  table: Table;
  zone: Zone;
  minSpendSatang: number;
  depositSatang: number;
}

const ACTIVE = [...ACTIVE_BOOKING_STATUSES];

/** A booking occupies its table if it's active and (for holds) the hold hasn't run out. */
function occupies(b: Pick<Booking, 'status' | 'holdExpiresAt'>, now: Date): boolean {
  if (!ACTIVE.includes(b.status as (typeof ACTIVE)[number])) return false;
  if ((b.status === 'held' || b.status === 'awaiting_payment') && b.holdExpiresAt && b.holdExpiresAt <= now) {
    return false;
  }
  return true;
}

export async function listTableOptions(db: Db, clubId: string): Promise<TableOption[]> {
  const rows = await db
    .select({ table: tables, zone: zones })
    .from(tables)
    .innerJoin(zones, eq(tables.zoneId, zones.id))
    .where(and(eq(tables.clubId, clubId), eq(tables.active, true)))
    .orderBy(asc(zones.sort), asc(tables.sort));
  return rows.map(({ table, zone }) => ({
    table,
    zone,
    minSpendSatang: table.minSpendSatang ?? zone.minSpendSatang,
    depositSatang: table.depositSatang ?? zone.depositSatang,
  }));
}

export async function bookingsForNight(db: Db, clubId: string, nightDate: string): Promise<Booking[]> {
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.clubId, clubId), eq(bookings.nightDate, nightDate)))
    .orderBy(asc(bookings.createdAt));
}

export async function availableTables(
  db: Db,
  clubId: string,
  nightDate: string,
  range: { min: number; max: number },
  now: Date,
): Promise<TableOption[]> {
  const [options, nightBookings] = await Promise.all([
    listTableOptions(db, clubId),
    bookingsForNight(db, clubId, nightDate),
  ]);
  const taken = new Set(nightBookings.filter((b) => occupies(b, now)).map((b) => b.tableId));
  return options.filter(
    (o) => !taken.has(o.table.id) && o.table.maxPax >= range.min && o.table.minPax <= range.max,
  );
}

// ---------- Holds ----------

export class BookingError extends Error {
  constructor(
    public readonly code:
      | 'table_taken'
      | 'night_not_bookable'
      | 'not_found'
      | 'invalid_state'
      | 'hold_expired'
      | 'details_missing',
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function audit(db: Db, clubId: string, actor: string, action: string, entityId: string, data?: unknown) {
  await db.insert(auditLog).values({ id: newId(), clubId, actor, action, entity: 'booking', entityId, data: data ?? null });
}

/**
 * Holds a table for a guest. Exactly one concurrent caller can win a given table+night: the
 * partial unique index rejects the others, which we report as `table_taken`.
 */
export async function holdTable(
  db: Db,
  club: Club,
  input: { guestId: string; tableId: string; nightDate: string; pax: number },
  now: Date,
): Promise<Booking> {
  if (!isNightBookable(club, input.nightDate, now)) throw new BookingError('night_not_bookable');
  const option = (await listTableOptions(db, club.id)).find((o) => o.table.id === input.tableId);
  if (!option) throw new BookingError('not_found', 'Table not found');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // Release this guest's other unfinished holds at this club (one active booking flow at a time).
        await tx
          .update(bookings)
          .set({ status: 'abandoned', statusReason: 'Guest chose another table', updatedAt: now })
          .where(
            and(
              eq(bookings.clubId, club.id),
              eq(bookings.guestId, input.guestId),
              inArray(bookings.status, ['held']),
            ),
          );
        // Free up stale holds on this table so the unique index reflects reality.
        await tx
          .update(bookings)
          .set({ status: 'expired', statusReason: 'Hold timed out', updatedAt: now })
          .where(
            and(
              eq(bookings.tableId, input.tableId),
              eq(bookings.nightDate, input.nightDate),
              inArray(bookings.status, ['held', 'awaiting_payment']),
              lt(bookings.holdExpiresAt, now),
            ),
          );
        const [row] = await tx
          .insert(bookings)
          .values({
            id: newId(),
            clubId: club.id,
            refCode: newRefCode(club.settings.refPrefix),
            guestId: input.guestId,
            tableId: input.tableId,
            nightDate: input.nightDate,
            pax: input.pax,
            status: 'held',
            source: 'line',
            holdExpiresAt: new Date(now.getTime() + club.settings.holdMinutes * 60_000),
            minSpendSatang: option.minSpendSatang,
            depositSatang: option.depositSatang,
          })
          .returning();
        return row!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Either the table is taken, or (very rarely) the ref code collided: check which.
        const stillFree = (await availableTables(db, club.id, input.nightDate, { min: 0, max: 99 }, now)).some(
          (o) => o.table.id === input.tableId,
        );
        if (!stillFree) throw new BookingError('table_taken');
        continue;
      }
      throw err;
    }
  }
  throw new BookingError('table_taken');
}

// ---------- Guest details ----------

export interface GuestDetails {
  name: string;
  phone: string;
  nationality: string;
  pax: number;
  specialRequest?: string;
}

export async function submitDetails(db: Db, club: Club, bookingId: string, details: GuestDetails, now: Date) {
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!booking || booking.clubId !== club.id) throw new BookingError('not_found');
  if (booking.status !== 'held') throw new BookingError('invalid_state');
  if (booking.holdExpiresAt && booking.holdExpiresAt <= now) throw new BookingError('hold_expired');

  await db
    .update(guests)
    .set({ name: details.name, phone: details.phone, nationality: details.nationality, consentAt: now, updatedAt: now })
    .where(eq(guests.id, booking.guestId));
  const [updated] = await db
    .update(bookings)
    .set({
      pax: details.pax,
      specialRequest: details.specialRequest || null,
      rulesVersion: club.settings.rulesVersion,
      rulesAcceptedAt: now,
      updatedAt: now,
    })
    .where(eq(bookings.id, bookingId))
    .returning();
  await audit(db, club.id, 'guest', 'details_submitted', bookingId);
  return updated!;
}

// ---------- Deposit ----------

/** Guest tapped "Confirm & pay deposit". */
export async function requestDeposit(db: Db, club: Club, bookingId: string, now: Date) {
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!booking || booking.clubId !== club.id) throw new BookingError('not_found');
  if (booking.status === 'awaiting_payment') return booking; // idempotent: re-send the QR
  if (booking.status !== 'held') throw new BookingError('invalid_state');
  if (booking.holdExpiresAt && booking.holdExpiresAt <= now) throw new BookingError('hold_expired');
  if (!booking.rulesAcceptedAt) throw new BookingError('details_missing');

  if (booking.depositSatang === 0) {
    const [b] = await db
      .update(bookings)
      .set({ status: 'confirmed', holdExpiresAt: null, updatedAt: now })
      .where(eq(bookings.id, bookingId))
      .returning();
    await audit(db, club.id, 'guest', 'confirmed_no_deposit', bookingId);
    return b!;
  }
  const [b] = await db
    .update(bookings)
    .set({ status: 'awaiting_payment', updatedAt: now })
    .where(eq(bookings.id, bookingId))
    .returning();
  await db.insert(deposits).values({
    id: newId(),
    bookingId,
    amountSatang: booking.depositSatang,
    method: 'promptpay_slip',
    status: 'pending',
  });
  await audit(db, club.id, 'guest', 'deposit_requested', bookingId);
  return b!;
}

export async function latestDeposit(db: Db, bookingId: string): Promise<Deposit | undefined> {
  return db.query.deposits.findFirst({ where: eq(deposits.bookingId, bookingId), orderBy: desc(deposits.createdAt) });
}

/** The booking a slip image most likely belongs to, if any. */
export async function bookingAwaitingSlip(db: Db, clubId: string, guestId: string, now: Date) {
  const lateWindow = new Date(now.getTime() - 2 * 60 * 60_000);
  return db.query.bookings.findFirst({
    where: and(
      eq(bookings.clubId, clubId),
      eq(bookings.guestId, guestId),
      or(
        eq(bookings.status, 'awaiting_payment'),
        // A slip that arrives after the hold ran out still goes to review (spec §5.2 step 6).
        and(eq(bookings.status, 'expired'), gt(bookings.updatedAt, lateWindow), gt(bookings.depositSatang, 0)),
      ),
    ),
    orderBy: desc(bookings.updatedAt),
  });
}

/**
 * Stores a received slip and moves the booking to payment review. Phase 0 has no automatic
 * verification, so every slip is reviewed by staff.
 * Returns `tableLost: true` when the hold had expired and someone else has the table now.
 */
export async function recordSlip(db: Db, club: Club, bookingId: string, slipPath: string, now: Date) {
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!booking || booking.clubId !== club.id) throw new BookingError('not_found');
  let deposit = await latestDeposit(db, bookingId);
  if (!deposit) {
    [deposit] = await db
      .insert(deposits)
      .values({ id: newId(), bookingId, amountSatang: booking.depositSatang, method: 'promptpay_slip', status: 'pending' })
      .returning();
  }
  await db
    .update(deposits)
    .set({ status: 'review', slipPath, slipReceivedAt: now })
    .where(eq(deposits.id, deposit!.id));

  let tableLost = false;
  try {
    await db
      .update(bookings)
      .set({ status: 'payment_review', holdExpiresAt: null, updatedAt: now })
      .where(eq(bookings.id, bookingId));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    tableLost = true;
    await db
      .update(bookings)
      .set({ statusReason: 'Slip arrived after hold expired; table was taken. Staff to reassign.', updatedAt: now })
      .where(eq(bookings.id, bookingId));
  }
  await audit(db, club.id, 'guest', 'slip_received', bookingId, { tableLost });
  return { tableLost };
}

// ---------- Staff actions ----------

async function transition(
  db: Db,
  bookingId: string,
  from: BookingStatus[],
  to: BookingStatus,
  actor: string,
  now: Date,
  reason?: string,
): Promise<Booking> {
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!booking) throw new BookingError('not_found');
  if (!from.includes(booking.status)) {
    throw new BookingError('invalid_state', `Cannot change a ${booking.status} booking to ${to}`);
  }
  let updated: Booking;
  try {
    [updated] = (await db
      .update(bookings)
      .set({ status: to, statusReason: reason ?? null, holdExpiresAt: null, updatedAt: now })
      .where(eq(bookings.id, bookingId))
      .returning()) as [Booking];
  } catch (err) {
    if (isUniqueViolation(err)) throw new BookingError('table_taken', 'That table is now booked by someone else');
    throw err;
  }
  await audit(db, booking.clubId, actor, `status:${to}`, bookingId, { from: booking.status, reason });
  return updated;
}

export async function approveDeposit(db: Db, bookingId: string, actor: string, now: Date) {
  const booking = await transition(db, bookingId, ['payment_review', 'awaiting_payment', 'expired'], 'confirmed', actor, now);
  const deposit = await latestDeposit(db, bookingId);
  if (deposit) {
    await db
      .update(deposits)
      .set({ status: 'verified', verifiedBy: actor, verifiedAt: now })
      .where(eq(deposits.id, deposit.id));
  }
  return booking;
}

export async function rejectDeposit(db: Db, bookingId: string, actor: string, reason: string, now: Date) {
  const booking = await transition(db, bookingId, ['payment_review', 'awaiting_payment', 'expired'], 'rejected', actor, now, reason);
  const deposit = await latestDeposit(db, bookingId);
  if (deposit) await db.update(deposits).set({ status: 'rejected', note: reason }).where(eq(deposits.id, deposit.id));
  return booking;
}

export const cancelBooking = (db: Db, id: string, actor: string, reason: string, now: Date) =>
  transition(db, id, ['held', 'awaiting_payment', 'payment_review', 'confirmed'], 'cancelled', actor, now, reason);

export const markArrived = (db: Db, id: string, actor: string, now: Date) =>
  transition(db, id, ['confirmed'], 'arrived', actor, now);

export const markNoShow = (db: Db, id: string, actor: string, now: Date) =>
  transition(db, id, ['confirmed'], 'no_show', actor, now);

/** Holds whose time ran out. Returns them so the guests can be told. */
export async function expireStaleHolds(db: Db, now: Date): Promise<Booking[]> {
  return db
    .update(bookings)
    .set({ status: 'expired', statusReason: 'Hold timed out', updatedAt: now })
    .where(and(inArray(bookings.status, ['held', 'awaiting_payment']), lt(bookings.holdExpiresAt, now)))
    .returning();
}

/** Phone, walk-in, promoter or VIP bookings entered by staff. Same availability rules as LINE. */
export async function createManualBooking(
  db: Db,
  club: Club,
  input: { tableId: string; nightDate: string; pax: number; name: string; phone?: string; notes?: string; depositPaid: boolean },
  actor: string,
  now: Date,
): Promise<Booking> {
  const option = (await listTableOptions(db, club.id)).find((o) => o.table.id === input.tableId);
  if (!option) throw new BookingError('not_found', 'Table not found');
  const [guest] = await db
    .insert(guests)
    .values({ id: newId(), clubId: club.id, name: input.name, phone: input.phone || null, displayName: input.name })
    .returning();
  try {
    const booking = await db.transaction(async (tx) => {
      await tx
        .update(bookings)
        .set({ status: 'expired', statusReason: 'Hold timed out', updatedAt: now })
        .where(
          and(
            eq(bookings.tableId, input.tableId),
            eq(bookings.nightDate, input.nightDate),
            inArray(bookings.status, ['held', 'awaiting_payment']),
            lt(bookings.holdExpiresAt, now),
          ),
        );
      const [b] = await tx
        .insert(bookings)
        .values({
          id: newId(),
          clubId: club.id,
          refCode: newRefCode(club.settings.refPrefix),
          guestId: guest!.id,
          tableId: input.tableId,
          nightDate: input.nightDate,
          pax: input.pax,
          status: 'confirmed',
          source: 'manual',
          minSpendSatang: option.minSpendSatang,
          depositSatang: option.depositSatang,
          notes: input.notes || null,
        })
        .returning();
      if (input.depositPaid && option.depositSatang > 0) {
        await tx.insert(deposits).values({
          id: newId(),
          bookingId: b!.id,
          amountSatang: option.depositSatang,
          method: 'manual',
          status: 'verified',
          verifiedBy: actor,
          verifiedAt: now,
        });
      }
      return b!;
    });
    await audit(db, club.id, actor, 'manual_booking', booking.id);
    return booking;
  } catch (err) {
    if (isUniqueViolation(err)) throw new BookingError('table_taken', 'That table is already booked for this night');
    throw err;
  }
}

// ---------- Reads ----------

/** The guest's current booking flow: an unfinished hold, or an upcoming booking. */
export async function currentBookingForGuest(db: Db, club: Club, guestId: string, now: Date) {
  const tonight = currentNightDate(now, club.settings.nightEndHour);
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.clubId, club.id),
        eq(bookings.guestId, guestId),
        inArray(bookings.status, ['held', 'awaiting_payment', 'payment_review', 'confirmed']),
      ),
    )
    .orderBy(asc(bookings.nightDate));
  return rows.find((b) => b.nightDate >= tonight && occupies(b, now));
}

export interface BookingView {
  booking: Booking;
  table: Table;
  zone: Zone;
  guest: Guest;
  deposit?: Deposit;
}

export async function getBookingView(db: Db, where: { id?: string; refCode?: string }): Promise<BookingView | undefined> {
  const cond = where.id ? eq(bookings.id, where.id) : eq(bookings.refCode, where.refCode ?? '');
  const [row] = await db
    .select({ booking: bookings, table: tables, zone: zones, guest: guests })
    .from(bookings)
    .innerJoin(tables, eq(bookings.tableId, tables.id))
    .innerJoin(zones, eq(tables.zoneId, zones.id))
    .innerJoin(guests, eq(bookings.guestId, guests.id))
    .where(cond)
    .limit(1);
  if (!row) return undefined;
  return { ...row, deposit: await latestDeposit(db, row.booking.id) };
}
