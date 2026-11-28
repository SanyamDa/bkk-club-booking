import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Actor } from '../bookings/service.js';
import { emit } from '../data/events.js';
import { isTestContext } from '../data/test-flag.js';
import type { Db } from '../db/client.js';
import { alerts, channels, clubs, conversations, guests, handoffEpisodes, messages, type Guest, type HandoffEpisode } from '../db/schema.js';
import type { GatewayRegistry, Message } from '../line/gateway.js';
import type { Outbox } from '../line/outbox.js';
import { newId } from '../lib/util.js';

/**
 * Handoff episodes (plan B14b, spec §6.3, §8.3, §8.7 item 3). One `handoff_episodes` row per
 * takeover, from the moment a person takes the chat until a host resolves it or the timeout job
 * hands it back to the bot. This file is the only writer of `conversations.mode`.
 */

/** The alert kind of the re-alert sent before a takeover times out (raised by `jobs/handoff-timeout.ts`). */
export const HANDOFF_REALERT_KIND = 'handoff_realert';

/** Trigger codes the bot passes today. B16 adds AI-driven ones. */
export type HandoffTrigger = 'guest_request' | 'large_group' | 'paid_after_expiry' | 'staff_reply' | (string & {});

export interface StartEpisodeInput {
  clubId: string;
  conversationId: string;
  /** A code, e.g. `guest_request`. Becomes `handoff.requested` props.trigger. */
  trigger: HandoffTrigger;
  /** Free text for staff (`handoff_episodes.reason`); never an event prop. */
  reason: string | null;
  /** The takeover topic (B16). Until B16 merges it defaults to the trigger code. */
  topic?: string | null;
  /** The guest message that started the takeover, when there is one. */
  firstMessageId: string | null;
  now: Date;
}

export interface EndEpisodeInput {
  episodeId: string;
  endedBy: 'staff' | 'timeout';
  resolverUserId?: string | null;
  now: Date;
  /** Who ended it, for the event. Defaults to the resolver as staff, or the system on timeout. */
  actor?: Actor;
}

export interface StaffReplyInput {
  clubId: string;
  conversationId: string;
  userId: string;
  text: string;
  /** Where the host typed it: `dashboard` or `chatwoot`. */
  channel: string;
  occurredAt: Date;
  /** The inbox's own message id; a repeated id is stored and sent once. Null for dashboard replies. */
  externalId: string | null;
  /** The guest's channel row, for a reply on a channel other than LINE (A18 Instagram). */
  channelId?: string | null;
}

/** How a staff reply reaches the guest. `AppContext` provides both (`ctx.deps.outbox`, `ctx.gateways`). */
export interface StaffReplySend {
  outbox: Outbox;
  gateways: GatewayRegistry;
}

export class EpisodeError extends Error {
  constructor(readonly code: 'not_found') {
    super(code);
    this.name = 'EpisodeError';
  }
}

const seconds = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));

/** The open episode of a conversation, if any. */
export async function openEpisode(db: Db, clubId: string, conversationId: string): Promise<HandoffEpisode | undefined> {
  const [row] = await db
    .select()
    .from(handoffEpisodes)
    .where(and(eq(handoffEpisodes.clubId, clubId), eq(handoffEpisodes.conversationId, conversationId), isNull(handoffEpisodes.endedAt)))
    .orderBy(desc(handoffEpisodes.startedAt))
    .limit(1);
  return row;
}

/** The conversation, its club and guest, with the conversation row locked for this transaction. */
async function lockConversation(tx: Db, clubId: string, conversationId: string) {
  const [conv] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.clubId, clubId)))
    .for('update');
  if (!conv) throw new EpisodeError('not_found');
  const club = (await tx.query.clubs.findFirst({ where: eq(clubs.id, clubId) }))!;
  const guest = await tx.query.guests.findFirst({ where: and(eq(guests.id, conv.guestId), eq(guests.clubId, clubId)) });
  return { conv, club, guest, origin: await originOf(tx, clubId, guest) };
}

/**
 * Channel and data origin of the guest's events: an Instagram contact's (A18) are tagged
 * `instagram` at the source (spec §14.8); everyone else is a LINE guest.
 */
