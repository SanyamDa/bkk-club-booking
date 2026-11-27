import { and, eq, isNull, notExists } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog, clubCredentials, clubs, platformFlags } from '../db/schema.js';
import { newId } from '../lib/util.js';
import type { LoginChannel } from '../line/credentials.js';
import { liffEndpointUrl, type LiffEndpointUpdater } from '../line/setup.js';
import { CREDENTIALS_KEY_REF, decryptSecret, encryptSecret, last4 } from './crypto.js';

/**
 * The platform's own LINE Login channel and LIFF app (spec §11.1.1), shared by every club
 * without a login channel of its own. Stored once, encrypted, in platform_flags['line_login'].
 */
const FLAG_KEY = 'line_login';

type StoredFlag = { ciphertext: string; key_ref: string; last4: string; set_by: string; set_at: string; liff_id: string };

async function readFlag(db: Db): Promise<StoredFlag | null> {
  const row = await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, FLAG_KEY) });
  return row?.value ? (row.value as StoredFlag) : null;
}

/**
 * Stores the platform login channel, fills `clubs.liff_id` on every club that has none and no own
 * login channel, and writes an audit row (last4 only). With `liffEndpoint`, it then points the
 * shared LIFF app at `<publicUrl>/liff/details` (A4b: set once, here, never per club in
 * `runLineSetup`). The console route passes `{ publicUrl: config.PUBLIC_URL, update: ctx.updateLiffEndpoint }`.
 * A failed endpoint update throws after the channel is stored; saving again retries it.
 */
export async function setPlatformLoginChannel(
  db: Db,
  key: Buffer,
  input: { channelId: string; channelSecret: string; liffId: string; setBy: string },
  now: Date,
  liffEndpoint?: { publicUrl: string; update: LiffEndpointUpdater },
): Promise<{ last4: string; setAt: Date }> {
  const tail = last4(input.channelSecret);
  const value: StoredFlag = {
    ciphertext: encryptSecret(JSON.stringify({ channelId: input.channelId, channelSecret: input.channelSecret, liffId: input.liffId }), key),
    key_ref: CREDENTIALS_KEY_REF,
    last4: tail,
    set_by: input.setBy,
    set_at: now.toISOString(),
    liff_id: input.liffId,
  };
  await db.transaction(async (tx) => {
    const before = await readFlag(tx as unknown as Db);
    await tx
      .insert(platformFlags)
      .values({ key: FLAG_KEY, value, updatedBy: input.setBy, updatedAt: now })
      .onConflictDoUpdate({ target: platformFlags.key, set: { value, updatedBy: input.setBy, updatedAt: now } });
    // Every club with no LIFF id and no login channel of its own uses the shared LIFF app.
    await tx
      .update(clubs)
      .set({ liffId: input.liffId })
      .where(
        and(
          isNull(clubs.liffId),
          notExists(
            tx
              .select({ id: clubCredentials.id })
              .from(clubCredentials)
              .where(and(eq(clubCredentials.clubId, clubs.id), eq(clubCredentials.kind, 'line_login'))),
          ),
        ),
      );
    await tx.insert(auditLog).values({
      id: newId(),
      clubId: null,
      actor: 'platform',
      actorType: 'platform',
      actorId: input.setBy,
      action: 'platform_login_channel.set',
      entity: 'platform_flags',
      entityId: FLAG_KEY,
      before: before ? { last4: before.last4 } : null,
      after: { last4: tail, liffId: input.liffId },
      at: now,
    });
  });
  if (liffEndpoint) {
    await liffEndpoint.update({ channelId: input.channelId, channelSecret: input.channelSecret }, input.liffId, liffEndpointUrl(liffEndpoint.publicUrl));
  }
  return { last4: tail, setAt: now };
}

export async function platformLoginChannel(db: Db, key: Buffer): Promise<LoginChannel | null> {
  const flag = await readFlag(db);
  if (!flag) return null;
  const plain = JSON.parse(decryptSecret(flag.ciphertext, key)) as { channelId: string; channelSecret: string; liffId: string };
  return { channelId: plain.channelId, channelSecret: plain.channelSecret, liffId: plain.liffId, shared: true };
}

export async function platformLoginSummary(db: Db): Promise<{ liffId: string; last4: string; setBy: string; setAt: Date } | null> {
  const flag = await readFlag(db);
  return flag ? { liffId: flag.liff_id, last4: flag.last4, setBy: flag.set_by, setAt: new Date(flag.set_at) } : null;
}
