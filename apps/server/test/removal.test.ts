import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emit } from '../src/data/events.js';
import { removeGuest, runRemovalRequests } from '../src/data/removal.js';
import type { Db } from '../src/db/client.js';
import {
  alerts,
  bookings,
  conversations,
  deposits,
  doorCounts,
  events,
  guestNotes,
  guestTags,
  guests,
  identityMap,
  messages,
  occupancySnapshots,
  rawWebhooks,
  removalRequests,
  type Club,
  type Guest,
} from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupTwoClubs>>;
let db: Db;
let clubA: Club;
let clubB: Club;
let uploads: string;
const now = FRIDAY_AFTERNOON;

beforeEach(async () => {
  ctx = await setupTwoClubs();
  ({ db, clubA, clubB } = ctx);
  uploads = await mkdtemp(join(tmpdir(), 'removal-'));
});
afterEach(async () => {
  await ctx.close();
  await rm(uploads, { recursive: true, force: true });
});

/** A guest with every kind of row removal touches: messages, events with raw, a slip, links, tags, alerts. */
async function seedGuest(club: Club, tableId: string, n: string) {
  const lineUserId = `Uline${n}${club.id}`;
  const [guest] = (await db
    .insert(guests)
    .values({ id: newId(), clubId: club.id, lineUserId, displayName: `Ari ${n}`, name: 'Ari Tan', phone: '0812345678', nationality: 'TH' })
    .returning()) as [Guest];
  const convId = newId();
  await db.insert(conversations).values({ id: convId, clubId: club.id, guestId: guest.id, handoffReason: 'Guest said: "call me Ari"' });
  await db.insert(messages).values([
    { id: newId(), clubId: club.id, guestId: guest.id, direction: 'in', kind: 'text', payload: { text: 'hi, I am Ari 0812345678' } },
    { id: newId(), clubId: club.id, guestId: guest.id, direction: 'out', kind: 'text', payload: { text: 'Hello Ari' } },
  ]);
  const bookingId = newId();
  await db.insert(bookings).values({
    id: bookingId,
    clubId: club.id,
    refCode: `${club.settings.refPrefix}-${n}${club.id.slice(-3).toUpperCase()}`.slice(0, 12),
    guestId: guest.id,
    tableId,
    nightDate: FRIDAY,
    pax: 4,
    status: 'confirmed',
    source: 'line',
    minSpendSatang: 800_000,
    depositSatang: 300_000,
    specialRequest: 'birthday for Ari',
  });
  const slipRel = join(club.id, `${bookingId}.jpg`);
  await mkdir(join(uploads, club.id), { recursive: true });
  await writeFile(join(uploads, slipRel), Buffer.from([0xff, 0xd8, 0xff]));
  await db.insert(deposits).values({
    id: newId(),
    clubId: club.id,
    bookingId,
    amountSatang: 300_000,
    method: 'promptpay_slip',
    status: 'verified',
    slipPath: slipRel,
    slipReceivedAt: now,
  });
  for (const type of ['guest.first_seen', 'message.received'] as const) {
    await emit(db, {
      clubId: club.id,
      type,
      occurredAt: now,
      actorType: 'guest',
      actorId: guest.id,
      channel: 'line',
      dataOrigin: 'line_chat',
      guestId: guest.id,
      conversationId: convId,
      raw: { text: 'hi, I am Ari' },
      isTest: false,
      dedupeKey: `${type}:${guest.id}`,
    });
  }
  await db.update(events).set({ personId: `person_${n}` }).where(eq(events.guestId, guest.id));
  await db.insert(identityMap).values({ personId: `person_${n}`, clubId: club.id, guestId: guest.id, platformLineSub: `sub_${n}` });
  await db.insert(guestTags).values({ guestId: guest.id, clubId: club.id, tag: 'vip' });
  await db.insert(guestNotes).values({ id: newId(), clubId: club.id, guestId: guest.id, text: 'Ari likes the corner' });
  await db.insert(alerts).values({ id: newId(), clubId: club.id, level: 'urgent', kind: 'handoff', conversationId: convId, textEn: 'Ari wants a host', textTh: 'Ari' });
  await db.insert(rawWebhooks).values({ id: newId(), clubId: club.id, channel: 'line', body: { events: [{ source: { userId: lineUserId } }] }, signatureOk: true });
  await db.insert(occupancySnapshots).values({
    clubId: club.id, nightDate: FRIDAY, takenAt: now, leadBucket: 't-0', tablesActive: 4, tablesHeld: 0, tablesConfirmed: 1,
    tablesArrived: 0, paxBooked: 4, minSpendBookedSatang: 800_000, depositsVerifiedSatang: 300_000,
  }).onConflictDoNothing();
  await db.insert(doorCounts).values({ id: newId(), clubId: club.id, nightDate: FRIDAY, delta: 1, kind: 'walk_in' });
  return { guest, convId, bookingId, slipRel };
}

