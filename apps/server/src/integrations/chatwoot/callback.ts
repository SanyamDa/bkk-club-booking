import { and, eq, like, sql } from 'drizzle-orm';
import { endOpenEpisode, recordStaffReply, type StaffReplySend } from '../../chat/episodes.js';
import type { Db } from '../../db/client.js';
import { conversations, platformFlags, type Club, type Conversation } from '../../db/schema.js';
import { bridgeState, verifyBridgeToken } from './bridge.js';
import { chatwootConversationRef, chatwootState } from './provision.js';

/**
 * Chatwoot → us (spec §6.3, plan A14): the API inbox webhook. A host's reply in Chatwoot becomes a
 * staff reply through B14b's `recordStaffReply` (sent to the guest on LINE once, deduped on the
 * Chatwoot message id), and Chatwoot's resolve button ends the takeover. Our own posts (bot messages,
 * mirrored dashboard replies) come back as echoes and are ignored.
 */

type Body = Record<string, any>;

export type CallbackCheck =
  | { ok: false; status: 400 | 401 | 403 | 404; error: string }
  | { ok: true; kind: 'ignored' }
  | { ok: true; kind: 'message' | 'status'; club: Club; conversation: Conversation; accountId: number; adminUserId: number | null; body: Body };

const idOf = (v: unknown): string | null => (typeof v === 'number' || (typeof v === 'string' && v !== '') ? String(v) : null);

/**
 * Checks a delivery before anything is written: the URL token, the account (must be this club's)
 * and the conversation (must be this club's mirrored conversation). Unhandled events pass as
 * `ignored` once the token is good.
 */
export async function checkCallback(db: Db, club: Club, token: string | undefined, body: unknown): Promise<CallbackCheck> {
  const cwState = await chatwootState(db, club.id);
  const bridge = await bridgeState(db, club.id);
  if (!cwState?.accountId || !bridge?.tokenHash) return { ok: false, status: 404, error: 'not_found' };
  if (!verifyBridgeToken(bridge, token)) return { ok: false, status: 401, error: 'bad_token' };
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'invalid' };
  const b = body as Body;
  const kind = b.event === 'message_created' ? 'message' : b.event === 'conversation_status_changed' ? 'status' : null;
  if (!kind) return { ok: true, kind: 'ignored' };

  const accountId = idOf(b.account?.id ?? b.account_id ?? b.conversation?.account_id);
  if (accountId !== String(cwState.accountId)) return { ok: false, status: 403, error: 'account_mismatch' };
  const conversationId = kind === 'message' ? idOf(b.conversation?.display_id ?? b.conversation?.id) : idOf(b.display_id ?? b.id);
  if (!conversationId) return { ok: false, status: 400, error: 'invalid' };
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.clubId, club.id), eq(conversations.externalRef, chatwootConversationRef(cwState.accountId, conversationId))),
  });
  if (!conversation) return { ok: false, status: 404, error: 'conversation_not_found' };
  return { ok: true, kind, club, conversation, accountId: cwState.accountId, adminUserId: cwState.adminUserId ?? null, body: b };
}

export type CallbackApplied = 'recorded' | 'resolved' | 'echo' | 'ignored';

type Mapping = { chatwootUserId: number; grantId?: string | null };

/** Our user behind a Chatwoot user (A13 mapping), or null when it is not one of ours. */
async function mappedUser(db: Db, clubId: string, chatwootUserId: string): Promise<{ userId: string; grantId: string | null } | null> {
  const prefix = `chatwoot:${clubId}:user:`;
  const [row] = await db
    .select({ key: platformFlags.key, value: platformFlags.value })
    .from(platformFlags)
    .where(and(like(platformFlags.key, `${prefix}%`), sql`${platformFlags.value}->>'chatwootUserId' = ${chatwootUserId}`))
    .limit(1);
  if (!row) return null;
  return { userId: row.key.slice(prefix.length), grantId: (row.value as Mapping).grantId ?? null };
}

/** Applies a checked delivery. The caller has stored it in `raw_webhooks`. */
export async function applyCallback(db: Db, checked: Extract<CallbackCheck, { kind: 'message' | 'status' }>, send: StaffReplySend, now: Date): Promise<CallbackApplied> {
  const { club, conversation, body } = checked;
  if (checked.kind === 'status') {
    if (body.status !== 'resolved') return 'ignored';
    await db.transaction((tx) =>
      endOpenEpisode(tx, { clubId: club.id, conversationId: conversation.id, resolverUserId: 'chatwoot', actor: { type: 'staff' }, now }),
    );
    return 'resolved';
  }

  const outgoing = body.message_type === 'outgoing' || body.message_type === 1;
  const text = typeof body.content === 'string' ? body.content.trim() : '';
  if (!outgoing || body.private || !text || !idOf(body.id)) return 'ignored';
  const senderType = String(body.sender?.type ?? body.sender_type ?? '').toLowerCase();
  const senderId = idOf(body.sender?.id ?? body.sender_id);
  // Our own posts: bot messages (Agent Bot) and mirrored dashboard replies (platform admin user).
  if (senderType === 'agent_bot' || senderType === 'agentbot') return 'echo';
  if (!senderId || (checked.adminUserId !== null && senderId === String(checked.adminUserId))) return 'echo';

  const user = await mappedUser(db, club.id, senderId);
  // A support session never messages a guest as the club (spec §16.1 q8, plan A5).
  if (user?.grantId) return 'ignored';
  const occurredAt = typeof body.created_at === 'number' ? new Date(body.created_at * 1000) : new Date(body.created_at ?? now);
  await recordStaffReply(
    db,
    {
      clubId: club.id,
      conversationId: conversation.id,
      userId: user?.userId ?? `chatwoot:${senderId}`,
      text: text.slice(0, 5000),
      channel: 'chatwoot',
      occurredAt: Number.isNaN(occurredAt.getTime()) ? now : occurredAt,
      externalId: `cw:${checked.accountId}:${idOf(body.id)}`,
    },
    send,
  );
  return 'recorded';
}
