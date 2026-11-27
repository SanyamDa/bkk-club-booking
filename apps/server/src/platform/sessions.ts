import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, users, type Session, type User } from '../db/schema.js';

export const SESSION_COOKIE = 'sid';
const STAFF_HOURS = 12;
const ADMIN_HOURS = 8;

/** The database stores only sha256(sid). */
export const hashSid = (sid: string): string => createHash('sha256').update(sid).digest('base64url');

/** Staff sessions last 12 hours, platform-admin sessions 8 hours. */
export async function createSession(
  db: Db,
  userId: string,
  meta: { ip?: string; userAgent?: string },
  now: Date,
): Promise<{ sid: string; expiresAt: Date }> {
  const [user] = await db.select({ platformRole: users.platformRole }).from(users).where(eq(users.id, userId));
  if (!user) throw new Error('createSession: unknown user');
  const hours = user.platformRole === 'admin' ? ADMIN_HOURS : STAFF_HOURS;
  const sid = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + hours * 3_600_000);
  await db.insert(sessions).values({
    idHash: hashSid(sid),
    userId,
    createdAt: now,
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  return { sid, expiresAt };
}

export async function loadSession(db: Db, sid: string, now: Date): Promise<{ user: User; session: Session } | null> {
  if (!sid) return null;
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, hashSid(sid)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row || row.user.disabledAt) return null;
  return row;
}

export async function revokeSession(db: Db, sid: string, now: Date): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.idHash, hashSid(sid)), isNull(sessions.revokedAt)));
}
