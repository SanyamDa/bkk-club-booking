import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approveDeposit,
  availableTables,
  BookingError,
  createManualBooking,
  expireStaleHolds,
  holdTable,
  isNightBookable,
  recordSlip,
  requestDeposit,
  submitDetails,
  upcomingNights,
} from '../src/bookings/service.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupDb>>;
beforeEach(async () => {
  ctx = await setupDb();
});
afterEach(async () => {
  await ctx.close();
});

const details = { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6 };

describe('nights', () => {
  it('only offers open nights inside the booking window', () => {
    const nights = upcomingNights(ctx.club, FRIDAY_AFTERNOON, 4);
    expect(nights).toEqual(['2026-11-27', '2026-11-28', '2026-12-02', '2026-12-03']); // Fri, Sat, Wed, Thu
    expect(isNightBookable(ctx.club, '2026-11-29', FRIDAY_AFTERNOON)).toBe(false); // Sunday: closed
  });

  it('treats 02:00 Saturday as Friday night, and closes same-night booking after 01:00', () => {
    const twoAmSaturday = new Date('2026-11-27T19:00:00Z'); // 02:00 Sat in Bangkok
    expect(isNightBookable(ctx.club, FRIDAY, twoAmSaturday)).toBe(false);
    const halfPastMidnight = new Date('2026-11-27T17:30:00Z'); // 00:30 Sat in Bangkok
    expect(isNightBookable(ctx.club, FRIDAY, halfPastMidnight)).toBe(true);
  });
});

describe('holds', () => {
  it('only lists free tables that fit the party size', async () => {
    const all = await availableTables(ctx.db, ctx.club.id, FRIDAY, { min: 5, max: 8 }, FRIDAY_AFTERNOON);
    expect(all.map((o) => o.table.code)).toEqual(['V1', 'V2', 'B1', 'B2', 'B3', 'B4']);
    const g = await makeGuest(ctx.db);
    await holdTable(ctx.db, ctx.club, { guestId: g.id, tableId: 'table_demo_B1', nightDate: FRIDAY, pax: 6 }, FRIDAY_AFTERNOON);
    const after = await availableTables(ctx.db, ctx.club.id, FRIDAY, { min: 5, max: 8 }, FRIDAY_AFTERNOON);
    expect(after.map((o) => o.table.code)).not.toContain('B1');
  });

  it('never lets two guests hold the same table, even at the same instant', async () => {
    const guestsList = await Promise.all(Array.from({ length: 8 }, () => makeGuest(ctx.db)));
    const results = await Promise.allSettled(
      guestsList.map((g) =>
        holdTable(ctx.db, ctx.club, { guestId: g.id, tableId: 'table_demo_V1', nightDate: FRIDAY, pax: 8 }, FRIDAY_AFTERNOON),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    for (const r of lost) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'table_taken' });
  });

  it('frees the table when a hold expires', async () => {
    const a = await makeGuest(ctx.db);
    const b = await makeGuest(ctx.db);
    await holdTable(ctx.db, ctx.club, { guestId: a.id, tableId: 'table_demo_T1', nightDate: FRIDAY, pax: 2 }, FRIDAY_AFTERNOON);
    const later = new Date(FRIDAY_AFTERNOON.getTime() + 11 * 60_000);
    const held = await holdTable(ctx.db, ctx.club, { guestId: b.id, tableId: 'table_demo_T1', nightDate: FRIDAY, pax: 2 }, later);
    expect(held.guestId).toBe(b.id);
  });

  it('releases a guest’s previous hold when they pick another table', async () => {
    const g = await makeGuest(ctx.db);
    await holdTable(ctx.db, ctx.club, { guestId: g.id, tableId: 'table_demo_T1', nightDate: FRIDAY, pax: 2 }, FRIDAY_AFTERNOON);
    await holdTable(ctx.db, ctx.club, { guestId: g.id, tableId: 'table_demo_T2', nightDate: FRIDAY, pax: 2 }, FRIDAY_AFTERNOON);
    const free = await availableTables(ctx.db, ctx.club.id, FRIDAY, { min: 2, max: 4 }, FRIDAY_AFTERNOON);
    expect(free.map((o) => o.table.code)).toContain('T1');
    expect(free.map((o) => o.table.code)).not.toContain('T2');
  });
});

describe('deposit flow', () => {
  it('goes held → awaiting_payment → payment_review → confirmed', async () => {
    const g = await makeGuest(ctx.db);
    const now = FRIDAY_AFTERNOON;
    const b = await holdTable(ctx.db, ctx.club, { guestId: g.id, tableId: 'table_demo_B2', nightDate: FRIDAY, pax: 6 }, now);
    await expect(requestDeposit(ctx.db, ctx.club, b.id, now)).rejects.toMatchObject({ code: 'details_missing' });
    await submitDetails(ctx.db, ctx.club, b.id, details, now);
    expect((await requestDeposit(ctx.db, ctx.club, b.id, now)).status).toBe('awaiting_payment');
    await recordSlip(ctx.db, ctx.club, b.id, 'uploads/x.jpg', now);
    const confirmed = await approveDeposit(ctx.db, ctx.club.id, b.id, { type: 'staff' }, now);
    expect(confirmed.status).toBe('confirmed');
  });

  it('expires unpaid holds and keeps a late slip for review', async () => {
    const g = await makeGuest(ctx.db);
    const now = FRIDAY_AFTERNOON;
    const b = await holdTable(ctx.db, ctx.club, { guestId: g.id, tableId: 'table_demo_B3', nightDate: FRIDAY, pax: 6 }, now);
    await submitDetails(ctx.db, ctx.club, b.id, details, now);
    await requestDeposit(ctx.db, ctx.club, b.id, now);
    const later = new Date(now.getTime() + 15 * 60_000);
    const expired = await expireStaleHolds(ctx.db, later);
    expect(expired.map((x) => x.id)).toEqual([b.id]);
    const res = await recordSlip(ctx.db, ctx.club, b.id, 'uploads/late.jpg', later);
    expect(res.tableLost).toBe(false); // nobody took it meanwhile, so it goes to review on the same table
  });
});

describe('manual bookings', () => {
  it('block availability exactly like LINE bookings', async () => {
    await createManualBooking(
      ctx.db,
      ctx.club,
      { tableId: 'table_demo_V2', nightDate: FRIDAY, pax: 10, name: 'VIP walk-in', depositPaid: true },
      { type: 'staff' },
      FRIDAY_AFTERNOON,
    );
    const g = await makeGuest(ctx.db);
    await expect(
      holdTable(ctx.db, ctx.club, { guestId: g.id, tableId: 'table_demo_V2', nightDate: FRIDAY, pax: 8 }, FRIDAY_AFTERNOON),
    ).rejects.toBeInstanceOf(BookingError);
  });
});
