import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { isUniqueViolation } from '../db/client.js';
import {
  ACTIVE_BOOKING_STATUSES,
  auditLog,
  bookings,
  bookingStatusHistory,
  clubs,
  deposits,
  guests,
  nights,
  tables,
  zones,
  type Booking,
  type BookingSource,
  type BookingStatus,
  type Club,
  type Deposit,
  type Guest,
  type Table,
  type Zone,
} from '../db/schema.js';
import { STATUS_EVENTS, type EventType } from '../data/event-types.js';
import { emit, type EventInput } from '../data/events.js';
import { isTestContext } from '../data/test-flag.js';
import { addDays, bangkokParts, currentNightDate, weekdayOf } from '../lib/time.js';
import { newId, newRefCode } from '../lib/util.js';
import { priceTables } from './pricing.js';

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

/** Same-night bookings close at 01:00 Bangkok time by default (spec §7.2; `sameNightCutoffHour`). */
export const DEFAULT_SAME_NIGHT_CUTOFF_HOUR = 1;
/** One active booking per guest per night by default (spec §7.2; `maxBookingsPerGuestPerNight`). */
export const DEFAULT_MAX_BOOKINGS_PER_GUEST_PER_NIGHT = 1;

/** The date is inside the booking window and, for tonight, before the same-night cutoff. */
function inBookingWindow(club: Club, date: string, now: Date): boolean {
  const s = club.settings;
  const tonight = currentNightDate(now, s.nightEndHour);
  if (date < tonight) return false;
  if (date > addDays(tonight, s.bookingWindowDays)) return false;
  if (date === tonight) {
    const hour = bangkokParts(now).hour;
    if (hour >= (s.sameNightCutoffHour ?? DEFAULT_SAME_NIGHT_CUTOFF_HOUR) && hour < s.nightEndHour) return false;
  }
  return true;
}

/** The settings-only open check (`openWeekdays`, `closedDates`), used when a date has no `nights` row. */
function openBySettings(club: Club, date: string): boolean {
  return club.settings.openWeekdays.includes(weekdayOf(date)) && !club.settings.closedDates.includes(date);
}

/** Settings-only check. The booking flow uses `isNightOpen`, which reads the `nights` row first (B8b). */
export function isNightBookable(club: Club, date: string, now: Date): boolean {
  return inBookingWindow(club, date, now) && openBySettings(club, date);
}

/**
 * A night's status (B8b): the `nights` row when one exists, else the club settings. `sold_out`
 * comes only from a row.
 */
export async function nightStatus(db: Db, clubId: string, date: string): Promise<'open' | 'closed' | 'sold_out'> {
  const row = await db.query.nights.findFirst({ where: and(eq(nights.clubId, clubId), eq(nights.date, date)) });
  if (row) return row.status;
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  return club && openBySettings(club, date) ? 'open' : 'closed';
}

/** Bookable now: inside the window and not closed (`nights` row first, settings otherwise). */
export async function isNightOpen(db: Db, club: Club, date: string, now: Date): Promise<boolean> {
  if (!inBookingWindow(club, date, now)) return false;
  return (await nightStatus(db, club.id, date)) !== 'closed';
}

export interface NightOption {
  date: string;
  status: 'open' | 'sold_out';
  eventName: string | null;
}

/**
 * The next `count` nights a guest can pick (B8b): `nights` rows where they exist (an event night
 * carries its `event_name`; a sold-out night is listed), the settings for dates without a row.
 */
