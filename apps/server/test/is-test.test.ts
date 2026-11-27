import type { webhook } from '@line/bot-sdk';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { availableTables, BookingError, holdTable } from '../src/bookings/service.js';
import { handleEvent } from '../src/bot/flow.js';
import { bookings, clubs, events, guests, messages, type Club, type Guest } from '../src/db/schema.js';
import { isTestContext, issueTesterCode } from '../src/data/test-flag.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const h = await setupTwoClubs();
  cleanups.push(h.close);
  const clock = { now: FRIDAY_AFTERNOON };
  const { app, ctx } = createApp(testConfig({ PUBLIC_URL: 'http://localhost:5173' }), h.db, { bot: { now: () => clock.now, log: () => {} } });
  /** One LINE text message from `userId` to `club`, through the real bot with the dev gateway. */
  const say = (club: Club, userId: string, text: string) =>
    handleEvent(ctx.deps, club, ctx.gateways.dev, {
      type: 'message',
      timestamp: clock.now.getTime(),
      mode: 'active',
      webhookEventId: newId(),
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId },
      replyToken: newId(),
      message: { type: 'text', id: newId(), text, quoteToken: 'q' },
    } as webhook.Event);
  const guestOf = async (club: Club, userId: string): Promise<Guest> =>
    (await h.db.query.guests.findFirst({ where: and(eq(guests.clubId, club.id), eq(guests.lineUserId, userId)) }))!;
  const eventsOf = (guest: Guest) => h.db.select().from(events).where(eq(events.guestId, guest.id));
  const setStatus = async (club: Club, status: Club['status']) => {
    await h.db.update(clubs).set({ status }).where(eq(clubs.id, club.id));
    return (await h.db.query.clubs.findFirst({ where: eq(clubs.id, club.id) }))!;
  };
  const hold = (club: Club, guest: Guest, tableId: string) =>
    holdTable(h.db, club, { guestId: guest.id, tableId, nightDate: FRIDAY, pax: 2 }, clock.now);
  return { ...h, app, ctx, clock, say, guestOf, eventsOf, setStatus, hold };
}

