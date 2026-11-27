import type { Db } from '../db/client.js';
import { messages, type Club, type Guest } from '../db/schema.js';
import { newId } from '../lib/util.js';
import type { LineGateway, Message } from './gateway.js';

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
  ) {}

  async toGuest(gateway: LineGateway, club: Club, guest: Guest, msgs: Message[], replyToken?: string) {
    if (msgs.length === 0) return;
    await this.db.insert(messages).values(
      msgs.map((m) => ({
        id: newId(),
        clubId: club.id,
        guestId: guest.id,
        direction: 'out' as const,
        kind: m.type,
        payload: m,
      })),
    );
    if (!guest.lineUserId) return; // manual-booking guests without LINE
    if (guest.unfollowedAt && !replyToken) return; // blocked the club: a push would fail and still cost quota
    const batches = chunk(msgs, MAX_PER_CALL);
    for (const [i, batch] of batches.entries()) {
      try {
        if (i === 0 && replyToken) await gateway.reply(replyToken, batch);
        else await gateway.push(guest.lineUserId, batch);
      } catch (err) {
        if (i === 0 && replyToken) {
          // Reply tokens are single-use and short-lived; fall back to push.
          try {
            await gateway.push(guest.lineUserId, batch);
            continue;
          } catch (pushErr) {
            this.log(`LINE push failed for guest ${guest.id}`, pushErr);
            continue;
          }
        }
        this.log(`LINE send failed for guest ${guest.id}`, err);
      }
    }
  }

  /** Staff alerts go to the club's linked LINE group. Always logged so the dashboard can show them. */
  async toStaff(gateway: LineGateway, club: Club, msgs: Message[]) {
    if (msgs.length === 0) return;
    await this.db.insert(messages).values(
      msgs.map((m) => ({
        id: newId(),
        clubId: club.id,
        target: 'staff',
        direction: 'out' as const,
        kind: m.type,
        payload: m,
      })),
    );
    if (!club.staffGroupId) return;
    try {
      await gateway.push(club.staffGroupId, msgs.slice(0, MAX_PER_CALL));
    } catch (err) {
      this.log(`LINE staff alert failed for club ${club.id}`, err);
    }
  }
}