export async function bookableNights(db: Db, club: Club, now: Date, count: number): Promise<NightOption[]> {
  const tonight = currentNightDate(now, club.settings.nightEndHour);
  const last = addDays(tonight, club.settings.bookingWindowDays);
  const rows = await db
    .select()
    .from(nights)
    .where(and(eq(nights.clubId, club.id), gte(nights.date, tonight), lte(nights.date, last)));
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: NightOption[] = [];
  for (let i = 0; i <= club.settings.bookingWindowDays && out.length < count; i++) {
    const date = addDays(tonight, i);
    if (!inBookingWindow(club, date, now)) continue;
    const row = byDate.get(date);
    if (row) {
      if (row.status !== 'closed') out.push({ date, status: row.status, eventName: row.eventName });
    } else if (openBySettings(club, date)) {
      out.push({ date, status: 'open', eventName: null });
    }
  }
  return out;
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

/**
 * Active tables with their price. With `nightDate`, the price is that night's from `price_rules`
 * (B9b, `bookings/pricing.ts`); without it, the table or zone price column.
 */
export async function listTableOptions(db: Db, clubId: string, nightDate?: string): Promise<TableOption[]> {
  const rows = await db
    .select({ table: tables, zone: zones })
    .from(tables)
    .innerJoin(zones, eq(tables.zoneId, zones.id))
    .where(and(eq(tables.clubId, clubId), eq(tables.active, true)))
    .orderBy(asc(zones.sort), asc(tables.sort));
  const prices = nightDate ? await priceTables(db, clubId, nightDate, rows) : undefined;
  return rows.map(({ table, zone }) => ({
    table,
    zone,
    ...(prices?.get(table.id) ?? {
      minSpendSatang: table.minSpendSatang ?? zone.minSpendSatang,
      depositSatang: table.depositSatang ?? zone.depositSatang,
    }),
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
  /**
   * B6: test rows and real rows never block each other (two partial unique indexes on bookings).
   * Pass the caller's `isTest` (from `isTestContext`) to see only that side; omitted, every
   * active booking counts as taken.
   */
  opts: { isTest?: boolean } = {},
): Promise<TableOption[]> {
  const [options, nightBookings] = await Promise.all([
    listTableOptions(db, clubId, nightDate),
    bookingsForNight(db, clubId, nightDate),
  ]);
  const sameSide = (b: Booking) => opts.isTest === undefined || b.isTest === opts.isTest;
  const taken = new Set(nightBookings.filter((b) => sameSide(b) && occupies(b, now)).map((b) => b.tableId));
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
      | 'details_missing'
      | 'guest_night_limit',
    message?: string,
  ) {
    super(message ?? code);
  }
}

// ---------- Actors and reasons (frozen contract, see build plan W0) ----------

export type Actor = {
  type: 'guest' | 'bot' | 'staff' | 'platform' | 'system';
  id?: string;
  sessionId?: string;
  supportGrantId?: string;
};

export const REASON_CODES = [
  'hold_expired',
  'guest_abandoned',
  'guest_cancelled',
  'club_cancelled',
  'payment_not_verified',
  'table_taken',
  'released',
  'other',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export type Reason = { code: ReasonCode; text?: string };

/** Free text of a reason as stored in `bookings.status_reason` (max 200 characters). */
function reasonText(reason: Reason | undefined): string | null {
  if (!reason) return null;
  return reason.text ? reason.text.slice(0, 200) : null;
}

/**
 * One booking `audit_log` row. Call it with the transaction handle of the change it records (B2).
 * The old `actor` column (NOT NULL, kept for today's readers) carries `actor.type`.
 */
async function audit(
  tx: Db,
  clubId: string,
  actor: Actor,
  action: string,
  entityId: string,
  data: unknown,
  extra: { reason?: Reason; before?: unknown; after?: unknown; at: Date },
) {
  await tx.insert(auditLog).values({
    id: newId(),
    clubId,
    actor: actor.type,
    actorType: actor.type,
    actorId: actor.id ?? null,
    sessionId: actor.sessionId ?? null,
    supportGrantId: actor.supportGrantId ?? null,
    reason: reasonText(extra.reason),
    action,
    entity: 'booking',
    entityId,
    data: data ?? null,
    before: extra.before ?? null,
    after: extra.after ?? null,
    at: extra.at,
  });
}

const GUEST: Actor = { type: 'guest' };
const SYSTEM: Actor = { type: 'system' };
const HOLD_EXPIRED: Reason = { code: 'hold_expired', text: 'Hold timed out' };

/** The event fields every event about this booking shares (spec §14.2). */
function bookingEventBase(b: Booking, actor: Actor, now: Date) {
  return {
    clubId: b.clubId,
    occurredAt: now,
    actorType: actor.type,
    actorId: actor.id,
    dataOrigin: 'first_party',
    bookingId: b.id,
    guestId: b.guestId,
    tableId: b.tableId,
    nightDate: b.nightDate,
    attemptId: b.attemptId ?? undefined,
    isTest: b.isTest,
  } satisfies Omit<EventInput, 'type'>;
}

/** What a status change carries beyond the status itself (B2). */
interface StatusChange {
  /** The row was just inserted with status `to`: history and events run from `null`, no update. */
  created?: boolean;
  /** More booking columns to set together with the status. */
  set?: Partial<typeof bookings.$inferInsert>;
  /** The deposit the change concerns. The `deposit.*` events of `STATUS_EVENTS` are written only with one. */
  deposit?: Deposit;
  /** `booking.checked_in`. */
  arrivedPax?: number | null;
  /** `table.held`. */
  holdMinutes?: number;
  /** B4: `events.source` (the attempt's entry tag) on this change's events. */
  eventSource?: string;
  /** `booking.abandoned`: the last step reached (default: the status the booking left). */
  lastStep?: string;
}

function statusEventProps(type: EventType, from: BookingStatus | null, reason: Reason | undefined, c: StatusChange): EventInput['props'] {
  const reasonCode = reason?.code ?? null;
  switch (type) {
    case 'table.held':
      return { hold_minutes: c.holdMinutes ?? null };
    case 'hold.expired':
    case 'booking.cancelled':
      return { reason_code: reasonCode };
    case 'booking.abandoned':
      return { last_step: c.lastStep ?? from, reason_code: reasonCode };
    case 'deposit.qr_sent':
    case 'deposit.verified':
      return { depositId: c.deposit!.id, amount_satang: c.deposit!.amountSatang };
    case 'slip.received':
      return { depositId: c.deposit!.id };
    case 'deposit.rejected':
      return { depositId: c.deposit!.id, reason_code: reasonCode };
    case 'booking.checked_in':
      return { arrived_pax: c.arrivedPax ?? null };
    default:
      return {};
  }
}

/**
 * The one writer of a booking status change (B2, spec §13.1 #11): the `bookings` update, one
 * `booking_status_history` row, one `audit_log` row, the generic `booking.status_changed` event and
 * the §14.2 events of `STATUS_EVENTS`, all on `tx`, so they commit or roll back together.
 * `reason.code` reaches history, `cancel_reason_code` and props; `reason.text` only `status_reason`,
 * `audit_log.reason` and `events.raw`. The update matches the status the caller read, so a booking
 * changed in between throws `invalid_state` instead of being overwritten.
 */
async function changeStatus(
  tx: Db,
  booking: Booking,
  to: BookingStatus,
  actor: Actor,
  reason: Reason | undefined,
  now: Date,
  extra: StatusChange = {},
): Promise<Booking> {
  const from = extra.created ? null : booking.status;
  let after = booking;
  if (!extra.created) {
    const [row] = await tx
      .update(bookings)
      .set({
        status: to,
        statusReason: reasonText(reason),
        updatedAt: now,
        ...(to === 'cancelled' ? { cancelledAt: now, cancelReasonCode: reason?.code ?? null } : {}),
        ...extra.set,
      })
      .where(and(eq(bookings.id, booking.id), eq(bookings.clubId, booking.clubId), eq(bookings.status, booking.status)))
      .returning();
    if (!row) throw new BookingError('invalid_state', `Booking ${booking.id} changed while it was being updated`);
    after = row;
  }
  await tx.insert(bookingStatusHistory).values({
    id: newId(),
    bookingId: booking.id,
    fromStatus: from,
    toStatus: to,
    at: now,
    actorType: actor.type,
    actorId: actor.id ?? null,
    reasonCode: reason?.code ?? null,
  });
  await audit(tx, booking.clubId, actor, `status:${to}`, booking.id, { from, reason: reason?.code ?? null }, {
    reason,
    before: from ? { status: from } : null,
    after: { status: to },
    at: now,
  });
  const base = { ...bookingEventBase(after, actor, now), ...(extra.eventSource ? { source: extra.eventSource } : {}) };
  const text = reasonText(reason);
  await emit(tx, {
    ...base,
    type: 'booking.status_changed',
    props: { from, to, reason_code: reason?.code ?? null },
    raw: text ? { reason_text: text } : undefined,
  });
  for (const type of STATUS_EVENTS[to] ?? []) {
    if (type.startsWith('deposit.') && !extra.deposit) continue;
    await emit(tx, { ...base, type, props: statusEventProps(type, from, reason, extra) });
  }
  await syncSoldOut(tx, after, actor, now);
  return after;
}

/**
 * B8b: after a booking change, marks the night `sold_out` (and emits `night.sold_out`) when every
 * active table is taken, and sets it back to `open` when a table frees up. Only the club's own
 * side counts: real bookings at a real club, test bookings at a demo club, so a simulator hold
 * never sells out a real night. A `closed` night is never touched.
 */
async function syncSoldOut(tx: Db, b: Booking, actor: Actor, now: Date): Promise<void> {
  const club = await tx.query.clubs.findFirst({ where: eq(clubs.id, b.clubId) });
  if (!club || b.isTest !== (club.status === 'demo')) return;
  const active = await tx
    .select({ id: tables.id })
    .from(tables)
    .where(and(eq(tables.clubId, b.clubId), eq(tables.active, true)));
  if (active.length === 0) return;
  const night = await tx
    .select({ tableId: bookings.tableId, status: bookings.status, holdExpiresAt: bookings.holdExpiresAt, isTest: bookings.isTest })
    .from(bookings)
    .where(and(eq(bookings.clubId, b.clubId), eq(bookings.nightDate, b.nightDate), inArray(bookings.status, ACTIVE)));
  const taken = new Set(night.filter((x) => x.isTest === b.isTest && occupies(x, now)).map((x) => x.tableId));
  const full = active.every((t) => taken.has(t.id));
  const row = await tx.query.nights.findFirst({ where: and(eq(nights.clubId, b.clubId), eq(nights.date, b.nightDate)) });
  if (full) {
    if (row && row.status !== 'open') return;
    const changed = row
      ? await tx
          .update(nights)
          .set({ status: 'sold_out' })
          .where(and(eq(nights.id, row.id), eq(nights.status, 'open')))
          .returning({ id: nights.id })
      : await tx
          .insert(nights)
          .values({ id: newId(), clubId: b.clubId, date: b.nightDate, status: 'sold_out' })
          .onConflictDoNothing()
          .returning({ id: nights.id });
    if (changed.length === 0) return;
    await emit(tx, {
      clubId: b.clubId,
      type: 'night.sold_out',
      occurredAt: now,
      actorType: actor.type,
      actorId: actor.id,
      dataOrigin: 'first_party',
      bookingId: b.id,
      tableId: b.tableId,
      nightDate: b.nightDate,
      isTest: b.isTest,
      props: {},
    });
  } else if (row?.status === 'sold_out') {
    await tx
      .update(nights)
      .set({ status: 'open' })
      .where(and(eq(nights.id, row.id), eq(nights.status, 'sold_out')));
  }
}

/**
 * Releases a confirmed booking's table for resale (B2; B10's no-show job is the first caller).
 * Not a status change (`released` is not a `BookingStatus`): it sets `released_at` and emits
 * `table.released` on `tx`, with no history row.
 */
export async function releaseTable(tx: Db, booking: Booking, actor: Actor, now: Date): Promise<void> {
  await tx
    .update(bookings)
    .set({ releasedAt: now, updatedAt: now })
    .where(and(eq(bookings.id, booking.id), eq(bookings.clubId, booking.clubId)));
  await emit(tx, { ...bookingEventBase(booking, actor, now), type: 'table.released', props: {} });
}

/**
 * Holds a table for a guest. Exactly one concurrent caller can win a given table+night: the
 * partial unique index rejects the others, which we report as `table_taken`.
 */
export async function holdTable(
  db: Db,
  club: Club,
  input: {
    guestId: string;
    tableId: string;
    nightDate: string;
    pax: number;
    /** B4: the bot's booking attempt, kept in `bookings.attempt_id` and on every event of the booking. */
    attemptId?: string;
    /** B4: the attempt's entry tag, written to `events.source` of the hold's events. */
    entry?: string;
    /** B4: `promoter` when the guest came through a promoter link (default `line`). */
    source?: BookingSource;
  },
  now: Date,
): Promise<Booking> {
  if (!(await isNightOpen(db, club, input.nightDate, now))) throw new BookingError('night_not_bookable');
  const option = (await listTableOptions(db, club.id, input.nightDate)).find((o) => o.table.id === input.tableId);
  if (!option) throw new BookingError('not_found', 'Table not found');
  // B6: the booking copies is_test from its context (demo club or test guest).
  const guest = await db.query.guests.findFirst({ where: and(eq(guests.id, input.guestId), eq(guests.clubId, club.id)) });
  const isTest = isTestContext({ club, guest });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // Release this guest's other unfinished holds at this club (one active booking flow at a time).
        const unfinished = await tx
          .select()
          .from(bookings)
          .where(and(eq(bookings.clubId, club.id), eq(bookings.guestId, input.guestId), inArray(bookings.status, ['held'])))
          .for('update');
        for (const b of unfinished) {
          // B4b: last_step is a funnel step (details / payment), never the status 'held'.
          const lastStep = b.rulesAcceptedAt ? 'payment' : 'details';
          await changeStatus(tx, b, 'abandoned', GUEST, { code: 'guest_abandoned', text: 'Guest chose another table' }, now, { lastStep });
        }
        // Spec §7.2: a guest has at most `maxBookingsPerGuestPerNight` active bookings on one night.
        if (await guestNightLimitReached(tx, club, input.guestId, input.nightDate)) throw new BookingError('guest_night_limit');
        // Free up stale holds on this table so the unique index reflects reality.
        await expireStaleOnTable(tx, input.tableId, input.nightDate, now);
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
            source: input.source ?? 'line',
            holdExpiresAt: new Date(now.getTime() + club.settings.holdMinutes * 60_000),
            minSpendSatang: option.minSpendSatang,
            depositSatang: option.depositSatang,
            attemptId: input.attemptId ?? null,
            isTest,
          })
          .returning();
        return changeStatus(tx, row!, 'held', GUEST, undefined, now, {
          created: true,
          holdMinutes: club.settings.holdMinutes,
          eventSource: input.entry,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Either the table is taken, or (very rarely) the ref code collided: check which.
        const stillFree = (await availableTables(db, club.id, input.nightDate, { min: 0, max: 99 }, now, { isTest })).some(
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
  /** Null when the club does not require it and the guest left it empty (§5.2 step 4). */
  nationality: string | null;
  pax: number;
  specialRequest?: string;
  /** §5.2 step 4, optional: `YYYY-MM-DD`. Kept on the guest when not given. */
  birthDate?: string | null;
  /** §5.2 step 4, optional: birthday, anniversary, etc. */
  occasion?: string | null;
}

/**
 * Stores the guest's details on a held booking. Not a status change (the booking stays `held`), so
 * it writes no history row: the guest and booking update, one audit row and one `details.submitted`
 * event, in one transaction (B2).
 */
export async function submitDetails(db: Db, club: Club, bookingId: string, details: GuestDetails, now: Date) {
  return db.transaction(async (tx) => {
    const booking = await tx.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
    if (!booking || booking.clubId !== club.id) throw new BookingError('not_found');
    if (booking.status !== 'held') throw new BookingError('invalid_state');
    if (booking.holdExpiresAt && booking.holdExpiresAt <= now) throw new BookingError('hold_expired');

    await tx
      .update(guests)
      .set({
        name: details.name,
        phone: details.phone,
        nationality: details.nationality,
        ...(details.birthDate ? { birthDate: details.birthDate } : {}),
        consentAt: now,
        updatedAt: now,
      })
      .where(eq(guests.id, booking.guestId));
    const [updated] = await tx
      .update(bookings)
      .set({
        pax: details.pax,
        specialRequest: details.specialRequest || null,
        occasion: details.occasion || null,
        rulesVersion: club.settings.rulesVersion,
        rulesAcceptedAt: now,
        updatedAt: now,
      })
      .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, club.id)))
      .returning();
    await audit(tx, club.id, GUEST, 'details_submitted', bookingId, null, { at: now });
    await emit(tx, { ...bookingEventBase(updated!, GUEST, now), type: 'details.submitted', props: { pax: details.pax } });
    return updated!;
  });
}

// ---------- Deposit ----------

/** Guest tapped "Confirm & pay deposit". */
export async function requestDeposit(db: Db, club: Club, bookingId: string, now: Date) {
  return db.transaction(async (tx) => {
    const booking = await tx.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
    if (!booking || booking.clubId !== club.id) throw new BookingError('not_found');
    if (booking.status === 'awaiting_payment') return booking; // idempotent: re-send the QR
    if (booking.status !== 'held') throw new BookingError('invalid_state');
    if (booking.holdExpiresAt && booking.holdExpiresAt <= now) throw new BookingError('hold_expired');
    if (!booking.rulesAcceptedAt) throw new BookingError('details_missing');

    if (booking.depositSatang === 0) {
      return changeStatus(tx, booking, 'confirmed', GUEST, undefined, now, { set: { holdExpiresAt: null } });
    }
    const [deposit] = await tx
      .insert(deposits)
      .values({
        id: newId(),
        clubId: club.id,
        bookingId,
        amountSatang: booking.depositSatang,
        method: 'promptpay_slip',
        status: 'pending',
      })
      .returning();
    return changeStatus(tx, booking, 'awaiting_payment', GUEST, undefined, now, { deposit });
  });
}

export async function latestDeposit(db: Db, bookingId: string): Promise<Deposit | undefined> {
  return db.query.deposits.findFirst({ where: eq(deposits.bookingId, bookingId), orderBy: desc(deposits.createdAt) });
}

/** A deposit by id, only when it belongs to this club. */
export async function getDepositForClub(db: Db, clubId: string, id: string): Promise<Deposit | undefined> {
  return db.query.deposits.findFirst({ where: and(eq(deposits.clubId, clubId), eq(deposits.id, id)) });
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
 * Stores a received slip and moves the booking to payment review. Automatic verification (B9,
 * `bookings/slip-verify.ts` `verifySlip`) runs after this and confirms the booking on a pass.
 * Returns `tableLost: true` when the hold had expired and someone else has the table now.
 */
const TABLE_LOST_TEXT = 'Slip arrived after hold expired; table was taken. Staff to reassign.';

export async function recordSlip(db: Db, club: Club, bookingId: string, slipPath: string, now: Date): Promise<{ tableLost: boolean }> {
  return db.transaction(async (tx) => {
    // Locked, so the hold-expiry sweep cannot change the status between this read and the update
    // below (that would fail the update and roll back the stored slip).
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, club.id)))
      .for('update');
    if (!booking) throw new BookingError('not_found');
    let deposit = await latestDeposit(tx, bookingId);
    if (!deposit) {
      [deposit] = await tx
        .insert(deposits)
        .values({ id: newId(), clubId: club.id, bookingId, amountSatang: booking.depositSatang, method: 'promptpay_slip', status: 'pending' })
        .returning();
    }
    [deposit] = await tx
      .update(deposits)
      .set({ status: 'review', slipPath, slipReceivedAt: now })
      .where(eq(deposits.id, deposit!.id))
      .returning();

    if (['held', 'awaiting_payment', 'expired'].includes(booking.status)) {
      try {
        // A savepoint: when the table went to someone else, the unique index rejects the update and
        // only the savepoint rolls back, so the slip stored above survives.
        await tx.transaction(async (sp) =>
          changeStatus(sp, booking, 'payment_review', GUEST, undefined, now, { set: { holdExpiresAt: null }, deposit }),
        );
        return { tableLost: false };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
      const [kept] = await tx
        .update(bookings)
        .set({ statusReason: TABLE_LOST_TEXT, updatedAt: now })
        .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, club.id)))
        .returning();
      await audit(tx, club.id, GUEST, 'slip_received', bookingId, { tableLost: true }, { reason: { code: 'table_taken', text: TABLE_LOST_TEXT }, at: now });
      await emit(tx, { ...bookingEventBase(kept!, GUEST, now), type: 'slip.received', props: { depositId: deposit!.id } });
      return { tableLost: true };
    }
    // A further slip for a booking already in review (or past it): stored, no status change.
    await audit(tx, club.id, GUEST, 'slip_received', bookingId, { tableLost: false }, { at: now });
    await emit(tx, { ...bookingEventBase(booking, GUEST, now), type: 'slip.received', props: { depositId: deposit!.id } });
    return { tableLost: false };
  });
}

