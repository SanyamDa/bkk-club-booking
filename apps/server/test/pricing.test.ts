import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { priceFor, pricesForNight } from '../src/bookings/pricing.js';
import { availableTables, BookingError, holdTable } from '../src/bookings/service.js';
import { nights, priceRules } from '../src/db/schema.js';
import { setPriceRule } from '../src/platform/club-settings.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupDb, setupTwoClubs } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupDb>>;
beforeEach(async () => {
  ctx = await setupDb();
});
afterEach(async () => {
  await ctx.close();
});

// Fixture: B1 is in zone_demo_dj (column price 1,500,000 / 500,000), no table price.
const B1 = 'table_demo_B1';
const DJ = 'zone_demo_dj';
const SATURDAY = '2026-11-28';
let n = 0;
const rule = (r: Partial<typeof priceRules.$inferInsert> & Pick<typeof priceRules.$inferInsert, 'scope' | 'minSpendSatang' | 'depositSatang'>) =>
  ctx.db.insert(priceRules).values({ id: `price_t${n++}`, clubId: ctx.club.id, scopeId: null, priority: 0, ...r });

describe('priceFor', () => {
  it('with no rule the column price is used', async () => {
    expect(await priceFor(ctx.db, ctx.club.id, B1, FRIDAY)).toEqual({ minSpendSatang: 1_500_000, depositSatang: 500_000 });
  });

  it('zone rule overrides column price', async () => {
    await rule({ scope: 'zone', scopeId: DJ, minSpendSatang: 1_800_000, depositSatang: 600_000, priority: 1 });
    expect(await priceFor(ctx.db, ctx.club.id, B1, FRIDAY)).toEqual({ minSpendSatang: 1_800_000, depositSatang: 600_000 });
    // A rule for another zone does not apply.
    await rule({ scope: 'zone', scopeId: 'zone_demo_vip', minSpendSatang: 9_000_000, depositSatang: 9_000_000, priority: 5 });
    expect((await priceFor(ctx.db, ctx.club.id, B1, FRIDAY)).minSpendSatang).toBe(1_800_000);
  });

  it('a table rule beats a zone rule', async () => {
    await rule({ scope: 'zone', scopeId: DJ, minSpendSatang: 1_800_000, depositSatang: 600_000, priority: 1 });
    await rule({ scope: 'table', scopeId: B1, minSpendSatang: 2_000_000, depositSatang: 700_000, priority: 2 });
    expect(await priceFor(ctx.db, ctx.club.id, B1, FRIDAY)).toEqual({ minSpendSatang: 2_000_000, depositSatang: 700_000 });
    expect((await priceFor(ctx.db, ctx.club.id, 'table_demo_B2', FRIDAY)).minSpendSatang).toBe(1_800_000);
  });

  it('an event-night rule (night_id) beats a weekday rule', async () => {
    await ctx.db.insert(nights).values({ id: 'night_sat', clubId: ctx.club.id, date: SATURDAY, status: 'open', eventName: 'Guest DJ' });
    await rule({ scope: 'zone', scopeId: DJ, weekday: 6, minSpendSatang: 2_000_000, depositSatang: 800_000, priority: 11 });
    await rule({ scope: 'club', nightId: 'night_sat', minSpendSatang: 3_000_000, depositSatang: 1_000_000, priority: 20 });
    expect(await priceFor(ctx.db, ctx.club.id, B1, SATURDAY)).toEqual({ minSpendSatang: 3_000_000, depositSatang: 1_000_000 });
    // The weekday rule applies on its weekday only, and the event rule on its night only.
    expect((await priceFor(ctx.db, ctx.club.id, B1, '2026-12-05')).minSpendSatang).toBe(2_000_000);
    expect((await priceFor(ctx.db, ctx.club.id, B1, FRIDAY)).minSpendSatang).toBe(1_500_000);
  });

  it('a rule changed today leaves a past night\'s price as it was', async () => {
    const actor = { type: 'staff' as const, id: 'user_test' };
    const lastWeek = new Date('2026-11-20T08:00:00Z'); // Friday 2026-11-20, 15:00 Bangkok
    await setPriceRule(ctx.db, ctx.club, { scope: 'zone', scopeId: DJ, minSpendSatang: 1_800_000, depositSatang: 600_000 }, actor, lastWeek);
    await setPriceRule(ctx.db, ctx.club, { scope: 'zone', scopeId: DJ, minSpendSatang: 2_200_000, depositSatang: 900_000 }, actor, FRIDAY_AFTERNOON);
    expect(await priceFor(ctx.db, ctx.club.id, B1, '2026-11-26')).toEqual({ minSpendSatang: 1_800_000, depositSatang: 600_000 });
    expect(await priceFor(ctx.db, ctx.club.id, B1, FRIDAY)).toEqual({ minSpendSatang: 2_200_000, depositSatang: 900_000 });
    // Before the first rule began the column price applies.
    expect((await priceFor(ctx.db, ctx.club.id, B1, '2026-11-13')).minSpendSatang).toBe(1_500_000);
  });

  it('refuses a table of another club', async () => {
    const two = await setupTwoClubs();
    try {
      await expect(priceFor(two.db, two.clubB.id, B1, FRIDAY)).rejects.toBeInstanceOf(BookingError);
    } finally {
      await two.close();
    }
  });
});

describe('booking flow prices', () => {
  it('availableTables and holdTable use the night\'s rule price', async () => {
    await rule({ scope: 'zone', scopeId: DJ, weekday: 5, minSpendSatang: 2_500_000, depositSatang: 1_200_000, priority: 11 });
    const options = await availableTables(ctx.db, ctx.club.id, FRIDAY, { min: 5, max: 8 }, FRIDAY_AFTERNOON);
    expect(options.find((o) => o.table.id === B1)).toMatchObject({ minSpendSatang: 2_500_000, depositSatang: 1_200_000 });
    expect((await pricesForNight(ctx.db, ctx.club.id, FRIDAY)).get(B1)).toEqual({ minSpendSatang: 2_500_000, depositSatang: 1_200_000 });
    const g = await makeGuest(ctx.db);
    const b = await holdTable(ctx.db, ctx.club, { guestId: g.id, tableId: B1, nightDate: FRIDAY, pax: 6 }, FRIDAY_AFTERNOON);
    expect(b).toMatchObject({ minSpendSatang: 2_500_000, depositSatang: 1_200_000 });
  });
});
