import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { hasMarketingOptOut } from '../data/removal.js';
import { emit } from '../data/events.js';
import { bookings, clubs, guests, platformFlags, type Club } from '../db/schema.js';
import type { AppContext } from '../http/context.js';
import { addDays, bangkokParts, toDateString } from '../lib/time.js';
import { lastKnownQuota } from '../platform/line-probe.js';

/** Bangkok hour on the day after the night when the message goes out. */
export const AFTER_VISIT_HOUR = 14;
/** The optional message is skipped once this share of the club's LINE push quota is used, so it never crowds out booking messages. */
export const AFTER_VISIT_QUOTA_SHARE = 0.9;

/** When the after-visit message for a night is due: the next day at 14:00 Bangkok. */
export function afterVisitDueAt(nightDate: string): Date {
  const [y, m, d] = addDays(nightDate, 1).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, AFTER_VISIT_HOUR - 7, 0));
}

async function quotaLeft(ctx: AppContext, club: Club): Promise<boolean> {
  const q = await lastKnownQuota(ctx.deps.db, club.id);
  return !q || q.limit <= 0 || q.used < q.limit * AFTER_VISIT_QUOTA_SHARE;
}

/**
 * The `after-visit` job (§5.2 step 10): for clubs with `afterVisitMessage` on, each guest who arrived
 * the night before gets one "Thanks for coming" [Book again] push from 14:00 the next day, until the
 * end of that day. Skipped for a guest who opted out of marketing, has no LINE or blocked the club,
 * a test booking at a real club, and when the club's push quota is nearly used up. Claimed once per
 * booking (`platform_flags['after_visit:<id>']`) with a `reminder.sent` (kind `after_visit`) event.
 * Returns the number sent.
 */
export async function sendAfterVisitMessages(ctx: AppContext, now: Date): Promise<number> {
  const db = ctx.deps.db;
  const p = bangkokParts(now);
  const today = toDateString(p.year, p.month, p.day);
  const yesterday = addDays(today, -1);
  const rows = await db
    .select({ booking: bookings, club: clubs, guest: guests })
    .from(bookings)
    .innerJoin(clubs, eq(bookings.clubId, clubs.id))
    .innerJoin(guests, eq(bookings.guestId, guests.id))
    .where(and(inArray(bookings.status, ['arrived', 'completed']), gte(bookings.nightDate, yesterday), lte(bookings.nightDate, yesterday)));
  let sent = 0;
  const quota = new Map<string, boolean>();
  for (const { booking, club, guest } of rows) {
    if (club.settings.afterVisitMessage !== true) continue;
    if (afterVisitDueAt(booking.nightDate) > now) continue;
    if (!guest.lineUserId || guest.unfollowedAt) continue;
    if (booking.isTest && club.status !== 'demo') continue;
    if (await hasMarketingOptOut(db, club.id, guest.id)) continue;
    if (!quota.has(club.id)) quota.set(club.id, await quotaLeft(ctx, club));
    if (!quota.get(club.id)) continue;
    const claimed = await db.transaction(async (tx) => {
      const [flag] = await tx
        .insert(platformFlags)
        .values({ key: `after_visit:${booking.id}`, value: { at: now.toISOString() }, updatedBy: 'system', updatedAt: now })
        .onConflictDoNothing()
        .returning({ key: platformFlags.key });
      if (!flag) return false;
      await emit(tx, {
        clubId: club.id,
        type: 'reminder.sent',
        occurredAt: now,
        actorType: 'system',
        dataOrigin: 'first_party',
        bookingId: booking.id,
        guestId: guest.id,
        tableId: booking.tableId,
        nightDate: booking.nightDate,
        props: { kind: 'after_visit' },
        isTest: booking.isTest,
        dedupeKey: `reminder.sent:after_visit:${booking.id}`,
      });
      return true;
    });
    if (!claimed) continue;
    sent++;
    await ctx.notifier.afterVisit(booking);
  }
  return sent;
}