// ---------- Staff actions ----------

interface TransitionOpts {
  set?: Partial<typeof bookings.$inferInsert>;
  arrivedPax?: number | null;
  /** Load the latest deposit for the `deposit.*` events, then run this on it inside the transaction. */
  onDeposit?: (tx: Db, deposit: Deposit) => Promise<void>;
}

async function transition(
  db: Db,
  clubId: string,
  bookingId: string,
  from: BookingStatus[],
  to: BookingStatus,
  actor: Actor,
  now: Date,
  reason?: Reason,
  opts: TransitionOpts = {},
): Promise<Booking> {
  try {
    return await db.transaction(async (tx) => {
      const booking = await tx.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId)) });
      if (!booking) throw new BookingError('not_found');
      if (!from.includes(booking.status)) {
        throw new BookingError('invalid_state', `Cannot change a ${booking.status} booking to ${to}`);
      }
      const deposit = opts.onDeposit ? await latestDeposit(tx, bookingId) : undefined;
      const updated = await changeStatus(tx, booking, to, actor, reason, now, {
        set: { holdExpiresAt: null, ...opts.set },
        deposit,
        arrivedPax: opts.arrivedPax,
      });
      if (deposit) await opts.onDeposit!(tx, deposit);
      return updated;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new BookingError('table_taken', 'That table is now booked by someone else');
    throw err;
  }
}

