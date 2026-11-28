import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { keepTable, latestKeep, latestPrompt, openReleasePrompt } from '../src/bookings/release-prompt.js';
import { holdTable } from '../src/bookings/service.js';
import { approveNote, createNote } from '../src/brain/notes.js';
import { openDb, type Db } from '../src/db/client.js';
import {
  alerts,
  bookings,
  brainNotes,
  channels,
  clubProfile,
  clubs,
  conversations,
  crowdRatings,
  doorCounts,
  events,
  guests,
  handoffEpisodes,
  messages,
  nights,
  posBills,
  tables,
  zones,
  type Club,
} from '../src/db/schema.js';
import { DEMO_CLUB_ID, seedDemoClub } from '../src/db/seed.js';
import { DemoError, fastForward, resetDemoClub } from '../src/demo/reset.js';
import { SEED_HIST, SEED_TONIGHT } from '../src/demo/seed-history.js';
import { VELORA } from '../src/demo/velora-content.js';
import { checkEventCompleteness } from '../src/jobs/nightly-check.js';
import { currentNightDate } from '../src/lib/time.js';
import { newId } from '../src/lib/util.js';
import { adminCookie, staffCookie, testConfig } from './helpers/track-a.js';

/** Wednesday 25 Nov 2026, 20:00 Bangkok: the first seed. */
const WED = new Date('2026-11-25T13:00:00Z');
/** Friday 27 Nov 2026, 20:00 Bangkok: the reset. */
const FRI = new Date('2026-11-27T13:00:00Z');
const B_ID = 'club_velora_test_b';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length) await closers.pop()!();
});

async function veloraDb(now = WED): Promise<{ db: Db; velora: Club; clubB: Club }> {
  const handle = await openDb({ dataDir: 'memory' });
  closers.push(handle.close);
  await seedDemoClub(handle.db, {}, now);
  // A live club next to Velora, with one table and a guest of its own.
  await handle.db.insert(clubs).values({
    id: B_ID,
    slug: 'velora-test-b',
    name: 'Club B',
    settings: { ...(await club(handle.db, DEMO_CLUB_ID)).settings, refPrefix: 'VB' },
    status: 'live',
  });
  await handle.db.insert(channels).values({ id: `chan_line_${B_ID}`, clubId: B_ID, kind: 'line' });
  await handle.db.insert(zones).values({ id: 'zone_vb', clubId: B_ID, name: 'Main', nameTh: 'หลัก', minSpendSatang: 500_000, depositSatang: 100_000 });
  await handle.db.insert(tables).values([
    { id: 'table_vb_1', clubId: B_ID, zoneId: 'zone_vb', code: 'M1', minPax: 2, maxPax: 6 },
    { id: 'table_vb_2', clubId: B_ID, zoneId: 'zone_vb', code: 'M2', minPax: 2, maxPax: 6 },
  ]);
  return { db: handle.db, velora: await club(handle.db, DEMO_CLUB_ID), clubB: await club(handle.db, B_ID) };
}

async function club(db: Db, id: string): Promise<Club> {
  return (await db.query.clubs.findFirst({ where: eq(clubs.id, id) }))!;
}

async function guestOf(db: Db, clubId: string) {
  const [g] = await db.insert(guests).values({ id: newId(), clubId, lineUserId: `SIM-${newId()}`, displayName: 'G' }).returning();
  return g!;
}

const ids = async (db: Db, prefix: string) =>
  (await db.select({ id: bookings.id, nightDate: bookings.nightDate }).from(bookings).where(and(eq(bookings.clubId, DEMO_CLUB_ID), like(bookings.id, `${prefix}%`)))).sort((a, b) =>
    a.id.localeCompare(b.id),
  );

