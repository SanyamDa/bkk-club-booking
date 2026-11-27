import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bookings, clubs, posBills, promoterAttributions, promoters, tables, type Club, type Promoter, type PromoterAttribution } from '../db/schema.js';
import { addDays } from '../lib/time.js';
import { newId } from '../lib/util.js';

/**
 * Promoters (spec §4, §5.1, §14.10, plan A20a). A promoter belongs to one club and has a
 * club-unique code that goes in their link. Which promoter brought a booking is kept in
 * `promoter_attributions`, keyed by booking id. Every function takes the club id and checks
 * every row it touches belongs to that club.
 */

export class PromoterError extends Error {
  constructor(readonly code: 'bad_code' | 'code_taken' | 'not_found' | 'bad_request') {
    super(code);
  }
}

/** Lowercase letters, digits and dashes, 2 to 24 characters, starting with a letter or digit. */
const CODE = /^[a-z0-9][a-z0-9-]{1,23}$/;
/** Bookings that held their table (as in the weekly report). */
const HELD = ['confirmed', 'arrived', 'completed', 'no_show'] as const;
const ARRIVED = new Set(['arrived', 'completed']);

export function normalizeCode(code: string): string {
  const c = code.trim().toLowerCase();
  if (!CODE.test(c)) throw new PromoterError('bad_code');
  return c;
}

/**
 * The promoter's booking link, served by `http/redirect.ts` (B4): the tap is counted, the guest lands
 * in the club's LINE chat with a pre-filled promo text, and the bot attributes the hold (`via: 'link'`).
 */
export function promoterLink(publicUrl: string, club: Pick<Club, 'slug'>, code: string): string {
  return `${publicUrl.replace(/\/$/, '')}/r/p/${encodeURIComponent(club.slug)}/${encodeURIComponent(code)}`;
}

