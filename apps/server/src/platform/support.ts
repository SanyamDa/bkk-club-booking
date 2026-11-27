import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog, clubs, platformFlags, supportGrants, type Club, type SupportGrant } from '../db/schema.js';
import { emit } from '../data/events.js';
import { newId } from '../lib/util.js';

/** A support session lasts 60 minutes from its start (spec §12.3). Elevating does not extend it. */
export const SUPPORT_GRANT_MINUTES = 60;

/** `platform_flags` key for the global stop (A5 controls). Value `true` or `{ stopped: true }`. */
export const GLOBAL_STOP_FLAG = 'global_stop';

export class SupportError extends Error {
  constructor(readonly code: 'not_found' | 'ended') {
    super(code);
  }
}

function isTestClub(club: Club): boolean {
  return club.status === 'demo';
}

/**
 * Starts a read-only support session for one club. Writes the grant, an `audit_log` row and the
 * `support.session_started` event in one transaction.
 */
export async function createSupportGrant(
  db: Db,
  input: { userId: string; sessionId?: string; club: Club; reason: string; ticketRef?: string | null; ip?: string },
  now: Date,
): Promise<SupportGrant> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [grant] = await tx
      .insert(supportGrants)
      .values({
        id: newId(),
        userId: input.userId,
        clubId: input.club.id,
        reason: input.reason,
        ticketRef: input.ticketRef ?? null,
        mode: 'read',
        startedAt: now,
        expiresAt: new Date(now.getTime() + SUPPORT_GRANT_MINUTES * 60_000),
        ip: input.ip ?? null,
      })
      .returning();
    await tx.insert(auditLog).values({
      id: newId(),
      clubId: input.club.id,
      actor: 'platform',
      actorType: 'platform',
      actorId: input.userId,
      sessionId: input.sessionId ?? null,
      supportGrantId: grant!.id,
      reason: input.reason,
      ip: input.ip ?? null,
      action: 'support.start',
      entity: 'support_grant',
      entityId: grant!.id,
      data: { mode: 'read', ticketRef: input.ticketRef ?? null },
      at: now,
    });
    await emit(tx, {
      clubId: input.club.id,
      type: 'support.session_started',
      occurredAt: now,
      actorType: 'platform',
      actorId: input.userId,
      dataOrigin: 'first_party',
      props: { supportGrantId: grant!.id, mode: 'read' },
      isTest: isTestClub(input.club),
    });
    return grant!;
  });
}

/** The user's own grant, active and unexpired at `now`. */
async function activeOwnGrant(db: Db, id: string, userId: string, now: Date): Promise<SupportGrant> {
  const [grant] = await db
    .select()
    .from(supportGrants)
    .where(and(eq(supportGrants.id, id), eq(supportGrants.userId, userId)))
    .limit(1);
  if (!grant) throw new SupportError('not_found');
  if (grant.endedAt || grant.expiresAt <= now) throw new SupportError('ended');
  return grant;
}

/** Steps a session up to `write` with a second reason (spec §12.3). The expiry stays the same. */
export async function elevateSupportGrant(
  db: Db,
  input: { id: string; userId: string; sessionId?: string; reason: string; ip?: string },
  now: Date,
): Promise<SupportGrant> {
  const grant = await activeOwnGrant(db, input.id, input.userId, now);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [updated] = await tx.update(supportGrants).set({ mode: 'write' }).where(eq(supportGrants.id, grant.id)).returning();
    await tx.insert(auditLog).values({
      id: newId(),
      clubId: grant.clubId,
      actor: 'platform',
      actorType: 'platform',
      actorId: input.userId,
      sessionId: input.sessionId ?? null,
      supportGrantId: grant.id,
      reason: input.reason,
      ip: input.ip ?? null,
      action: 'support.elevate',
      entity: 'support_grant',
      entityId: grant.id,
      before: { mode: grant.mode },
      after: { mode: 'write' },
      at: now,
    });
    return updated!;
  });
}

/** Ends a session now. Writes `audit_log` and `support.session_ended` in one transaction. */
export async function endSupportGrant(
  db: Db,
  input: { id: string; userId: string; sessionId?: string; ip?: string },
  now: Date,
): Promise<SupportGrant> {
  const grant = await activeOwnGrant(db, input.id, input.userId, now);
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, grant.clubId) });
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [updated] = await tx.update(supportGrants).set({ endedAt: now }).where(eq(supportGrants.id, grant.id)).returning();
    await tx.insert(auditLog).values({
      id: newId(),
      clubId: grant.clubId,
      actor: 'platform',
      actorType: 'platform',
      actorId: input.userId,
      sessionId: input.sessionId ?? null,
      supportGrantId: grant.id,
      reason: grant.reason,
      ip: input.ip ?? null,
      action: 'support.end',
      entity: 'support_grant',
      entityId: grant.id,
      at: now,
    });
    await emit(tx, {
      clubId: grant.clubId,
      type: 'support.session_ended',
      occurredAt: now,
      actorType: 'platform',
      actorId: input.userId,
      dataOrigin: 'first_party',
      props: { supportGrantId: grant.id, mode: grant.mode },
      isTest: club ? isTestClub(club) : false,
    });
    return updated!;
  });
}

/** The user's active, unexpired grants (any club). */
export async function activeGrantsOf(db: Db, userId: string, now: Date): Promise<SupportGrant[]> {
  return db
    .select()
    .from(supportGrants)
    .where(and(eq(supportGrants.userId, userId), isNull(supportGrants.endedAt), gt(supportGrants.expiresAt, now)));
}

/** True when `platform_flags['global_stop']` is set (A5 controls). B3 checks it before any automatic reply. */
export async function isGloballyStopped(db: Db): Promise<boolean> {
  const [row] = await db.select({ value: platformFlags.value }).from(platformFlags).where(eq(platformFlags.key, GLOBAL_STOP_FLAG)).limit(1);
  const v = row?.value as unknown;
  if (v === true) return true;
  return typeof v === 'object' && v !== null && (v as { stopped?: unknown }).stopped === true;
}
