import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { clubs, priceRules, tables, zones } from '../src/db/schema.js';
import { applyClubContent } from '../src/demo/apply-content.js';
import { VELORA } from '../src/demo/velora-content.js';
import { setupTwoClubs } from './helpers.js';

/** Task B0 (last step): the one writer of club content. B7 (Velora seed) and A5 ('velora-like') reuse it. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const NEW_CLUB = 'club_apply_content';

/**
 * setupTwoClubs().clubB already has tables V1, V2, S1, S2, which Velora also uses (codes are
 * unique per club), so the content goes into a new club cloned from clubB's settings, and clubB
 * is checked to be untouched.
 */
async function setup() {
  const s = await setupTwoClubs();
  close = s.close;
  await s.db.insert(clubs).values({ id: NEW_CLUB, slug: 'apply-content', name: 'Apply Content', settings: { ...s.clubB.settings, refPrefix: 'AC' }, status: 'onboarding' });
  return s;
}

describe('applyClubContent', () => {
  it('applyClubContent writes tables and prices for a new club id', async () => {
    const s = await setup();
    const before = { zones: await s.db.select().from(zones).where(eq(zones.clubId, s.clubB.id)), tables: await s.db.select().from(tables).where(eq(tables.clubId, s.clubB.id)) };
    await s.db.transaction(async (tx) => applyClubContent(tx as unknown as Db, NEW_CLUB, VELORA));

    const zs = await s.db.select().from(zones).where(eq(zones.clubId, NEW_CLUB));
    expect(zs).toHaveLength(VELORA.zones.length);
    for (const z of VELORA.zones) {
      const row = zs.find((r) => r.name === z.name_en)!;
      expect(row, z.code).toBeDefined();
      // The zone base price (Wednesday) sits in the zone price columns the booking flow reads.
      expect(row).toMatchObject({ nameTh: z.name_th, sort: z.sort, minSpendSatang: z.minSpendSatang, depositSatang: z.depositSatang });
    }

    const ts = await s.db.select().from(tables).where(eq(tables.clubId, NEW_CLUB));
    expect(ts.map((t) => t.code).sort()).toEqual(VELORA.tables.map((t) => t.code).sort());
    for (const t of VELORA.tables) {
      const row = ts.find((r) => r.code === t.code)!;
      const zone = zs.find((z) => z.name === VELORA.zones.find((vz) => vz.code === t.zone)!.name_en)!;
      expect(row).toMatchObject({ zoneId: zone.id, minPax: t.minPax, maxPax: t.maxPax, floorX: t.floorX, floorY: t.floorY, shape: t.shape, sort: t.sort, active: true, minSpendSatang: t.minSpendSatang, depositSatang: t.depositSatang });
    }

    const rules = await s.db.select().from(priceRules).where(eq(priceRules.clubId, NEW_CLUB));
    expect(rules).toHaveLength(VELORA.priceRules.length);
    for (const r of VELORA.priceRules) {
      const scopeId = r.scope === 'zone' ? zs.find((z) => z.name === VELORA.zones.find((vz) => vz.code === r.target)!.name_en)!.id : r.scope === 'table' ? ts.find((t) => t.code === r.target)!.id : null;
      expect(rules, r.label).toContainEqual(expect.objectContaining({ scope: r.scope, scopeId, weekday: r.weekday, nightId: null, minSpendSatang: r.minSpendSatang, depositSatang: r.depositSatang, priority: r.priority }));
    }

    const club = (await s.db.query.clubs.findFirst({ where: eq(clubs.id, NEW_CLUB) }))!;
    expect(club.settings.rules).toEqual({ en: VELORA.policies.map((p) => p.en), th: VELORA.policies.map((p) => p.th) });
    // No status change.
    expect(club.status).toBe('onboarding');

    // Other clubs are untouched.
    expect(await s.db.select().from(zones).where(eq(zones.clubId, s.clubB.id))).toEqual(before.zones);
    expect(await s.db.select().from(tables).where(eq(tables.clubId, s.clubB.id))).toEqual(before.tables);
    expect(await s.db.select().from(priceRules).where(eq(priceRules.clubId, s.clubB.id))).toHaveLength(0);
  });

  it('rejects a table whose zone is not in the content', async () => {
    const s = await setup();
    const bad = { ...VELORA, tables: [{ ...VELORA.tables[0]!, zone: 'NOPE' }] };
    await expect(s.db.transaction(async (tx) => applyClubContent(tx as unknown as Db, NEW_CLUB, bad))).rejects.toThrow(/NOPE/);
    expect(await s.db.select().from(zones).where(eq(zones.clubId, NEW_CLUB))).toHaveLength(0);
  });
});
