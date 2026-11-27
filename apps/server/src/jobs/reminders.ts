import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import { emit } from '../data/events.js';
import { bookings, clubs, type Booking, type Club } from '../db/schema.js';
import type { AppContext } from '../http/context.js';
import { addDays, bangkokParts, toDateString } from '../lib/time.js';
import { atNightTime } from './no-show.js';

export const DEFAULT_REMINDER_TIME = '18:00';

/** When the day-of reminder for a night is due (spec §5.2 step 8: club-set, default 18:00). */
export function reminderDueAt(club: Pick<Club, 'settings'>, nightDate: string): Date {
  return atNightTime(club, nightDate, club.settings.reminderTime ?? DEFAULT_REMINDER_TIME);
}

/**
 * Claims the booking's reminder (`reminder_sent_at`, only while null) and emits `reminder.sent`
 * in one transaction. Returns the booking when this call claimed it, so it is sent once only.
 */
async function claimReminder(ctx: AppContext, booking: Booking, now: Date): Promise<Booking | undefined> {
  return ctx.deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(bookings)
      .set({ reminderSentAt: now, updatedAt: now })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'confirmed'), isNull(bookings.reminderSentAt)))
      .returning();
    if (!row) return undefined;
    await emit(tx, {
      clubId: row.clubId,
      type: 'reminder.sent',
      occurredAt: now,
      actorType: 'system',
      dataOrigin: 'first_party',
      bookingId: row.id,
      guestId: row.guestId,
      tableId: row.tableId,
      nightDate: row.nightDate,
      attemptId: row.attemptId ?? undefined,
      props: { kind: 'day_of' },
      isTest: row.isTest,
      dedupeKey: `reminder.sent:day_of:${row.id}`,
    });
    return row;
  });
}

/**
 * The `reminders` job (B10): every confirmed booking whose reminder time has passed and whose
 * arrival time has not gets one reminder push. With `only`, that one booking is reminded now
 * whatever its time (demo fast-forward), still once only. Returns the number sent.
 */
export async function sendDueReminders(ctx: AppContext, now: Date, only?: { clubId: string; bookingId: string }): Promise<number> {
  const db = ctx.deps.db;
  const p = bangkokParts(now);
  const today = toDateString(p.year, p.month, p.day);
  const where = only
    ? and(eq(bookings.id, only.bookingId), eq(bookings.clubId, only.clubId), eq(bookings.status, 'confirmed'), isNull(bookings.reminderSentAt))
    : and(
        eq(bookings.status, 'confirmed'),
        isNull(bookings.reminderSentAt),
        gte(bookings.nightDate, addDays(today, -1)),
        lte(bookings.nightDate, addDays(today, 1)),
      );
  const rows = await db.select({ booking: bookings, club: clubs }).from(bookings).innerJoin(clubs, eq(bookings.clubId, clubs.id)).where(where);
  let sent = 0;
  for (const { booking, club } of rows) {
    if (!only) {
      const arrival = atNightTime(club, booking.nightDate, club.settings.arrivalBy);
      if (reminderDueAt(club, booking.nightDate) > now || now >= arrival) continue;
    }
    const claimed = await claimReminder(ctx, booking, now);
    if (!claimed) continue;
    sent++;
    await ctx.notifier.reminder(claimed);
  }
  return sent;
}

/** Demo fast-forward to the reminder time for one booking. False when nothing was sent. */
export async function remindNow(ctx: AppContext, clubId: string, bookingId: string, now: Date): Promise<boolean> {
  return (await sendDueReminders(ctx, now, { clubId, bookingId })) > 0;
}
