import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { alerts, auditLog, bookings, staffGroups, type Alert, type Booking, type Club } from '../db/schema.js';
import { releaseAt } from '../jobs/no-show.js';
import { newId } from '../lib/util.js';
import { BookingError, releaseNoShow, type Actor } from './service.js';

/**
 * Plan B10c (spec §5.2 step 9): the host prompt "17A not arrived — release table?" [Release]
 * [Keep 30 min]. The prompt is the urgent `no_arrival` alert of the booking; a Keep is an
 * `audit_log` row `release_kept` whose `until` is the new release time. No migration.
 */

export const KEEP_MINUTES = 30;
/** Minutes the host has to answer before an `autoNoShow` club releases the table itself (assumption: the spec gives no window). */
export const DEFAULT_RELEASE_PROMPT_MINUTES = 15;
export const RELEASE_PROMPT_KIND = 'no_arrival';
const KEEP_ACTION = 'release_kept';

/**
 * The newest Keep of the booking: when it was tapped and the release time it set. A Keep counts only
 * while the prompt it answered still exists: a demo reset deletes the prompts of the bookings it
 * reseeds (same ids), so a Keep from an earlier demo (the audit log is kept) does not move tonight's
 * release time.
 */
export async function latestKeep(db: Db, clubId: string, bookingId: string): Promise<{ at: Date; until: Date } | undefined> {
  const [row] = await db
    .select({ at: auditLog.at, data: auditLog.data })
    .from(auditLog)
    .innerJoin(
      alerts,
      and(eq(alerts.id, sql`${auditLog.data}->>'alertId'`), eq(alerts.clubId, clubId), eq(alerts.bookingId, bookingId), eq(alerts.kind, RELEASE_PROMPT_KIND)),
    )
    .where(and(eq(auditLog.clubId, clubId), eq(auditLog.entity, 'booking'), eq(auditLog.entityId, bookingId), eq(auditLog.action, KEEP_ACTION)))
    .orderBy(desc(auditLog.at))
    .limit(1);
  const until = (row?.data as { until?: string } | null)?.until;
  return row && until ? { at: row.at, until: new Date(until) } : undefined;
}

/** The booking's release time: B10's `releaseAt`, moved later by the newest Keep. */
export async function effectiveReleaseAt(db: Db, club: Club, booking: Booking): Promise<Date> {
  const base = releaseAt(club, booking);
  const keep = await latestKeep(db, club.id, booking.id);
  return keep && keep.until > base ? keep.until : base;
}

/** The newest prompt of the booking sent after `since` (the newest Keep), if any, answered or not. */
export async function latestPrompt(db: Db, clubId: string, bookingId: string, since?: Date): Promise<Alert | undefined> {
  const [row] = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.clubId, clubId),
        eq(alerts.bookingId, bookingId),
        eq(alerts.kind, RELEASE_PROMPT_KIND),
        since ? gt(alerts.createdAt, since) : undefined,
      ),
    )
    .orderBy(desc(alerts.createdAt))
    .limit(1);
  return row;
}

/** The newest unanswered prompt of the booking, if any. */
export async function openReleasePrompt(db: Db, clubId: string, bookingId: string): Promise<Alert | undefined> {
  const [row] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.clubId, clubId), eq(alerts.bookingId, bookingId), eq(alerts.kind, RELEASE_PROMPT_KIND), isNull(alerts.resolvedAt)))
    .orderBy(desc(alerts.createdAt))
    .limit(1);
  return row;
}

async function resolvePrompts(db: Db, clubId: string, bookingId: string, now: Date): Promise<void> {
  await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(and(eq(alerts.clubId, clubId), eq(alerts.bookingId, bookingId), eq(alerts.kind, RELEASE_PROMPT_KIND), isNull(alerts.resolvedAt)));
}

/**
 * [Release]: the booking becomes `no_show` and its table is freed (`releaseNoShow`), and its open
 * prompts are answered. Throws `BookingError` when the booking is not a confirmed booking of the club.
 */
export async function releaseFromPrompt(db: Db, clubId: string, bookingId: string, actor: Actor, now: Date): Promise<Booking> {
  const released = await releaseNoShow(db, clubId, bookingId, actor, now);
  await resolvePrompts(db, clubId, bookingId, now);
  return released;
}