export async function approveDeposit(db: Db, clubId: string, bookingId: string, actor: Actor, now: Date) {
  return transition(db, clubId, bookingId, ['payment_review', 'awaiting_payment', 'expired'], 'confirmed', actor, now, undefined, {
    onDeposit: async (tx, deposit) => {
      await tx
        .update(deposits)
        .set({ status: 'verified', verifiedBy: actor.id ?? actor.type, verifiedAt: now })
        .where(eq(deposits.id, deposit.id));
    },
  });
}

export async function rejectDeposit(db: Db, clubId: string, bookingId: string, actor: Actor, reason: Reason, now: Date) {
  return transition(db, clubId, bookingId, ['payment_review', 'awaiting_payment', 'expired'], 'rejected', actor, now, reason, {
    onDeposit: async (tx, deposit) => {
      await tx.update(deposits).set({ status: 'rejected', note: reasonText(reason) }).where(eq(deposits.id, deposit.id));
    },
  });
}

/**
 * `opts.deposit` (§6.2 cancel "with or without forfeiting the deposit"): a verified deposit becomes
 * `forfeited` (the club keeps it) or `refunded_manual` (staff refund it outside the system), in the
 * same transaction. Without it the deposit row is left as it was.
 */
export const cancelBooking = (db: Db, clubId: string, id: string, actor: Actor, reason: Reason, now: Date, opts: { deposit?: 'forfeit' | 'refund' } = {}) =>
  transition(db, clubId, id, ['held', 'awaiting_payment', 'payment_review', 'confirmed'], 'cancelled', actor, now, reason, {
    onDeposit: opts.deposit
      ? async (tx, deposit) => {
          if (deposit.status !== 'verified') return;
          await tx
            .update(deposits)
            .set({ status: opts.deposit === 'forfeit' ? 'forfeited' : 'refunded_manual', note: reasonText(reason) })
            .where(eq(deposits.id, deposit.id));
        }
      : undefined,
  });

