import { unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { and, eq, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  alerts,
  bookings,
  conversations,
  deposits,
  events,
  guestNotes,
  guestTags,
  guests,
  handoffEpisodes,
  identityMap,
  messages,
  notices,
  rawWebhooks,
  removalRequests,
  type Club,
  type Guest,
} from '../db/schema.js';
import { newId } from '../lib/util.js';
import { emit } from './events.js';
import { isTestContext } from './test-flag.js';

/** Where slip files live when the caller does not say (`bot/deps.ts` uses `DATA_DIR/uploads`). */
export const defaultUploadsDir = () => join(process.env.DATA_DIR ?? '.data', 'uploads');

/** The notice text version written with a marketing opt-out (spec §5.5). */
export const MARKETING_NOTICE_VERSION = 'marketing-v1';

export class RemovalError extends Error {
  constructor(readonly code: 'not_found') {
    super(code);
    this.name = 'RemovalError';
  }
}

/** Unlinks files under `root`; a missing file or a path outside `root` is skipped, never thrown. */
export async function unlinkUnder(root: string, relPaths: string[]): Promise<void> {
  const base = resolve(root);
  for (const rel of relPaths) {
    const file = resolve(base, rel);
    if (!file.startsWith(base + sep)) continue;
    await unlink(file).catch(() => undefined);
  }
}

/**
 * Removes one guest's personal data (spec §14.9, plan B10b). The `guests` row is anonymised in
 * place, because bookings and messages point at it. Message text, `events.raw`, slip files, identity
 * links, tags, notes and staff alerts about the guest are deleted, and the ids that tie the guest's
 * events together are cleared. Counts (bookings, events per type, snapshots, door counts) stay.
 * Emits no event (the removal job does). Idempotent: a second run clears nothing.
 */
export async function removeGuest(
  db: Db,
  clubId: string,
  guestId: string,
  now: Date,
  uploadsDir: string = defaultUploadsDir(),
): Promise<{ messagesCleared: number; slipsDeleted: number; eventsCleared: number }> {
  const result = await db.transaction(async (tx) => {
    const guest = await tx.query.guests.findFirst({ where: and(eq(guests.id, guestId), eq(guests.clubId, clubId)) });
    if (!guest) throw new RemovalError('not_found');

    const convIds = (
      await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.clubId, clubId), eq(conversations.guestId, guestId)))
    ).map((r) => r.id);
    const bookingIds = (
      await tx.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.clubId, clubId), eq(bookings.guestId, guestId)))
    ).map((r) => r.id);

    // LINE redeliveries hold the guest's user id and text; drop that club's raw copies.
    if (guest.lineUserId) {
      await tx
        .delete(rawWebhooks)
        .where(and(eq(rawWebhooks.clubId, clubId), like(sql`${rawWebhooks.body}::text`, `%${guest.lineUserId}%`)));
    }

    await tx
      .update(guests)
      .set({ lineUserId: null, displayName: null, name: null, phone: null, nationality: null, birthDate: null, externalUserId: null, updatedAt: now })
      .where(eq(guests.id, guestId));

    const cleared = await tx
      .update(messages)
      .set({ payload: { removed: true }, error: null })
      .where(and(eq(messages.clubId, clubId), eq(messages.guestId, guestId), sql`${messages.payload} <> '{"removed":true}'::jsonb`))
      .returning({ id: messages.id });

    const eventScope = convIds.length
      ? or(eq(events.guestId, guestId), inArray(events.conversationId, convIds))!
      : eq(events.guestId, guestId);
    const evs = await tx
      .update(events)
      .set({
        raw: null,
        guestId: null,
        personId: null,
        conversationId: null,
        actorId: sql`case when ${events.actorType} = 'guest' then null else ${events.actorId} end`,
        dedupeKey: sql`case when position(${guestId} in coalesce(${events.dedupeKey}, '')) > 0 then null else ${events.dedupeKey} end`,
      })
      .where(and(eq(events.clubId, clubId), eventScope))
      .returning({ id: events.id });

    await tx.delete(identityMap).where(and(eq(identityMap.clubId, clubId), eq(identityMap.guestId, guestId)));
    await tx.delete(guestTags).where(and(eq(guestTags.clubId, clubId), eq(guestTags.guestId, guestId)));
    await tx.delete(guestNotes).where(and(eq(guestNotes.clubId, clubId), eq(guestNotes.guestId, guestId)));

    const alertScope = [
      ...(convIds.length ? [inArray(alerts.conversationId, convIds)] : []),
      ...(bookingIds.length ? [inArray(alerts.bookingId, bookingIds)] : []),
    ];
    if (alertScope.length) await tx.delete(alerts).where(and(eq(alerts.clubId, clubId), or(...alertScope)));

    let slipPaths: string[] = [];
    if (bookingIds.length) {
      await tx.update(bookings).set({ specialRequest: null, notes: null }).where(and(eq(bookings.clubId, clubId), inArray(bookings.id, bookingIds)));
      const slipScope = and(eq(deposits.clubId, clubId), inArray(deposits.bookingId, bookingIds), isNotNull(deposits.slipPath));
      slipPaths = (await tx.select({ path: deposits.slipPath }).from(deposits).where(slipScope)).map((d) => d.path!);
      if (slipPaths.length) await tx.update(deposits).set({ slipPath: null }).where(slipScope);
    }
    if (convIds.length) {
      await tx.update(conversations).set({ handoffReason: null, state: {} }).where(inArray(conversations.id, convIds));
      await tx.update(handoffEpisodes).set({ reason: null }).where(and(eq(handoffEpisodes.clubId, clubId), inArray(handoffEpisodes.conversationId, convIds)));
    }
    return { messagesCleared: cleared.length, eventsCleared: evs.length, slipPaths };
  });
  // Files go after the commit: a rolled-back removal must not lose a slip the database still names.
  await unlinkUnder(uploadsDir, result.slipPaths);
  return { messagesCleared: result.messagesCleared, slipsDeleted: result.slipPaths.length, eventsCleared: result.eventsCleared };
}

