import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { webhook } from '@line/bot-sdk';
import { and, eq, inArray } from 'drizzle-orm';
import {
  abandonUnfinished as abandonUnfinishedBookings,
  availableTables,
  BookingError,
  bookingAwaitingSlip,
  cancelBooking,
  currentBookingForGuest,
  RUNNING_LATE_MINUTES,
  setRunningLate,
  getBookingView,
  holdTable,
  isNightOpen,
  paxRange,
  recordSlip,
  requestDeposit,
  SELF_BOOK_MAX_PAX,
  bookableNights,
} from '../bookings/service.js';
import { verifySlip, type SlipVerifier } from '../bookings/slip-verify.js';
import { startGatewayDeposit, type PaymentGateways } from '../integrations/payments/gateway.js';
import type { Db } from '../db/client.js';
import { isUniqueViolation } from '../db/client.js';
import {
  bookings,
  conversations,
  guests,
  messages as messagesTable,
  tables as tablesTable,
  platformFlags,
  type Club,
  type Conversation,
  type Guest,
} from '../db/schema.js';
import { GLOBAL_STOP_FLAG, isGloballyStopped } from '../platform/support.js';
import type { LineGateway, Message } from '../line/gateway.js';
import type { Outbox } from '../line/outbox.js';
import { formatClock, formatNight } from '../lib/time.js';
import { releaseAt } from '../jobs/no-show.js';
import { newId } from '../lib/util.js';
import { langOf, t, type Lang } from './i18n.js';
import { detectIntent, testerCodeIn } from './intents.js';
import { emit } from '../data/events.js';
import { recordMarketingOptOut, requestRemoval } from '../data/removal.js';
import { startEpisode, type HandoffTrigger } from '../chat/episodes.js';
import { getConversationForClub } from '../chat/conversations.js';
import { isTestContext, isTestGuestAtCreate, redeemTesterCode } from '../data/test-flag.js';
import type { Links } from './links.js';
import * as M from './messages.js';
import { handleStaffLink } from './staff-link.js';
import { answerGuestMessage, extractContext, type ModelClient } from '../brain/answer.js';
import { extractBookingDetails, hasBookingDetails, looksLikeBookingRequest, paxKeyFor, type BookingDetails } from '../brain/extract.js';

export interface BotDeps {
  db: Db;
  outbox: Outbox;
  links: Links;
  uploadsDir: string;
  now: () => Date;
  log: (msg: string, err?: unknown) => void;
  /** B16: AI answers for free text; null or absent keeps the keyword rules and the menu. */
  ai?: ModelClient | null;
  /** B9: automatic slip verification; absent or null = every slip goes to staff review. */
  slipVerifier?: SlipVerifier | null;
  /** A20b: payment gateways; the first one takes the deposit when the club's `payment_gateway` switch is on. */
  payments?: PaymentGateways;
}

interface Turn {
  deps: BotDeps;
  club: Club;
  gateway: LineGateway;
  guest: Guest;
  conv: Conversation;
  lang: Lang;
  now: Date;
  replyToken?: string;
  /** The inbound `messages` row of this turn (B14b: the first message of a takeover). */
  inboundId?: string;
}

/** Sends to the guest. The reply token is single-use, so later sends in the same turn are pushes. */
async function send(turn: Turn, msgs: Message[]) {
  const replyToken = turn.replyToken;
  turn.replyToken = undefined;
  await turn.deps.outbox.toGuest(turn.gateway, turn.club, turn.guest, msgs, replyToken);
}

const staff = (turn: Pick<Turn, 'deps' | 'gateway' | 'club'>, msgs: Message[]) =>
  turn.deps.outbox.toStaff(turn.gateway, turn.club, msgs);

// ---------- Entry point ----------

/** Handles one LINE webhook event for one club. Never throws: errors are logged (kept for `http/dev.ts`). */
export async function handleEvent(deps: BotDeps, club: Club, gateway: LineGateway, event: webhook.Event): Promise<void> {
  try {
    await processEvent(deps, club, gateway, event);
  } catch (err) {
    deps.log(`Bot error for club ${club.id}`, err);
  }
}

export interface ProcessEventOptions {
  /** Dry-run replay (B3): run the turn even when this event's turn already completed. */
  ignoreDedupe?: boolean;
}

/**
 * One LINE webhook event (plan B3). Throws, so `processDelivery` can record the error on the raw
 * row. Dedupe is per `webhookEventId`: an event whose inbound row has `processed_at` set is skipped;
 * an inbound row with `processed_at` NULL is a turn that crashed, so the row is reused and the turn runs.
 */
