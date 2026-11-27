import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { channels, conversations, guests, messages, platformFlags, type Club } from '../../db/schema.js';
import { emit } from '../../data/events.js';
import { newId } from '../../lib/util.js';
import { decryptSecret } from '../../platform/crypto.js';
import { chatwootConversationRef, chatwootState, InboxNotProvisioned, type ChatwootClient } from './provision.js';

/**
 * Instagram through Chatwoot's native Instagram inbox (spec §11.5, plan A18).
 *
 * OAuth happens in Chatwoot's own UI: the person who can log in to the club's Instagram
 * professional account completes Instagram's login screen inside the club's Chatwoot account
 * (A13). That leaves a `Channel::Instagram` inbox there. `connectInstagram` then links it: it finds
 * the inbox, registers an account webhook for `message_created` that points at
 * `/integrations/chatwoot/<clubId>/instagram?token=<per-club token>`, and marks the club's
 * `channels` row (kind `instagram`). Only a SHA-256 of the token is stored, in
 * `platform_flags['chatwoot:<clubId>:instagram']`.
 *
 * Every event recorded from Instagram carries `data_origin = 'instagram'` and `channel = 'instagram'`
 * (§14.8): Instagram data stays with its club and is never read by cross-club views.
 */

export const INSTAGRAM_CHANNEL = 'instagram';

export interface InstagramState {
  /** Chatwoot inbox id of the club's Instagram inbox. */
  inboxId: number;
  /** Instagram professional account id, when Chatwoot reports it. */
  instagramId: string | null;
  webhookId?: number;
  /** SHA-256 (hex) of the token in the webhook URL. */
  tokenHash?: string;
  connectedAt?: string;
}

export class InstagramInboxMissing extends Error {
  constructor(clubId: string) {
    super(`club ${clubId} has no Instagram inbox in Chatwoot yet: finish the Instagram login inside Chatwoot first`);
  }
}

export const instagramFlagKey = (clubId: string) => `chatwoot:${clubId}:instagram`;
/** Path of the Instagram webhook on our server, under the A13 callback scheme (`/integrations/chatwoot/<clubId>/...`). */
export const instagramWebhookPath = (clubId: string) => `/integrations/chatwoot/${clubId}/instagram`;
export const instagramWebhookUrl = (publicUrl: string, clubId: string, token: string) =>
  `${publicUrl.replace(/\/$/, '')}${instagramWebhookPath(clubId)}?token=${encodeURIComponent(token)}`;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function instagramState(db: Db, clubId: string): Promise<InstagramState | null> {
  const [row] = await db.select({ value: platformFlags.value }).from(platformFlags).where(eq(platformFlags.key, instagramFlagKey(clubId))).limit(1);
  return (row?.value as InstagramState | undefined) ?? null;
}