/** Row counts and sums of the seeded history, for comparing two seeds. */
async function histFigures(db: Db) {
  const hist = (col: unknown) => sql`left(${col}, ${SEED_HIST.length}) = ${SEED_HIST}`;
  const one = async (q: Promise<{ n: number; s: number | null }[]>) => {
    const [r] = await q;
    return [Number(r!.n), Number(r!.s ?? 0)];
  };
  return {
    bookings: await one(db.select({ n: sql<number>`count(*)`, s: sql<number>`sum(${bookings.minSpendSatang} + ${bookings.pax})` }).from(bookings).where(hist(bookings.id))),
    guests: await one(db.select({ n: sql<number>`count(*)`, s: sql<number>`0` }).from(guests).where(hist(guests.id))),
    events: await one(db.select({ n: sql<number>`count(*)`, s: sql<number>`0` }).from(events).where(hist(events.id))),
    door: await one(db.select({ n: sql<number>`count(*)`, s: sql<number>`sum(${doorCounts.delta})` }).from(doorCounts).where(hist(doorCounts.id))),
    crowd: await one(db.select({ n: sql<number>`count(*)`, s: sql<number>`sum(${crowdRatings.level})` }).from(crowdRatings).where(hist(crowdRatings.id))),
    handoffs: await one(db.select({ n: sql<number>`count(*)`, s: sql<number>`0` }).from(handoffEpisodes).where(hist(handoffEpisodes.id))),
    messages: await one(db.select({ n: sql<number>`count(*)`, s: sql<number>`0` }).from(messages).where(hist(messages.id))),
    bills: await one(db.select({ n: sql<number>`count(*)`, s: sql<number>`sum(${posBills.totalSatang})` }).from(posBills).where(hist(posBills.id))),
  };
}

