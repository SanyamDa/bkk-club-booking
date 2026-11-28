import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { messages } from '../src/db/schema.js';
import type { LineGateway, Message } from '../src/line/gateway.js';
import { Outbox } from '../src/line/outbox.js';
import { makeGuest, setupDb } from './helpers.js';

/**
 * B4b: a DB or event error after LINE accepted a send must not fall back to push (a duplicate
 * message to the guest) and must not mark delivered rows as failed.
 */
type Sent = { via: 'reply' | 'push'; messages: Message[] };

function gateway(): LineGateway & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    live: true,
    sent,
    reply: async (_to, msgs) => void sent.push({ via: 'reply', messages: msgs }),
    push: async (_to, msgs) => void sent.push({ via: 'push', messages: msgs }),
    getContent: async () => Buffer.alloc(0),
    getProfile: async () => ({ displayName: 'g', language: 'en' }),
    loading: async () => {},
  };
}

/** The DB with `transaction` broken, so the `message.sent` write throws after the send. */
function brokenEvents(db: Db): Db {
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'transaction') return async () => {
        throw new Error('events table down');
      };
      return Reflect.get(target, prop, recv);
    },
  });
}

describe('Outbox bookkeeping after a send', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('a reply whose event write fails is not resent as a push and stays sent', async () => {
    const s = await setupDb();
    close = s.close;
    const guest = await makeGuest(s.db);
    const logs: string[] = [];
    const outbox = new Outbox(brokenEvents(s.db), (m) => void logs.push(m));
    const gw = gateway();
    await outbox.toGuest(gw, s.club, guest, [{ type: 'text', text: 'hi' }], 'reply-token');
    expect(gw.sent.map((x) => x.via)).toEqual(['reply']);
    const rows = await s.db.select().from(messages).where(eq(messages.guestId, guest.id));
    expect(rows.map((r) => r.deliveryStatus)).toEqual(['sent']);
    expect(logs.some((l) => l.includes('bookkeeping'))).toBe(true);
  });

  it('a push whose event write fails keeps the rows sent and still sends later batches', async () => {
    const s = await setupDb();
    close = s.close;
    const guest = await makeGuest(s.db);
    const outbox = new Outbox(brokenEvents(s.db), () => {});
    const gw = gateway();
    const msgs: Message[] = Array.from({ length: 7 }, (_, i) => ({ type: 'text', text: `m${i}` }));
    await outbox.toGuest(gw, s.club, guest, msgs);
    expect(gw.sent.map((x) => x.via)).toEqual(['push', 'push']);
    const rows = await s.db.select().from(messages).where(eq(messages.guestId, guest.id));
    expect(rows.every((r) => r.deliveryStatus === 'sent')).toBe(true);
  });
});
