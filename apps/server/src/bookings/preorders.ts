import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  auditLog,
  bookingPreorders,
  bookings,
  guests,
  menuItems,
  tables,
  type Booking,
  type BookingStatus,
  type Club,
  type MenuItem,
} from '../db/schema.js';
import { emit } from '../data/events.js';
import { currentNightDate } from '../lib/time.js';
import { newId } from '../lib/util.js';
import type { Actor } from './service.js';

/**
 * Bottle pre-orders (plan B22, spec §10 Phase 3). The club's bottle menu is `menu_items`; a line
 * copies the menu price when the item is first ordered, so a later price change never alters it.
 * A pre-order is a note for the bar: not charged, not part of the deposit, not minimum spend.
 */

export const MAX_QTY = 20;
export const MAX_LINES = 20;
/** Booking statuses whose pre-order can still change. */
export const PREORDER_OPEN_STATUSES: BookingStatus[] = ['held', 'awaiting_payment', 'payment_review', 'confirmed'];

export class PreorderError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_state' | 'bad_item' | 'too_many') {
    super(code);
    this.name = 'PreorderError';
  }
}

// ---------- Menu ----------

export async function listMenu(db: Db, clubId: string, opts: { activeOnly?: boolean } = {}): Promise<MenuItem[]> {
  return db
    .select()
    .from(menuItems)
    .where(opts.activeOnly ? and(eq(menuItems.clubId, clubId), eq(menuItems.active, true)) : eq(menuItems.clubId, clubId))
    .orderBy(asc(menuItems.sort), asc(menuItems.name));
}

export interface MenuItemInput {
  name: string;
  nameTh: string;
  priceSatang: number;
  active?: boolean;
  sort?: number;
}

export async function createMenuItem(db: Db, clubId: string, input: MenuItemInput, now: Date): Promise<MenuItem> {
  const [row] = await db
    .insert(menuItems)
    .values({ id: newId(), clubId, name: input.name, nameTh: input.nameTh, priceSatang: input.priceSatang, active: input.active ?? true, sort: input.sort ?? 0, createdAt: now })
    .returning();
  return row!;
}

export async function updateMenuItem(db: Db, clubId: string, id: string, patch: Partial<MenuItemInput>): Promise<MenuItem | undefined> {
  // drizzle writes `set  where` (a syntax error) for an empty patch: return the row unchanged.
  if (!Object.values(patch).some((v) => v !== undefined)) {
    return db.query.menuItems.findFirst({ where: and(eq(menuItems.id, id), eq(menuItems.clubId, clubId)) });
  }
  const [row] = await db
    .update(menuItems)
    .set(patch)
    .where(and(eq(menuItems.id, id), eq(menuItems.clubId, clubId)))
    .returning();
  return row;
}

// ---------- Pre-orders ----------

export interface PreorderLine {
  menuItemId: string;
  name: string;
  nameTh: string;
  qty: number;
  unitPriceSatang: number;
  lineTotalSatang: number;
}

export interface PreorderSummary {
  bookingId: string;
  lines: PreorderLine[];
  totalSatang: number;
}

async function summary(db: Db, clubId: string, bookingId: string): Promise<PreorderSummary> {
  const rows = await db
    .select({ line: bookingPreorders, item: menuItems })
    .from(bookingPreorders)
    .innerJoin(menuItems, eq(menuItems.id, bookingPreorders.menuItemId))
    .where(and(eq(bookingPreorders.clubId, clubId), eq(bookingPreorders.bookingId, bookingId)))
    .orderBy(asc(menuItems.sort), asc(menuItems.name));
  const lines = rows.map(({ line, item }) => ({
    menuItemId: item.id,
    name: item.name,
    nameTh: item.nameTh,
    qty: line.qty,
    unitPriceSatang: line.unitPriceSatang,
    lineTotalSatang: line.qty * line.unitPriceSatang,
  }));
  return { bookingId, lines, totalSatang: lines.reduce((s, l) => s + l.lineTotalSatang, 0) };
}

/** The booking's pre-order. Throws `not_found` when the booking is not this club's. */
export async function getPreorder(db: Db, clubId: string, bookingId: string): Promise<PreorderSummary> {
  const booking = await db.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId)) });
  if (!booking) throw new PreorderError('not_found');
  return summary(db, clubId, bookingId);
}

type Lines = { menuItemId: string; qty: number }[];