async function originOf(tx: Db, clubId: string, guest: Guest | undefined): Promise<{ channel: string; dataOrigin: 'first_party' | 'instagram' }> {
  if (guest?.channelId && !guest.lineUserId) {
    const [ch] = await tx.select({ kind: channels.kind }).from(channels).where(and(eq(channels.id, guest.channelId), eq(channels.clubId, clubId))).limit(1);
    if (ch?.kind === 'instagram') return { channel: 'instagram', dataOrigin: 'instagram' };
  }
  return { channel: 'line', dataOrigin: 'first_party' };
}

/**
 * Starts a takeover: one `handoff_episodes` row, the conversation in human mode, `handoff.requested`.
 * When the conversation already has an open episode, returns it and changes nothing.
 */
export async function startEpisode(tx: Db, input: StartEpisodeInput): Promise<HandoffEpisode> {
  const { conv, club, guest, origin } = await lockConversation(tx, input.clubId, input.conversationId);
  const open = await openEpisode(tx, input.clubId, conv.id);
  if (open) return open;
  const [episode] = await tx
    .insert(handoffEpisodes)
    .values({
      id: newId(),
      clubId: input.clubId,
      conversationId: conv.id,
      startedAt: input.now,
      trigger: input.trigger,
      reason: input.reason,
      topic: input.topic ?? input.trigger,
      firstMessageId: input.firstMessageId,
      lastMessageId: input.firstMessageId,
    })
    .returning();
  await tx
    .update(conversations)
    .set({ mode: 'human', handoffRequestedAt: input.now, handoffReason: input.reason, updatedAt: input.now })
    .where(and(eq(conversations.id, conv.id), eq(conversations.clubId, input.clubId)));
  await emit(tx, {
    clubId: input.clubId,
    type: 'handoff.requested',
    occurredAt: input.now,
    actorType: input.trigger === 'guest_request' ? 'guest' : input.trigger === 'staff_reply' ? 'staff' : 'bot',
    ...origin,
    guestId: conv.guestId,
    conversationId: conv.id,
    props: { trigger: input.trigger },
    isTest: isTestContext({ club, guest }),
  });
  return episode!;
}

/**
 * Ends a takeover and gives the chat back to the bot. Emits `handoff.resolved` (staff) or
 * `handoff.timed_out` (timeout). Returns undefined, changing nothing, when the episode already ended.
 * The caller checks the club first (A14 and the staff routes look the conversation up club-scoped).
 */
export async function endEpisode(tx: Db, input: EndEpisodeInput): Promise<HandoffEpisode | undefined> {
  // Lock order is conversation, then episode, as in startEpisode and recordStaffReply: the other
  // order deadlocks a host reply against the handoff-timeout job.
  const [found] = await tx.select().from(handoffEpisodes).where(eq(handoffEpisodes.id, input.episodeId)).limit(1);
  if (!found || found.endedAt) return undefined;
  const { conv, club, guest, origin } = await lockConversation(tx, found.clubId, found.conversationId);
  const [episode] = await tx
    .update(handoffEpisodes)
    .set({ endedAt: input.now, endedBy: input.endedBy, resolverUserId: input.resolverUserId ?? null })
    .where(and(eq(handoffEpisodes.id, input.episodeId), isNull(handoffEpisodes.endedAt)))
    .returning();
  if (!episode) return undefined;
  await backToBot(tx, episode.clubId, conv.id, input.now);
  const actor: Actor =
    input.actor ?? (input.endedBy === 'timeout' ? { type: 'system' } : { type: 'staff', id: input.resolverUserId ?? undefined });
  await emit(tx, {
    clubId: episode.clubId,
    type: input.endedBy === 'timeout' ? 'handoff.timed_out' : 'handoff.resolved',
    occurredAt: input.now,
    actorType: actor.type,
    actorId: actor.id,
    ...origin,
    guestId: conv.guestId,
    conversationId: conv.id,
    props: { durationSec: seconds(episode.startedAt, input.now) },
    isTest: isTestContext({ club, guest }),
  });
  return episode;
}

async function backToBot(tx: Db, clubId: string, conversationId: string, now: Date) {
  await tx
    .update(conversations)
    .set({ mode: 'bot', handoffRequestedAt: null, handoffReason: null, updatedAt: now })
    .where(and(eq(conversations.id, conversationId), eq(conversations.clubId, clubId)));
  // The takeover is over, so its open re-alerts are too.
  await tx
    .update(alerts)
    .set({ resolvedAt: now })
    .where(and(eq(alerts.clubId, clubId), eq(alerts.conversationId, conversationId), eq(alerts.kind, HANDOFF_REALERT_KIND), isNull(alerts.resolvedAt)));
}