describe('test-data marking (B6)', () => {
  it('simulator and demo rows carry is_test', async () => {
    const s = await setup();

    // A simulator guest at a live club.
    await s.say(s.clubB, 'SIM-ari', 'hi');
    const sim = await s.guestOf(s.clubB, 'SIM-ari');
    expect(sim.isTest).toBe(true);
    expect(isTestContext({ club: s.clubB, guest: sim })).toBe(true);
    expect((await s.hold(s.clubB, sim, 'table_b_S1')).isTest).toBe(true);
    const simEvents = await s.eventsOf(sim);
    expect(simEvents.map((e) => e.type)).toContain('guest.first_seen');
    expect(simEvents.every((e) => e.isTest)).toBe(true);

    // A real LINE id at the demo club (clubA is status 'demo').
    await s.say(s.clubA, 'Udemo1', 'hi');
    const demo = await s.guestOf(s.clubA, 'Udemo1');
    expect(demo.isTest).toBe(true);
    expect((await s.hold(s.clubA, demo, 'table_demo_B1')).isTest).toBe(true);
    const demoEvents = await s.eventsOf(demo);
    expect(demoEvents.length).toBeGreaterThan(0);
    expect(demoEvents.every((e) => e.isTest)).toBe(true);

    // Control: a real guest at the live club stays real.
    await s.say(s.clubB, 'Ureal1', 'hi');
    const real = await s.guestOf(s.clubB, 'Ureal1');
    expect(real.isTest).toBe(false);
    expect(isTestContext({ club: s.clubB, guest: real })).toBe(false);
    expect((await s.hold(s.clubB, real, 'table_b_S2')).isTest).toBe(false);
    const realEvents = await s.eventsOf(real);
    expect(realEvents.length).toBeGreaterThan(0);
    expect(realEvents.every((e) => !e.isTest)).toBe(true);
  });

  it('a test booking never blocks a real booking on the same table', async () => {
    const s = await setup();
    await s.say(s.clubB, 'SIM-t1', 'hi');
    await s.say(s.clubB, 'Ureal1', 'hi');
    const sim = await s.guestOf(s.clubB, 'SIM-t1');
    const real = await s.guestOf(s.clubB, 'Ureal1');

    const testHold = await s.hold(s.clubB, sim, 'table_b_S1');
    expect(testHold.isTest).toBe(true);
    const realView = await availableTables(s.db, s.clubB.id, FRIDAY, { min: 2, max: 4 }, s.clock.now, { isTest: false });
    expect(realView.map((o) => o.table.id)).toContain('table_b_S1');
    const testView = await availableTables(s.db, s.clubB.id, FRIDAY, { min: 2, max: 4 }, s.clock.now, { isTest: true });
    expect(testView.map((o) => o.table.id)).not.toContain('table_b_S1');

    const realHold = await s.hold(s.clubB, real, 'table_b_S1');
    expect(realHold.isTest).toBe(false);
    const active = await s.db.select().from(bookings).where(and(eq(bookings.tableId, 'table_b_S1'), eq(bookings.status, 'held')));
    expect(active).toHaveLength(2);

    // The staff table map shows the real booking on that table, not the earlier test hold.
    const cookie = await staffCookie({ app: s.app, ctx: s.ctx } as Parameters<typeof staffCookie>[0], s.clubB);
    const res = await s.app.request(staffUrl(s.clubB.slug, `/night?date=${FRIDAY}`), { headers: { cookie } });
    expect(res.status).toBe(200);
    const night = (await res.json()) as { tables: { id: string; booking: { id: string; isTest: boolean } | null }[]; bookings: { id: string; isTest: boolean }[] };
    expect(night.tables.find((t) => t.id === 'table_b_S1')?.booking).toMatchObject({ id: realHold.id, isTest: false });
    expect(night.bookings.find((b) => b.id === testHold.id)).toMatchObject({ isTest: true });
  });

  it('two test bookings still cannot share a table', async () => {
    const s = await setup();
    await s.say(s.clubB, 'SIM-t1', 'hi');
    await s.say(s.clubB, 'SIM-t2', 'hi');
    const a = await s.guestOf(s.clubB, 'SIM-t1');
    const b = await s.guestOf(s.clubB, 'SIM-t2');
    await s.hold(s.clubB, a, 'table_b_S1');
    await expect(s.hold(s.clubB, b, 'table_b_S1')).rejects.toMatchObject({ code: 'table_taken' });
    await expect(s.hold(s.clubB, b, 'table_b_S1')).rejects.toBeInstanceOf(BookingError);
    // The index itself refuses a second active test row, not only the service.
    await expect(
      s.db.insert(bookings).values({
        id: newId(),
        clubId: s.clubB.id,
        refCode: 'TB-DUP1',
        guestId: b.id,
        tableId: 'table_b_S1',
        nightDate: FRIDAY,
        pax: 2,
        status: 'confirmed',
        source: 'manual',
        minSpendSatang: 0,
        depositSatang: 0,
        isTest: true,
      }),
    ).rejects.toThrow();
  });

  it("a tester code typed at an onboarding club marks the guest, and that guest's later bookings and events are test rows", async () => {
    const s = await setup();
    const club = await s.setStatus(s.clubB, 'onboarding');
    await s.say(club, 'Utester', 'hi');
    expect((await s.guestOf(club, 'Utester')).isTest).toBe(false);

    const { code, expiresAt } = await issueTesterCode(s.db, club.id, 'user_admin', s.clock.now);
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(expiresAt.getTime()).toBe(s.clock.now.getTime() + 10 * 60_000);

    await s.say(club, 'Utester', ` ${code.toLowerCase()} `);
    const tester = await s.guestOf(club, 'Utester');
    expect(tester.isTest).toBe(true);
    expect(isTestContext({ club, guest: tester })).toBe(true);
    const reply = await s.db.select().from(messages).where(and(eq(messages.guestId, tester.id), eq(messages.direction, 'out')));
    expect(JSON.stringify(reply.at(-1)?.payload)).toContain('Tester registered');

    // Later rows are test rows: every event written after registration.
    const registered = (await s.eventsOf(tester)).filter((e) => e.type === 'guest.tester_registered');
    expect(registered).toHaveLength(1);
    expect(registered[0]!.isTest).toBe(true);
    const seenBefore = new Set((await s.eventsOf(tester)).map((e) => e.id));
    expect((await s.hold(club, tester, 'table_b_S1')).isTest).toBe(true);
    const later = (await s.eventsOf(tester)).filter((e) => !seenBefore.has(e.id));
    expect(later.map((e) => e.type)).toEqual(expect.arrayContaining(['table.held', 'booking.status_changed']));
    expect(later.every((e) => e.isTest)).toBe(true);

    // Single use: a second guest typing the same code stays real.
    await s.say(club, 'Uother', code);
    expect((await s.guestOf(club, 'Uother')).isTest).toBe(false);

    // Expired: a new code typed after 10 minutes does nothing.
    const late = await issueTesterCode(s.db, club.id, 'user_admin', s.clock.now);
    s.clock.now = new Date(s.clock.now.getTime() + 10 * 60_000 + 1);
    await s.say(club, 'Uother', late.code);
    expect((await s.guestOf(club, 'Uother')).isTest).toBe(false);
  });

  it('a tester code typed at a live club changes nothing', async () => {
    const s = await setup();
    await s.say(s.clubB, 'Ulive', 'hi');
    const { code } = await issueTesterCode(s.db, s.clubB.id, 'user_admin', s.clock.now);
    await s.say(s.clubB, 'Ulive', code);
    const guest = await s.guestOf(s.clubB, 'Ulive');
    expect(guest.isTest).toBe(false);
    expect((await s.eventsOf(guest)).some((e) => e.type === 'guest.tester_registered')).toBe(false);
    expect((await s.hold(s.clubB, guest, 'table_b_S1')).isTest).toBe(false);
  });
});