export async function processEvent(
  deps: BotDeps,
  club: Club,
  gateway: LineGateway,
  event: webhook.Event,
  opts: ProcessEventOptions = {},
): Promise<void> {
  if (event.source?.type === 'group') {
    await handleGroupEvent(deps, club, gateway, event);
    return;
  }
  if (event.source?.type !== 'user' || !event.source.userId) return;
  if (event.type !== 'message' && event.type !== 'postback' && event.type !== 'follow' && event.type !== 'unfollow') return;

  const now = deps.now();
  const guest = await upsertGuest(deps.db, gateway, club, event.source.userId);
  const inbound = await logInbound(deps.db, club, guest, event);
  if (inbound.processedAt && !opts.ignoreDedupe) return; // redelivery of a finished turn
  await runTurn(deps, club, gateway, event, guest, now, inbound.id);
  // Last step of a completed turn: a later redelivery of this event is a no-op.
  await deps.db.update(messagesTable).set({ processedAt: deps.now() }).where(eq(messagesTable.id, inbound.id));
}

/**
 * The bot pause in force, if any (B3): `club:<bot_paused_at>` for a club pause, `global:<updated_at>`
 * for the platform-wide stop. The key names one pause, so the staff alert goes out once per pause.
 */
async function activePause(db: Db, club: Club): Promise<string | null> {
  if (club.botPaused) return `club:${club.botPausedAt?.toISOString() ?? 'unknown'}`;
  if (!(await isGloballyStopped(db))) return null;
  const flag = await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, GLOBAL_STOP_FLAG) });
  return `global:${flag?.updatedAt.toISOString() ?? 'unknown'}`;
}

type GuestEvent = webhook.MessageEvent | webhook.PostbackEvent | webhook.FollowEvent | webhook.UnfollowEvent;

async function runTurn(deps: BotDeps, club: Club, gateway: LineGateway, event: GuestEvent, guestIn: Guest, now: Date, inboundId?: string) {
  let guest = guestIn;
  if (event.type === 'unfollow') {
    // Guest blocked the club's account: stop pushing to them (it would fail and waste quota).
    await deps.db.update(guests).set({ unfollowedAt: now, updatedAt: now }).where(eq(guests.id, guest.id));
    return;
  }
  if (guest.unfollowedAt) {
    [guest] = (await deps.db
      .update(guests)
      .set({ unfollowedAt: null, updatedAt: now })
      .where(eq(guests.id, guest.id))
      .returning()) as [Guest];
  }
  let conv = await getConversation(deps.db, club, guest);
  const turn: Turn = {
    deps,
    club,
    gateway,
    guest,
    conv,
    lang: langOf(guest.lang),
    now,
    replyToken: 'replyToken' in event ? event.replyToken : undefined,
    inboundId,
  };

  // B3 bot pause (club pause or global stop): the inbound row is stored, the guest gets nothing,
  // and the staff group is alerted once per conversation per pause.
  const pause = await activePause(deps.db, club);
  if (pause) {
    if (conv.state.pauseAlertedFor !== pause) {
      const who = guest.name ?? guest.displayName ?? 'A guest';
      await staff(turn, [
        M.plain(`Bot is paused: ${who} sent a message and got no automatic reply. Please answer from the inbox.\nบอทหยุดชั่วคราว: ${who} ส่งข้อความมาและยังไม่ได้รับคำตอบ กรุณาตอบจากกล่องข้อความ`),
      ]);
      await updateConversation(deps.db, conv.id, { state: { ...conv.state, pauseAlertedFor: pause } });
    }
    return;
  }

  if (event.type === 'follow') {
    await send(turn, M.greeting(club, turn.lang));
    return;
  }

  // Human handoff: the bot stays quiet until staff resolve it or the B14b timeout job hands it back.
  // B10b (spec §5.5): a marketing opt-out applies at once, so a typed stop is recorded silently
  // (the host sees the message), and a tap on the bot's own stop or remove-confirm button still works.
  if (conv.mode === 'human') {
    if (event.type === 'message' && event.message.type === 'text' && detectIntent(event.message.text).kind === 'stop_marketing') {
      await recordMarketingOptOut(deps.db, club, guest, now);
    } else if (event.type === 'postback') {
      const a = new URLSearchParams(event.postback.data).get('a');
      if (a === 'stop' || a === 'remove_confirm') await handlePostback(turn, event.postback.data, event.postback.params);
    }
    return;
  }

  if (event.type === 'postback') {
    await handlePostback(turn, event.postback.data, event.postback.params);
    return;
  }

  const m = event.message;
  if (m.type === 'text') await handleText(turn, m.text);
  else if (m.type === 'image') await handleImage(turn, m.id);
  else await send(turn, [M.menu(club, turn.lang)]);
}

// ---------- Staff group linking ----------

