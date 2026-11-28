import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualBooking, markArrived } from '../src/bookings/service.js';
import { bookings, bookingStatusHistory, events } from '../src/db/schema.js';
import { completeAt, completeEndedNights } from '../src/jobs/completion.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupDb } from './helpers.js';

/** §7.1: arrived bookings become `completed` at the club's closing time + 2h. */
const STAFF = { type: 'staff' as const, id: 'user_1' };
let ctx: Awaited<ReturnType<typeof setupDb>>;
beforeEach(async () => {
  ctx = await setupDb();
});
afterEach(async () => {
  await ctx.close();
});

async function arrivedBooking(tableId = 'table_demo_B1') {
  const b = await createManualBooking(ctx.db, ctx.club, { tableId, nightDate: FRIDAY, pax: 4, name: 'Ari', depositPaid: true }, STAFF, FRIDAY_AFTERNOON);
  await markArrived(ctx.db, ctx.club.id, b.id, STAFF, FRIDAY_AFTERNOON, 4);
  return b;
}

describe('completion job (§7.1)', () => {
  it('completes an arrived booking only after closing time + 2h, with history and event', async () => {
    const b = await arrivedBooking();
    const due = completeAt(ctx.club, FRIDAY);
    const close = String(ctx.club.settings.nightEndHour).padStart(2, '0');
    expect(due.toISOString()).toBe(new Date(new Date(`2026-11-28T${close}:00:00+07:00`).getTime() + 2 * 3_600_000).toISOString());

    expect(await completeEndedNights(ctx.db, new Date(due.getTime() - 60_000))).toBe(0);
    expect((await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, b.id) }))!.status).toBe('arrived');

    expect(await completeEndedNights(ctx.db, due)).toBe(1);
    expect((await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, b.id) }))!.status).toBe('completed');
    const history = await ctx.db.select().from(bookingStatusHistory).where(eq(bookingStatusHistory.bookingId, b.id)).orderBy(asc(bookingStatusHistory.at));
    expect(history.at(-1)).toMatchObject({ fromStatus: 'arrived', toStatus: 'completed', actorType: 'system' });
    const ev = await ctx.db.select().from(events).where(and(eq(events.bookingId, b.id), eq(events.type, 'booking.status_changed')));
    expect(ev.map((e) => (e.props as { to: string }).to)).toContain('completed');

    // Running again changes nothing.
    expect(await completeEndedNights(ctx.db, new Date(due.getTime() + 3_600_000))).toBe(0);
  });

  it('leaves confirmed (not arrived) bookings alone', async () => {
    const b = await createManualBooking(ctx.db, ctx.club, { tableId: 'table_demo_B2', nightDate: FRIDAY, pax: 4, name: 'Bo', depositPaid: true }, STAFF, FRIDAY_AFTERNOON);
    await completeEndedNights(ctx.db, new Date(completeAt(ctx.club, FRIDAY).getTime() + 60_000));
    expect((await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, b.id) }))!.status).toBe('confirmed');
  });
});