/**
 * No answer in time (the job, `autoNoShow` on): in one transaction, locks the booking (as
 * `keepTable` does), checks again that no Keep answered `promptId`, then releases the table and
 * resolves the prompts. `'answered'` when a host kept the table meanwhile; then nothing changes.
 * Throws `BookingError` when the booking is no longer a confirmed booking of the club.
 */
export async function autoReleaseFromPrompt(
  db: Db,
  clubId: string,
  bookingId: string,
  promptId: string,
  actor: Actor,
  now: Date,
): Promise<Booking | 'answered'> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, clubId)))
      .for('update');
    if (!locked) throw new BookingError('not_found');
    if (locked.status !== 'confirmed') throw new BookingError('invalid_state', `Cannot release a ${locked.status} booking`);
    // A Keep is written under the same booking lock, so this sees any Keep tapped before now.
    const [kept] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.clubId, clubId),
          eq(auditLog.entity, 'booking'),
          eq(auditLog.entityId, bookingId),
          eq(auditLog.action, KEEP_ACTION),
          eq(sql`${auditLog.data}->>'alertId'`, promptId),
        ),
      )
      .limit(1);
    if (kept) return 'answered' as const;
    const released = await releaseNoShow(tx, clubId, bookingId, actor, now);
    await resolvePrompts(tx, clubId, bookingId, now);
    return released;
  });
}

/**
 * [Keep 30 min]: answers the prompt (`alertId`, or the newest open one) and moves the release time
 * 30 minutes past the current one (or past now, when that is already behind). One tap extends once:
 * a prompt already answered gives `'answered'` and changes nothing. After `until` the job prompts again.
 */
export async function keepTable(
  db: Db,
  club: Club,
  bookingId: string,
  actor: Actor,
  now: Date,
  alertId?: string,
): Promise<{ until: Date } | 'answered'> {
  return db.transaction(async (tx) => {
    // Lock the booking first, as the job's auto-release does, so a Keep and a release never interleave.
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.clubId, club.id)))
      .for('update');
    if (!booking) throw new BookingError('not_found');
    if (booking.status !== 'confirmed') throw new BookingError('invalid_state', `Cannot keep a ${booking.status} booking`);
    const current = await effectiveReleaseAt(tx, club, booking);
    const extended = current.getTime() + KEEP_MINUTES * 60_000;
    const until = new Date(extended > now.getTime() ? extended : now.getTime() + KEEP_MINUTES * 60_000);
    const promptId = alertId ?? (await openReleasePrompt(tx, club.id, bookingId))?.id;
    if (!promptId) return 'answered' as const;
    const [answered] = await tx
      .update(alerts)
      .set({ resolvedAt: now })
      .where(
        and(
          eq(alerts.id, promptId),
          eq(alerts.clubId, club.id),
          eq(alerts.bookingId, bookingId),
          eq(alerts.kind, RELEASE_PROMPT_KIND),
          isNull(alerts.resolvedAt),
        ),
      )
      .returning({ id: alerts.id });
    if (!answered) return 'answered' as const;
    await tx.insert(auditLog).values({
      id: newId(),
      clubId: club.id,
      actor: actor.type,
      actorType: actor.type,
      actorId: actor.id ?? null,
      sessionId: actor.sessionId ?? null,
      supportGrantId: actor.supportGrantId ?? null,
      action: KEEP_ACTION,
      entity: 'booking',
      entityId: bookingId,
      data: { alertId: answered.id, minutes: KEEP_MINUTES, until: until.toISOString() },
      at: now,
    });
    return { until };
  });
}

/** A LINE group linked to the club (its main staff group or a purpose group, §9 `staff_groups`). */
export async function isClubStaffGroup(db: Db, club: Club, groupId: string): Promise<boolean> {
  if (club.staffGroupId && club.staffGroupId === groupId) return true;
  const [row] = await db
    .select({ id: staffGroups.id })
    .from(staffGroups)
    .where(and(eq(staffGroups.clubId, club.id), eq(staffGroups.lineGroupId, groupId)))
    .limit(1);
  return !!row;
}
