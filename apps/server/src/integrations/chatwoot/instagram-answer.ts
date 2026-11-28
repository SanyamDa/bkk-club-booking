import { and, eq } from 'drizzle-orm';
import { answerGuestMessage, type ModelClient } from '../../brain/answer.js';
import { handoffAlertKind, urgentWordIn } from '../../bot/alerts.js';
import { activePause } from '../../bot/flow.js';
import { t } from '../../bot/i18n.js';
import { detectIntent } from '../../bot/intents.js';
import { handoffAckText } from '../../bot/messages.js';
import type { Links } from '../../bot/links.js';
import { startEpisode, type HandoffTrigger } from '../../chat/episodes.js';
import type { Db } from '../../db/client.js';
import { channels, conversations, guests, messages, type Club, type Conversation, type Guest } from '../../db/schema.js';
import { newId } from '../../lib/util.js';
import { raiseAlert } from '../../platform/alerts.js';
import { decryptSecret } from '../../platform/crypto.js';
import { isFeatureOn } from '../../platform/features.js';
import { chatwootAccount } from './client.js';
import { chatwootConversationRef, chatwootState, type ChatwootClient } from './provision.js';

/**
 * B16 on Instagram (spec §11.5, plan A18): a guest's Instagram message, recorded by
 * `recordInstagramMessage`, goes through the same answer path as LINE: `answerGuestMessage` (the
 * club's brain snapshot, the output guard, the cost cap, `ai.*` and `faq.missed` events, tagged
 * `instagram`) and the same handoff (`startEpisode` plus an urgent alert). The reply goes back
 * into the Chatwoot conversation as an outgoing message, which Chatwoot delivers on Instagram.
 *
 * Instagram through the inbox has text only: no buttons or date picker. A booking request, or any
 * outcome that on LINE shows buttons, gets the counted link that opens the club's LINE account
 * (`Links.tracked(club, 'line', 'instagram')`), where the guest books. With no LINE account set up
 * the chat goes to a host instead.
 *
 * Quiet (no reply) while a host has the chat, while the bot is paused, when the club's `instagram`
 * switch is off, or when there is no model client or no Chatwoot.
 */

export type InstagramAnswer = 'answered' | 'line_link' | 'handoff' | 'quiet' | 'off' | 'send_failed';

export interface InstagramAnswerDeps {
  db: Db;
  ai: ModelClient | null | undefined;
  cw: ChatwootClient | null;
  key: Buffer;
  links: Links;
  log: (msg: string, err?: unknown) => void;
}

const THAI = /[฀-๿]/;

const lineLinkText = (lang: 'th' | 'en', url: string) =>
  lang === 'th'
    ? `จองโต๊ะได้ใน LINE ของเรา: เปิดลิงก์นี้แล้วกด "จองโต๊ะ"\n${url}`
    : `You can book a table in our LINE: open this link and tap "Book a table".\n${url}`;

export async function answerInstagramMessage(deps: InstagramAnswerDeps, club: Club, messageId: string, now: Date): Promise<InstagramAnswer> {
  const { db } = deps;
  const [inbound] = await db.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.clubId, club.id))).limit(1);
  const text = ((inbound?.payload as { text?: unknown } | undefined)?.text ?? '') as string;
  if (!inbound?.guestId || typeof text !== 'string' || !text.trim()) return 'quiet';
  const guest = await db.query.guests.findFirst({ where: and(eq(guests.id, inbound.guestId), eq(guests.clubId, club.id)) });
  const conv = await db.query.conversations.findFirst({ where: and(eq(conversations.clubId, club.id), eq(conversations.guestId, inbound.guestId)) });
  if (!guest || !conv) return 'quiet';
  if (conv.mode === 'human') return 'quiet';
  if (!deps.ai || !deps.cw || (await activePause(db, club)) || !(await isFeatureOn(db, club.id, 'instagram')) || !(await isFeatureOn(db, club.id, 'ai_answers'))) return 'off';

  const s = { deps, club, guest, conv, inboundId: inbound.id, now, lang: (THAI.test(text) ? 'th' : 'en') as 'th' | 'en' };

  const word = urgentWordIn(club, text);
  if (word) return handoff(s, 'complaint', `Complaint or safety word "${word}": "${text.slice(0, 120)}"`, null);
  const intent = detectIntent(text);
  if (intent.kind === 'handoff') return handoff(s, 'guest_request', `Guest said: "${text.slice(0, 120)}"`, null);
  if (intent.kind === 'book' || intent.kind === 'my_booking') return lineLink(s);

  const out = await answerGuestMessage({ db, client: deps.ai, log: deps.log }, { club, guest, conv, lang: s.lang, channel: 'instagram' }, text, now);
  switch (out.kind) {
    case 'answer':
      return (await send(s, out.text)) ? 'answered' : 'send_failed';
    case 'menu':
    case 'booking':
    case 'my_booking':
      return lineLink(s);
    case 'handoff': {
      const why = { ai_cost_cap: 'AI cost cap reached', ai_unavailable: 'AI unavailable', faq_missed: 'Bot has no answer', guard: 'Bot answer blocked (price or availability)', guest_request: 'Guest asked for a host' }[out.reason];
      const reason = `${why} (Instagram): "${text.slice(0, 120)}"${out.summary ? `\n${out.summary}` : ''}`;
      return handoff(s, out.reason, reason, out.topic ?? out.reason);
    }
  }
}

