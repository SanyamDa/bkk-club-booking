import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clubs, messages } from '../src/db/schema.js';
import type { LineGateway, Message } from '../src/line/gateway.js';
import { Outbox } from '../src/line/outbox.js';
import { FRIDAY_AFTERNOON, makeGuest, setupDb } from './helpers.js';

/** Spec §11.1.4: at most 2 push messages per booking by default; optional pushes past it are skipped. */

let ctx: Awaited<ReturnType<typeof setupDb>>;
let pushes: Message[][];
let clock: Date;
const gateway: LineGateway = {
  live: false,
  reply: async () => {},
  push: async (_to, msgs) => {
    pushes.push(msgs);
  },
  getContent: async () => Buffer.alloc(0),
  getProfile: async () => null,
  loading: async () => {},
};
const text = (t: string): Message => ({ type: 'text', text: t });

beforeEach(async () => {
  ctx = await setupDb();
  pushes = [];
  clock = FRIDAY_AFTERNOON;
});
afterEach(async () => {
  await ctx.close();
});

describe('push budget per booking (spec §11.1.4)', () => {
  it('counts push requests per booking and skips optional pushes once the cap is used', async () => {
    const outbox = new Outbox(ctx.db, () => {}, () => clock);
    const guest = await makeGuest(ctx.db, { lineUserId: 'Ubudget' });
    const tick = () => (clock = new Date(clock.getTime() + 1000));
    const booking = { id: 'bk_budget' };

    // One request with two messages (confirmation and pre-order prompt) counts once.
    await outbox.toGuest(gateway, ctx.club, guest, [text('confirmed'), text('pre-order?')], undefined, undefined, { booking });
    tick();
    await outbox.toGuest(gateway, ctx.club, guest, [text('reminder')], undefined, undefined, { booking: { ...booking, optional: true } });
    tick();
    expect(pushes).toHaveLength(2);
    // The budget is used: an optional push is stored as skipped and never sent.
    await outbox.toGuest(gateway, ctx.club, guest, [text('hold expired')], undefined, undefined, { booking: { ...booking, optional: true } });
    expect(pushes).toHaveLength(2);
    const [skipped] = await ctx.db.select().from(messages).where(eq(messages.deliveryStatus, 'skipped'));
    expect((skipped!.payload as { text: string }).text).toBe('hold expired');
    // An essential push (a club cancellation) still goes.
    tick();
    await outbox.toGuest(gateway, ctx.club, guest, [text('cancelled by club')], undefined, undefined, { booking });
    expect(pushes).toHaveLength(3);
    // Another booking has its own budget.
    tick();
    await outbox.toGuest(gateway, ctx.club, guest, [text('other reminder')], undefined, undefined, { booking: { id: 'bk_other', optional: true } });
    expect(pushes).toHaveLength(4);
  });

  it("the cap is the club's setting", async () => {
    await ctx.db.update(clubs).set({ settings: { ...ctx.club.settings, maxPushesPerBooking: 1 } }).where(eq(clubs.id, ctx.club.id));
    const club = (await ctx.db.query.clubs.findFirst({ where: eq(clubs.id, ctx.club.id) }))!;
    const outbox = new Outbox(ctx.db, () => {}, () => clock);
    const guest = await makeGuest(ctx.db, { lineUserId: 'Ubudget2' });
    await outbox.toGuest(gateway, club, guest, [text('confirmed')], undefined, undefined, { booking: { id: 'bk_one' } });
    clock = new Date(clock.getTime() + 1000);
    await outbox.toGuest(gateway, club, guest, [text('reminder')], undefined, undefined, { booking: { id: 'bk_one', optional: true } });
    expect(pushes).toHaveLength(1);
  });
});
