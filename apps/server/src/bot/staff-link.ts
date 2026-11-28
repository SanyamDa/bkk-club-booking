import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog, clubs, staffGroups, type Club, type StaffGroupPurpose } from '../db/schema.js';
import type { LineGateway } from '../line/gateway.js';
import { newId } from '../lib/util.js';
import * as M from './messages.js';

/** A staff link code lives 10 minutes (spec §13.1 #7). */
export const STAFF_LINK_CODE_TTL_MS = 10 * 60_000;
/** No 0/O/1/I, so a code read off a screen is typed right. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const STAFF_LINK_CODE_LENGTH = 8;

export const hashStaffLinkCode = (code: string) => createHash('sha256').update(`staff-link:${code.toUpperCase()}`).digest('hex');

function newCode(): string {
  let s = '';
  for (const b of randomBytes(STAFF_LINK_CODE_LENGTH)) s += ALPHABET[b % ALPHABET.length];
  return s;
}

/** What a purpose group receives, for the bot's confirmation in the group. */
const PURPOSE_LABEL: Record<StaffGroupPurpose, { en: string; th: string }> = {
  bookings: { en: 'booking', th: 'การจอง' },
  payments: { en: 'payment', th: 'การชำระเงิน' },
  handoff: { en: 'guest chat', th: 'แชทลูกค้า' },
};

/**
 * Makes a fresh single-use staff link code for the club and returns it once. Only its hash and a
 * 10-minute expiry are stored; a new code replaces any earlier unused one. The code is never
 * logged. The caller (the staff route) writes the `audit_log` row with the full actor; `userId`
 * names who asked and is kept for that caller's record. `purpose` (spec §9 `staff_groups`): the
 * code links a group for that purpose only; omitted, it links the club's main staff group.
 */
export async function issueStaffLinkCode(
  db: Db,
  clubId: string,
  userId: string,
  now: Date,
  purpose?: StaffGroupPurpose,
): Promise<{ code: string; expiresAt: Date }> {
  void userId;
  const code = newCode();
  const expiresAt = new Date(now.getTime() + STAFF_LINK_CODE_TTL_MS);
  await db
    .update(clubs)
    .set({ staffLinkCodeHash: hashStaffLinkCode(code), staffLinkCodeExpiresAt: expiresAt, staffLinkCodePurpose: purpose ?? null })
    .where(eq(clubs.id, clubId));
  return { code, expiresAt };
}

export type StaffLinkResult = 'ignored' | 'linked' | 'pending' | 'replaced';

/**
 * `link <code>` typed in a LINE group (plan B5). The code is consumed on first use whatever happens
 * next. A club with no staff group (or this same group) gets it linked at once. A club already
 * linked to another group keeps that group: this group is stored as pending, and a second fresh
 * code typed here completes the replacement, tells the old group, and is audited.
 * A code issued for a purpose links this group as the club's group for that purpose at once
 * (the dashboard login that issued it for that purpose is the check); a group it replaces is told.
 */
