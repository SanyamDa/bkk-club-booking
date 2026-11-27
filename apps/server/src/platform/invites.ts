import { createHmac, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clubMemberships, invites, sessions, users, type MembershipRole } from '../db/schema.js';
import { newId } from '../lib/util.js';
import { hashPassword } from './passwords.js';

/** Staff invites (plan A8, spec §4 and §12.3 Onboarding). */

export const INVITE_DAYS = 7;
export const MIN_PASSWORD_LENGTH = 10;
export const INVITE_ROLES = ['owner', 'manager', 'host', 'door', 'promoter'] as const satisfies readonly MembershipRole[];

export type Invite = typeof invites.$inferSelect;

export class InviteError extends Error {
  constructor(public code: 'invalid_invite' | 'weak_password' | 'not_found' | 'last_owner') {
    super(code);
  }
}

/**
 * The stored form of an invite token: HMAC-SHA256 keyed by APP_SECRET (base64url). The link
 * carries the random token; the database holds only this, so a database copy alone cannot
 * produce a working link.
 */
export function inviteTokenHash(secret: string, token: string): string {
  return createHmac('sha256', `invite:${secret}`).update(token).digest('base64url');
}

export const normalEmail = (email: string) => email.trim().toLowerCase();

/** Creates a one-time invite; any earlier pending invite for the same email and club stops working. */
export async function createInvite(
  db: Db,
  secret: string,
  input: { clubId: string; email: string; role: MembershipRole; createdBy: string | null },
  now: Date,
): Promise<{ invite: Invite; token: string }> {
  const email = normalEmail(input.email);
  const token = randomBytes(32).toString('base64url');
  const invite = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx
      .update(invites)
      .set({ expiresAt: now })
      .where(and(eq(invites.clubId, input.clubId), eq(invites.email, email), isNull(invites.acceptedAt), gt(invites.expiresAt, now)));
    const [row] = await tx
      .insert(invites)
      .values({
        id: newId(),
        clubId: input.clubId,
        email,
        role: input.role,
        tokenHash: inviteTokenHash(secret, token),
        expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
        createdBy: input.createdBy,
      })
      .returning();
    return row!;
  });
  return { invite, token };
}

/** The pending (not accepted, not expired) invite for `token`, or undefined. */
export async function pendingInvite(db: Db, secret: string, token: string, now: Date): Promise<Invite | undefined> {
  if (!token || token.length > 200) return undefined;
  const [row] = await db
    .select()
    .from(invites)
    .where(and(eq(invites.tokenHash, inviteTokenHash(secret, token)), isNull(invites.acceptedAt), gt(invites.expiresAt, now)));
  return row;
}

/** Pending invites of a club, ordered by email. */
export async function pendingInvites(db: Db, clubId: string, now: Date): Promise<Invite[]> {
  return db
    .select()
    .from(invites)
    .where(and(eq(invites.clubId, clubId), isNull(invites.acceptedAt), gt(invites.expiresAt, now)))
    .orderBy(asc(invites.email));
}

/** Ends a pending invite of `clubId` (sets `expires_at` to now). Throws `not_found` for another club's or a used invite. */
export async function revokeInvite(db: Db, clubId: string, id: string, now: Date): Promise<Invite> {
  const [row] = await db
    .update(invites)
    .set({ expiresAt: now })
    .where(and(eq(invites.id, id), eq(invites.clubId, clubId), isNull(invites.acceptedAt), gt(invites.expiresAt, now)))
    .returning();
  if (!row) throw new InviteError('not_found');
  return row;
}

/**
 * Accepts an invite in one transaction: claims it (only one caller wins), creates the account when
 * `account` is `{ name, password }`, re-enables an existing account, and adds or updates the
 * membership with the invite's role. The caller has already checked an existing account's password.
 */