/** Guest arrived. `arrivedPax` is the actual party size when staff give it (stored in `arrived_pax`). */
export const markArrived = (db: Db, clubId: string, id: string, actor: Actor, now: Date, arrivedPax?: number) =>
  transition(db, clubId, id, ['confirmed'], 'arrived', actor, now, undefined, {
    set: { arrivedAt: now, arrivedPax: arrivedPax ?? null },
    arrivedPax: arrivedPax ?? null,
  });

export const markNoShow = (db: Db, clubId: string, id: string, actor: Actor, now: Date) =>
  transition(db, clubId, id, ['confirmed'], 'no_show', actor, now, undefined, { set: { noShowAt: now } });

/**
 * §7.1 `completed`: an arrived booking whose night is over (the `completion` job, closing time + 2h)
 * or whose POS bill closed. Through `changeStatus` on the caller's `tx`, so history, audit and the
 * `booking.status_changed` event commit with it. Returns null (no change) when the booking is not
 * `arrived`, so the POS path can call it for any matched bill.
 */
export async function completeBookingTx(tx: Db, clubId: string, bookingId: string, actor: Actor, now: Date): Promise<Booking | null> {
  const booking = await tx.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId)) });
  if (!booking || booking.status !== 'arrived') return null;
  return changeStatus(tx, booking, 'completed', actor, undefined, now);
}

