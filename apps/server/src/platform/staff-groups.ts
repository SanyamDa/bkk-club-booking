import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { STAFF_GROUP_PURPOSES, staffGroups, type Club, type StaffGroup, type StaffGroupPurpose } from '../db/schema.js';

export { STAFF_GROUP_PURPOSES, type StaffGroupPurpose };

export const isStaffGroupPurpose = (v: unknown): v is StaffGroupPurpose =>
  typeof v === 'string' && (STAFF_GROUP_PURPOSES as readonly string[]).includes(v);

/** Alert kinds (spec §6.4) that go to the payments group. Any `payment_*` kind does too. */
const PAYMENT_KINDS = new Set(['payment_review']);
/** Alert kinds about a guest waiting for a person (spec §6.1 "Guest wants a human"). */
const HANDOFF_KINDS = new Set(['guest_wants_human', 'bot_unanswered', 'complaint', 'handoff_realert', 'bot_paused']);
/** Alert kinds about a booking (§6.1 new booking, running late, cancellation, release, daily summary). */
const BOOKING_KINDS = new Set(['booking_confirmed', 'running_late', 'cancellation', 'no_arrival', 'no_show_released', 'guest_unfollowed', 'daily_summary']);

/** The staff-group purpose of an alert kind; `undefined` sends it to the club's main group. */
export function purposeOfAlertKind(kind: string): StaffGroupPurpose | undefined {
  if (PAYMENT_KINDS.has(kind) || kind.startsWith('payment_')) return 'payments';
  if (HANDOFF_KINDS.has(kind)) return 'handoff';
  if (BOOKING_KINDS.has(kind)) return 'bookings';
  return undefined;
}

/**
 * The LINE group a staff message for `purpose` goes to: the club's group linked for that purpose,
 * else the club's main staff group (`clubs.staff_group_id`), else null (nothing is sent).
 */
export async function staffGroupFor(db: Db, club: Club, purpose?: StaffGroupPurpose): Promise<string | null> {
  if (purpose) {
    const [row] = await db
      .select({ lineGroupId: staffGroups.lineGroupId })
      .from(staffGroups)
      .where(and(eq(staffGroups.clubId, club.id), eq(staffGroups.purpose, purpose)))
      .limit(1);
    if (row) return row.lineGroupId;
  }
  return club.staffGroupId ?? null;
}

export async function listStaffGroups(db: Db, clubId: string): Promise<StaffGroup[]> {
  return db.select().from(staffGroups).where(eq(staffGroups.clubId, clubId));
}

/** Removes the club's group for `purpose`; its messages fall back to the main group. Null when none was linked. */
export async function unlinkStaffGroup(db: Db, clubId: string, purpose: StaffGroupPurpose): Promise<StaffGroup | null> {
  const [row] = await db
    .delete(staffGroups)
    .where(and(eq(staffGroups.clubId, clubId), eq(staffGroups.purpose, purpose)))
    .returning();
  return row ?? null;
}