async function handleGroupEvent(deps: BotDeps, club: Club, gateway: LineGateway, event: webhook.Event) {
  if (event.type === 'join' && event.replyToken) {
    await gateway.reply(event.replyToken, [
      M.plain(
        `Hi! To get ${club.name} booking alerts in this group, a manager presses "Issue link code" on the dashboard's Setup page and types "link" followed by that code here.\nผู้จัดการกด "Issue link code" ในหน้า Setup ของแดชบอร์ด แล้วพิมพ์ "link" ตามด้วยรหัสนั้นในกลุ่มนี้ เพื่อรับการแจ้งเตือนการจอง`,
      ),
    ]);
    return;
  }
  if (event.type !== 'message' || event.message.type !== 'text' || event.source?.type !== 'group') return;
  const intent = detectIntent(event.message.text);
  if (intent.kind !== 'staff_link') return;
  // B5: the typed code is compared with the stored hash (never `club.staffLinkCode`) and never logged.
  const result = await handleStaffLink(
    deps.db,
    club,
    gateway,
    { groupId: event.source.groupId, code: intent.code, replyToken: event.replyToken },
    deps.now(),
  );
  if (result !== 'ignored') deps.log(`Staff group link ${result} for club ${club.id}`);
}

// ---------- Text ----------

async function handleText(turn: Turn, text: string) {
  // B6: at an onboarding club, the one-time tester code marks this guest as a tester.
  const testerCode = turn.club.status === 'onboarding' ? testerCodeIn(text) : null;
  if (testerCode) {
    const tester = await redeemTesterCode(turn.deps.db, turn.club, turn.guest, testerCode, turn.now);
    if (tester) {
      turn.guest = tester;
      await send(turn, [
        M.plain(
          'Tester registered. Your bookings and messages here are test data.\nลงทะเบียนผู้ทดสอบแล้ว การจองและข้อความของคุณที่นี่เป็นข้อมูลทดสอบ',
          M.menuQuickReplies(turn.club, turn.lang),
        ),
      ]);
      return;
    }
  }
  const intent = detectIntent(text);
  switch (intent.kind) {
    case 'details_sent': {
      const view = await getBookingView(turn.deps.db, { clubId: turn.club.id, refCode: intent.ref });
      if (view && view.booking.guestId === turn.guest.id) {
        await sendReview(turn, view.booking.id);
        return;
      }
      await send(turn, [M.menu(turn.club, turn.lang)]);
      return;
    }
    case 'handoff':
      await requestHandoff(turn, 'guest_request', `Guest said: "${text.slice(0, 120)}"`);
      return;
    case 'my_booking':
      await showMyBooking(turn);
      return;
    case 'book': {
      // B16: "โต๊ะ 6 คน เสาร์นี้" jumps past the steps the guest already answered.
      const details = extractBookingDetails(text, await extractContext(turn.deps.db, turn.club, turn.now));
      if (hasBookingDetails(details)) await prefillBooking(turn, details);
      else await startBooking(turn);
      return;
    }
    case 'location':
      await send(turn, [M.plain(`${turn.club.settings.address}\n${turn.club.settings.mapUrl}`, M.menuQuickReplies(turn.club, turn.lang))]);
      return;
    case 'remove_data':
      await send(turn, [M.removeConfirm(turn.lang)]);
      return;
    case 'stop_marketing':
      await optOutMarketing(turn);
      return;
    default:
      await handleFreeText(turn, text);
  }
}

// ---------- B10b: data removal and marketing opt-out ----------

async function optOutMarketing(turn: Turn) {
  await recordMarketingOptOut(turn.deps.db, turn.club, turn.guest, turn.now);
  await send(turn, [M.plain(t(turn.lang, 'optedOut'), M.menuQuickReplies(turn.club, turn.lang))]);
}

async function confirmRemoval(turn: Turn) {
  await requestRemoval(turn.deps.db, turn.club, turn.guest, turn.now);
  await send(turn, [M.plain(t(turn.lang, 'removeRequested'))]);
}

// ---------- Postbacks ----------

async function handlePostback(turn: Turn, data: string, params?: webhook.PostbackContent['params']) {
  const p = new URLSearchParams(data);
  switch (p.get('a')) {
    case 'book':
      await startBooking(turn, { force: true });
      return;
    case 'restart':
      await abandonUnfinished(turn);
      await startBooking(turn, { force: true });
      return;
    case 'continue':
      await continueBooking(turn, p.get('b') ?? '');
      return;
    case 'night':
      await chooseNight(turn, p.get('d') ?? '');
      return;
    case 'night_pick':
      await chooseNight(turn, (params as { date?: string } | undefined)?.date ?? '');
      return;
    case 'pax':
      await choosePax(turn, p.get('r') ?? '');
      return;
    case 'table':
      await chooseTable(turn, p.get('t') ?? '', p.get('d') ?? turn.conv.state.nightDate ?? '');
      return;
    case 'confirm':
      await confirm(turn, p.get('b') ?? '');
      return;
    case 'my':
      await showMyBooking(turn);
      return;
    case 'host':
      await requestHandoff(turn, 'guest_request', 'Guest tapped "Talk to a host"');
      return;
    case 'privacy':
      await send(turn, [M.myData(turn.lang)]);
      return;
    case 'stop':
      await optOutMarketing(turn);
      return;
    case 'remove':
      await send(turn, [M.removeConfirm(turn.lang)]);
      return;
    case 'remove_confirm':
      await confirmRemoval(turn);
      return;
    case 'late': // B10
      await runningLate(turn, p.get('b') ?? '', p.get('m'));
      return;
    case 'cancel': // B10
      await guestCancel(turn, p.get('b') ?? '', false);
      return;
    case 'cancel_yes': // B10
      await guestCancel(turn, p.get('b') ?? '', true);
      return;
    default:
      await send(turn, [M.menu(turn.club, turn.lang)]);
  }
}

