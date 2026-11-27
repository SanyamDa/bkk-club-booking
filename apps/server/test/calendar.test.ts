import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { calendarDays } from '../src/db/schema.js';
import { CALENDAR_SEED } from '../src/data/calendar-seed.js';
import { alcoholBanDates, CalendarDayError, seedCalendarDays, upsertCalendarDay } from '../src/data/calendar.js';
import { setupDb } from './helpers.js';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await setupDb());
});
afterEach(async () => {
  await close();
});

const rowsOn = (date: string) => db.select().from(calendarDays).where(eq(calendarDays.date, date));

describe('calendar days (plan B13)', () => {
  it('Thai public holidays, holy days and alcohol-ban days for 2026-2027 are present', async () => {
    const inserted = await seedCalendarDays(db);
    expect(inserted).toBe(CALENDAR_SEED.length);
    for (const year of ['2026', '2027']) {
      const all = (await db.select().from(calendarDays)).filter((r) => r.date.startsWith(year));
      const kinds = (k: string) => all.filter((r) => r.kind === k);
      expect(kinds('public_holiday').length).toBeGreaterThanOrEqual(15);
      expect(kinds('holy_day').map((r) => r.name).sort()).toEqual(['Asahna Bucha', 'Khao Phansa', 'Makha Bucha', 'Ok Phansa', 'Visakha Bucha']);
      expect(kinds('alcohol_ban')).toHaveLength(5);
    }
    expect((await rowsOn('2026-01-01')).map((r) => r.kind)).toEqual(['public_holiday']);
    expect((await rowsOn('2026-04-13')).map((r) => r.name)).toContain('Songkran');
    expect((await rowsOn('2026-03-03')).map((r) => r.kind).sort()).toEqual(['alcohol_ban', 'holy_day', 'public_holiday']);
    const bans = await alcoholBanDates(db, '2026-07-01', '2026-07-31');
    expect([...bans].sort()).toEqual(['2026-07-29', '2026-07-30']);
  });

  it('upsertCalendarDay adds an election day once; a repeat is a no-op', async () => {
    const input = { date: '2027-03-29', kind: 'election', name: 'General election' };
    await upsertCalendarDay(db, input);
    await upsertCalendarDay(db, input);
    const rows = await rowsOn('2027-03-29');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'election', name: 'General election', notes: null });
    await upsertCalendarDay(db, { ...input, notes: 'Alcohol ban from 18:00 the day before' });
    const [updated] = await db
      .select()
      .from(calendarDays)
      .where(and(eq(calendarDays.date, '2027-03-29'), eq(calendarDays.kind, 'election')));
    expect(updated!.notes).toBe('Alcohol ban from 18:00 the day before');
    expect(await rowsOn('2027-03-29')).toHaveLength(1);
  });

  it('upsertCalendarDay rejects an unknown kind and a bad date', async () => {
    await expect(upsertCalendarDay(db, { date: '2027-03-29', kind: 'party', name: 'x' })).rejects.toBeInstanceOf(CalendarDayError);
    await expect(upsertCalendarDay(db, { date: '29/03/2027', kind: 'election', name: 'x' })).rejects.toBeInstanceOf(CalendarDayError);
    await expect(upsertCalendarDay(db, { date: '2027-02-30', kind: 'election', name: 'x' })).rejects.toBeInstanceOf(CalendarDayError);
    await expect(upsertCalendarDay(db, { date: '2027-03-29', kind: 'election', name: '  ' })).rejects.toBeInstanceOf(CalendarDayError);
    expect(await db.select().from(calendarDays)).toHaveLength(0);
  });

  it('seeding twice inserts nothing the second time', async () => {
    await seedCalendarDays(db);
    await upsertCalendarDay(db, { date: '2026-03-03', kind: 'alcohol_ban', name: 'Makha Bucha', notes: 'checked by hand' });
    expect(await seedCalendarDays(db)).toBe(0);
    expect(await db.select().from(calendarDays)).toHaveLength(CALENDAR_SEED.length);
    const [ban] = await db
      .select()
      .from(calendarDays)
      .where(and(eq(calendarDays.date, '2026-03-03'), eq(calendarDays.kind, 'alcohol_ban')));
    expect(ban!.notes).toBe('checked by hand');
  });

  // Needs B8b's nights job (jobs/nights.ts ensureNights), not landed yet. B8b reads alcoholBanDates.
  it.todo('the next nights job run closes a new alcohol-ban day on rows nobody edited');
});