export const completeBooking = (db: Db, clubId: string, bookingId: string, actor: Actor, now: Date) =>
  db.transaction((tx) => completeBookingTx(tx as unknown as Db, clubId, bookingId, actor, now));

/** What staff (or the guest, pax only) may change on a booking without a status change (§6.2, §5.3). */
export interface BookingChange {
  pax?: number;
  /** Move to another table and/or night. The booked minimum spend and deposit stay as booked. */
  tableId?: string;
  nightDate?: string;
  /** Staff notes; null clears them. */
  notes?: string | null;
}

/** Statuses whose table, night or party size can still change. */
const CHANGEABLE: BookingStatus[] = ['held', 'awaiting_payment', 'payment_review', 'confirmed'];

/**
 * §6.2 "change table or night, change party size, add notes" and §5.3 [Change party size]. One
 * transaction: the booking update, one audit row with before and after, and one `booking.changed`
 * event per changed field. Party size must fit the (new) table; a move to a taken table is
 * `table_taken` (the one-active-booking index). Notes can change on an arrived booking too.
 */
export async function changeBooking(db: Db, club: Club, bookingId: string, actor: Actor, change: BookingChange, now: Date): Promise<Booking> {
  try {
    return await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const booking = await tx.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, club.id)) });
      if (!booking) throw new BookingError('not_found');
      const onlyNotes = change.pax === undefined && change.tableId === undefined && change.nightDate === undefined;
      const allowed = onlyNotes ? [...CHANGEABLE, 'arrived'] : CHANGEABLE;
      if (!allowed.includes(booking.status)) throw new BookingError('invalid_state', `Cannot change a ${booking.status} booking`);

      const tableId = change.tableId ?? booking.tableId;
      const nightDate = change.nightDate ?? booking.nightDate;
      const pax = change.pax ?? booking.pax;
      const moved = tableId !== booking.tableId || nightDate !== booking.nightDate;
      const table = await tx.query.tables.findFirst({ where: and(eq(tables.id, tableId), eq(tables.clubId, club.id)) });
      if (!table || (moved && !table.active)) throw new BookingError('not_found', 'Table not found');
      if (pax < table.minPax || pax > table.maxPax) throw new BookingError('invalid_state', `This table seats ${table.minPax}–${table.maxPax}`);
      if (moved) {
        if ((await nightStatus(tx, club.id, nightDate)) === 'closed') throw new BookingError('night_not_bookable');
        await expireStaleOnTable(tx, tableId, nightDate, now);
      }

      const set: Partial<typeof bookings.$inferInsert> = { updatedAt: now };
      const fields: string[] = [];
      if (pax !== booking.pax) (set.pax = pax), fields.push('pax');
      if (tableId !== booking.tableId) (set.tableId = tableId), fields.push('table');
      if (nightDate !== booking.nightDate) (set.nightDate = nightDate), fields.push('night');
      if (change.notes !== undefined && (change.notes || null) !== booking.notes) (set.notes = change.notes || null), fields.push('notes');
      if (!fields.length) return booking;

      const [after] = await tx
        .update(bookings)
        .set(set)
        .where(and(eq(bookings.id, booking.id), eq(bookings.clubId, club.id), eq(bookings.status, booking.status)))
        .returning();
      if (!after) throw new BookingError('invalid_state', `Booking ${booking.id} changed while it was being updated`);
      const pick = (b: Booking) => ({ pax: b.pax, tableId: b.tableId, nightDate: b.nightDate, notes: b.notes });
      await audit(tx, club.id, actor, 'booking_changed', booking.id, { fields }, { before: pick(booking), after: pick(after), at: now });
      for (const field of fields) {
        await emit(tx, {
          ...bookingEventBase(after, actor, now),
          type: 'booking.changed',
          props: {
            field,
            from_pax: field === 'pax' ? booking.pax : null,
            to_pax: field === 'pax' ? after.pax : null,
            from_table_id: field === 'table' ? booking.tableId : null,
            from_night: field === 'night' ? booking.nightDate : null,
          },
        });
      }
      if (moved) {
        await syncSoldOut(tx, booking, actor, now); // the night or table it left
        await syncSoldOut(tx, after, actor, now);
      }
      return after;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new BookingError('table_taken', 'That table is already booked that night');
    throw err;
  }
}