// ---------- B10: running late and guest cancel ----------

/** The guest's own confirmed booking, or undefined (another guest's id, another club's, or not confirmed). */
async function ownConfirmed(turn: Turn, bookingId: string) {
  const view = await getBookingView(turn.deps.db, { clubId: turn.club.id, id: bookingId });
  if (!view || view.booking.guestId !== turn.guest.id || view.booking.status !== 'confirmed') return undefined;
  return view;
}

async function cannotChange(turn: Turn) {
  await send(turn, [M.plain(t(turn.lang, 'cannotChangeBooking'), M.menuQuickReplies(turn.club, turn.lang))]);
}

/** Spec §5.2 step 8: [15 min] [30 min] [1 hr]; the host is alerted and the release time moves when the club allows. */
async function runningLate(turn: Turn, bookingId: string, minutesParam: string | null) {
  const view = await ownConfirmed(turn, bookingId);
  if (!view) return cannotChange(turn);
  const minutes = Number(minutesParam);
  if (!(RUNNING_LATE_MINUTES as readonly number[]).includes(minutes)) {
    await send(turn, [M.askLate(turn.lang, bookingId)]);
    return;
  }
  const actor = { type: 'guest' as const, id: turn.guest.id };
  const updated = await setRunningLate(turn.deps.db, turn.club.id, bookingId, actor, minutes, turn.now);
  const until = formatClock(releaseAt(turn.club, updated));
  await send(turn, [M.plain(t(turn.lang, 'lateNoted', { code: view.table.code, time: until }), M.menuQuickReplies(turn.club, turn.lang))]);
  await staff(turn, [M.staffRunningLate({ ...view, booking: updated }, minutes, until)]);
}

/** Spec §5.2 step 8: the policy is shown first; on confirm the booking is cancelled and the host alerted. */
async function guestCancel(turn: Turn, bookingId: string, confirmed: boolean) {
  const view = await ownConfirmed(turn, bookingId);
  if (!view) return cannotChange(turn);
  if (!confirmed) {
    await send(turn, [M.cancelAsk(turn.club, turn.lang, view)]);
    return;
  }
  try {
    await cancelBooking(turn.deps.db, turn.club.id, bookingId, { type: 'guest', id: turn.guest.id }, { code: 'guest_cancelled', text: 'Guest cancelled in chat' }, turn.now);
  } catch (err) {
    if (err instanceof BookingError) return cannotChange(turn);
    throw err;
  }
  await send(turn, [
    M.plain(t(turn.lang, 'cancelledByGuest', { ref: view.booking.refCode, night: formatNight(view.booking.nightDate, turn.lang) }), M.menuQuickReplies(turn.club, turn.lang)),
  ]);
  await staff(turn, [M.staffGuestCancelled(view)]);
}

// ---------- Booking steps ----------

async function startBooking(turn: Turn, opts: { force?: boolean } = {}) {
  const current = await currentBookingForGuest(turn.deps.db, turn.club, turn.guest.id, turn.now);
  if (current) {
    const view = (await getBookingView(turn.deps.db, { clubId: turn.club.id, id: current.id }))!;
    if (current.status === 'held' || current.status === 'awaiting_payment') {
      if (!opts.force) {
        // Repeated "book a table" never gets silence: offer to continue (spec §5.3).
        await send(turn, [M.inProgress(turn.lang, view.table.code, current.nightDate, current.id)]);
        return;
      }
    } else {
      await send(turn, [M.alreadyBooked(turn.club, turn.lang, view)]);
      return;
    }
  }
  const nights = await bookableNights(turn.deps.db, turn.club, turn.now, 4);
  await send(turn, [M.askNight(turn.club, turn.lang, nights, turn.now)]);
}

async function abandonUnfinished(turn: Turn) {
  // B2: each abandoned booking gets its history row, audit row and events.
  await abandonUnfinishedBookings(turn.deps.db, turn.club.id, turn.guest.id, turn.now);
}

