import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { identityMap } from '../db/schema.js';
import { newId } from '../lib/util.js';

/**
 * First-use pair of a guest and the `sub` of a shared-channel LIFF ID token (spec §11.1.1, plan B5).
 * With the platform's own LINE Login channel the token's `sub` is our provider's id, not the id the
 * club's webhook sees, so it can't be compared with `guests.line_user_id`. The first verified
 * request for a guest stores the pair; every later request must carry the same sub.
 *
 * - `linked`: no sub was stored for this guest; it is stored now.
 * - `match`: the stored sub equals `sub`.
 * - `mismatch`: another sub is stored for this guest (the caller answers 403 `wrong_user`).
 *
 * `person_id` is reused from any row (any club) with the same sub, else new (B20 builds on it).
 */
export async function linkLiffSub(
  tx: Db,
  input: { clubId: string; guestId: string; sub: string },
  now: Date,
): Promise<'linked' | 'match' | 'mismatch'> {
  const [own] = await tx
    .select()
    .from(identityMap)
    .where(and(eq(identityMap.clubId, input.clubId), eq(identityMap.guestId, input.guestId)))
    .limit(1);
  if (own?.platformLineSub) return own.platformLineSub === input.sub ? 'match' : 'mismatch';

  if (own) {
    // A row from another link (phone hash, B20) without a sub yet: fill the sub only if still empty.
    const [set] = await tx
      .update(identityMap)
      .set({ platformLineSub: input.sub })
      .where(and(eq(identityMap.clubId, input.clubId), eq(identityMap.guestId, input.guestId), isNull(identityMap.platformLineSub)))
      .returning();
    if (set) return 'linked';
  } else {
    const [same] = await tx
      .select({ personId: identityMap.personId })
      .from(identityMap)
      .where(and(eq(identityMap.platformLineSub, input.sub), isNotNull(identityMap.personId)))
      .limit(1);
    const inserted = await tx
      .insert(identityMap)
      .values({ personId: same?.personId ?? newId(), clubId: input.clubId, guestId: input.guestId, platformLineSub: input.sub, firstLinkedAt: now })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) return 'linked';
  }
  // A concurrent request stored a pair first: compare with what it stored.
  const [after] = await tx
    .select({ sub: identityMap.platformLineSub })
    .from(identityMap)
    .where(and(eq(identityMap.clubId, input.clubId), eq(identityMap.guestId, input.guestId)))
    .limit(1);
  return after?.sub === input.sub ? 'match' : 'mismatch';
}