/**
 * B10 no-show job: a confirmed booking past its release time becomes `no_show` through
 * `changeStatus` and its table is released with `releaseTable`, in one transaction.
 */
export async function releaseNoShow(db: Db, clubId: string, bookingId: string, actor: Actor, now: Date): Promise<Booking> {
  return db.transaction(async (tx) => {
    const booking = await tx.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId)) });
    if (!booking) throw new BookingError('not_found');
    if (booking.status !== 'confirmed') throw new BookingError('invalid_state', `Cannot release a ${booking.status} booking`);
    const updated = await changeStatus(tx, booking, 'no_show', actor, { code: 'released', text: 'Not arrived by the release time' }, now, {
      set: { noShowAt: now },
    });
    await releaseTable(tx, updated, actor, now);
    return { ...updated, releasedAt: now };
  });
}

/** Minutes a guest may say they are running late (spec §5.2 step 8). */
export const RUNNING_LATE_MINUTES = [15, 30, 60] as const;

/**
 * B10: the guest is running late. Sets `running_late_minutes` on their confirmed booking, with an
 * audit row and a `running_late` event in one transaction. Not a status change.
 */
export async function setRunningLate(db: Db, clubId: string, bookingId: string, actor: Actor, minutes: number, now: Date): Promise<Booking> {
  if (!(RUNNING_LATE_MINUTES as readonly number[]).includes(minutes)) throw new BookingError('invalid_state', 'Unsupported minutes');
  return db.transaction(async (tx) => {
    const booking = await tx.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId)) });
    if (!booking) throw new BookingError('not_found');
    if (booking.status !== 'confirmed') throw new BookingError('invalid_state', `Cannot change a ${booking.status} booking`);
    const [updated] = await tx
      .update(bookings)
      .set({ runningLateMinutes: minutes, updatedAt: now })
      .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId)))
      .returning();
    await audit(tx, clubId, actor, 'running_late', bookingId, { minutes }, {
      before: { runningLateMinutes: booking.runningLateMinutes },
      after: { runningLateMinutes: minutes },
      at: now,
    });
    await emit(tx, { ...bookingEventBase(updated!, actor, now), type: 'running_late', props: { minutes } });
    return updated!;
  });
}

/** Expires the stale holds on one table and night, inside the caller's transaction. */
async function expireStaleOnTable(tx: Db, tableId: string, nightDate: string, now: Date) {
  const stale = await tx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.tableId, tableId),
        eq(bookings.nightDate, nightDate),
        inArray(bookings.status, ['held', 'awaiting_payment']),
        lt(bookings.holdExpiresAt, now),
      ),
    )
    .for('update');
  for (const b of stale) await changeStatus(tx, b, 'expired', SYSTEM, HOLD_EXPIRED, now);
}

/** Holds whose time ran out, each with its history, audit and events, in one transaction. Returns them so the guests can be told. */
export async function expireStaleHolds(db: Db, now: Date): Promise<Booking[]> {
  return db.transaction(async (tx) => {
    const stale = await tx
      .select()
      .from(bookings)
      .where(and(inArray(bookings.status, ['held', 'awaiting_payment']), lt(bookings.holdExpiresAt, now)))
      .for('update');
    const out: Booking[] = [];
    for (const b of stale) out.push(await changeStatus(tx, b, 'expired', SYSTEM, HOLD_EXPIRED, now));
    return out;
  });
}

/**
 * Expires one hold of one club now, through `changeStatus` (B7: the demo fast-forward). The hold
 * time is not checked: the caller decides the hold is over. `undefined` when the booking is not a
 * `held` or `awaiting_payment` booking of `clubId`. Other bookings and clubs are never touched.
 */
export async function expireHold(db: Db, clubId: string, bookingId: string, now: Date): Promise<Booking | undefined> {
  return db.transaction(async (tx) => {
    const [b] = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId), inArray(bookings.status, ['held', 'awaiting_payment'])))
      .for('update');
    if (!b) return undefined;
    return changeStatus(tx, b, 'expired', SYSTEM, HOLD_EXPIRED, now);
  });
}

