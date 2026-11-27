import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { nights, priceRules, tables, zones, type PriceRule, type Table, type Zone } from '../db/schema.js';
import { weekdayOf } from '../lib/time.js';
import { BookingError } from './service.js';

export interface Price {
  minSpendSatang: number;
  depositSatang: number;
}

const SCOPE_RANK = { club: 0, zone: 1, table: 2 } as const;

/** Rules of one club that are in force on `nightDate` (`valid_from`/`valid_to` inclusive, null = open). */
async function rulesInForce(db: Db, clubId: string, nightDate: string): Promise<{ rules: PriceRule[]; nightId: string | null }> {
  const [rules, night] = await Promise.all([
    db
      .select()
      .from(priceRules)
      .where(
        and(
          eq(priceRules.clubId, clubId),
          or(isNull(priceRules.validFrom), lte(priceRules.validFrom, nightDate)),
          or(isNull(priceRules.validTo), gte(priceRules.validTo, nightDate)),
        ),
      ),
    db.query.nights.findFirst({ where: and(eq(nights.clubId, clubId), eq(nights.date, nightDate)), columns: { id: true } }),
  ]);
  return { rules, nightId: night?.id ?? null };
}

/**
 * The price of one table on one night: the highest-`priority` rule matching the table, its zone or
 * the club, the night's weekday or its `nights` row. A tie goes to the more specific scope, then
 * the later `valid_from`. With no rule, the table's price column, else the zone's.
 */
function resolve(rules: PriceRule[], nightId: string | null, weekday: number, table: Table, zone: Zone): Price {
  let best: PriceRule | undefined;
  for (const r of rules) {
    if (r.scope === 'table' && r.scopeId !== table.id) continue;
    if (r.scope === 'zone' && r.scopeId !== zone.id) continue;
    if (r.weekday != null && r.weekday !== weekday) continue;
    if (r.nightId != null && r.nightId !== nightId) continue;
    if (!best || better(r, best)) best = r;
  }
  if (best) return { minSpendSatang: best.minSpendSatang, depositSatang: best.depositSatang };
  return { minSpendSatang: table.minSpendSatang ?? zone.minSpendSatang, depositSatang: table.depositSatang ?? zone.depositSatang };
}

function better(a: PriceRule, b: PriceRule): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (SCOPE_RANK[a.scope] !== SCOPE_RANK[b.scope]) return SCOPE_RANK[a.scope] > SCOPE_RANK[b.scope];
  return (a.validFrom ?? '') > (b.validFrom ?? '');
}

/** Prices every given table for one night with one read of the rules. */
export async function priceTables(db: Db, clubId: string, nightDate: string, rows: { table: Table; zone: Zone }[]): Promise<Map<string, Price>> {
  const { rules, nightId } = await rulesInForce(db, clubId, nightDate);
  const weekday = weekdayOf(nightDate);
  return new Map(rows.map(({ table, zone }) => [table.id, resolve(rules, nightId, weekday, table, zone)]));
}

/** Every table of the club (active or not), priced for one night. */
export async function pricesForNight(db: Db, clubId: string, nightDate: string): Promise<Map<string, Price>> {
  const rows = await db.select({ table: tables, zone: zones }).from(tables).innerJoin(zones, eq(tables.zoneId, zones.id)).where(eq(tables.clubId, clubId));
  return priceTables(db, clubId, nightDate, rows);
}

/** One table's minimum spend and deposit for a night. Throws `not_found` for another club's table. */
export async function priceFor(db: Db, clubId: string, tableId: string, nightDate: string): Promise<Price> {
  const [row] = await db
    .select({ table: tables, zone: zones })
    .from(tables)
    .innerJoin(zones, eq(tables.zoneId, zones.id))
    .where(and(eq(tables.clubId, clubId), eq(tables.id, tableId)));
  if (!row) throw new BookingError('not_found', 'Table not found');
  return (await priceTables(db, clubId, nightDate, [row])).get(tableId)!;
}
