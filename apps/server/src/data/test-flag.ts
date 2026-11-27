import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { guests, platformFlags, type Club, type Guest } from '../db/schema.js';
import { SIM_USER_PREFIX } from '../line/gateway.js';
import { emit } from './events.js';

/**
 * Test-data marking (plan B6, spec §9, §12.4). `guests.is_test` is the source of the flag;
 * bookings and events copy it, and every other table takes it from its guest, booking or club.
 */

/** True when activity in this context is test data: a demo club, or a test guest. */
export function isTestContext({ club, guest }: { club: Club; guest?: Guest | null }): boolean {
  return club.status === 'demo' || Boolean(guest?.isTest);
}

/** `is_test` for a guest row created now: every simulator guest (`SIM-` id) and every guest of a demo club. */
export function isTestGuestAtCreate(club: Club, lineUserId: string | null | undefined): boolean {
  return club.status === 'demo' || Boolean(lineUserId?.startsWith(SIM_USER_PREFIX));
}

// ---------- Tester code (§12.2 live test, §12.3 status table) ----------

export const TESTER_CODE_TTL_MS = 10 * 60_000;
const TESTER_CODE_LENGTH = 8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export const testerCodeKey = (clubId: string) => `tester_code:${clubId}`;

type TesterCodeFlag = { hash: string; expiresAt: string };

function hashCode(clubId: string, code: string): string {
  return createHash('sha256').update(`tester:${clubId}:${code.toUpperCase()}`).digest('hex');
}

function newTesterCode(): string {
  let s = '';
  for (const b of randomBytes(TESTER_CODE_LENGTH)) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

/**
 * Makes a one-time tester code for a club: 8 random characters, 10-minute expiry, single use.
 * Only the hash is stored (`platform_flags['tester_code:<clubId>']`); a new code replaces the
 * previous one. The code is returned once and never logged.
 */
export async function issueTesterCode(db: Db, clubId: string, userId: string, now: Date): Promise<{ code: string; expiresAt: Date }> {
  const code = newTesterCode();
  const expiresAt = new Date(now.getTime() + TESTER_CODE_TTL_MS);
  const value: TesterCodeFlag = { hash: hashCode(clubId, code), expiresAt: expiresAt.toISOString() };
  await db
    .insert(platformFlags)
    .values({ key: testerCodeKey(clubId), value, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({ target: platformFlags.key, set: { value, updatedBy: userId, updatedAt: now } });
  return { code, expiresAt };
}

/**
 * Registers the guest as a tester when `code` is the club's live tester code. Only at a club with
 * `status = 'onboarding'`; at any other club it changes nothing. On success the code is used up,
 * the guest gets `is_test = true`, and the updated guest is returned; otherwise undefined.
 */
export async function redeemTesterCode(db: Db, club: Club, guest: Guest, code: string, now: Date): Promise<Guest | undefined> {
  if (club.status !== 'onboarding') return undefined;
  const key = testerCodeKey(club.id);
  return db.transaction(async (tx) => {
    const flag = await tx.query.platformFlags.findFirst({ where: eq(platformFlags.key, key) });
    const value = flag?.value as TesterCodeFlag | null | undefined;
    if (!value?.hash || !value.expiresAt) return undefined;
    if (new Date(value.expiresAt).getTime() <= now.getTime()) return undefined;
    const given = Buffer.from(hashCode(club.id, code));
    const stored = Buffer.from(value.hash);
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) return undefined;
    // Single use: only the caller that deletes this exact hash wins.
    const used = await tx
      .delete(platformFlags)
      .where(and(eq(platformFlags.key, key), sql`${platformFlags.value}->>'hash' = ${value.hash}`))
      .returning({ key: platformFlags.key });
    if (!used.length) return undefined;
    const [updated] = await tx
      .update(guests)
      .set({ isTest: true, updatedAt: now })
      .where(and(eq(guests.id, guest.id), eq(guests.clubId, club.id)))
      .returning();
    if (!updated) return undefined;
    await emit(tx, {
      clubId: club.id,
      type: 'guest.tester_registered',
      occurredAt: now,
      actorType: 'guest',
      actorId: updated.id,
      channel: 'line',
      dataOrigin: 'line_chat',
      guestId: updated.id,
      isTest: isTestContext({ club, guest: updated }),
    });
    return updated;
  });
}