export async function createPromoter(
  db: Db,
  clubId: string,
  input: { name: string; code: string; commissionBps?: number; userId?: string | null },
  now: Date,
): Promise<Promoter> {
  const code = normalizeCode(input.code);
  const name = input.name.trim();
  if (!name) throw new PromoterError('bad_request');
  const taken = await db.query.promoters.findFirst({ where: and(eq(promoters.clubId, clubId), eq(promoters.code, code)) });
  if (taken) throw new PromoterError('code_taken');
  const [row] = await db
    .insert(promoters)
    .values({ id: newId(), clubId, code, name, userId: input.userId ?? null, commissionBps: input.commissionBps ?? 0, createdAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new PromoterError('code_taken');
  return row;
}

export async function getPromoter(db: Db, clubId: string, id: string): Promise<Promoter | undefined> {
  return db.query.promoters.findFirst({ where: and(eq(promoters.clubId, clubId), eq(promoters.id, id)) });
}

/** The club's enabled promoter with this code (any case), if any (B4: the promoter-link text). */
export async function activePromoterByCode(db: Db, clubId: string, code: string): Promise<Promoter | undefined> {
  const found = await db.query.promoters.findFirst({ where: and(eq(promoters.clubId, clubId), eq(promoters.code, code.trim().toLowerCase())) });
  return found && !found.disabledAt ? found : undefined;
}

export async function updatePromoter(
  db: Db,
  clubId: string,
  id: string,
  patch: { name?: string; commissionBps?: number; userId?: string | null; disabled?: boolean },
  now: Date = new Date(),
): Promise<Promoter> {
  const current = await getPromoter(db, clubId, id);
  if (!current) throw new PromoterError('not_found');
  const set: Partial<Promoter> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new PromoterError('bad_request');
    set.name = patch.name.trim();
  }
  if (patch.commissionBps !== undefined) set.commissionBps = patch.commissionBps;
  if (patch.userId !== undefined) set.userId = patch.userId;
  if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? (current.disabledAt ?? now) : null;
  if (Object.keys(set).length === 0) return current;
  const [row] = await db.update(promoters).set(set).where(and(eq(promoters.clubId, clubId), eq(promoters.id, id))).returning();
  return row!;
}

export async function listPromoters(db: Db, clubId: string): Promise<Promoter[]> {
  return db.select().from(promoters).where(eq(promoters.clubId, clubId)).orderBy(asc(promoters.name));
}

/**
 * Attributes a booking to a promoter of the same club. `via: 'link'` (the guest came through the
 * promoter's link; B's bot calls this at the hold) never replaces an existing attribution;
 * `via: 'manual'` (staff) does. A disabled promoter is `not_found`.
 */
export async function attributeBooking(
  db: Db,
  clubId: string,
  bookingId: string,
  who: { promoterId?: string; code?: string },
  via: 'link' | 'manual',
  actorId: string | null,
  now: Date,
): Promise<PromoterAttribution> {
  const booking = await db.query.bookings.findFirst({ where: and(eq(bookings.clubId, clubId), eq(bookings.id, bookingId)) });
  if (!booking) throw new PromoterError('not_found');
  let promoter: Promoter | undefined;
  if (who.promoterId) promoter = await getPromoter(db, clubId, who.promoterId);
  else if (who.code) {
    const code = who.code.trim().toLowerCase();
    promoter = await db.query.promoters.findFirst({ where: and(eq(promoters.clubId, clubId), eq(promoters.code, code)) });
  } else throw new PromoterError('bad_request');
  if (!promoter || promoter.disabledAt) throw new PromoterError('not_found');

  const values = { bookingId, clubId, promoterId: promoter.id, via, attributedBy: actorId, createdAt: now };
  if (via === 'link') {
    await db.insert(promoterAttributions).values(values).onConflictDoNothing();
  } else {
    await db
      .insert(promoterAttributions)
      .values(values)
      .onConflictDoUpdate({ target: promoterAttributions.bookingId, set: { promoterId: promoter.id, via, attributedBy: actorId, createdAt: now } });
  }
  return (await db.query.promoterAttributions.findFirst({ where: eq(promoterAttributions.bookingId, bookingId) }))!;
}

/** Removes a booking's attribution. `not_found` when the booking is not the club's. */
export async function removeAttribution(db: Db, clubId: string, bookingId: string): Promise<void> {
  const booking = await db.query.bookings.findFirst({ where: and(eq(bookings.clubId, clubId), eq(bookings.id, bookingId)) });
  if (!booking) throw new PromoterError('not_found');
  await db.delete(promoterAttributions).where(and(eq(promoterAttributions.clubId, clubId), eq(promoterAttributions.bookingId, bookingId)));
}

export interface PromoterReportRow {
  promoterId: string;
  name: string;
  code: string;
  commissionBps: number;
  /** Bookings that held their table (confirmed, arrived, completed, no-show). */
  bookings: number;
  arrived: number;
  noShows: number;
  pax: number;
  /** POS spend of the arrived bookings (0 without POS data). */
  spendSatang: number;
  /** bps × (POS spend, or the minimum spend without a bill), arrived bookings only. */
  commissionSatang: number;
}

interface AttributedBooking {
  id: string;
  promoterId: string;
  status: string;
  pax: number;
  nightDate: string;
  minSpendSatang: number;
  refCode: string;
  tableId: string;
}

/** Attributed bookings of a club with nights in [from, to], test rows dropped unless the club is a demo. */
async function attributedBookings(db: Db, clubId: string, from: string, to: string, promoterId?: string): Promise<AttributedBooking[]> {
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  if (!club) return [];
  const withTest = club.status === 'demo';
  const rows = await db
    .select({
      id: bookings.id,
      promoterId: promoterAttributions.promoterId,
      status: bookings.status,
      pax: bookings.pax,
      nightDate: bookings.nightDate,
      minSpendSatang: bookings.minSpendSatang,
      refCode: bookings.refCode,
      tableId: bookings.tableId,
      isTest: bookings.isTest,
    })
    .from(promoterAttributions)
    .innerJoin(bookings, eq(bookings.id, promoterAttributions.bookingId))
    .where(
      and(
        eq(promoterAttributions.clubId, clubId),
        eq(bookings.clubId, clubId),
        gte(bookings.nightDate, from),
        lte(bookings.nightDate, to),
        promoterId ? eq(promoterAttributions.promoterId, promoterId) : undefined,
      ),
    )
    .orderBy(desc(bookings.nightDate));
  return rows.filter((r) => withTest || !r.isTest);
}

async function billTotals(db: Db, clubId: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db
    .select({ bookingId: posBills.bookingId, total: posBills.totalSatang })
    .from(posBills)
    .where(and(eq(posBills.clubId, clubId), inArray(posBills.bookingId, ids)));
  for (const r of rows) if (r.bookingId && r.total !== null) out.set(r.bookingId, (out.get(r.bookingId) ?? 0) + r.total);
  return out;
}

/** Per-promoter figures for nights `from`..`to` (YYYY-MM-DD, inclusive), most bookings first. */
export async function promoterReport(db: Db, clubId: string, from: string, to: string): Promise<PromoterReportRow[]> {
  const list = await listPromoters(db, clubId);
  const rows = (await attributedBookings(db, clubId, from, to)).filter((b) => (HELD as readonly string[]).includes(b.status));
  const bills = await billTotals(db, clubId, rows.map((r) => r.id));
  const out = new Map<string, PromoterReportRow>(
    list.map((p) => [
      p.id,
      { promoterId: p.id, name: p.name, code: p.code, commissionBps: p.commissionBps, bookings: 0, arrived: 0, noShows: 0, pax: 0, spendSatang: 0, commissionSatang: 0 },
    ]),
  );
  for (const b of rows) {
    const r = out.get(b.promoterId);
    if (!r) continue;
    r.bookings += 1;
    r.pax += b.pax;
    if (b.status === 'no_show') r.noShows += 1;
    if (ARRIVED.has(b.status)) {
      r.arrived += 1;
      const bill = bills.get(b.id);
      if (bill !== undefined) r.spendSatang += bill;
      r.commissionSatang += Math.round(((bill ?? b.minSpendSatang) * r.commissionBps) / 10_000);
    }
  }
  return [...out.values()].sort((a, b) => b.bookings - a.bookings || b.commissionSatang - a.commissionSatang || a.name.localeCompare(b.name));
}

/** Top three promoters of the week starting `weekStart` (Monday) for the weekly report; null when the club has no promoters. */
export async function topPromoters(
  db: Db,
  clubId: string,
  weekStart: string,
): Promise<{ promoterId: string; name: string; code: string; bookings: number; pax: number }[] | null> {
  const list = await listPromoters(db, clubId);
  if (!list.length) return null;
  const rows = await promoterReport(db, clubId, weekStart, addDays(weekStart, 6));
  return rows
    .filter((r) => r.bookings > 0)
    .slice(0, 3)
    .map(({ promoterId, name, code, bookings: n, pax }) => ({ promoterId, name, code, bookings: n, pax }));
}

/**
 * The promoter's own view (spec §4 "see their bookings and commission"): their bookings from
 * `from` on, with no guest name, phone or LINE data.
 */
export async function promoterOwnBookings(db: Db, clubId: string, promoterId: string, from: string, to: string) {
  const rows = await attributedBookings(db, clubId, from, to, promoterId);
  const tableRows = rows.length
    ? await db.select({ id: tables.id, code: tables.code }).from(tables).where(and(eq(tables.clubId, clubId), inArray(tables.id, [...new Set(rows.map((r) => r.tableId))])))
    : [];
  const codeOf = new Map(tableRows.map((t) => [t.id, t.code]));
  return rows.map((r) => ({ id: r.id, ref: r.refCode, nightDate: r.nightDate, status: r.status, pax: r.pax, tableCode: codeOf.get(r.tableId) ?? null }));
}