/** Replaces the booking's pre-order lines on `tx` (the booking row is locked by the caller). */
async function writeLines(tx: Db, club: Club, booking: Booking, lines: Lines, actor: Actor, now: Date): Promise<void> {
  const merged = new Map<string, number>();
  for (const l of lines) merged.set(l.menuItemId, (merged.get(l.menuItemId) ?? 0) + l.qty);
  if (merged.size > MAX_LINES) throw new PreorderError('too_many');
  for (const qty of merged.values()) {
    if (!Number.isInteger(qty) || qty < 1) throw new PreorderError('bad_item');
    if (qty > MAX_QTY) throw new PreorderError('too_many');
  }
  const ids = [...merged.keys()];
  const items = ids.length
    ? await tx
        .select()
        .from(menuItems)
        .where(and(eq(menuItems.clubId, club.id), inArray(menuItems.id, ids)))
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const existing = await tx
    .select()
    .from(bookingPreorders)
    .where(and(eq(bookingPreorders.clubId, club.id), eq(bookingPreorders.bookingId, booking.id)));
  const oldPrice = new Map(existing.map((l) => [l.menuItemId, l.unitPriceSatang]));
  for (const id of ids) {
    const item = byId.get(id);
    // An item already on the order keeps its line even if it was taken off the menu since.
    if (!item || (!item.active && !oldPrice.has(id))) throw new PreorderError('bad_item');
  }

  await tx.delete(bookingPreorders).where(and(eq(bookingPreorders.clubId, club.id), eq(bookingPreorders.bookingId, booking.id)));
  let total = 0;
  for (const [id, qty] of merged) {
    const unit = oldPrice.get(id) ?? byId.get(id)!.priceSatang;
    total += unit * qty;
    await tx.insert(bookingPreorders).values({ id: newId(), clubId: club.id, bookingId: booking.id, menuItemId: id, qty, unitPriceSatang: unit, createdAt: now });
  }
  const after = [...merged].map(([menuItemId, qty]) => ({ menuItemId, qty }));
  await tx.insert(auditLog).values({
    id: newId(),
    clubId: club.id,
    actor: actor.type,
    actorType: actor.type,
    actorId: actor.id ?? null,
    sessionId: actor.sessionId ?? null,
    supportGrantId: actor.supportGrantId ?? null,
    action: 'preorder_set',
    entity: 'booking',
    entityId: booking.id,
    before: existing.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty })),
    after,
    at: now,
  });
  await emit(tx, {
    clubId: club.id,
    type: 'preorder.placed',
    occurredAt: now,
    actorType: actor.type,
    actorId: actor.id,
    dataOrigin: 'first_party',
    bookingId: booking.id,
    guestId: booking.guestId,
    tableId: booking.tableId,
    nightDate: booking.nightDate,
    attemptId: booking.attemptId ?? undefined,
    isTest: booking.isTest,
    props: { item_count: [...merged.values()].reduce((s, q) => s + q, 0), total_satang: total },
  });
}

/** Locks the booking and checks its pre-order can still change. */
async function lockOpenBooking(tx: Db, club: Club, bookingId: string, now: Date): Promise<Booking> {
  const [booking] = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, club.id)))
    .for('update');
  if (!booking) throw new PreorderError('not_found');
  if (!PREORDER_OPEN_STATUSES.includes(booking.status)) throw new PreorderError('invalid_state');
  if (booking.nightDate < currentNightDate(now, club.settings.nightEndHour)) throw new PreorderError('invalid_state');
  return booking;
}

/** Replaces the booking's pre-order with `lines` (an empty list clears it). */
export async function setPreorder(db: Db, club: Club, bookingId: string, lines: Lines, actor: Actor, now: Date): Promise<PreorderSummary> {
  await db.transaction(async (tx) => {
    const booking = await lockOpenBooking(tx, club, bookingId, now);
    await writeLines(tx, club, booking, lines, actor, now);
  });
  return summary(db, club.id, bookingId);
}

/** Adds `qty` of one item to the booking's pre-order (the bot's [Add 1]). */
export async function addPreorderItem(db: Db, club: Club, bookingId: string, menuItemId: string, qty: number, actor: Actor, now: Date): Promise<PreorderSummary> {
  await db.transaction(async (tx) => {
    const booking = await lockOpenBooking(tx, club, bookingId, now);
    const existing = await tx
      .select({ menuItemId: bookingPreorders.menuItemId, qty: bookingPreorders.qty })
      .from(bookingPreorders)
      .where(and(eq(bookingPreorders.clubId, club.id), eq(bookingPreorders.bookingId, bookingId)));
    await writeLines(tx, club, booking, [...existing, { menuItemId, qty }], actor, now);
  });
  return summary(db, club.id, bookingId);
}

export interface NightPreorder {
  bookingId: string;
  refCode: string;
  status: BookingStatus;
  tableCode: string;
  guestName: string | null;
  preorder: PreorderSummary;
}

/** Every booking of the night with a pre-order, for the bar. Test rows hidden once the club is live. */
export async function preordersForNight(db: Db, club: Club, nightDate: string): Promise<NightPreorder[]> {
  const rows = await db
    .selectDistinct({ booking: bookings, tableCode: tables.code, guestName: guests.name, displayName: guests.displayName })
    .from(bookingPreorders)
    .innerJoin(bookings, eq(bookings.id, bookingPreorders.bookingId))
    .innerJoin(tables, eq(tables.id, bookings.tableId))
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .where(and(eq(bookingPreorders.clubId, club.id), eq(bookings.clubId, club.id), eq(bookings.nightDate, nightDate)))
    .orderBy(asc(tables.code));
  const out: NightPreorder[] = [];
  for (const r of rows) {
    if (club.status === 'live' && r.booking.isTest) continue;
    out.push({
      bookingId: r.booking.id,
      refCode: r.booking.refCode,
      status: r.booking.status,
      tableCode: r.tableCode,
      guestName: r.guestName ?? r.displayName,
      preorder: await summary(db, club.id, r.booking.id),
    });
  }
  return out;
}