async function continueBooking(turn: Turn, bookingId: string) {
  const view = await getBookingView(turn.deps.db, { clubId: turn.club.id, id: bookingId });
  if (!view || view.booking.guestId !== turn.guest.id) return startBooking(turn, { force: true });
  const b = view.booking;
  const expired = b.holdExpiresAt && b.holdExpiresAt <= turn.now;
  if (b.status === 'held' && !expired) {
    if (!b.rulesAcceptedAt) await send(turn, [M.held(turn.club, turn.lang, view, turn.deps.links.details(turn.club, b, turn.now))]);
    else await sendReview(turn, b.id);
    return;
  }
  if (b.status === 'awaiting_payment' && !expired) {
    // A gateway deposit gets its same charge again (createCharge is idempotent per deposit).
    if (view.deposit?.method === 'gateway' && (await sendGatewayPayment(turn, b.id))) return;
    await send(turn, M.payment(turn.club, turn.lang, view, turn.deps.links.promptpayQr(turn.club, b)));
    return;
  }
  await startBooking(turn, { force: true });
}

/** Where the provider sends the guest after paying: back into LINE, where the confirmation arrives. */
export const PAYMENT_RETURN_URL = 'https://line.me/R/';

/**
 * A20b: when the club's `payment_gateway` switch is on and a gateway is configured, opens (or
 * re-opens) the charge and sends the guest the payment link. Returns false when the caller should
 * keep the PromptPay slip flow: switch off, no gateway, nothing to pay, or the provider failed.
 * Booking errors (hold expired, details missing) are rethrown for the caller.
 */
async function sendGatewayPayment(turn: Turn, bookingId: string): Promise<boolean> {
  const gateway = Object.values(turn.deps.payments ?? {})[0];
  if (!gateway) return false;
  let charge;
  try {
    charge = await startGatewayDeposit(turn.deps.db, turn.club, gateway, bookingId, PAYMENT_RETURN_URL, turn.now);
  } catch (err) {
    if (err instanceof BookingError) throw err;
    turn.deps.log(`Payment gateway ${gateway.provider} failed; falling back to the slip flow`, err);
    return false;
  }
  if (!charge) return false;
  const view = await getBookingView(turn.deps.db, { clubId: turn.club.id, id: bookingId });
  if (!view) return false;
  await send(turn, [M.paymentLink(turn.club, turn.lang, view, charge.payUrl)]);
  return true;
}

async function chooseNight(turn: Turn, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(await isNightOpen(turn.deps.db, turn.club, date, turn.now))) {
    const nights = await bookableNights(turn.deps.db, turn.club, turn.now, 4);
    await send(turn, [
      M.plain(t(turn.lang, 'nightClosed', { night: /^\d{4}-\d{2}-\d{2}$/.test(date) ? formatNight(date, turn.lang) : date })),
      M.askNight(turn.club, turn.lang, nights, turn.now),
    ]);
    return;
  }
  turn.conv = await updateConversation(turn.deps.db, turn.conv.id, { state: { nightDate: date } });
  await send(turn, [M.askPax(turn.lang, date)]);
}

async function choosePax(turn: Turn, key: string) {
  const range = paxRange(key);
  const nightDate = turn.conv.state.nightDate;
  if (!range || !nightDate) return startBooking(turn, { force: true });
  if (range.min > SELF_BOOK_MAX_PAX) {
    await send(turn, [M.plain(t(turn.lang, 'bigGroup'))]);
    await requestHandoff(turn, 'large_group', `Large group (13+) for ${formatNight(nightDate, 'en')}`, { silent: true });
    return;
  }
  turn.conv = await updateConversation(turn.deps.db, turn.conv.id, { state: { nightDate, paxRange: key } });
  await sendTables(turn, nightDate, key);
}

async function sendTables(turn: Turn, nightDate: string, key: string, prefix: Message[] = []) {
  const range = paxRange(key)!;
  const label = `${range.min}–${range.max}`;
  const options = await availableTables(turn.deps.db, turn.club.id, nightDate, range, turn.now, {
    isTest: isTestContext({ club: turn.club, guest: turn.guest }),
  });
  if (options.length === 0) {
    await send(turn, [...prefix, M.noTables(turn.lang, nightDate, label)]);
    return;
  }
  await send(turn, [...prefix, ...M.tablesCarousel(turn.club, turn.lang, options, nightDate, label)]);
}

async function chooseTable(turn: Turn, tableId: string, nightDate: string, guestPax?: number) {
  const key = turn.conv.state.paxRange ?? '2-4';
  const range = paxRange(key)!;
  try {
    const booking = await holdTable(
      turn.deps.db,
      turn.club,
      { guestId: turn.guest.id, tableId, nightDate, pax: guestPax ?? (range.max > SELF_BOOK_MAX_PAX ? range.min : range.max) },
      turn.now,
    );
    const view = (await getBookingView(turn.deps.db, { clubId: turn.club.id, id: booking.id }))!;
    await send(turn, [M.held(turn.club, turn.lang, view, turn.deps.links.details(turn.club, booking, turn.now))]);
  } catch (err) {
    if (err instanceof BookingError && err.code === 'table_taken') {
      const code = tableId.split('_').pop() ?? '';
      await sendTables(turn, nightDate, key, [M.plain(t(turn.lang, 'tableTaken', { code }))]);
      return;
    }
    if (err instanceof BookingError && (err.code === 'night_not_bookable' || err.code === 'not_found')) {
      await startBooking(turn, { force: true });
      return;
    }
    throw err;
  }
}