/**
 * The guest asked for removal (menu item or keyword, after one confirm tap). Writes one
 * `removal_requests` row and emits `guest.removal_requested`; false when one is already pending.
 */
export async function requestRemoval(db: Db, club: Club, guest: Guest, now: Date, channel = 'line'): Promise<boolean> {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select({ id: removalRequests.id })
      .from(removalRequests)
      .where(and(eq(removalRequests.clubId, club.id), eq(removalRequests.guestId, guest.id), isNull(removalRequests.completedAt)))
      .limit(1);
    if (pending.length) return false;
    await tx.insert(removalRequests).values({ id: newId(), clubId: club.id, guestId: guest.id, requestedAt: now, channel });
    await emit(tx, {
      clubId: club.id,
      type: 'guest.removal_requested',
      occurredAt: now,
      actorType: 'guest',
      actorId: guest.id,
      channel,
      dataOrigin: 'line_chat',
      guestId: guest.id,
      isTest: isTestContext({ club, guest }),
    });
    return true;
  });
}

/** True when the guest stopped marketing (spec §5.5). Every marketing send checks it; booking reminders do not. */
export async function hasMarketingOptOut(db: Db, clubId: string, guestId: string): Promise<boolean> {
  const rows = await db
    .select({ id: notices.id })
    .from(notices)
    .where(and(eq(notices.clubId, clubId), eq(notices.guestId, guestId), eq(notices.purpose, 'marketing'), isNotNull(notices.withdrawnAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * The guest typed stop or tapped the menu item: a `notices` row with `purpose = 'marketing'` and
 * `withdrawn_at` set, and `marketing.opted_out`. False (nothing written) when already opted out.
 */
export async function recordMarketingOptOut(db: Db, club: Club, guest: Guest, now: Date, channel = 'line'): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (await hasMarketingOptOut(tx, club.id, guest.id)) return false;
    await tx.insert(notices).values({
      id: newId(),
      clubId: club.id,
      guestId: guest.id,
      purpose: 'marketing',
      textVersion: MARKETING_NOTICE_VERSION,
      channel,
      withdrawnAt: now,
    });
    await emit(tx, {
      clubId: club.id,
      type: 'marketing.opted_out',
      occurredAt: now,
      actorType: 'guest',
      actorId: guest.id,
      channel,
      dataOrigin: 'line_chat',
      guestId: guest.id,
      isTest: isTestContext({ club, guest }),
    });
    return true;
  });
}

/**
 * The daily `removal` job: runs `removeGuest` for every pending request, sets `completed_at`, and
 * emits `guest.removed` (no guest id). One failing request is logged and retried next run.
 */
export async function runRemovalRequests(
  db: Db,
  now: Date,
  uploadsDir: string = defaultUploadsDir(),
  log: (msg: string, err?: unknown) => void = () => {},
): Promise<number> {
  const pending = await db
    .select({ id: removalRequests.id, clubId: removalRequests.clubId, guestId: removalRequests.guestId, isTest: guests.isTest })
    .from(removalRequests)
    .innerJoin(guests, eq(guests.id, removalRequests.guestId))
    .where(isNull(removalRequests.completedAt));
  let done = 0;
  for (const r of pending) {
    try {
      await removeGuest(db, r.clubId, r.guestId, now, uploadsDir);
      await db.transaction(async (tx) => {
        await tx.update(removalRequests).set({ completedAt: now, completedBy: 'system:removal' }).where(eq(removalRequests.id, r.id));
        await emit(tx, { clubId: r.clubId, type: 'guest.removed', occurredAt: now, actorType: 'system', dataOrigin: 'first_party', isTest: r.isTest });
      });
      done++;
    } catch (err) {
      log(`Removal request ${r.id} failed`, err);
    }
  }
  return done;
}