export async function acceptInvite(
  db: Db,
  secret: string,
  token: string,
  account: { userId: string } | { name: string; password: string },
  now: Date,
): Promise<{ userId: string; clubId: string; role: MembershipRole; invite: Invite }> {
  if ('password' in account && account.password.length < MIN_PASSWORD_LENGTH) throw new InviteError('weak_password');
  const passwordHash = 'password' in account ? await hashPassword(account.password) : null;
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [invite] = await tx
      .update(invites)
      .set({ acceptedAt: now })
      .where(and(eq(invites.tokenHash, inviteTokenHash(secret, token)), isNull(invites.acceptedAt), gt(invites.expiresAt, now)))
      .returning();
    if (!invite) throw new InviteError('invalid_invite');
    let userId: string;
    if ('userId' in account) {
      userId = account.userId;
      await tx.update(users).set({ disabledAt: null }).where(eq(users.id, userId));
    } else {
      const existing = await tx.query.users.findFirst({ where: eq(sql`lower(${users.email})`, invite.email) });
      if (existing && existing.passwordHash) throw new InviteError('invalid_invite');
      if (existing) {
        userId = existing.id;
        await tx.update(users).set({ passwordHash, name: account.name || existing.name, disabledAt: null }).where(eq(users.id, userId));
      } else {
        userId = newId();
        await tx.insert(users).values({ id: userId, email: invite.email, name: account.name || null, passwordHash, createdAt: now });
      }
    }
    await tx
      .insert(clubMemberships)
      .values({ userId, clubId: invite.clubId, role: invite.role, createdAt: now })
      .onConflictDoUpdate({ target: [clubMemberships.userId, clubMemberships.clubId], set: { role: invite.role } });
    return { userId, clubId: invite.clubId, role: invite.role, invite };
  });
}

/** Members of a club with their account fields. */
export async function listMembers(db: Db, clubId: string) {
  return db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: clubMemberships.role,
      lastLoginAt: users.lastLoginAt,
      since: clubMemberships.createdAt,
    })
    .from(clubMemberships)
    .innerJoin(users, eq(users.id, clubMemberships.userId))
    .where(eq(clubMemberships.clubId, clubId))
    .orderBy(asc(users.email));
}

export async function membershipOf(db: Db, clubId: string, userId: string) {
  const [m] = await db
    .select()
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)));
  return m;
}

async function otherOwners(db: Db, clubId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ userId: clubMemberships.userId })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.role, 'owner'), ne(clubMemberships.userId, userId)));
  return rows.length;
}

/** Sets a member's role. Throws `not_found` (not a member of this club) or `last_owner`. */
export async function setMemberRole(db: Db, clubId: string, userId: string, role: MembershipRole) {
  const m = await membershipOf(db, clubId, userId);
  if (!m) throw new InviteError('not_found');
  if (m.role === 'owner' && role !== 'owner' && (await otherOwners(db, clubId, userId)) === 0) throw new InviteError('last_owner');
  await db
    .update(clubMemberships)
    .set({ role })
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)));
  return { before: m.role, after: role };
}

/** Revokes every live session of `userId`; returns how many. */
export async function revokeUserSessions(db: Db, userId: string, now: Date): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.idHash });
  return rows.length;
}

/**
 * Disables a member of `clubId`: removes this club's membership and revokes all of the person's
 * sessions. When the person belongs to no other club (and is not a platform admin) the account
 * itself is disabled (`users.disabled_at`), so the password stops working. A manager of one club
 * never locks a person out of another club. Throws `not_found` or `last_owner`.
 */
export async function disableMember(
  db: Db,
  clubId: string,
  userId: string,
  now: Date,
): Promise<{ role: MembershipRole; sessionsRevoked: number; accountDisabled: boolean }> {
  const m = await membershipOf(db, clubId, userId);
  if (!m) throw new InviteError('not_found');
  if (m.role === 'owner' && (await otherOwners(db, clubId, userId)) === 0) throw new InviteError('last_owner');
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.delete(clubMemberships).where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)));
    const remaining = await tx.select({ c: clubMemberships.clubId }).from(clubMemberships).where(eq(clubMemberships.userId, userId));
    const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });
    const accountDisabled = remaining.length === 0 && user?.platformRole !== 'admin';
    if (accountDisabled) await tx.update(users).set({ disabledAt: now }).where(eq(users.id, userId));
    const sessionsRevoked = await revokeUserSessions(tx, userId, now);
    return { role: m.role, sessionsRevoked, accountDisabled };
  });
}