describe('B7 Velora seeded club', () => {
  it('seeds Velora from the content: tables, live FAQ notes without the gaps, profile, history and tonight', async () => {
    const { db, velora } = await veloraDb();
    expect(velora.status).toBe('demo');
    expect(await db.select().from(tables).where(eq(tables.clubId, DEMO_CLUB_ID))).toHaveLength(VELORA.tables.length);

    const notes = await db.select().from(brainNotes).where(eq(brainNotes.clubId, DEMO_CLUB_ID));
    expect(notes).toHaveLength(VELORA.faqs.length);
    expect(notes.every((n) => n.status === 'live' && n.source === 'onboarding' && n.type === 'faq')).toBe(true);
    const text = notes.map((n) => `${n.title}\n${n.bodyMd}`).join('\n');
    for (const g of VELORA.gaps) expect(text).not.toContain(g.question_en);

    const profile = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, DEMO_CLUB_ID) });
    expect(profile).toMatchObject({ district: 'Thonglor', capacityStanding: 450, usualPeakHour: 1, priceBand: 'premium' });

    const hist = await ids(db, SEED_HIST);
    expect(hist.length).toBeGreaterThan(150);
    expect(hist.every((b) => b.nightDate < '2026-11-25')).toBe(true);
    // Every past date has its nights row (B8b), and every seeded history night is open on it.
    const nightRows = await db.select().from(nights).where(and(eq(nights.clubId, DEMO_CLUB_ID), sql`${nights.date} < '2026-11-25'`));
    expect(nightRows.length).toBeGreaterThanOrEqual(42);
    const open = new Set(nightRows.filter((n) => n.status === 'open').map((n) => n.date));
    expect(hist.every((b) => open.has(b.nightDate))).toBe(true);
    const allGuests = await db.select().from(guests).where(eq(guests.clubId, DEMO_CLUB_ID));
    expect(allGuests.every((g) => g.isTest)).toBe(true);
    const allEvents = await db.select({ isTest: events.isTest }).from(events).where(eq(events.clubId, DEMO_CLUB_ID));
    expect(allEvents.length).toBeGreaterThan(0);
    expect(allEvents.every((e) => e.isTest)).toBe(true);
    // Every seeded status change has its event (the B2 nightly check), and no props carry personal data.
    for (const night of ['2026-11-20', '2026-11-25']) expect(await checkEventCompleteness(db, night, WED)).toMatchObject({ missing: 0, piiInProps: 0 });

    // Tonight: some tables booked, one hold in progress, one slip waiting review, one guest waiting for a host.
    const tonight = await db.select().from(bookings).where(like(bookings.id, `${SEED_TONIGHT}%`));
    expect(tonight.every((b) => b.nightDate === '2026-11-25')).toBe(true);
    expect(tonight.filter((b) => b.status === 'confirmed').length).toBeGreaterThanOrEqual(4);
    expect(tonight.filter((b) => b.status === 'held')).toHaveLength(1);
    expect(tonight.filter((b) => b.status === 'payment_review')).toHaveLength(1);
    const waiting = await db.select().from(conversations).where(and(eq(conversations.clubId, DEMO_CLUB_ID), eq(conversations.mode, 'human')));
    expect(waiting.map((c) => c.id)).toEqual([`${SEED_TONIGHT}conv_waiting`]);
  });

  it('reset restores the seeded tonight with today\'s date', async () => {
    const { db, velora } = await veloraDb(WED);
    const tonightBefore = (await ids(db, SEED_TONIGHT)).map((b) => b.id);
    const histBefore = await histFigures(db);
    const tablesBefore = (await db.select().from(tables).where(eq(tables.clubId, DEMO_CLUB_ID))).map((t) => t.id).sort();

    const g = await guestOf(db, DEMO_CLUB_ID);
    const free = (await db.select().from(tables).where(and(eq(tables.clubId, DEMO_CLUB_ID), eq(tables.code, 'H8'))))[0]!;
    const added = await holdTable(db, velora, { guestId: g.id, tableId: free.id, nightDate: '2026-11-25', pax: 2 }, WED);

    const res = await resetDemoClub(db, DEMO_CLUB_ID, FRI);
    expect(res.nightDate).toBe(currentNightDate(FRI, velora.settings.nightEndHour));
    expect(await db.query.bookings.findFirst({ where: eq(bookings.id, added.id) })).toBeUndefined();
    expect(await db.query.guests.findFirst({ where: eq(guests.id, g.id) })).toBeUndefined();
    const tonightAfter = await ids(db, SEED_TONIGHT);
    expect(tonightAfter.map((b) => b.id)).toEqual(tonightBefore);
    expect(tonightAfter.every((b) => b.nightDate === '2026-11-27')).toBe(true);
    expect(await histFigures(db)).toEqual(histBefore);
    expect((await db.select().from(tables).where(eq(tables.clubId, DEMO_CLUB_ID))).map((t) => t.id).sort()).toEqual(tablesBefore);
    // Only seeded activity is left.
    const left = await db.select({ id: events.id }).from(events).where(eq(events.clubId, DEMO_CLUB_ID));
    expect(left.every((e) => e.id.startsWith(SEED_HIST) || e.id.startsWith(SEED_TONIGHT))).toBe(true);
    // The brain notes are content and stay.
    expect(await db.select().from(brainNotes).where(eq(brainNotes.clubId, DEMO_CLUB_ID))).toHaveLength(VELORA.faqs.length);
  });

  it('reset retires the note learned in the demo, so the gap exists again, and returns chats to the bot (spec §12.4)', async () => {
    const { db } = await veloraDb(WED);
    const draft = await createNote(
      db,
      { clubId: DEMO_CLUB_ID, title: 'Birthday cakes', slug: 'birthday-cakes', type: 'faq', bodyMd: 'You can bring a cake.', source: 'takeover', frontmatter: { gapTopic: 'birthday_cake' } } as never,
      { type: 'staff' },
      WED,
    );
    await approveNote(db, DEMO_CLUB_ID, draft.id, { type: 'staff', id: 'u1' }, WED);
    await resetDemoClub(db, DEMO_CLUB_ID, FRI);
    const [after] = await db.select().from(brainNotes).where(eq(brainNotes.id, draft.id));
    expect(after!.status).toBe('retired');
    // The seeded onboarding notes stay live.
    const live = await db.select().from(brainNotes).where(and(eq(brainNotes.clubId, DEMO_CLUB_ID), eq(brainNotes.status, 'live')));
    expect(live).toHaveLength(VELORA.faqs.length);
  });

  it('reset clears release prompts and Keeps of reseeded tonight bookings (B10c)', async () => {
    const { db, velora } = await veloraDb(WED);
    const [tonight] = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.clubId, DEMO_CLUB_ID), like(bookings.id, `${SEED_TONIGHT}%`), eq(bookings.status, 'confirmed')))
      .limit(1);
    expect(tonight).toBeDefined();
    const promptId = newId();
    await db.insert(alerts).values({ id: promptId, clubId: DEMO_CLUB_ID, level: 'urgent', kind: 'no_arrival', bookingId: tonight!.id, textEn: 'p', textTh: 'p', createdAt: WED });
    expect(await keepTable(db, velora, tonight!.id, { type: 'staff', id: 'u1' }, WED, promptId)).toMatchObject({ until: expect.any(Date) });
    expect(await latestKeep(db, DEMO_CLUB_ID, tonight!.id)).toBeDefined();

    await resetDemoClub(db, DEMO_CLUB_ID, FRI);
    // Same id, a fresh booking: no prompt, no open prompt, no Keep moving its release time.
    expect(await db.query.bookings.findFirst({ where: eq(bookings.id, tonight!.id) })).toBeDefined();
    expect(await latestPrompt(db, DEMO_CLUB_ID, tonight!.id)).toBeUndefined();
    expect(await openReleasePrompt(db, DEMO_CLUB_ID, tonight!.id)).toBeUndefined();
    expect(await latestKeep(db, DEMO_CLUB_ID, tonight!.id)).toBeUndefined();
  });

  it('reset refuses a non-demo club', async () => {
    const { db } = await veloraDb();
    await expect(resetDemoClub(db, B_ID, FRI)).rejects.toMatchObject({ code: 'not_demo' });
    await expect(resetDemoClub(db, B_ID, FRI)).rejects.toBeInstanceOf(DemoError);
  });

  it('reset leaves club B untouched', async () => {
    const { db, clubB } = await veloraDb();
    const g = await guestOf(db, B_ID);
    const b = await holdTable(db, clubB, { guestId: g.id, tableId: 'table_vb_1', nightDate: '2026-11-27', pax: 2 }, FRI);
    const count = async () => ({
      bookings: (await db.select().from(bookings).where(eq(bookings.clubId, B_ID))).length,
      guests: (await db.select().from(guests).where(eq(guests.clubId, B_ID))).length,
      events: (await db.select().from(events).where(eq(events.clubId, B_ID))).length,
    });
    const before = await count();
    expect(before.events).toBeGreaterThan(0);
    await resetDemoClub(db, DEMO_CLUB_ID, FRI);
    expect(await count()).toEqual(before);
    expect((await db.query.bookings.findFirst({ where: eq(bookings.id, b.id) }))!.status).toBe('held');
  });

  it('fast-forward expires the chosen hold, tells the guest, and leaves a stale hold of club B alone', async () => {
    const { db, clubB } = await veloraDb(FRI);
    const app = createApp(testConfig(), db, { bot: { now: () => FRI, log: () => {} } });
    const told = vi.spyOn(app.ctx.notifier, 'holdExpired');

    // Club B: a hold whose time already ran out (the global sweep would expire it).
    const g = await guestOf(db, B_ID);
    const stale = await holdTable(db, clubB, { guestId: g.id, tableId: 'table_vb_2', nightDate: '2026-11-27', pax: 2 }, new Date(FRI.getTime() - 60 * 60_000));

    const [hold] = await db.select().from(bookings).where(and(like(bookings.id, `${SEED_TONIGHT}%`), eq(bookings.status, 'held')));
    expect(hold!.holdExpiresAt!.getTime()).toBeGreaterThan(FRI.getTime());
    const expired = await fastForward(app.ctx, DEMO_CLUB_ID, 'hold_expiry', hold!.id, FRI);
    expect(expired).toMatchObject({ id: hold!.id, status: 'expired' });
    expect(expired!.holdExpiresAt!.getTime()).toBeLessThan(FRI.getTime());
    expect(told).toHaveBeenCalledTimes(1);
    expect(told.mock.calls[0]![0].id).toBe(hold!.id);
    const out = await db.select().from(messages).where(and(eq(messages.guestId, hold!.guestId), eq(messages.direction, 'out')));
    expect(out).toHaveLength(1);
    const history = await db.select({ type: events.type }).from(events).where(and(eq(events.bookingId, hold!.id), eq(events.type, 'hold.expired')));
    expect(history).toHaveLength(1);

    expect((await db.query.bookings.findFirst({ where: eq(bookings.id, stale.id) }))!.status).toBe('held');
    // A booking that is not a hold of that club: nothing happens.
    expect(await fastForward(app.ctx, DEMO_CLUB_ID, 'hold_expiry', stale.id, FRI)).toBeUndefined();
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('seeded history is deterministic', async () => {
    const a = await veloraDb(WED);
    const b = await veloraDb(WED);
    const fa = await histFigures(a.db);
    expect(fa.bookings[0]).toBeGreaterThan(0);
    expect(fa.door[1]).toBeGreaterThan(0);
    expect(fa.handoffs[0]).toBeGreaterThan(0);
    expect(await histFigures(b.db)).toEqual(fa);
    const idsA = (await ids(a.db, SEED_HIST)).map((r) => `${r.id}:${r.nightDate}`);
    expect((await ids(b.db, SEED_HIST)).map((r) => `${r.id}:${r.nightDate}`)).toEqual(idsA);
  });

  it('demo routes: platform admin resets and fast-forwards; a club manager gets 403; a live club gets 409', async () => {
    const { db, clubB } = await veloraDb(FRI);
    const app = createApp(testConfig(), db, { bot: { now: () => FRI, log: () => {} } });
    const admin = await adminCookie(app);
    const post = (path: string, cookie: string, body?: unknown) =>
      app.app.request(`/api/admin/demo${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const reset = await post('/demo/reset', admin);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ nightDate: '2026-11-27' });
    expect((await post(`/${clubB.slug}/reset`, admin)).status).toBe(409);
    expect((await post('/nope/reset', admin)).status).toBe(404);

    const [hold] = await db.select().from(bookings).where(and(like(bookings.id, `${SEED_TONIGHT}%`), eq(bookings.status, 'held')));
    expect((await post('/demo/fast-forward', admin, { what: 'party', bookingId: hold!.id })).status).toBe(400);
    // B10 widened `what`: a hold has no reminder or release to run, so nothing happens and it is 404.
    expect((await post('/demo/fast-forward', admin, { what: 'reminder', bookingId: hold!.id })).status).toBe(404);
    expect((await post('/demo/fast-forward', admin, { what: 'release', bookingId: hold!.id })).status).toBe(404);
    expect((await db.query.bookings.findFirst({ where: eq(bookings.id, hold!.id) }))!.status).toBe('held');
    const ff = await post('/demo/fast-forward', admin, { what: 'hold_expiry', bookingId: hold!.id });
    expect(ff.status).toBe(200);
    expect(await ff.json()).toMatchObject({ booking: { id: hold!.id, status: 'expired' } });
    expect((await post('/demo/fast-forward', admin, { what: 'hold_expiry', bookingId: hold!.id })).status).toBe(404);

    const manager = await staffCookie(app, clubB);
    expect((await post('/demo/reset', manager)).status).toBe(403);
    const after = await db.select().from(bookings).where(inArray(bookings.status, ['held']));
    expect(after.every((b) => b.clubId !== DEMO_CLUB_ID)).toBe(true);
  });
});
