import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clubs, priceRules, tables, zones } from '../db/schema.js';
import { newId } from '../lib/util.js';
import type { VELORA } from './velora-content.js';

/**
 * The one writer of demo club content (plan B0, spec §12.4). Inserts zones, tables, price rules
 * and policies for `clubId`: no history, no brain notes, no status change. A5 calls it for
 * `template: 'velora-like'` inside the club-insert transaction; B7 reuses it for the Velora seed.
 *
 * - The zone base price (Wednesday) goes into the zone price columns, which the booking flow
 *   still reads. Table prices are copied as given (null means the zone's).
 * - Price rules keep their `weekday`; `night_id` stays null (the event night is a weekday rule).
 * - Policies become `clubs.settings.rules` ({ en: [], th: [] }), the house rules guests accept.
 *
 * Pass the transaction handle: callers run it inside `db.transaction` (PGlite hangs on the root
 * db there). Table codes are unique per club, so it is for a club with no tables yet.
 */
export async function applyClubContent(tx: Db, clubId: string, content: typeof VELORA): Promise<void> {
  const zoneIds = new Map<string, string>();
  for (const z of content.zones) zoneIds.set(z.code, `zone_${newId()}`);
  const zoneId = (code: string) => {
    const id = zoneIds.get(code);
    if (!id) throw new Error(`applyClubContent: unknown zone ${code}`);
    return id;
  };

  const tableIds = new Map<string, string>();
  for (const t of content.tables) {
    zoneId(t.zone);
    tableIds.set(t.code, `table_${newId()}`);
  }
  const scopeId = (r: (typeof content.priceRules)[number]): string | null => {
    if (r.scope === 'club') return null;
    if (r.target === null) throw new Error(`applyClubContent: price rule "${r.label}" has no target`);
    if (r.scope === 'zone') return zoneId(r.target);
    const id = tableIds.get(r.target);
    if (!id) throw new Error(`applyClubContent: unknown table ${r.target}`);
    return id;
  };
  const rules = content.priceRules.map((r) => ({
    id: `price_${newId()}`,
    clubId,
    scope: r.scope,
    scopeId: scopeId(r),
    weekday: r.weekday,
    minSpendSatang: r.minSpendSatang,
    depositSatang: r.depositSatang,
    priority: r.priority,
  }));

  const club = await tx.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  if (!club) throw new Error(`applyClubContent: no club ${clubId}`);

  if (content.zones.length > 0) {
    await tx.insert(zones).values(
      content.zones.map((z) => ({ id: zoneId(z.code), clubId, name: z.name_en, nameTh: z.name_th, sort: z.sort, minSpendSatang: z.minSpendSatang, depositSatang: z.depositSatang })),
    );
  }
  if (content.tables.length > 0) {
    await tx.insert(tables).values(
      content.tables.map((t) => ({
        id: tableIds.get(t.code)!,
        clubId,
        zoneId: zoneId(t.zone),
        code: t.code,
        minPax: t.minPax,
        maxPax: t.maxPax,
        sort: t.sort,
        minSpendSatang: t.minSpendSatang,
        depositSatang: t.depositSatang,
        floorX: t.floorX,
        floorY: t.floorY,
        shape: t.shape,
      })),
    );
  }
  if (rules.length > 0) await tx.insert(priceRules).values(rules);

  const rulesText = { en: content.policies.map((p) => p.en), th: content.policies.map((p) => p.th) };
  await tx.update(clubs).set({ settings: { ...club.settings, rules: rulesText } }).where(eq(clubs.id, clubId));
}
