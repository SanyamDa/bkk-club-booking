import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog, clubCredentials, clubs } from '../db/schema.js';
import { newId } from '../lib/util.js';
import { forgetLineToken } from '../line/tokens.js';
import { CREDENTIALS_KEY_REF, decryptSecret, encryptSecret, last4 } from './crypto.js';

export type CredentialKind = 'line_messaging' | 'line_login' | 'instagram' | 'pos';

/** The field whose last four characters identify a secret object in the console. */
function secretLast4(secret: object): string {
  const s = secret as Record<string, unknown>;
  for (const k of ['channelSecret', 'secret', 'accessToken', 'apiKey', 'token']) {
    if (typeof s[k] === 'string' && s[k]) return last4(s[k] as string);
  }
  return last4(JSON.stringify(secret));
}

/**
 * Encrypts and stores one club secret (one row per club and kind), records an audit row with
 * the before/after `last4` only, and drops the club's cached LINE token so a change applies on
 * the next message. A `line_login` secret with a `liffId` sets `clubs.liff_id` (A4b).
 */
export async function setClubCredential(
  db: Db,
  key: Buffer,
  input: { clubId: string; kind: CredentialKind; secret: object; setBy: string },
  now: Date,
): Promise<{ last4: string; setAt: Date }> {
  const tail = secretLast4(input.secret);
  const ciphertext = encryptSecret(JSON.stringify(input.secret), key);
  await db.transaction(async (tx) => {
    const before = await tx.query.clubCredentials.findFirst({
      where: and(eq(clubCredentials.clubId, input.clubId), eq(clubCredentials.kind, input.kind)),
    });
    const id = before?.id ?? newId();
    await tx
      .insert(clubCredentials)
      .values({ id, clubId: input.clubId, kind: input.kind, ciphertext, keyRef: CREDENTIALS_KEY_REF, last4: tail, setBy: input.setBy, setAt: now })
      .onConflictDoUpdate({
        target: [clubCredentials.clubId, clubCredentials.kind],
        set: { ciphertext, keyRef: CREDENTIALS_KEY_REF, last4: tail, setBy: input.setBy, setAt: now },
      });
    const liffId = (input.secret as { liffId?: unknown }).liffId;
    if (input.kind === 'line_login' && typeof liffId === 'string' && liffId) {
      await tx.update(clubs).set({ liffId }).where(eq(clubs.id, input.clubId));
    }
    await tx.insert(auditLog).values({
      id: newId(),
      clubId: input.clubId,
      actor: 'platform',
      actorType: 'platform',
      actorId: input.setBy,
      action: 'credential.set',
      entity: 'club_credentials',
      entityId: id,
      before: before ? { kind: input.kind, last4: before.last4 } : null,
      after: { kind: input.kind, last4: tail },
      at: now,
    });
  });
  forgetLineToken(input.clubId);
  return { last4: tail, setAt: now };
}

/** What the console may show about a club's secrets: never the secret itself. */
export async function credentialSummary(db: Db, clubId: string): Promise<{ kind: string; last4: string; setBy: string; setAt: Date }[]> {
  const rows = await db.select().from(clubCredentials).where(eq(clubCredentials.clubId, clubId));
  return rows.map((r) => ({ kind: r.kind, last4: r.last4 ?? '', setBy: r.setBy ?? '', setAt: r.setAt }));
}

/** Decrypted secret object of one kind for a club, or null when none is stored. */
export async function readClubCredential<T>(db: Db, key: Buffer, clubId: string, kind: CredentialKind): Promise<T | null> {
  const row = await db.query.clubCredentials.findFirst({
    where: and(eq(clubCredentials.clubId, clubId), eq(clubCredentials.kind, kind)),
  });
  return row ? (JSON.parse(decryptSecret(row.ciphertext, key)) as T) : null;
}
