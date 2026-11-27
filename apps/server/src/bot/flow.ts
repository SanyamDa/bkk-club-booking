import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { webhook } from '@line/bot-sdk';
import { and, eq, inArray } from 'drizzle-orm';
import {
  abandonUnfinished as abandonUnfinishedBookings,
  availableTables,
  BookingError,
  bookingAwaitingSlip,
  currentBookingForGuest,
  getBookingView,
  holdTable,
  isNightBookable,
  paxRange,
  recordSlip,
  requestDeposit,
  SELF_BOOK_MAX_PAX,
  upcomingNights,
} from '../bookings/service.js';
import type { Db } from '../db/client.js';
import { isUniqueViolation } from '../db/client.js';
import {
  bookings,
  conversations,
  guests,
  messages as messagesTable,
  type Club,
  type Conversation,
  type Guest,
} from '../db/schema.js';
import type { LineGateway, Message } from '../line/gateway.js';
import type { Outbox } from '../line/outbox.js';
import { formatNight } from '../lib/time.js';
import { newId } from '../lib/util.js';
import { langOf, t, type Lang } from './i18n.js';
import { detectIntent, testerCodeIn } from './intents.js';
import { emit } from '../data/events.js';
import { isTestContext, isTestGuestAtCreate, redeemTesterCode } from '../data/test-flag.js';
import type { Links } from './links.js';
import * as M from './messages.js';
import { handleStaffLink } from './staff-link.js';

export interface BotDeps {
  db: Db;
  outbox: Outbox;
  links: Links;
  uploadsDir: string;
  now: () => Date;
  log: (msg: string, err?: unknown) => void;
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

/** Handles one LINE webhook event for one club. Never throws: errors are logged and the guest gets the menu. */
export async function handleEvent(deps: BotDeps, club: Club, gateway: LineGateway, event: webhook.Event): Promise<void> {
  try {
    if (event.source?.type === 'group') {
      await handleGroupEvent(deps, club, gateway, event);
      return;
    }
    if (event.source?.type !== 'user' || !event.source.userId) return;
    if (event.type !== 'message' && event.type !== 'postback' && event.type !== 'follow' && event.type !== 'unfollow') return;

    const now = deps.now();
    let guest = await upsertGuest(deps.db, gateway, club, event.source.userId);
    if (!(await logInbound(deps.db, club, guest, event))) return; // duplicate delivery

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
    };

    if (event.type === 'follow') {
      await send(turn, M.greeting(club, turn.lang));
      return;
    }

    // Human handoff: the bot stays quiet until staff resolve it or it times out.
    if (conv.mode === 'human') {
      const timeoutMs = club.settings.handoffTimeoutMinutes * 60_000;
      if (conv.handoffRequestedAt && now.getTime() - conv.handoffRequestedAt.getTime() > timeoutMs) {
        conv = await updateConversation(deps.db, conv.id, { mode: 'bot', handoffRequestedAt: null, handoffReason: null });
        turn.conv = conv;
      } else {
        return;
      }
    }

    if (event.type === 'postback') {
      await handlePostback(turn, event.postback.data, event.postback.params);
      return;
    }

    const m = event.message;
    if (m.type === 'text') await handleText(turn, m.text);
    else if (m.type === 'image') await handleImage(turn, m.id);
    else await send(turn, [M.menu(club, turn.lang)]);
  } catch (err) {
    deps.log(`Bot error for club ${club.id}`, err);
  }
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
      await requestHandoff(turn, `Guest said: "${text.slice(0, 120)}"`);
      return;
    case 'my_booking':
      await showMyBooking(turn);
      return;
    case 'book':
      await startBooking(turn);
      return;
    case 'location':
      await send(turn, [M.plain(`${turn.club.settings.address}\n${turn.club.settings.mapUrl}`, M.menuQuickReplies(turn.club, turn.lang))]);
      return;
    default:
      await send(turn, [M.menu(turn.club, turn.lang)]);
  }
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
      await requestHandoff(turn, 'Guest tapped "Talk to a host"');
      return;
    default:
      await send(turn, [M.menu(turn.club, turn.lang)]);
  }
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
  const nights = upcomingNights(turn.club, turn.now, 4);
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
    await send(turn, M.payment(turn.club, turn.lang, view, turn.deps.links.promptpayQr(turn.club, b)));
    return;
  }
  await startBooking(turn, { force: true });
}

async function chooseNight(turn: Turn, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isNightBookable(turn.club, date, turn.now)) {
    const nights = upcomingNights(turn.club, turn.now, 4);
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
    await requestHandoff(turn, `Large group (13+) for ${formatNight(nightDate, 'en')}`, { silent: true });
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

async function chooseTable(turn: Turn, tableId: string, nightDate: string) {
  const key = turn.conv.state.paxRange ?? '2-4';
  const range = paxRange(key)!;
  try {
    const booking = await holdTable(
      turn.deps.db,
      turn.club,
      { guestId: turn.guest.id, tableId, nightDate, pax: range.max > SELF_BOOK_MAX_PAX ? range.min : range.max },
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
      const nights = upcomingNights(turn.club, turn.now, 4);
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

  const { tableLost } = await recordSlip(turn.deps.db, turn.club, booking.id, relPath, turn.now);
  await send(turn, [M.plain(t(turn.lang, tableLost ? 'slipTableLost' : 'slipReceived'))]);
  const view = (await getBookingView(turn.deps.db, { clubId: turn.club.id, id: booking.id }))!;
  await staff(turn, [M.staffNewBooking(view, 'review')]);
  if (tableLost) await requestHandoff(turn, 'Paid after hold expired; table was taken. Reassign or refund.', { silent: true });
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
    await send(turn, [M.confirmation(turn.club, turn.lang, view, turn.deps.links.pass(current))]);
    return;
  }
  if (current.status === 'held' || current.status === 'awaiting_payment') {
    await send(turn, [M.inProgress(turn.lang, view.table.code, current.nightDate, current.id)]);
    return;
  }
  await send(turn, [M.alreadyBooked(turn.club, turn.lang, view)]);
}

async function requestHandoff(turn: Turn, reason: string, opts: { silent?: boolean } = {}) {
  turn.conv = await updateConversation(turn.deps.db, turn.conv.id, {
    mode: 'human',
    handoffRequestedAt: turn.now,
    handoffReason: reason,
  });
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

/** Records the inbound event. Returns false if LINE already delivered it (webhooks can be redelivered). */
async function logInbound(db: Db, club: Club, guest: Guest, event: webhook.Event): Promise<boolean> {
  const kind = event.type === 'message' ? event.message.type : event.type;
  const payload =
    event.type === 'message'
      ? event.message.type === 'text'
        ? { text: event.message.text }
        : { type: event.message.type }
      : event.type === 'postback'
        ? { data: event.postback.data, params: event.postback.params ?? null }
        : {};
  try {
    await db.insert(messagesTable).values({
      id: newId(),
      clubId: club.id,
      guestId: guest.id,
      direction: 'in',
      kind,
      payload,
      lineMessageId: event.webhookEventId,
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

async function getConversation(db: Db, club: Club, guest: Guest): Promise<Conversation> {
  const found = await db.query.conversations.findFirst({ where: eq(conversations.guestId, guest.id) });
  if (found) return found;
  try {
    const [c] = await db
      .insert(conversations)
      .values({ id: newId(), clubId: club.id, guestId: guest.id, mode: 'bot', state: {} })
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