type Session = { deps: InstagramAnswerDeps; club: Club; guest: Guest; conv: Conversation; inboundId: string; now: Date; lang: 'th' | 'en' };

async function lineLink(s: Session): Promise<InstagramAnswer> {
  const [line] = await s.deps.db
    .select({ basicId: channels.externalId })
    .from(channels)
    .where(and(eq(channels.clubId, s.club.id), eq(channels.kind, 'line')))
    .limit(1);
  if (!line?.basicId) return handoff(s, 'instagram_booking', 'Instagram guest wants to book; the club has no LINE account to link to', 'booking');
  return (await send(s, lineLinkText(s.lang, s.deps.links.tracked(s.club, 'line', 'instagram')))) ? 'line_link' : 'send_failed';
}

/** The same takeover as LINE (`requestHandoff` in `bot/flow.ts`): an episode, the ack, an urgent alert. */
async function handoff(s: Session, trigger: HandoffTrigger, reason: string, topic: string | null): Promise<InstagramAnswer> {
  await s.deps.db.transaction((tx) =>
    startEpisode(tx, { clubId: s.club.id, conversationId: s.conv.id, trigger, reason, topic, firstMessageId: s.inboundId, now: s.now }),
  );
  await send(s, handoffAckText(s.club, s.lang, s.now));
  const kind = handoffAlertKind(trigger);
  const head =
    kind === 'complaint'
      ? { en: 'Complaint or safety message', th: 'ข้อร้องเรียนหรือเรื่องความปลอดภัย' }
      : kind === 'bot_unanswered'
        ? { en: 'The bot could not answer', th: 'บอทตอบไม่ได้' }
        : { en: 'Guest wants a host', th: 'ลูกค้าต้องการคุยกับพนักงาน' };
  const who = s.guest.name ?? s.guest.displayName ?? 'Instagram guest';
  await raiseAlert(
    s.deps.db,
    {
      clubId: s.club.id,
      level: 'urgent',
      kind,
      conversationId: s.conv.id,
      text: {
        en: `${head.en} (Instagram): ${who}\n${reason}\nReply from the inbox, then mark it resolved.`,
        th: `${head.th} (Instagram): ${who}\n${reason}\nตอบจากกล่องข้อความ แล้วกดว่าเสร็จแล้ว`,
      },
    },
    s.now,
  );
  return 'handoff';
}

/**
 * Posts one bot message into the guest's Chatwoot conversation (as the Agent Bot when it has a
 * token) and stores it as an outbound `messages` row on the club's Instagram channel. A failed post
 * is stored as `failed` with Chatwoot's error. Returns whether Chatwoot took it.
 */
async function send(s: Session, content: string): Promise<boolean> {
  const { db } = s.deps;
  const cwState = await chatwootState(db, s.club.id);
  const prefix = cwState?.accountId ? chatwootConversationRef(cwState.accountId, '') : null;
  const cwConversationId = prefix && s.conv.externalRef?.startsWith(prefix) ? Number(s.conv.externalRef.slice(prefix.length)) : NaN;
  const [channel] = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.clubId, s.club.id), eq(channels.kind, 'instagram'))).limit(1);
  const row = {
    id: newId(),
    clubId: s.club.id,
    guestId: s.guest.id,
    direction: 'out' as const,
    kind: 'text',
    payload: { type: 'text', text: content },
    authorType: 'bot' as const,
    channelId: channel?.id ?? null,
    occurredAt: s.now,
  };
  try {
    if (!cwState?.accountId || !cwState.adminTokenEnc || !Number.isInteger(cwConversationId) || cwConversationId <= 0) {
      throw new Error('no Chatwoot conversation for this Instagram guest');
    }
    const token = decryptSecret(cwState.botTokenEnc ?? cwState.adminTokenEnc, s.deps.key);
    const cwMessageId = await chatwootAccount(s.deps.cw!, cwState.accountId, token).createMessage(cwConversationId, { content, messageType: 'outgoing' });
    await db.insert(messages).values({
      ...row,
      sentVia: 'push',
      deliveryStatus: 'sent',
      externalId: cwMessageId ? `cw:${cwState.accountId}:${cwMessageId}` : null,
    });
    return true;
  } catch (err) {
    s.deps.log(`Instagram reply failed for club ${s.club.id}`, err);
    await db.insert(messages).values({ ...row, sentVia: 'none', deliveryStatus: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    return false;
  }
}
