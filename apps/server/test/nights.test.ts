import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookableNights, cancelBooking, holdTable, nightStatus } from '../src/bookings/service.js';
import * as M from '../src/bot/messages.js';
import { upsertCalendarDay } from '../src/data/calendar.js';
import { clubs, events, nights, tables, type Club } from '../src/db/schema.js';
import { ensureNights, runNightsJob } from '../src/jobs/nights.js';
import { addDays } from '../src/lib/time.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupDb>>;
beforeEach(async () => {
  ctx = await setupDb();
});
afterEach(async () => {
  await ctx.close();
});

const rowFor = async (date: string) =>
  ctx.db.query.nights.findFirst({ where: and(eq(nights.clubId, ctx.club.id), eq(nights.date, date)) });

// The fixture club is open Wed-Sat with a 30-day window; FRIDAY is 2026-11-27.
const SUNDAY = '2026-11-29';
const WEDNESDAY = '2026-12-02';
const THURSDAY = '2026-12-03';

describe('nights (plan B8b)', () => {
  it('job writes a row for every date in the booking window, open and closed', async () => {
    const written = await runNightsJob(ctx.db, FRIDAY_AFTERNOON);
    const window = ctx.club.settings.bookingWindowDays + 1;
    expect(written).toBe(window);
    const rows = await ctx.db.select().from(nights).where(eq(nights.clubId, ctx.club.id));
    expect(rows).toHaveLength(window);
    const dates = rows.map((r) => r.date).sort();
    expect(dates[0]).toBe(FRIDAY);
    expect(dates.at(-1)).toBe(addDays(FRIDAY, ctx.club.settings.bookingWindowDays));
    expect((await rowFor(FRIDAY))!.status).toBe('open');
    expect((await rowFor(SUNDAY))!.status).toBe('closed');
    // A second run writes nothing new.
    expect(await runNightsJob(ctx.db, FRIDAY_AFTERNOON)).toBe(0);
    expect(await nightStatus(ctx.db, ctx.club.id, FRIDAY)).toBe('open');
    expect(await nightStatus(ctx.db, ctx.club.id, SUNDAY)).toBe('closed');
  });

  it('a closed night has a row with closed_reason', async () => {
    const club: Club = { ...ctx.club, settings: { ...ctx.club.settings, closedDates: [WEDNESDAY] } };
    await upsertCalendarDay(ctx.db, { date: THURSDAY, kind: 'alcohol_ban', name: 'Test ban' });
    await ensureNights(ctx.db, club, FRIDAY, 10, FRIDAY_AFTERNOON);
    expect(await rowFor(SUNDAY)).toMatchObject({ status: 'closed', closedReason: 'weekday' });
    expect(await rowFor(WEDNESDAY)).toMatchObject({ status: 'closed', closedReason: 'closed_date' });
    expect(await rowFor(THURSDAY)).toMatchObject({ status: 'closed', closedReason: 'alcohol_ban' });
    expect(await rowFor(FRIDAY)).toMatchObject({ status: 'open', closedReason: null });
  });

  it('a row edited by a person survives the next job run', async () => {
    await runNightsJob(ctx.db, FRIDAY_AFTERNOON);
    // A9's calendar opens a normally-closed Sunday as an event night.
    await ctx.db
      .update(nights)
      .set({ status: 'open', closedReason: null, eventName: 'Sunday Special', editedBy: 'user_staff' })
      .where(and(eq(nights.clubId, ctx.club.id), eq(nights.date, SUNDAY)));
    await runNightsJob(ctx.db, FRIDAY_AFTERNOON);
    expect(await rowFor(SUNDAY)).toMatchObject({ status: 'open', eventName: 'Sunday Special', editedBy: 'user_staff' });
    expect(await nightStatus(ctx.db, ctx.club.id, SUNDAY)).toBe('open');
    expect((await bookableNights(ctx.db, ctx.club, FRIDAY_AFTERNOON, 4)).map((n) => n.date)).toContain(SUNDAY);
  });

  it('a settings change refreshes rows nobody edited', async () => {
    await runNightsJob(ctx.db, FRIDAY_AFTERNOON);
    await ctx.db
      .update(nights)
      .set({ notes: 'DJ confirmed', editedBy: 'user_staff' })
      .where(and(eq(nights.clubId, ctx.club.id), eq(nights.date, WEDNESDAY)));
    // The club stops opening on Wednesdays and Thursdays.
    await ctx.db
      .update(clubs)
      .set({ settings: { ...ctx.club.settings, openWeekdays: [5, 6] } })
      .where(eq(clubs.id, ctx.club.id));
    expect(await runNightsJob(ctx.db, FRIDAY_AFTERNOON)).toBeGreaterThan(0);
    expect(await rowFor(THURSDAY)).toMatchObject({ status: 'closed', closedReason: 'weekday' });
    expect(await rowFor(WEDNESDAY)).toMatchObject({ status: 'open', notes: 'DJ confirmed' });
    expect(await rowFor(FRIDAY)).toMatchObject({ status: 'open' });
  });

  it('taking the last table sets sold_out and emits night.sold_out; a cancellation reopens the night', async () => {
    await runNightsJob(ctx.db, FRIDAY_AFTERNOON);
    // Leave two active tables so the test is short.
    const keep = ['table_demo_T1', 'table_demo_T2'];
    for (const t of await ctx.db.select().from(tables).where(eq(tables.clubId, ctx.club.id))) {
      if (!keep.includes(t.id)) await ctx.db.update(tables).set({ active: false }).where(eq(tables.id, t.id));
    }
    const soldOutEvents = () =>
      ctx.db.select().from(events).where(and(eq(events.type, 'night.sold_out'), eq(events.clubId, ctx.club.id)));

    const g1 = await makeGuest(ctx.db);
    await holdTable(ctx.db, ctx.club, { guestId: g1.id, tableId: keep[0]!, nightDate: FRIDAY, pax: 4 }, FRIDAY_AFTERNOON);
    expect(await nightStatus(ctx.db, ctx.club.id, FRIDAY)).toBe('open');
    expect(await soldOutEvents()).toHaveLength(0);

    const g2 = await makeGuest(ctx.db);
    const last = await holdTable(ctx.db, ctx.club, { guestId: g2.id, tableId: keep[1]!, nightDate: FRIDAY, pax: 4 }, FRIDAY_AFTERNOON);
    expect(await nightStatus(ctx.db, ctx.club.id, FRIDAY)).toBe('sold_out');
    const sold = await soldOutEvents();
    expect(sold).toHaveLength(1);
    expect(sold[0]).toMatchObject({ nightDate: FRIDAY, isTest: true });
    // The job does not reopen a sold-out night.
    await runNightsJob(ctx.db, FRIDAY_AFTERNOON);
    expect(await nightStatus(ctx.db, ctx.club.id, FRIDAY)).toBe('sold_out');

    await cancelBooking(ctx.db, ctx.club.id, last.id, { type: 'staff', id: 'user_staff' }, { code: 'club_cancelled' }, FRIDAY_AFTERNOON);
    expect(await nightStatus(ctx.db, ctx.club.id, FRIDAY)).toBe('open');
    expect(await soldOutEvents()).toHaveLength(1);
  });

  it("an event night's name appears in the guest date list", async () => {
    await runNightsJob(ctx.db, FRIDAY_AFTERNOON);
    await ctx.db
      .update(nights)
      .set({ eventName: 'Techno Saturday', eventType: 'guest_dj', editedBy: 'user_staff' })
      .where(and(eq(nights.clubId, ctx.club.id), eq(nights.date, '2026-11-28')));
    const list = await bookableNights(ctx.db, ctx.club, FRIDAY_AFTERNOON, 4);
    expect(list.find((n) => n.date === '2026-11-28')?.eventName).toBe('Techno Saturday');
    const msg = M.askNight(ctx.club, 'en', list, FRIDAY_AFTERNOON);
    expect(JSON.stringify(msg)).toContain('Techno Saturday');
  });
});