/** After the guest submitted the details form: show the summary with the confirm button. */
export async function sendReview(turn: Pick<Turn, 'deps' | 'club' | 'gateway' | 'guest' | 'lang' | 'replyToken'>, bookingId: string) {
  const view = await getBookingView(turn.deps.db, { clubId: turn.club.id, id: bookingId });
  if (!view) return;
  const replyToken = turn.replyToken;
  turn.replyToken = undefined;
  await turn.deps.outbox.toGuest(turn.gateway, turn.club, turn.guest, [M.review(turn.club, turn.lang, view)], replyToken);
}

async function confirm(turn: Turn, bookingId: string) {
  const view = await getBookingView(turn.deps.db, { clubId: turn.club.id, id: bookingId });
  if (!view || view.booking.guestId !== turn.guest.id) return startBooking(turn, { force: true });
  try {
    if (view.booking.depositSatang > 0 && (await sendGatewayPayment(turn, bookingId))) return;
    const booking = await requestDeposit(turn.deps.db, turn.club, bookingId, turn.now);
    const fresh = (await getBookingView(turn.deps.db, { clubId: turn.club.id, id: booking.id }))!;
    if (booking.status === 'confirmed') {
      await send(turn, [M.confirmation(turn.club, turn.lang, fresh, turn.deps.links.pass(booking))]);
      await staff(turn, [M.staffNewBooking(fresh, 'confirmed')]);
      return;
    }
    await send(turn, M.payment(turn.club, turn.lang, fresh, turn.deps.links.promptpayQr(turn.club, booking)));
  } catch (err) {
    if (err instanceof BookingError && err.code === 'hold_expired') {
      const nights = await bookableNights(turn.deps.db, turn.club, turn.now, 4);
      await send(turn, [M.plain(t(turn.lang, 'holdExpiredOnConfirm')), M.askNight(turn.club, turn.lang, nights, turn.now)]);
      return;
    }
    if (err instanceof BookingError && err.code === 'details_missing') {
      await send(turn, [M.held(turn.club, turn.lang, view, turn.deps.links.details(turn.club, view.booking, turn.now))]);
      return;
    }
    if (err instanceof BookingError && err.code === 'invalid_state') {
      await showMyBooking(turn);
      return;
    }
    throw err;
  }
}

// ---------- Slips ----------

function imageExtension(buf: Buffer): 'jpg' | 'png' | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  return null;
}

const MAX_SLIP_BYTES = 10 * 1024 * 1024;

async function handleImage(turn: Turn, messageId: string) {
  const booking = await bookingAwaitingSlip(turn.deps.db, turn.club.id, turn.guest.id, turn.now);
  if (!booking) {
    await send(turn, [M.plain(t(turn.lang, 'slipWithoutBooking'), M.menuQuickReplies(turn.club, turn.lang))]);
    return;
  }
  if (turn.guest.lineUserId) await turn.gateway.loading(turn.guest.lineUserId);
  const data = await turn.gateway.getContent(messageId);
  const ext = imageExtension(data);
  if (!ext || data.length > MAX_SLIP_BYTES) {
    await send(turn, [M.plain(t(turn.lang, 'slipWithoutBooking'), M.menuQuickReplies(turn.club, turn.lang))]);
    return;
  }
  const dir = join(turn.deps.uploadsDir, turn.club.id);
  await mkdir(dir, { recursive: true });
  const relPath = join(turn.club.id, `${booking.id}-${turn.now.getTime()}.${ext}`);
  await writeFile(join(turn.deps.uploadsDir, relPath), data);

  // Read before recordSlip clears holdExpiresAt: a hold that ran out but that the 30 s sweep has
  // not expired yet is still a late slip (spec §5.2 step 6).
  const lateSlip = booking.status === 'expired' || (booking.holdExpiresAt !== null && booking.holdExpiresAt <= turn.now);
  const { tableLost } = await recordSlip(turn.deps.db, turn.club, booking.id, relPath, turn.now);
  // B9 (spec §11.2): verify automatically; a pass confirms, anything else stays in payment review.
  if (!tableLost && turn.deps.slipVerifier) {
    let verified = false;
    try {
      const out = await verifySlip(turn.deps.db, turn.club, booking.id, data, turn.deps.slipVerifier, turn.now, {
        lateSlip,
      });
      verified = out.verified;
    } catch (err) {
      turn.deps.log(`slip verification failed for booking ${booking.id}`, err);
    }
    if (verified) {
      const confirmed = (await getBookingView(turn.deps.db, { clubId: turn.club.id, id: booking.id }))!;
      await send(turn, [M.confirmation(turn.club, turn.lang, confirmed, turn.deps.links.pass(confirmed.booking))]);
      await staff(turn, [M.staffNewBooking(confirmed, 'confirmed')]);
      return;
    }
  }
  await send(turn, [M.plain(t(turn.lang, tableLost ? 'slipTableLost' : 'slipReceived'))]);
  const view = (await getBookingView(turn.deps.db, { clubId: turn.club.id, id: booking.id }))!;
  await staff(turn, [M.staffNewBooking(view, 'review')]);
  if (tableLost) await requestHandoff(turn, 'paid_after_expiry', 'Paid after hold expired; table was taken. Reassign or refund.', { silent: true });
}

