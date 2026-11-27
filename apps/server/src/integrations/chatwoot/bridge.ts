import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, gte, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { clubs, conversations, guests, handoffEpisodes, messages, platformFlags, type Club, type Conversation, type Guest } from '../../db/schema.js';
import type { AppContext } from '../../http/context.js';
import { newId } from '../../lib/util.js';
import { decryptSecret } from '../../platform/crypto.js';
import { chatwootAccount, type ChatwootAccount, type ChatwootStatus } from './client.js';
import { chatwootCallbackUrl, chatwootConversationRef, chatwootState, type ChatwootClient, type ChatwootClubState } from './provision.js';

/**
 * LINE → Chatwoot mirroring (spec §6.3, plan A14). Our server keeps the LINE webhook and runs the
 * bot; this job copies every guest message, bot message and dashboard staff reply of a LINE guest
 * into the club's Chatwoot API inbox, in creation order, behind a per-club cursor. It never runs on
 * the LINE path: when Chatwoot is down the bot still answers and the rows wait for the next run.
 *
 * State per club in `platform_flags['chatwoot:<clubId>:bridge']`.
 */

export interface BridgeState {
  /** `messages.created_at` (database text, full precision) and id of the last mirrored row. */
  cursorAt?: string;
  cursorId?: string;
  /** Handoff episodes started or ended from this time on get their Chatwoot status set next run. */
  episodesAt?: string;
  /** SHA-256 (hex) of the token in the inbox webhook URL. */
  tokenHash?: string;
  webhookSet?: boolean;
}

export const bridgeFlagKey = (clubId: string) => `chatwoot:${clubId}:bridge`;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Rows newer than this (database clock) wait for the next run, so a late-committing transaction is never skipped. */
export const MIRROR_SETTLE_MS = 2_000;
export const MIRROR_BATCH = 100;

export async function bridgeState(db: Db, clubId: string): Promise<BridgeState | null> {
  const [row] = await db.select({ value: platformFlags.value }).from(platformFlags).where(eq(platformFlags.key, bridgeFlagKey(clubId))).limit(1);
  return (row?.value as BridgeState | undefined) ?? null;
}

async function saveBridge(db: Db, clubId: string, value: BridgeState, now: Date) {
  await db
    .insert(platformFlags)
    .values({ key: bridgeFlagKey(clubId), value, updatedBy: 'chatwoot-bridge', updatedAt: now })
    .onConflictDoUpdate({ target: platformFlags.key, set: { value, updatedBy: 'chatwoot-bridge', updatedAt: now } });
}

