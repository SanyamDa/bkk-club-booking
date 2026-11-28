import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Actor } from '../bookings/service.js';
import { emit } from '../data/events.js';
import { recordOps } from '../data/ops.js';
import { isTestContext } from '../data/test-flag.js';
import type { Db } from '../db/client.js';
import { channels, events, messages, type Club, type Guest } from '../db/schema.js';
import { newId } from '../lib/util.js';
import type { LineGateway, Message } from './gateway.js';
import { describeLineError } from './setup.js';

const MAX_PER_CALL = 5; // LINE limit per reply/push request
/** Spec §11.1.4: at most 2 push requests per booking by default (the reminder and one other). */
export const DEFAULT_MAX_PUSHES_PER_BOOKING = 2;
const BOT: Actor = { type: 'bot' };
/** `deliver` sends a row a staff member wrote (its author is on the row and on `host.replied`). */
const STAFF_SEND: Actor = { type: 'staff' };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The single place messages leave the system. Every message is logged (so staff and the
 * simulator can see the conversation), then sent as a free reply when we have a reply token,
 * falling back to a push (which counts against the club's LINE quota).
 */
export class Outbox {
  constructor(
    private db: Db,
    private log: (msg: string, err?: unknown) => void = console.error,
    private now: () => Date = () => new Date(),
  ) {}

  /**
   * B4: who wrote an outbound row (`author_type`, `author_id`), its channel (the club's `kind = 'line'`
   * row) and when it was sent. A platform admin under a support grant is stored as staff.
   */
  private async stamp(club: Club, author: Actor) {
    const [channel] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.clubId, club.id), eq(channels.kind, 'line')))
      .limit(1);
    const authorType = author.type === 'platform' ? 'staff' : author.type;
    return { authorType, authorId: author.id ?? null, channelId: channel?.id ?? null, occurredAt: this.now() };
  }

  /**
   * `opts.causeId`: the inbound `messages` row this send answers (B4b: `message.sent` cause and latency).
   * `opts.booking`: the booking a push is about (spec §11.1.4 push budget). Each push request for it is
   * counted; an `optional` one is skipped once the club's `maxPushesPerBooking` (default 2) is used.
   */
  async toGuest(
    gateway: LineGateway,
    club: Club,
    guest: Guest,
    msgs: Message[],
    replyToken?: string,
    author: Actor = BOT,
    opts: { causeId?: string; booking?: { id: string; optional?: boolean } } = {},
  ) {
    if (msgs.length === 0) return;
    const stamp = await this.stamp(club, author);
    const rows = msgs.map((m) => ({
      id: newId(),
      clubId: club.id,
      guestId: guest.id,
      direction: 'out' as const,
      kind: m.type,
      payload: m,
      ...stamp,
    }));
    // Each row gets its own `created_at` in send order (`clock_timestamp()` plus i microseconds; the
    // default `now()` is fixed for a whole transaction), so threads ordered by it never swap tied rows.
    await this.db.insert(messages).values(rows.map((r, i) => ({ ...r, createdAt: sql`clock_timestamp() + make_interval(secs => ${i / 1_000_000})` })));
    const ids = rows.map((r) => r.id);
    // B3: every outbound row ends with a delivery_status (sent | failed | skipped).
    if (!guest.lineUserId) return this.mark(ids, 'skipped', 'none'); // manual-booking guests without LINE
    // Blocked the club: a push would fail and still cost quota.
    if (guest.unfollowedAt && !replyToken) return this.mark(ids, 'skipped', 'none');
    // Spec §11.1.4: an optional push about a booking that already used its push budget is not sent.
    if (!replyToken && opts.booking?.optional && (await this.pushesForBooking(club.id, opts.booking.id)) >= (club.settings.maxPushesPerBooking ?? DEFAULT_MAX_PUSHES_PER_BOOKING)) {
      return this.mark(ids, 'skipped', 'none');
    }
    const batches = chunk(rows, MAX_PER_CALL);
    for (const [i, batch] of batches.entries()) {
      const batchIds = batch.map((r) => r.id);
      const payload = batch.map((r) => r.payload);
      // Only the LINE call sits in a try: a DB or event error after LINE accepted the batch must
      // never reach the push fallback (a duplicate send) or `failed()` (B4b).
      let via: 'reply' | 'push' | null = null;
      if (i === 0 && replyToken) {
        try {
          await gateway.reply(replyToken, payload);
          via = 'reply';
        } catch {
          // Reply tokens are single-use and short-lived; fall back to push.
        }
      }
      if (!via) {
        try {
          await gateway.push(guest.lineUserId, payload);
          via = 'push';
        } catch (err) {
          this.log(`LINE send failed for guest ${guest.id}`, err);
          await this.afterSend(guest.id, async () => {
            await this.failed(club, batchIds, 'guest', err);
            await this.sentEvents(club, guest, batch, 'push', false, author, opts.causeId, opts.booking?.id);
          });
          continue;
        }
      }
      const sentVia = via;
      await this.afterSend(guest.id, async () => {
        await this.mark(batchIds, 'sent', sentVia);
        await this.sentEvents(club, guest, batch, sentVia, true, author, opts.causeId, opts.booking?.id);
      });
    }
  }

  /**
   * Push requests already sent about a booking: its delivered push `message.sent` events, one request
   * per send time (the rows of one request share the time `sentEvents` stamps).
   */
  private async pushesForBooking(clubId: string, bookingId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(distinct ${events.occurredAt})::int` })
      .from(events)
      .where(
        and(
          eq(events.clubId, clubId),
          eq(events.bookingId, bookingId),
          eq(events.type, 'message.sent'),
          sql`${events.props}->>'kind' = 'push'`,
          sql`(${events.props}->>'delivered')::boolean`,
        ),
      );
    return row?.n ?? 0;
  }

  /** Book-keeping after a send. It only logs on error: the send itself already happened (or failed). */
  private async afterSend(guestId: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (err) {
      this.log(`message bookkeeping failed for guest ${guestId}`, err);
    }
  }

  /**
   * B4b (§14.2): one `message.sent` per row LINE was asked to deliver: `kind` reply or push,
   * `delivered`, `latency_ms` from the inbound message named by `causeId`, and `template` (the LINE
   * message type). Skipped rows (no LINE user, blocked) were never sent and get no event.
   */
  private async sentEvents(
    club: Club,
    guest: Guest,
    rows: { id: string; kind: string }[],
    via: 'reply' | 'push',
    delivered: boolean,
    author: Actor,
    causeId?: string,
    bookingId?: string,
  ) {
    const now = this.now();
    let latency: number | null = null;
    if (causeId) {
      const [cause] = await this.db
        .select({ occurredAt: messages.occurredAt, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.id, causeId), eq(messages.clubId, club.id)))
        .limit(1);
      const at = cause?.occurredAt ?? cause?.createdAt;
      if (at) latency = Math.max(0, now.getTime() - at.getTime());
    }
    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        await emit(tx, {
          clubId: club.id,
          type: 'message.sent',
          occurredAt: now,
          actorType: author.type,
          actorId: author.id,
          channel: 'line',
          dataOrigin: 'first_party',
          guestId: guest.id,
          causeId,
          bookingId,
          props: { kind: via, delivered, latency_ms: latency, template: row.kind, messageId: row.id },
          isTest: isTestContext({ club, guest }),
        });
      }
    });
  }

  /**
   * Pushes one message row the caller already stored (a staff reply, plan B14b: `recordStaffReply`
   * writes the row with its author and external id in its own transaction) and records how it went.
   */
  async deliver(gateway: LineGateway, club: Club, guest: Guest, messageId: string, msgs: Message[]) {
    if (!guest.lineUserId || guest.unfollowedAt) return this.mark([messageId], 'skipped', 'none');
    const row = [{ id: messageId, kind: msgs[0]?.type ?? 'text' }];
    try {
      await gateway.push(guest.lineUserId, msgs.slice(0, MAX_PER_CALL));
    } catch (err) {
      this.log(`LINE send failed for guest ${guest.id}`, err);
      return this.afterSend(guest.id, async () => {
        await this.failed(club, [messageId], 'guest', err);
        await this.sentEvents(club, guest, row, 'push', false, STAFF_SEND);
      });
    }
    await this.afterSend(guest.id, async () => {
      await this.mark([messageId], 'sent', 'push');
      await this.sentEvents(club, guest, row, 'push', true, STAFF_SEND);
    });
  }

  /** Staff alerts go to the club's linked LINE group. Always logged so the dashboard can show them. */
  async toStaff(gateway: LineGateway, club: Club, msgs: Message[], author: Actor = BOT) {
    if (msgs.length === 0) return;
    const stamp = await this.stamp(club, author);
    const rows = msgs.map((m) => ({
      id: newId(),
      clubId: club.id,
      target: 'staff',
      direction: 'out' as const,
      kind: m.type,
      payload: m,
      ...stamp,
    }));
    await this.db.insert(messages).values(rows);
    const ids = rows.map((r) => r.id);
    if (!club.staffGroupId) return this.mark(ids, 'skipped', 'none');
    const sent = ids.slice(0, MAX_PER_CALL);
    if (ids.length > MAX_PER_CALL) await this.mark(ids.slice(MAX_PER_CALL), 'skipped', 'none');
    try {
      await gateway.push(club.staffGroupId, msgs.slice(0, MAX_PER_CALL));
      await this.mark(sent, 'sent', 'push');
    } catch (err) {
      this.log(`LINE staff alert failed for club ${club.id}`, err);
      await this.failed(club, sent, 'staff', err);
    }
  }

  private async mark(ids: string[], status: 'sent' | 'skipped', via: 'reply' | 'push' | 'none') {
    await this.db.update(messages).set({ deliveryStatus: status, sentVia: via, error: null }).where(inArray(messages.id, ids));
  }

  /** A failed send: the rows say `failed` with LINE's error, and one `send_failed` ops event (B3). */
  private async failed(club: Club, ids: string[], target: 'guest' | 'staff', err: unknown) {
    const error = describeLineError(err).slice(0, 1000);
    await this.db.update(messages).set({ deliveryStatus: 'failed', sentVia: 'push', error }).where(inArray(messages.id, ids));
    await recordOps(this.db, club.id, 'send_failed', { target, messageIds: ids, error }, this.now());
  }
}