// ---------- My booking / handoff ----------

async function showMyBooking(turn: Turn) {
  const current = await currentBookingForGuest(turn.deps.db, turn.club, turn.guest.id, turn.now);
  if (!current) {
    await send(turn, [M.plain(t(turn.lang, 'noBooking'), M.menuQuickReplies(turn.club, turn.lang))]);
    return;
  }
  const view = (await getBookingView(turn.deps.db, { clubId: turn.club.id, id: current.id }))!;
  if (current.status === 'confirmed') {
    // B10: My booking offers [Running late] [Cancel] [Talk to a host] (spec §5.3).
    const card = M.confirmation(turn.club, turn.lang, view, turn.deps.links.pass(current));
    await send(turn, [{ ...card, quickReply: { items: M.bookingActions(turn.lang, current.id) } } as Message]);
    return;
  }
  if (current.status === 'held' || current.status === 'awaiting_payment') {
    await send(turn, [M.inProgress(turn.lang, view.table.code, current.nightDate, current.id)]);
    return;
  }
  await send(turn, [M.alreadyBooked(turn.club, turn.lang, view)]);
}

// ---------- AI answers (B16) ----------

/**
 * Free text the keyword rules did not route. Booking details found by the deterministic pass jump
 * into the flow with no model call ("17A sat 6ppl"); otherwise the AI answers from the club brain.
 */
async function handleFreeText(turn: Turn, text: string) {
  const ctx = await extractContext(turn.deps.db, turn.club, turn.now);
  const details = extractBookingDetails(text, ctx);
  if (looksLikeBookingRequest(details)) return prefillBooking(turn, details);
  const ai = turn.deps.ai;
  if (!ai) {
    await send(turn, [M.menu(turn.club, turn.lang)]);
    return;
  }
  const out = await answerGuestMessage(
    { db: turn.deps.db, client: ai, log: turn.deps.log },
    { club: turn.club, guest: turn.guest, conv: turn.conv, lang: turn.lang },
    text,
    turn.now,
  );
  switch (out.kind) {
    case 'answer':
      await send(turn, [M.plain(out.text, M.menuQuickReplies(turn.club, out.lang))]);
      return;
    case 'menu':
      await send(turn, [M.menu(turn.club, turn.lang)]);
      return;
    case 'booking':
      await prefillBooking(turn, out.details);
      return;
    case 'my_booking':
      await showMyBooking(turn);
      return;
    case 'handoff': {
      const why: Record<typeof out.reason, string> = {
        ai_cost_cap: 'AI cost cap reached',
        ai_unavailable: 'AI unavailable',
        faq_missed: 'Bot has no answer',
        guard: 'Bot answer blocked (price or availability)',
        guest_request: 'Guest asked for a host',
      };
      const reason = `${why[out.reason]}: "${text.slice(0, 120)}"${out.summary ? `\n${out.summary}` : ''}`;
      await requestHandoff(turn, out.reason, reason, { topic: out.topic ?? out.reason });
      return;
    }
  }
}

/** Jumps to the first booking step the details do not answer (spec §8.1). */
async function prefillBooking(turn: Turn, d: BookingDetails) {
  const current = await currentBookingForGuest(turn.deps.db, turn.club, turn.guest.id, turn.now);
  if (current || !d.date) return startBooking(turn);
  if (!d.pax || !(await isNightOpen(turn.deps.db, turn.club, d.date, turn.now))) return chooseNight(turn, d.date);
  const key = paxKeyFor(d.pax);
  turn.conv = await updateConversation(turn.deps.db, turn.conv.id, { state: { nightDate: d.date } });
  const table = d.tableCode
    ? await turn.deps.db.query.tables.findFirst({ where: and(eq(tablesTable.clubId, turn.club.id), eq(tablesTable.code, d.tableCode)) })
    : undefined;
  // A named table that is inactive or too small falls back to the table list for the party size.
  if (!table || !table.active || d.pax > table.maxPax || paxRange(key)!.min > SELF_BOOK_MAX_PAX) return choosePax(turn, key);
  turn.conv = await updateConversation(turn.deps.db, turn.conv.id, { state: { nightDate: d.date, paxRange: key } });
  await chooseTable(turn, table.id, d.date, d.pax);
}

/**
 * B14b: the takeover is a `handoff_episodes` row started in `chat/episodes.ts`; `trigger` is its code.
 * B16: `topic` is the AI's takeover topic (absent, the episode's topic is the trigger code).
 */