export async function handleStaffLink(
  db: Db,
  club: Club,
  gateway: LineGateway,
  input: { groupId: string; code: string; replyToken?: string },
  now: Date,
): Promise<StaffLinkResult> {
  const outcome = await db.transaction(async (tx) => {
    const codeMatches = and(eq(clubs.id, club.id), eq(clubs.staffLinkCodeHash, hashStaffLinkCode(input.code)), gt(clubs.staffLinkCodeExpiresAt, now));
    // The purpose the code was issued for; `.returning()` below gives the row after it is cleared.
    const [issued] = await tx.select({ purpose: clubs.staffLinkCodePurpose }).from(clubs).where(codeMatches);
    const [row] = await tx
      .update(clubs)
      .set({ staffLinkCodeHash: null, staffLinkCodeExpiresAt: null, staffLinkCodePurpose: null })
      .where(codeMatches)
      .returning();
    if (!row) return { result: 'ignored' as const };
    const purpose = issued?.purpose ?? null;
    if (purpose) {
      const [prev] = await tx.select().from(staffGroups).where(and(eq(staffGroups.clubId, club.id), eq(staffGroups.purpose, purpose)));
      await tx
        .insert(staffGroups)
        .values({ id: newId(), clubId: club.id, lineGroupId: input.groupId, purpose, linkedAt: now })
        .onConflictDoUpdate({ target: [staffGroups.clubId, staffGroups.purpose], set: { lineGroupId: input.groupId, linkedAt: now } });
      const old = prev && prev.lineGroupId !== input.groupId ? prev.lineGroupId : undefined;
      await tx
        .insert(auditLog)
        .values(
          old
            ? groupAudit(club.id, 'staff_group.replaced', input.groupId, { purpose, from: old, to: input.groupId }, now)
            : groupAudit(club.id, 'staff_group.linked', input.groupId, { purpose, groupId: input.groupId }, now),
        );
      return { result: old ? ('replaced' as const) : ('linked' as const), old, purpose };
    }
    const old = row.staffGroupId;
    if (!old || old === input.groupId) {
      await tx.update(clubs).set({ staffGroupId: input.groupId, pendingStaffGroupId: null }).where(eq(clubs.id, club.id));
      await tx.insert(auditLog).values(groupAudit(club.id, 'staff_group.linked', input.groupId, { groupId: input.groupId }, now));
      return { result: 'linked' as const };
    }
    if (row.pendingStaffGroupId !== input.groupId) {
      await tx.update(clubs).set({ pendingStaffGroupId: input.groupId }).where(eq(clubs.id, club.id));
      return { result: 'pending' as const };
    }
    await tx.update(clubs).set({ staffGroupId: input.groupId, pendingStaffGroupId: null }).where(eq(clubs.id, club.id));
    await tx.insert(auditLog).values(groupAudit(club.id, 'staff_group.replaced', input.groupId, { from: old, to: input.groupId }, now));
    return { result: 'replaced' as const, old };
  });

  if (outcome.result === 'ignored') return 'ignored';
  const say = async (msg: string) => {
    const msgs = [M.plain(msg)];
    if (input.replyToken) await gateway.reply(input.replyToken, msgs);
    else await gateway.push(input.groupId, msgs);
  };
  if (outcome.result === 'pending') {
    await say(
      `${club.name} booking alerts already go to another LINE group. To move them to this group, a manager presses "Issue link code" on the dashboard's Setup page again and types the new code here within 10 minutes.\nการแจ้งเตือนของ ${club.name} ส่งไปที่กลุ่ม LINE อื่นอยู่แล้ว หากต้องการย้ายมากลุ่มนี้ ผู้จัดการกด "Issue link code" ในหน้า Setup ของแดชบอร์ดอีกครั้ง แล้วพิมพ์รหัสใหม่ในกลุ่มนี้ภายใน 10 นาที`,
    );
    return 'pending';
  }
  const label = 'purpose' in outcome && outcome.purpose ? PURPOSE_LABEL[outcome.purpose] : { en: 'booking', th: 'การจอง' };
  await say(`✅ This group will now receive ${club.name} ${label.en} alerts.\nกลุ่มนี้จะได้รับการแจ้งเตือน${label.th}แล้ว`);
  if (outcome.result === 'replaced' && outcome.old) {
    await gateway.push(outcome.old, [
      M.plain(`${club.name} ${label.en} alerts now go to another LINE group. This group no longer receives them.\nการแจ้งเตือน${label.th}ของ ${club.name} ย้ายไปที่กลุ่ม LINE อื่นแล้ว กลุ่มนี้จะไม่ได้รับอีก`),
    ]);
  }
  return outcome.result;
}

function groupAudit(clubId: string, action: string, entityId: string, data: unknown, now: Date) {
  // The bot cannot tell who typed the code in the group; the dashboard login that issued it is the manager check.
  return { id: newId(), clubId, actor: 'bot', actorType: 'bot' as const, actorId: null, action, entity: 'staff_group', entityId, data, at: now };
}
