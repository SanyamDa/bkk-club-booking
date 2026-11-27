import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { bookings, conversations, deposits, events, type Club } from '../src/db/schema.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { isolationFixtures, loginAs, makeUser, staffUrl, testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let app: ReturnType<typeof createApp>;
let ids: Record<string, string>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  ({ db, close, clubA } = await setupTwoClubs());
  app = createApp(testConfig(), db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
  ids = await isolationFixtures(db, clubA);
  const user = await makeUser(db, { email: 'host-a@test.local', clubId: clubA.id, role: 'host' });
  userId = user.id;
  cookie = await loginAs(app, user);
});
afterEach(async () => {
  await close();
});

const eventsOf = (type: string) => db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, type)));

describe('staff events (plan A2)', () => {
  it('viewing a booking and a slip emits staff.booking_viewed and staff.slip_viewed', async () => {
    const bookingId = ids['bookings/:id']!;
    const depositId = ids['deposits/:id']!;
    const [deposit] = await db.select().from(deposits).where(eq(deposits.id, depositId));
    const file = join(app.ctx.deps.uploadsDir, deposit!.slipPath!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'slip-bytes');

    const view = await app.app.request(staffUrl(clubA.slug, `/bookings/${bookingId}`), { headers: { cookie } });
    expect(view.status).toBe(200);
    const slip = await app.app.request(staffUrl(clubA.slug, `/deposits/${depositId}/slip`), { headers: { cookie } });
    expect(slip.status).toBe(200);
    expect(await slip.text()).toBe('slip-bytes');

    const [viewed] = await eventsOf('staff.booking_viewed');
    expect(viewed).toMatchObject({ bookingId, actorType: 'staff', actorId: userId, dataOrigin: 'first_party', isTest: true });
    const [slipViewed] = await eventsOf('staff.slip_viewed');
    expect(slipViewed).toMatchObject({ bookingId, actorType: 'staff', actorId: userId });
    expect(slipViewed!.props).toEqual({ depositId });
  });

  it('resolving a handoff emits handoff.resolved and keeps the booking untouched', async () => {
    const conversationId = ids['conversations/:id']!;
    const res = await app.app.request(staffUrl(clubA.slug, `/conversations/${conversationId}/resolve`), { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv!.mode).toBe('bot');
    const [resolved] = await eventsOf('handoff.resolved');
    expect(resolved).toMatchObject({ conversationId, actorType: 'staff', actorId: userId });
    expect(resolved!.props).toEqual({ durationSec: 0 });
    const [b] = await db.select().from(bookings).where(eq(bookings.id, ids['bookings/:id']!));
    expect(b!.status).toBe('held');
  });
});