async function requestHandoff(turn: Turn, trigger: HandoffTrigger, reason: string, opts: { silent?: boolean; topic?: string } = {}) {
  await turn.deps.db.transaction((tx) =>
    startEpisode(tx, {
      clubId: turn.club.id,
      conversationId: turn.conv.id,
      trigger,
      reason,
      topic: opts.topic ?? null,
      firstMessageId: turn.inboundId ?? null,
      now: turn.now,
    }),
  );
  turn.conv = (await getConversationForClub(turn.deps.db, turn.club.id, turn.conv.id))!;
  if (!opts.silent) await send(turn, [M.plain(t(turn.lang, 'handoffAck'))]);

  const current = await currentBookingForGuest(turn.deps.db, turn.club, turn.guest.id, turn.now);
  let summary = reason;
  if (current) {
    const v = (await getBookingView(turn.deps.db, { clubId: turn.club.id, id: current.id }))!;
    summary += `\nBooking: ${v.table.code} · ${formatNight(current.nightDate, 'en')} · ${current.status} · ${current.refCode}`;
  } else if (turn.conv.state.nightDate) {
    summary += `\nWas looking at ${formatNight(turn.conv.state.nightDate, 'en')}${turn.conv.state.paxRange ? `, ${turn.conv.state.paxRange} guests` : ''}`;
  }
  await staff(turn, [M.staffHandoff(turn.guest.name ?? turn.guest.displayName ?? 'Guest', summary)]);
}

// ---------- Persistence helpers ----------

async function upsertGuest(db: Db, gateway: LineGateway, club: Club, lineUserId: string): Promise<Guest> {
  const found = await db.query.guests.findFirst({
    where: and(eq(guests.clubId, club.id), eq(guests.lineUserId, lineUserId)),
  });
  if (found) return found;
  const profile = await gateway.getProfile(lineUserId);
  try {
    return await db.transaction(async (tx) => {
      const [g] = await tx
        .insert(guests)
        .values({
          id: newId(),
          clubId: club.id,
          lineUserId,
          displayName: profile?.displayName ?? null,
          lang: langOf(profile?.language),
          // B6: simulator (`SIM-`) guests and every guest of a demo club are test rows.
          isTest: isTestGuestAtCreate(club, lineUserId),
        })
        .returning();
      await emit(tx, {
        clubId: club.id,
        type: 'guest.first_seen',
        occurredAt: new Date(),
        actorType: 'guest',
        actorId: g!.id,
        channel: 'line',
        dataOrigin: 'line_chat',
        guestId: g!.id,
        isTest: isTestContext({ club, guest: g }),
        dedupeKey: `guest.first_seen:${g!.id}`,
      });
      return g!;
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return (await db.query.guests.findFirst({
      where: and(eq(guests.clubId, club.id), eq(guests.lineUserId, lineUserId)),
    }))!;
  }
}

/**
 * Records the inbound event and returns its row. Idempotent on `(club_id, line_message_id)`: a
 * redelivered event returns the row stored the first time (B3: the caller reads its `processed_at`).
 * Uses ON CONFLICT DO NOTHING, never a caught unique violation, so it is safe inside a transaction.
 */
async function logInbound(db: Db, club: Club, guest: Guest, event: webhook.Event): Promise<{ id: string; processedAt: Date | null }> {
  const kind = event.type === 'message' ? event.message.type : event.type;
  const payload =
    event.type === 'message'
      ? event.message.type === 'text'
        ? { text: event.message.text }
        : { type: event.message.type }
      : event.type === 'postback'
        ? { data: event.postback.data, params: event.postback.params ?? null }
        : {};
  const [row] = await db
    .insert(messagesTable)
    .values({
      id: newId(),
      clubId: club.id,
      guestId: guest.id,
      direction: 'in',
      kind,
      payload,
      lineMessageId: event.webhookEventId,
    })
    .onConflictDoNothing()
    .returning({ id: messagesTable.id, processedAt: messagesTable.processedAt });
  if (row) return row;
  const [found] = await db
    .select({ id: messagesTable.id, processedAt: messagesTable.processedAt })
    .from(messagesTable)
    .where(and(eq(messagesTable.clubId, club.id), eq(messagesTable.lineMessageId, event.webhookEventId)))
    .limit(1);
  return found!;
}

async function getConversation(db: Db, club: Club, guest: Guest): Promise<Conversation> {
  const found = await db.query.conversations.findFirst({ where: eq(conversations.guestId, guest.id) });
  if (found) return found;
  try {
    const [c] = await db
      .insert(conversations)
      .values({ id: newId(), clubId: club.id, guestId: guest.id, state: {} })
      .returning();
    return c!;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return (await db.query.conversations.findFirst({ where: eq(conversations.guestId, guest.id) }))!;
  }
}

async function updateConversation(db: Db, id: string, set: Partial<Omit<Conversation, 'id'>>) {
  const [c] = await db
    .update(conversations)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(conversations.id, id))
    .returning();
  return c!;
}