/** Constant-time check of the callback URL token against the stored hash. */
export function verifyBridgeToken(state: BridgeState | null, token: string | undefined | null): boolean {
  if (!state?.tokenHash || !token) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(state.tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const ready = (s: ChatwootClubState | null): s is ChatwootClubState & { accountId: number; inboxId: number; adminTokenEnc: string } =>
  !!s?.accountId && !!s.inboxId && !!s.adminTokenEnc && !!s.provisionedAt;

/**
 * Points the club's API inbox webhook (staff replies) at our callback with a fresh secret token,
 * once. A13 created the inbox without a token, so callbacks are refused until this has run.
 */
export async function ensureBridgeWebhook(db: Db, cw: ChatwootClient, key: Buffer, clubId: string, publicUrl: string, now: Date): Promise<BridgeState> {
  const cwState = await chatwootState(db, clubId);
  const state: BridgeState = { ...((await bridgeState(db, clubId)) ?? {}) };
  if (state.webhookSet && state.tokenHash) return state;
  if (!ready(cwState)) throw new Error(`club ${clubId} has no provisioned Chatwoot inbox`);
  const token = randomBytes(32).toString('base64url');
  const api = chatwootAccount(cw, cwState.accountId, decryptSecret(cwState.adminTokenEnc, key));
  await api.setInboxWebhook(cwState.inboxId, `${chatwootCallbackUrl(publicUrl, clubId)}?token=${encodeURIComponent(token)}`);
  state.tokenHash = hashToken(token);
  state.webhookSet = true;
  await saveBridge(db, clubId, state, now);
  return state;
}

/** The text Chatwoot shows for a stored message row. */
export function mirrorContent(kind: string, payload: unknown): string {
  // B4: an inbound LINE row holds the whole event (`message.text`, `postback.data`).
  const raw = (payload ?? {}) as { text?: unknown; altText?: unknown; data?: unknown; message?: { text?: unknown }; postback?: { data?: unknown } };
  const p = { ...raw, text: raw.text ?? raw.message?.text, data: raw.data ?? raw.postback?.data };
  if (typeof p.text === 'string' && p.text) return p.text;
  if (typeof p.altText === 'string' && p.altText) return p.altText;
  if (kind === 'postback' && typeof p.data === 'string') return `[tap] ${p.data}`;
  return `[${kind}]`;
}

const statusFor = (conv: Pick<Conversation, 'mode'>): ChatwootStatus => (conv.mode === 'human' ? 'open' : 'pending');

/** The Chatwoot conversation id stored in `conversations.external_ref` for this account, if any. */
function refConversationId(conv: Pick<Conversation, 'externalRef'>, accountId: number): number | null {
  const prefix = chatwootConversationRef(accountId, '');
  if (!conv.externalRef?.startsWith(prefix)) return null;
  const id = Number(conv.externalRef.slice(prefix.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The guest's Chatwoot conversation, created (contact, contact inbox, conversation) on first use. */
async function ensureConversation(db: Db, api: ChatwootAccount, cwState: { accountId: number; inboxId: number }, club: Club, guest: Guest): Promise<number> {
  let conv = await db.query.conversations.findFirst({ where: and(eq(conversations.clubId, club.id), eq(conversations.guestId, guest.id)) });
  if (!conv) {
    // A guest the outbox wrote to before the bot made the conversation row (column defaults only).
    await db.insert(conversations).values({ id: newId(), clubId: club.id, guestId: guest.id }).onConflictDoNothing();
    conv = (await db.query.conversations.findFirst({ where: and(eq(conversations.clubId, club.id), eq(conversations.guestId, guest.id)) }))!;
  }
  const existing = refConversationId(conv, cwState.accountId);
  if (existing) return existing;

  const name = guest.name ?? guest.displayName ?? 'LINE guest';
  let contactId: number;
  let sourceId: string | null;
  try {
    ({ contactId, sourceId } = await api.createContact({ inboxId: cwState.inboxId, identifier: guest.id, name }));
  } catch (err) {
    // A crash after the contact was created: the identifier is taken (422). Reuse that contact.
    const found = (err as { status?: number }).status === 422 ? await api.searchContact(guest.id) : null;
    if (!found) throw err;
    contactId = found;
    sourceId = await api.createContactInbox(found, cwState.inboxId, guest.id);
  }
  const cwConversationId = await api.createConversation({ inboxId: cwState.inboxId, contactId, sourceId: sourceId ?? guest.id, status: statusFor(conv) });
  await db
    .update(conversations)
    .set({ externalRef: chatwootConversationRef(cwState.accountId, cwConversationId) })
    .where(and(eq(conversations.id, conv.id), eq(conversations.clubId, club.id)));
  return cwConversationId;
}

export interface MirrorResult {
  mirrored: number;
  /** True when rows are still waiting: Chatwoot failed, or the batch was full. */
  pending: boolean;
  error?: string;
}

/**
 * Mirrors the club's next batch of LINE-guest messages into Chatwoot and sets the Chatwoot status
 * of conversations whose takeover started or ended since the last run. Stops at the first Chatwoot
 * failure with the cursor on the last row that went through, so nothing is lost or reordered.
 */
export async function mirrorClub(
  db: Db,
  cw: ChatwootClient,
  key: Buffer,
  club: Club,
  opts: { now: Date; publicUrl: string; batch?: number; settleMs?: number; log?: (msg: string, err?: unknown) => void },
): Promise<MirrorResult> {
  const cwState = await chatwootState(db, club.id);
  if (!ready(cwState)) return { mirrored: 0, pending: false };
  const adminToken = decryptSecret(cwState.adminTokenEnc, key);
  const botToken = cwState.botTokenEnc ? decryptSecret(cwState.botTokenEnc, key) : adminToken;
  const asAdmin = chatwootAccount(cw, cwState.accountId, adminToken);
  const asBot = chatwootAccount(cw, cwState.accountId, botToken);
  const batch = opts.batch ?? MIRROR_BATCH;
  const settleMs = opts.settleMs ?? MIRROR_SETTLE_MS;

  let state: BridgeState;
  try {
    state = await ensureBridgeWebhook(db, cw, key, club.id, opts.publicUrl, opts.now);
  } catch (err) {
    opts.log?.(`Chatwoot bridge: webhook setup failed for club ${club.id}`, err);
    return { mirrored: 0, pending: true, error: errorCode(err) };
  }

  const after = state.cursorAt && state.cursorId ? sql`(${messages.createdAt}, ${messages.id}) > (${state.cursorAt}::timestamptz, ${state.cursorId})` : undefined;
  const rows = await db
    .select({ m: messages, g: guests, at: sql<string>`${messages.createdAt}::text` })
    .from(messages)
    .innerJoin(guests, and(eq(guests.id, messages.guestId), eq(guests.clubId, club.id)))
    .where(
      and(
        eq(messages.clubId, club.id),
        isNotNull(guests.lineUserId),
        after,
        sql`${messages.createdAt} <= now() - (${settleMs}::int * interval '1 millisecond')`,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(batch);

  let mirrored = 0;
  for (const { m, g, at } of rows) {
    const fromChatwoot = m.authorType === 'staff' && !!m.externalId?.startsWith('cw:');
    if (!fromChatwoot) {
      try {
        const cwConversationId = await ensureConversation(db, asAdmin, cwState, club, g);
        const content = mirrorContent(m.kind, m.payload).slice(0, 10_000);
        if (m.direction === 'in') await asAdmin.createMessage(cwConversationId, { content, messageType: 'incoming' });
        else if (m.authorType === 'staff') await asAdmin.createMessage(cwConversationId, { content, messageType: 'outgoing' });
        else await asBot.createMessage(cwConversationId, { content, messageType: 'outgoing' });
        mirrored++;
      } catch (err) {
        opts.log?.(`Chatwoot bridge: mirror failed for club ${club.id}, message ${m.id}`, err);
        return { mirrored, pending: true, error: errorCode(err) };
      }
    }
    state = { ...state, cursorAt: at, cursorId: m.id };
    await saveBridge(db, club.id, state, opts.now);
  }

  // Conversation status follows the takeover: human mode open, bot mode pending (spec §6.3).
  if (state.episodesAt) {
    const since = new Date(state.episodesAt);
    const changed = await db
      .selectDistinct({ conversationId: handoffEpisodes.conversationId })
      .from(handoffEpisodes)
      .where(and(eq(handoffEpisodes.clubId, club.id), or(gte(handoffEpisodes.startedAt, since), gte(handoffEpisodes.endedAt, since))));
    for (const { conversationId } of changed) {
      const conv = await db.query.conversations.findFirst({ where: and(eq(conversations.id, conversationId), eq(conversations.clubId, club.id)) });
      const cwId = conv ? refConversationId(conv, cwState.accountId) : null;
      if (!conv || !cwId) continue;
      try {
        await asAdmin.toggleStatus(cwId, statusFor(conv));
      } catch (err) {
        opts.log?.(`Chatwoot bridge: status update failed for club ${club.id}`, err);
        return { mirrored, pending: true, error: errorCode(err) };
      }
    }
  }
  state = { ...state, episodesAt: opts.now.toISOString() };
  await saveBridge(db, club.id, state, opts.now);
  return { mirrored, pending: rows.length === batch };
}

const errorCode = (err: unknown) => {
  const status = (err as { status?: number }).status;
  return typeof status === 'number' ? `chatwoot_${status}` : 'chatwoot_unreachable';
};

/** The `chatwoot-mirror` job: every provisioned club, one batch each. One club's failure never stops the others. */
export async function mirrorAll(ctx: AppContext, now: Date): Promise<void> {
  const cw = ctx.chatwoot;
  if (!cw) return;
  const db = ctx.deps.db;
  for (const club of await db.select().from(clubs)) {
    if (!ready(await chatwootState(db, club.id))) continue;
    await mirrorClub(db, cw, ctx.config.CREDENTIALS_KEY, club, { now, publicUrl: ctx.config.PUBLIC_URL, log: ctx.deps.log });
  }
}