/**
 * The dashboard [Mark resolved]: ends the conversation's open episode. A human-mode conversation
 * with no episode row (made before B14b) goes back to the bot with `handoff.resolved` timed from
 * `handoff_requested_at`. Throws `EpisodeError('not_found')` for another club's conversation.
 */
export async function endOpenEpisode(
  tx: Db,
  input: { clubId: string; conversationId: string; resolverUserId: string; actor?: Actor; now: Date },
): Promise<void> {
  const { conv, club, guest, origin } = await lockConversation(tx, input.clubId, input.conversationId);
  const open = await openEpisode(tx, input.clubId, conv.id);
  if (open) {
    await endEpisode(tx, { episodeId: open.id, endedBy: 'staff', resolverUserId: input.resolverUserId, actor: input.actor, now: input.now });
    return;
  }
  if (conv.mode !== 'human') return;
  await backToBot(tx, input.clubId, conv.id, input.now);
  const actor: Actor = input.actor ?? { type: 'staff', id: input.resolverUserId };
  await emit(tx, {
    clubId: input.clubId,
    type: 'handoff.resolved',
    occurredAt: input.now,
    actorType: actor.type,
    actorId: actor.id,
    ...origin,
    guestId: conv.guestId,
    conversationId: conv.id,
    props: { durationSec: conv.handoffRequestedAt ? seconds(conv.handoffRequestedAt, input.now) : null },
    isTest: isTestContext({ club, guest }),
  });
}

/**
 * A host's reply (dashboard now, Chatwoot callback in A14). Stores it as a `messages` row with
 * `author_type='staff'`, starts a takeover if the bot had the chat, emits `host.replied`, then sends
 * it to the guest through the outbox. A repeated `externalId` returns the first row and sends nothing.
 * `send: null` records a reply the channel already delivered (a host typing on Instagram, A18).
 * Throws `EpisodeError('not_found')` when the conversation is not this club's.
 */
export async function recordStaffReply(db: Db, input: StaffReplyInput, send: StaffReplySend | null): Promise<{ messageId: string }> {
  const payload: Message = { type: 'text', text: input.text };
  const result = await db.transaction(async (tx) => {
    const { conv, club, guest, origin } = await lockConversation(tx, input.clubId, input.conversationId);
    const [row] = await tx
      .insert(messages)
      .values({
        id: newId(),
        clubId: input.clubId,
        guestId: conv.guestId,
        direction: 'out',
        kind: 'text',
        payload,
        authorType: 'staff',
        authorId: input.userId,
        occurredAt: input.occurredAt,
        externalId: input.externalId,
        ...(input.channelId ? { channelId: input.channelId, sentVia: 'none' as const, deliveryStatus: 'sent' as const } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [first] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.clubId, input.clubId), eq(messages.externalId, input.externalId!)));
      return { messageId: first!.id, fresh: false as const };
    }
    const episode =
      (await openEpisode(tx, input.clubId, conv.id)) ??
      (await startEpisode(tx, {
        clubId: input.clubId,
        conversationId: conv.id,
        trigger: 'staff_reply',
        reason: null,
        firstMessageId: row.id,
        now: input.occurredAt,
      }));
    await tx.update(handoffEpisodes).set({ lastMessageId: row.id }).where(eq(handoffEpisodes.id, episode.id));
    const [lastIn] = await tx
      .select({ at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.clubId, input.clubId), eq(messages.guestId, conv.guestId), eq(messages.direction, 'in')))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    await emit(tx, {
      clubId: input.clubId,
      type: 'host.replied',
      occurredAt: input.occurredAt,
      actorType: 'staff',
      actorId: input.userId,
      ...origin,
      source: input.channel,
      guestId: conv.guestId,
      conversationId: conv.id,
      props: { latency_ms: lastIn ? Math.max(0, input.occurredAt.getTime() - lastIn.at.getTime()) : null },
      isTest: isTestContext({ club, guest }),
    });
    return { messageId: row.id, fresh: true as const, club, guest };
  });
  if (send && result.fresh && result.guest) {
    const gateway = await send.gateways.forClub(result.club, result.guest.lineUserId);
    await send.outbox.deliver(gateway, result.club, result.guest, result.messageId, [payload]);
  }
  return { messageId: result.messageId };
}
