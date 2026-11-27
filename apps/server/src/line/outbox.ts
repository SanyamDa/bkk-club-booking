import { inArray } from 'drizzle-orm';
import { recordOps } from '../data/ops.js';
import type { Db } from '../db/client.js';
import { messages, type Club, type Guest } from '../db/schema.js';
import { newId } from '../lib/util.js';
import type { LineGateway, Message } from './gateway.js';
import { describeLineError } from './setup.js';

const MAX_PER_CALL = 5; // LINE limit per reply/push request

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

  async toGuest(gateway: LineGateway, club: Club, guest: Guest, msgs: Message[], replyToken?: string) {
    if (msgs.length === 0) return;
    const rows = msgs.map((m) => ({
      id: newId(),
      clubId: club.id,
      guestId: guest.id,
      direction: 'out' as const,
      kind: m.type,
      payload: m,
    }));
    await this.db.insert(messages).values(rows);
    const ids = rows.map((r) => r.id);
    // B3: every outbound row ends with a delivery_status (sent | failed | skipped).
    if (!guest.lineUserId) return this.mark(ids, 'skipped', 'none'); // manual-booking guests without LINE
    // Blocked the club: a push would fail and still cost quota.
    if (guest.unfollowedAt && !replyToken) return this.mark(ids, 'skipped', 'none');
    const batches = chunk(rows, MAX_PER_CALL);
    for (const [i, batch] of batches.entries()) {
      const batchIds = batch.map((r) => r.id);
      const payload = batch.map((r) => r.payload);
      try {
        if (i === 0 && replyToken) {
          try {
            await gateway.reply(replyToken, payload);
            await this.mark(batchIds, 'sent', 'reply');
            continue;
          } catch {
            // Reply tokens are single-use and short-lived; fall back to push.
          }
        }
        await gateway.push(guest.lineUserId, payload);
        await this.mark(batchIds, 'sent', 'push');
      } catch (err) {
        this.log(`LINE send failed for guest ${guest.id}`, err);
        await this.failed(club, batchIds, 'guest', err);
      }
    }
  }

  /**
   * Pushes one message row the caller already stored (a staff reply, plan B14b: `recordStaffReply`
   * writes the row with its author and external id in its own transaction) and records how it went.
   */
  async deliver(gateway: LineGateway, club: Club, guest: Guest, messageId: string, msgs: Message[]) {
    if (!guest.lineUserId || guest.unfollowedAt) return this.mark([messageId], 'skipped', 'none');
    try {
      await gateway.push(guest.lineUserId, msgs.slice(0, MAX_PER_CALL));
      await this.mark([messageId], 'sent', 'push');
    } catch (err) {
      this.log(`LINE send failed for guest ${guest.id}`, err);
      await this.failed(club, [messageId], 'guest', err);
    }
  }

  /** Staff alerts go to the club's linked LINE group. Always logged so the dashboard can show them. */
  async toStaff(gateway: LineGateway, club: Club, msgs: Message[]) {
    if (msgs.length === 0) return;
    const rows = msgs.map((m) => ({
      id: newId(),
      clubId: club.id,
      target: 'staff',
      direction: 'out' as const,
      kind: m.type,
      payload: m,
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