async function aggregates(clubId: string) {
  const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]!.n);
  const perType = await db
    .select({ type: events.type, n: sql<number>`count(*)::int` })
    .from(events)
    .where(eq(events.clubId, clubId))
    .groupBy(events.type)
    .orderBy(events.type);
  return {
    bookings: await count(db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(eq(bookings.clubId, clubId))),
    snapshots: await count(db.select({ n: sql<number>`count(*)::int` }).from(occupancySnapshots).where(eq(occupancySnapshots.clubId, clubId))),
    doorCounts: await count(db.select({ n: sql<number>`count(*)::int` }).from(doorCounts).where(eq(doorCounts.clubId, clubId))),
    messages: await count(db.select({ n: sql<number>`count(*)::int` }).from(messages).where(eq(messages.clubId, clubId))),
    perType,
  };
}

describe('guest removal (B10b)', () => {
  it('removal anonymises the guest in place, deletes message text, events.raw, slip files and identity links, and clears guest ids on events', async () => {
    const { guest, convId, bookingId, slipRel } = await seedGuest(clubA, 'table_demo_B1', '1');
    const result = await removeGuest(db, clubA.id, guest.id, now, uploads);
    expect(result).toEqual({ messagesCleared: 2, slipsDeleted: 1, eventsCleared: 2 });

    const g = (await db.select().from(guests).where(eq(guests.id, guest.id)))[0]!;
    expect(g).toMatchObject({ id: guest.id, clubId: clubA.id, lineUserId: null, displayName: null, name: null, phone: null, nationality: null });

    const msgs = await db.select().from(messages).where(eq(messages.guestId, guest.id));
    expect(msgs).toHaveLength(2);
    for (const m of msgs) expect(m.payload).toEqual({ removed: true });

    const evs = await db.select().from(events).where(eq(events.clubId, clubA.id));
    expect(evs).toHaveLength(2);
    for (const e of evs) {
      expect(e).toMatchObject({ raw: null, guestId: null, personId: null, conversationId: null, actorId: null, dedupeKey: null });
    }

    expect(existsSync(join(uploads, slipRel))).toBe(false);
    const dep = (await db.select().from(deposits).where(eq(deposits.bookingId, bookingId)))[0]!;
    expect(dep.slipPath).toBeNull();

    expect(await db.select().from(identityMap).where(eq(identityMap.guestId, guest.id))).toHaveLength(0);
    expect(await db.select().from(guestTags).where(eq(guestTags.guestId, guest.id))).toHaveLength(0);
    expect(await db.select().from(guestNotes).where(eq(guestNotes.guestId, guest.id))).toHaveLength(0);
    expect(await db.select().from(alerts).where(eq(alerts.conversationId, convId))).toHaveLength(0);
    expect(await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubA.id))).toHaveLength(0);
    const b = (await db.select().from(bookings).where(eq(bookings.id, bookingId)))[0]!;
    expect(b.specialRequest).toBeNull();
    const conv = (await db.select().from(conversations).where(eq(conversations.id, convId)))[0]!;
    expect(conv.handoffReason).toBeNull();

    // Run again: nothing left to clear, and no error on the missing file.
    expect(await removeGuest(db, clubA.id, guest.id, now, uploads)).toEqual({ messagesCleared: 0, slipsDeleted: 0, eventsCleared: 0 });
  });

  it('aggregate counts (bookings, events per type, snapshots, door counts) equal before and after', async () => {
    const { guest } = await seedGuest(clubA, 'table_demo_B1', '1');
    await seedGuest(clubA, 'table_demo_B2', '2');
    const before = await aggregates(clubA.id);
    await removeGuest(db, clubA.id, guest.id, now, uploads);
    expect(await aggregates(clubA.id)).toEqual(before);
  });

  it('removal leaves another guest of the same club untouched', async () => {
    const one = await seedGuest(clubA, 'table_demo_B1', '1');
    const two = await seedGuest(clubA, 'table_demo_B2', '2');
    const snapshot = async () => ({
      guest: await db.select().from(guests).where(eq(guests.id, two.guest.id)),
      messages: await db.select().from(messages).where(eq(messages.guestId, two.guest.id)).orderBy(messages.id),
      events: await db.select().from(events).where(eq(events.guestId, two.guest.id)).orderBy(events.id),
      booking: await db.select().from(bookings).where(eq(bookings.id, two.bookingId)),
      deposits: await db.select().from(deposits).where(eq(deposits.bookingId, two.bookingId)),
      conversation: await db.select().from(conversations).where(eq(conversations.id, two.convId)),
      identity: await db.select().from(identityMap).where(eq(identityMap.guestId, two.guest.id)),
      tags: await db.select().from(guestTags).where(eq(guestTags.guestId, two.guest.id)),
      notes: await db.select().from(guestNotes).where(eq(guestNotes.guestId, two.guest.id)),
      alerts: await db.select().from(alerts).where(eq(alerts.conversationId, two.convId)),
      webhooks: (await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubA.id))).filter((r) =>
        JSON.stringify(r.body).includes(two.guest.lineUserId!),
      ),
    });
    const before = await snapshot();
    // The snapshot holds real rows, so an empty-equals-empty pass is impossible.
    expect(before.guest).toHaveLength(1);
    expect(before.messages).toHaveLength(2);
    expect(before.events).toHaveLength(2);
    expect(before.identity).toHaveLength(1);
    expect(before.tags).toHaveLength(1);
    expect(before.notes).toHaveLength(1);
    expect(before.alerts).toHaveLength(1);
    expect(before.webhooks).toHaveLength(1);
    expect(before.events.every((e) => e.raw !== null && e.personId === 'person_2')).toBe(true);

    await removeGuest(db, clubA.id, one.guest.id, now, uploads);
    expect(await snapshot()).toEqual(before);
    expect(existsSync(join(uploads, two.slipRel))).toBe(true);
    // Guest 1's own raw webhook is gone; guest 2's is the only one left.
    expect(await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubA.id))).toHaveLength(1);
  });

  it('removal in club A leaves club B untouched', async () => {
    const a = await seedGuest(clubA, 'table_demo_B1', '1');
    const b = await seedGuest(clubB, 'table_b_S1', '1');
    const snapshot = async () => ({
      guest: await db.select().from(guests).where(eq(guests.id, b.guest.id)),
      messages: await db.select().from(messages).where(eq(messages.clubId, clubB.id)),
      events: await db.select().from(events).where(eq(events.clubId, clubB.id)),
      deposits: await db.select().from(deposits).where(eq(deposits.clubId, clubB.id)),
      identity: await db.select().from(identityMap).where(eq(identityMap.clubId, clubB.id)),
      tags: await db.select().from(guestTags).where(eq(guestTags.clubId, clubB.id)),
      alerts: await db.select().from(alerts).where(eq(alerts.clubId, clubB.id)),
      webhooks: await db.select().from(rawWebhooks).where(eq(rawWebhooks.clubId, clubB.id)),
    });
    const before = await snapshot();
    await removeGuest(db, clubA.id, a.guest.id, now, uploads);
    expect(await snapshot()).toEqual(before);
    expect(existsSync(join(uploads, b.slipRel))).toBe(true);
    // A guest of club B cannot be removed through club A.
    await expect(removeGuest(db, clubA.id, b.guest.id, now, uploads)).rejects.toThrow(/not_found/);
  });

  it('the removal job completes pending requests and emits guest.removed', async () => {
    const { guest } = await seedGuest(clubA, 'table_demo_B1', '1');
    await db.insert(removalRequests).values({ id: newId(), clubId: clubA.id, guestId: guest.id, channel: 'line' });
    expect(await runRemovalRequests(db, now, uploads)).toBe(1);
    const [req] = await db.select().from(removalRequests).where(eq(removalRequests.guestId, guest.id));
    expect(req!.completedAt).toEqual(now);
    expect(await db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, 'guest.removed')))).toHaveLength(1);
    expect(await runRemovalRequests(db, now, uploads)).toBe(0);
  });
});