/**
 * The guest started over: their unfinished bookings at this club become `abandoned`, each through
 * `changeStatus` (B2). `last_step` is the step each one had reached (B4b): `details` for a hold
 * whose form was not submitted, `payment` once it was.
 */
export async function abandonUnfinished(db: Db, clubId: string, guestId: string, now: Date): Promise<Booking[]> {
  return db.transaction(async (tx) => {
    const open = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.clubId, clubId), eq(bookings.guestId, guestId), inArray(bookings.status, ['held', 'awaiting_payment'])))
      .for('update');
    const out: Booking[] = [];
    for (const b of open) {
      const lastStep = b.status === 'held' && !b.rulesAcceptedAt ? 'details' : 'payment';
      out.push(await changeStatus(tx, b, 'abandoned', GUEST, { code: 'guest_abandoned', text: 'Guest started over' }, now, { lastStep }));
    }
    return out;
  });
}

/** Phone, walk-in, promoter or VIP bookings entered by staff. Same availability rules as LINE. */
export async function createManualBooking(
  db: Db,
  club: Club,
  input: {
    tableId: string;
    nightDate: string;
    pax: number;
    name: string;
    phone?: string;
    notes?: string;
    depositPaid: boolean;
    /** §9: `manual_phone` or `manual_walkin` (default `manual`). */
    source?: Extract<BookingSource, 'manual' | 'manual_phone' | 'manual_walkin'>;
    /** An existing guest of this club (a LINE guest booking by phone); otherwise a new guest row is made. */
    guestId?: string;
  },
  actor: Actor,
  now: Date,
): Promise<Booking> {
  const option = (await listTableOptions(db, club.id, input.nightDate)).find((o) => o.table.id === input.tableId);
  if (!option) throw new BookingError('not_found', 'Table not found');
  const existing = input.guestId ? await db.query.guests.findFirst({ where: and(eq(guests.id, input.guestId), eq(guests.clubId, club.id)) }) : undefined;
  if (input.guestId && !existing) throw new BookingError('not_found', 'Guest not found');
  const [guest] = existing
    ? [existing]
    : await db
        .insert(guests)
        .values({ id: newId(), clubId: club.id, name: input.name, phone: input.phone || null, displayName: input.name, isTest: isTestContext({ club }) })
        .returning();
  try {
    return await db.transaction(async (tx) => {
      await expireStaleOnTable(tx, input.tableId, input.nightDate, now);
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
          source: input.source ?? 'manual',
          minSpendSatang: option.minSpendSatang,
          depositSatang: option.depositSatang,
          notes: input.notes || null,
          isTest: isTestContext({ club, guest }),
        })
        .returning();
      let deposit: Deposit | undefined;
      if (input.depositPaid && option.depositSatang > 0) {
        [deposit] = await tx
          .insert(deposits)
          .values({
            id: newId(),
            clubId: club.id,
            bookingId: b!.id,
            amountSatang: option.depositSatang,
            method: 'manual',
            status: 'verified',
            verifiedBy: actor.id ?? actor.type,
            verifiedAt: now,
          })
          .returning();
      }
      const booking = await changeStatus(tx, b!, 'confirmed', actor, undefined, now, { created: true, deposit });
      await emit(tx, { ...bookingEventBase(booking, actor, now), type: 'booking.manual_created', props: { pax: input.pax } });
      return booking;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new BookingError('table_taken', 'That table is already booked for this night');
    throw err;
  }
}

// ---------- Reads ----------

/** The guest's current booking flow: an unfinished hold, or an upcoming booking. */
/**
 * True when the guest already has the club's maximum of active bookings on that night (spec §7.2).
 * Counts bookings with a slip in review, confirmed or arrived; an unfinished one is replaced by a new hold.
 */
export async function guestNightLimitReached(db: Db, club: Club, guestId: string, nightDate: string): Promise<boolean> {
  const max = club.settings.maxBookingsPerGuestPerNight ?? DEFAULT_MAX_BOOKINGS_PER_GUEST_PER_NIGHT;
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.clubId, club.id),
        eq(bookings.guestId, guestId),
        eq(bookings.nightDate, nightDate),
        inArray(bookings.status, ['payment_review', 'confirmed', 'arrived']),
      ),
    );
  return rows.length >= max;
}

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

/** One booking with its table, zone, guest and latest deposit, only when it belongs to `where.clubId`. */
export async function getBookingView(
  db: Db,
  where: { clubId: string; id?: string; refCode?: string },
): Promise<BookingView | undefined> {
  if (!where.id && !where.refCode) return undefined;
  const key = where.id ? eq(bookings.id, where.id) : eq(bookings.refCode, where.refCode!);
  return loadBookingView(db, and(eq(bookings.clubId, where.clubId), key)!);
}

/**
 * The only unscoped booking lookup (`ref_code` is globally unique). Use it only after a signed
 * link was verified (`http/liff.ts` load, `http/media.ts`); take the club from `view.booking.clubId`.
 */
export async function getBookingViewByRef(db: Db, refCode: string): Promise<BookingView | undefined> {
  if (!refCode) return undefined;
  return loadBookingView(db, eq(bookings.refCode, refCode));
}

async function loadBookingView(db: Db, cond: SQL): Promise<BookingView | undefined> {
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
