import { createHmac, hkdfSync } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, identityMap } from '../db/schema.js';
import { newId } from '../lib/util.js';

// ---------- Cross-club person (spec §14.4, plan B20) ----------

/**
 * A phone number as E.164, or null when it is too short to be one. Thai local numbers
 * (`0` then 9 or 10 digits) and `66…` without a plus are read as Thai; `+…` and `00…` keep their country code.
 */
export function normalizePhone(phone: string): string | null {
  const trimmed = phone.trim();
  let digits = trimmed.replace(/\D/g, '');
  let international = trimmed.startsWith('+');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (!international) {
    if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) digits = `66${digits.slice(1)}`;
    else if (!(digits.startsWith('66') && digits.length >= 10 && digits.length <= 12)) return digits.length >= 8 ? `+${digits}` : null;
  }
  if (digits.startsWith('660')) digits = `66${digits.slice(3)}`; // "+66 081…": the trunk 0 kept by mistake
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/** The phone-hash key, derived from the credentials key so it lives outside the database. */
export function phoneHashKey(credentialsKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', credentialsKey, Buffer.alloc(0), 'identity_map.phone_hash', 32));
}

/** Keyed hash of the normalised number; null when the number does not normalise. */
export function hashPhone(key: Buffer, phone: string): string | null {
  const e164 = normalizePhone(phone);
  return e164 ? createHmac('sha256', key).update(e164).digest('base64url') : null;
}

/** The platform person of a club's guest, or null when the guest has no link. */
export async function personIdOf(db: Db, clubId: string, guestId: string): Promise<string | null> {
  const [row] = await db
    .select({ personId: identityMap.personId })
    .from(identityMap)
    .where(and(eq(identityMap.clubId, clubId), eq(identityMap.guestId, guestId)))
    .limit(1);
  return row?.personId ?? null;
}

/** Instagram data stays with its club (§14.8): those events never carry a person id. */
const notInstagram = ne(events.dataOrigin, 'instagram');

/** Backfills `events.person_id` on the guest's earlier events in that club. */
async function fillGuestEvents(tx: Db, clubId: string, guestId: string, personId: string): Promise<void> {
  await tx
    .update(events)
    .set({ personId })
    .where(and(eq(events.clubId, clubId), eq(events.guestId, guestId), notInstagram, or(isNull(events.personId), ne(events.personId, personId))));
}

/**
 * Merges persons into one: the person whose first link is earliest keeps its id, and every
 * `identity_map` and `events` row of the others is repointed. Returns the kept id.
 */
async function mergePersons(tx: Db, personIds: string[]): Promise<string> {
  const ids = [...new Set(personIds)];
  if (ids.length === 1) return ids[0]!;
  const firsts = await tx
    .select({ personId: identityMap.personId, first: sql<Date>`min(${identityMap.firstLinkedAt})`.as('first') })
    .from(identityMap)
    .where(inArray(identityMap.personId, ids))
    .groupBy(identityMap.personId)
    .orderBy(asc(sql`first`), asc(identityMap.personId));
  const keep = firsts[0]?.personId ?? ids.sort()[0]!;
  const drop = ids.filter((id) => id !== keep);
  await tx.update(identityMap).set({ personId: keep }).where(inArray(identityMap.personId, drop));
  await tx.update(events).set({ personId: keep }).where(inArray(events.personId, drop));
  return keep;
}

/**
 * Stores the keyed hash of the phone a guest typed in our booking form on the guest's link row
 * (insert or overwrite) and links the person to every other row with that hash, at any club.
 * Returns the guest's person id, or null when the number does not normalise (nothing written).
 */
export async function linkPhone(
  tx: Db,
  input: { clubId: string; guestId: string; phone: string },
  key: Buffer,
  now: Date,
): Promise<{ personId: string } | null> {
  const phoneHash = hashPhone(key, input.phone);
  if (!phoneHash) return null;
  const own = await personIdOf(tx, input.clubId, input.guestId);
  const same = await tx
    .select({ personId: identityMap.personId })
    .from(identityMap)
    .where(eq(identityMap.phoneHash, phoneHash))
    .orderBy(asc(identityMap.firstLinkedAt))
    .limit(1);
  if (own) {
    await tx.update(identityMap).set({ phoneHash }).where(and(eq(identityMap.clubId, input.clubId), eq(identityMap.guestId, input.guestId)));
  } else {
    await tx
      .insert(identityMap)
      .values({ personId: same[0]?.personId ?? newId(), clubId: input.clubId, guestId: input.guestId, phoneHash, firstLinkedAt: now })
      .onConflictDoUpdate({ target: [identityMap.clubId, identityMap.guestId], set: { phoneHash } });
  }
  const persons = await tx.selectDistinct({ personId: identityMap.personId }).from(identityMap).where(eq(identityMap.phoneHash, phoneHash));
  const personId = await mergePersons(tx, persons.map((p) => p.personId));
  await fillGuestEvents(tx, input.clubId, input.guestId, personId);
  return { personId };
}

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
 * `person_id` is reused from any row (any club) with the same sub, else new. When the guest's row
 * already had a person from its phone link (B20), the persons sharing the sub merge (`mergePersons`),
 * and the guest's earlier events get the person id.
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
    if (set) {
      await afterSubLinked(tx, input, set.personId);
      return 'linked';
    }
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
    if (inserted[0]) {
      await afterSubLinked(tx, input, inserted[0].personId);
      return 'linked';
    }
  }
  // A concurrent request stored a pair first: compare with what it stored.
  const [after] = await tx
    .select({ sub: identityMap.platformLineSub })
    .from(identityMap)
    .where(and(eq(identityMap.clubId, input.clubId), eq(identityMap.guestId, input.guestId)))
    .limit(1);
  return after?.sub === input.sub ? 'match' : 'mismatch';
}

/** A sub was just stored: join the persons that share it, then backfill the guest's events. */
async function afterSubLinked(tx: Db, input: { clubId: string; guestId: string; sub: string }, personId: string): Promise<void> {
  const persons = await tx.selectDistinct({ personId: identityMap.personId }).from(identityMap).where(eq(identityMap.platformLineSub, input.sub));
  const keep = await mergePersons(tx, [personId, ...persons.map((p) => p.personId)]);
  await fillGuestEvents(tx, input.clubId, input.guestId, keep);
}