async function saveState(db: Db, clubId: string, value: InstagramState, by: string, now: Date) {
  await db
    .insert(platformFlags)
    .values({ key: instagramFlagKey(clubId), value, updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({ target: platformFlags.key, set: { value, updatedBy: by, updatedAt: now } });
}

/** Public summary for API responses: ids and status, never the token or its hash. */
export function instagramSummary(state: InstagramState | null) {
  return {
    status: state?.connectedAt ? ('connected' as const) : state ? ('partial' as const) : ('not_connected' as const),
    inboxId: state?.inboxId ?? null,
    instagramId: state?.instagramId ?? null,
    connectedAt: state?.connectedAt ?? null,
  };
}

type CwInbox = { id: number; name?: string; channel_type?: string; instagram_id?: string | number | null };

/** Chatwoot's native Instagram inbox, or an Instagram account linked through a Facebook page inbox. */
const isInstagramInbox = (i: CwInbox) => i.channel_type === 'Channel::Instagram' || (i.channel_type === 'Channel::FacebookPage' && !!i.instagram_id);

/**
 * Links the club's Chatwoot Instagram inbox (spec §11.5). Idempotent: a stored webhook is not
 * registered again. Throws InboxNotProvisioned without an A13 account, InstagramInboxMissing when
 * the account has no Instagram inbox (or `inboxId` is not one), ChatwootError when Chatwoot fails.
 */
export async function connectInstagram(
  db: Db,
  cw: ChatwootClient,
  key: Buffer,
  club: { id: string },
  opts: { inboxId?: number; publicUrl: string; by: string; now: Date },
): Promise<InstagramState> {
  const cwState = await chatwootState(db, club.id);
  if (!cwState?.accountId || !cwState.adminTokenEnc) throw new InboxNotProvisioned(club.id);
  const accountId = cwState.accountId;
  const adminToken = decryptSecret(cwState.adminTokenEnc, key);

  const listed = await cw.request<{ payload?: CwInbox[] }>('GET', `/api/v1/accounts/${accountId}/inboxes`, undefined, adminToken);
  const candidates = (listed.payload ?? []).filter(isInstagramInbox);
  const prior = await instagramState(db, club.id);
  const wanted = opts.inboxId ?? prior?.inboxId;
  const inbox = wanted !== undefined ? candidates.find((i) => i.id === wanted) : candidates[0];
  if (!inbox) throw new InstagramInboxMissing(club.id);

  const state: InstagramState = { ...(prior ?? {}), inboxId: inbox.id, instagramId: inbox.instagram_id != null ? String(inbox.instagram_id) : null };
  if (!state.webhookId || !state.tokenHash) {
    const token = randomBytes(32).toString('base64url');
    const res = await cw.request<{ id?: number; payload?: { webhook?: { id: number } } }>(
      'POST',
      `/api/v1/accounts/${accountId}/webhooks`,
      { url: instagramWebhookUrl(opts.publicUrl, club.id, token), subscriptions: ['message_created'] },
      adminToken,
    );
    state.webhookId = res.payload?.webhook?.id ?? res.id;
    state.tokenHash = hashToken(token);
    await saveState(db, club.id, state, opts.by, opts.now);
  }
  state.connectedAt ??= opts.now.toISOString();
  await saveState(db, club.id, state, opts.by, opts.now);

  const externalId = state.instagramId ?? `cw-inbox:${inbox.id}`;
  await db
    .insert(channels)
    .values({ id: newId(), clubId: club.id, kind: 'instagram', externalId, status: 'connected', connectedAt: opts.now })
    .onConflictDoUpdate({ target: [channels.clubId, channels.kind], set: { externalId, status: 'connected', connectedAt: opts.now } });
  return state;
}

/** Constant-time check of the webhook URL token against the stored hash. */
export function verifyInstagramToken(state: InstagramState | null, token: string | undefined | null): boolean {
  if (!state?.tokenHash || !token) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(state.tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The fields of Chatwoot's `message_created` webhook we read; the rest is kept in `raw`. */
const messageCreated = z.object({
  event: z.literal('message_created'),
  id: z.union([z.number(), z.string()]),
  content: z.string().nullish(),
  message_type: z.union([z.string(), z.number()]),
  private: z.boolean().nullish(),
  created_at: z.union([z.string(), z.number()]).nullish(),
  source_id: z.string().nullish(),
  sender: z.object({ id: z.union([z.number(), z.string()]).nullish(), name: z.string().nullish(), type: z.string().nullish() }).passthrough().nullish(),
  attachments: z.array(z.object({ file_type: z.string().nullish(), data_url: z.string().nullish() }).passthrough()).nullish(),
  conversation: z
    .object({ id: z.union([z.number(), z.string()]), contact_inbox: z.object({ source_id: z.string().nullish() }).passthrough().nullish() })
    .passthrough(),
  inbox: z.object({ id: z.union([z.number(), z.string()]) }).passthrough(),
  account: z.object({ id: z.union([z.number(), z.string()]) }).passthrough(),
});

export type InstagramApplied = 'recorded' | 'duplicate' | 'ignored';

const occurredAt = (v: string | number | null | undefined, fallback: Date) => {
  if (v === null || v === undefined) return fallback;
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
};

/**
 * Records one inbound Instagram message from a verified Chatwoot delivery: the guest (found or
 * created by the Instagram-scoped id), the conversation (`external_ref` = Chatwoot conversation),
 * the `messages` row and the `message.received` event, all tagged `instagram` (§14.8).
 * Only incoming, non-private messages of the club's own account and Instagram inbox are recorded;
 * a redelivery (same Chatwoot message id) is a duplicate.
 *
 * Writing `guests` / `conversations` / `messages` is B's domain (chat capture). This is a direct
 * write until B publishes a messages writer; see the Track A sync file.
 */
export async function recordInstagramMessage(db: Db, club: Club, state: InstagramState, body: unknown, now: Date): Promise<InstagramApplied> {
  const cwState = await chatwootState(db, club.id);
  const parsed = messageCreated.safeParse(body);
  if (!parsed.success || !cwState?.accountId) return 'ignored';
  const p = parsed.data;
  if (String(p.account.id) !== String(cwState.accountId) || String(p.inbox.id) !== String(state.inboxId)) return 'ignored';
  if (!(p.message_type === 'incoming' || p.message_type === 0) || p.private) return 'ignored';

  const [channel] = await db.select().from(channels).where(and(eq(channels.clubId, club.id), eq(channels.kind, 'instagram'))).limit(1);
  if (!channel) return 'ignored';
  const contactId = p.conversation.contact_inbox?.source_id ?? (p.sender?.id != null ? `cw-contact:${p.sender.id}` : null);
  if (!contactId) return 'ignored';

  const isTest = club.status === 'demo';
  const at = occurredAt(p.created_at, now);
  const attachments = (p.attachments ?? []).map((a) => ({ type: a.file_type ?? 'file', url: a.data_url ?? null }));
  const text = p.content ?? null;
  const externalId = `cw:${cwState.accountId}:${p.id}`;

  return db.transaction(async (tx) => {
    const seen = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.clubId, club.id), eq(messages.externalId, externalId))).limit(1);
    if (seen.length) return 'duplicate' as const;

    let guest = await tx.query.guests.findFirst({ where: and(eq(guests.clubId, club.id), eq(guests.channelId, channel.id), eq(guests.externalUserId, contactId)) });
    let newGuest = false;
    if (!guest) {
      [guest] = await tx
        .insert(guests)
        .values({ id: newId(), clubId: club.id, channelId: channel.id, externalUserId: contactId, displayName: p.sender?.name ?? null, isTest })
        .returning();
      newGuest = true;
    }
    const g = guest!;
    const ref = chatwootConversationRef(cwState.accountId!, p.conversation.id);
    let conv = await tx.query.conversations.findFirst({ where: and(eq(conversations.clubId, club.id), eq(conversations.guestId, g.id)) });
    if (!conv) {
      [conv] = await tx.insert(conversations).values({ id: newId(), clubId: club.id, guestId: g.id, externalRef: ref }).returning();
    } else if (!conv.externalRef) {
      await tx.update(conversations).set({ externalRef: ref }).where(eq(conversations.id, conv.id));
    }
    const c = conv!;

    const inserted = await tx
      .insert(messages)
      .values({
        id: newId(),
        clubId: club.id,
        guestId: g.id,
        direction: 'in',
        kind: text ? 'text' : attachments.length ? 'attachment' : 'text',
        payload: { text, attachments, sourceId: p.source_id ?? null },
        authorType: 'guest',
        channelId: channel.id,
        occurredAt: at,
        externalId,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (!inserted.length) return 'duplicate' as const;

    const base = { clubId: club.id, actorType: 'guest' as const, channel: INSTAGRAM_CHANNEL, dataOrigin: 'instagram' as const, source: 'chatwoot', guestId: g.id, conversationId: c.id, isTest };
    if (newGuest) await emit(tx, { ...base, type: 'guest.first_seen', occurredAt: at, dedupeKey: `ig:first_seen:${g.id}` });
    await emit(tx, {
      ...base,
      type: 'message.received',
      occurredAt: at,
      props: { kind: text ? 'text' : 'attachment', attachments: attachments.length, messageId: inserted[0]!.id },
      raw: body,
      dedupeKey: `ig:msg:${externalId}`,
    });
    return 'recorded' as const;
  });
}
