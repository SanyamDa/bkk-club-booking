import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { bookings, clubs, crowdRatings, deposits, events, nights, occupancySnapshots, type Club } from '../src/db/schema.js';
import { buildScheduler } from '../src/jobs/index.js';
import { runNightsJob } from '../src/jobs/nights.js';
import {
  CrowdRatingError,
  dueBucket,
  leadBuckets,
  recordCrowdRating,
  runCrowdPrompts,
  runSnapshots,
  takeSnapshot,
} from '../src/jobs/snapshots.js';
import { newId } from '../src/lib/util.js';
import { makeGuest, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club; // fixture club, status 'demo'
let clubB: Club; // status 'live', four tables, open Wed–Sat

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

/** Bangkok wall-clock time as an instant (UTC+7). */
const bkk = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);

const snapshotsOf = (clubId: string, nightDate: string) =>
  db.select().from(occupancySnapshots).where(and(eq(occupancySnapshots.clubId, clubId), eq(occupancySnapshots.nightDate, nightDate)));

describe('occupancy snapshots (plan B12)', () => {
  it('lead buckets are 14, 7, 3, 1 days before, 12:00 and 18:00 on the day, then every 30 minutes from doors to close', () => {
    const list = leadBuckets(clubB, '2026-12-12');
    const names = list.map((b) => b.bucket);
    expect(names.slice(0, 6)).toEqual(['d14', 'd7', 'd3', 'd1', 'd0_1200', 'd0_1800']);
    expect(list[0]!.at).toEqual(bkk('2026-11-28', '12:00'));
    expect(list[1]!.at).toEqual(bkk('2026-12-05', '12:00'));
    expect(list[2]!.at).toEqual(bkk('2026-12-09', '12:00'));
    expect(list[3]!.at).toEqual(bkk('2026-12-11', '12:00'));
    expect(list[4]!.at).toEqual(bkk('2026-12-12', '12:00'));
    expect(list[5]!.at).toEqual(bkk('2026-12-12', '18:00'));
    // Doors 18:00 (same instant as d0_1800, so no live_1800) to close 06:00 the next morning.
    expect(names).not.toContain('live_1800');
    expect(names[6]).toBe('live_1830');
    expect(names.at(-1)).toBe('live_0600');
    expect(list.at(-1)!.at).toEqual(bkk('2026-12-13', '06:00'));
    expect(list.filter((b) => b.bucket.startsWith('live_'))).toHaveLength(24);
    for (let i = 7; i < list.length; i++) expect(list[i]!.at.getTime() - list[i - 1]!.at.getTime()).toBe(30 * 60_000);
  });

  it('a snapshot exists for every club-night not closed at every scheduled lead bucket, and none for a closed night', async () => {
    const start = bkk('2026-11-27', '11:00');
    await runNightsJob(db, start);
    // A person closes Friday 11 Dec (A9's calendar); Sunday 13 Dec is closed by the weekday rule.
    await db
      .update(nights)
      .set({ status: 'closed', closedReason: 'private_event', editedBy: 'user_manager' })
      .where(and(eq(nights.clubId, clubB.id), eq(nights.date, '2026-12-11')));
    const open = ['2026-12-12'];
    const closed = ['2026-12-11', '2026-12-13'];
    const times = new Set<number>();
    for (const d of [...open, ...closed]) for (const b of leadBuckets(clubB, d)) times.add(b.at.getTime() + 60_000);
    for (const t of [...times].sort((a, b) => a - b)) await runSnapshots(db, new Date(t));

    for (const d of open) {
      const rows = await snapshotsOf(clubB.id, d);
      expect(rows.map((r) => r.leadBucket).sort()).toEqual(leadBuckets(clubB, d).map((b) => b.bucket).sort());
      expect(rows.every((r) => r.tablesActive === 4)).toBe(true);
    }
    for (const d of closed) expect(await snapshotsOf(clubB.id, d)).toHaveLength(0);
  });

  it('snapshot counts held, confirmed and arrived tables, pax, min spend and verified deposits; test bookings do not count at a real club', async () => {
    const night = '2026-12-12';
    const now = bkk(night, '22:00');
    const guest = await makeGuest(db, { clubId: clubB.id });
    const add = (tableId: string, status: string, pax: number, minSpend: number, extra: Record<string, unknown> = {}) => {
      const id = newId();
      return db
        .insert(bookings)
        .values({
          id, clubId: clubB.id, refCode: `TB${id.slice(0, 8)}`, guestId: guest.id, tableId, nightDate: night, pax,
          status: status as 'held', source: 'line', minSpendSatang: minSpend, depositSatang: 100_000, ...extra,
        })
        .then(() => id);
    };
    await add('table_b_V1', 'held', 8, 2_000_000, { holdExpiresAt: new Date(now.getTime() + 5 * 60_000) });
    await add('table_b_V2', 'held', 6, 2_000_000, { holdExpiresAt: new Date(now.getTime() - 60_000) }); // ran out
    const confirmed = await add('table_b_S1', 'confirmed', 3, 600_000);
    await add('table_b_S2', 'arrived', 4, 600_000, { arrivedPax: 5 });
    await add('table_b_S1', 'cancelled', 2, 600_000);
    await add('table_b_V2', 'confirmed', 10, 2_000_000, { isTest: true }); // simulator booking
    await db.insert(deposits).values({ id: newId(), clubId: clubB.id, bookingId: confirmed, amountSatang: 200_000, method: 'promptpay_slip', status: 'verified' });

    expect(await takeSnapshot(db, clubB, night, 'live_2200', now)).toBe(true);
    const [row] = await snapshotsOf(clubB.id, night);
    expect(row).toMatchObject({
      leadBucket: 'live_2200',
      takenAt: now,
      tablesActive: 4,
      tablesHeld: 1,
      tablesConfirmed: 1,
      tablesArrived: 1,
      paxBooked: 8 + 3 + 4,
      minSpendBookedSatang: 2_000_000 + 600_000 + 600_000,
      depositsVerifiedSatang: 200_000,
    });
  });

  it('a repeat run in the same bucket writes nothing; a missed window is not caught up', async () => {
    const night = '2026-12-12';
    await runNightsJob(db, bkk('2026-11-27', '11:00'));
    const d14 = bkk('2026-11-28', '12:00');
    expect(dueBucket(clubB, night, new Date(d14.getTime() + 60 * 60_000))).toBe('d14');
    expect(dueBucket(clubB, night, new Date(d14.getTime() + 3 * 60 * 60_000))).toBeNull();
    expect(dueBucket(clubB, night, bkk(night, '18:31'))).toBe('live_1830');
    expect(dueBucket(clubB, night, bkk(night, '19:00'))).toBe('live_1900');
    expect(dueBucket(clubB, night, bkk('2026-12-13', '06:29'))).toBe('live_0600');
    expect(dueBucket(clubB, night, bkk('2026-12-13', '06:30'))).toBeNull();

    // Three hours late for d14: nothing is written for that bucket.
    await runSnapshots(db, new Date(d14.getTime() + 3 * 60 * 60_000));
    expect(await snapshotsOf(clubB.id, night)).toHaveLength(0);
    // On time, then again five minutes later in the same bucket.
    await runSnapshots(db, bkk(night, '22:01'));
    await runSnapshots(db, bkk(night, '22:06'));
    const rows = await snapshotsOf(clubB.id, night);
    expect(rows.map((r) => r.leadBucket)).toEqual(['live_2200']);
  });
});

describe('crowd rating (plan B12)', () => {
  it('crowd rating 1-5 is stored with the user and emits crowd.rated; 0 and 6 are refused', async () => {
    const now = bkk('2026-12-13', '01:15'); // after midnight: still Saturday's night
    const row = await recordCrowdRating(db, clubB, { level: 4, userId: 'user_door' }, now);
    expect(row).toMatchObject({ clubId: clubB.id, nightDate: '2026-12-12', level: 4, userId: 'user_door', at: now });
    const [ev] = await db.select().from(events).where(and(eq(events.clubId, clubB.id), eq(events.type, 'crowd.rated')));
    expect(ev).toMatchObject({ actorType: 'staff', actorId: 'user_door', nightDate: '2026-12-12', props: { rating: 4 }, isTest: false, dataOrigin: 'first_party' });

    for (const level of [0, 6, 2.5]) {
      await expect(recordCrowdRating(db, clubB, { level, userId: 'user_door' }, now)).rejects.toBeInstanceOf(CrowdRatingError);
    }
    expect(await db.select().from(crowdRatings).where(eq(crowdRatings.clubId, clubB.id))).toHaveLength(1);
  });

  it('door role can rate through the route; another club\'s slug is 403', async () => {
    const now = bkk('2026-12-12', '23:00');
    const app = createApp(testConfig(), db, { bot: { now: () => now, log: () => {} } });
    const cookie = await staffCookie(app, clubA, 'door');
    const post = (slug: string, body: unknown) =>
      app.app.request(staffUrl(slug, '/door/crowd-rating'), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const ok = await post(clubA.slug, { level: 3 });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { rating: { nightDate: string; level: number } };
    expect(body.rating).toMatchObject({ nightDate: '2026-12-12', level: 3 });
    const [row] = await db.select().from(crowdRatings).where(eq(crowdRatings.clubId, clubA.id));
    expect(row!.userId).toBeTruthy();
    const [ev] = await db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, 'crowd.rated')));
    expect(ev).toMatchObject({ actorId: row!.userId, isTest: true }); // demo club: test row

    expect((await post(clubA.slug, { level: 9 })).status).toBe(400);
    expect((await post(clubA.slug, { level: 'full' })).status).toBe(400);
    expect((await post(clubB.slug, { level: 3 })).status).toBe(403);
    expect(await db.select().from(crowdRatings).where(eq(crowdRatings.clubId, clubB.id))).toHaveLength(0);
  });

  it('how full now is pushed once per prompt hour to the staff group, not on a closed night', async () => {
    await db.update(clubs).set({ staffGroupId: 'Cstaffgroup' }).where(eq(clubs.id, clubA.id));
    const app = createApp(testConfig(), db, { bot: { now: () => new Date(), log: () => {} } });
    const pushes: { to: string; text: string }[] = [];
    const dev = app.ctx.gateways.dev as unknown as { push: (to: string, msgs: { type: string; text?: string }[]) => Promise<void> };
    vi.spyOn(dev, 'push').mockImplementation(async (to, msgs) => {
      for (const m of msgs) pushes.push({ to, text: m.text ?? '' });
    });
    const send = (club: Club, nightDate: string) => app.ctx.notifier.crowdPrompt(club, nightDate);
    await runNightsJob(db, bkk('2026-11-27', '11:00'));
    const run = (date: string, hhmm: string) => runCrowdPrompts(db, bkk(date, hhmm), send);
    const toGroup = () => pushes.filter((p) => p.to === 'Cstaffgroup');

    await run('2026-11-27', '21:05'); // before the first prompt hour
    expect(toGroup()).toHaveLength(0);
    await run('2026-11-27', '22:02');
    await run('2026-11-27', '22:07'); // same hour: not again
    await run('2026-11-27', '22:40'); // past the window
    expect(toGroup()).toHaveLength(1);
    expect(toGroup()[0]!.text).toContain('how full is it now?');
    expect(toGroup()[0]!.text).toContain('ตอนนี้คนเยอะแค่ไหน');
    await run('2026-11-27', '23:01');
    await run('2026-11-28', '00:03'); // after midnight: still Friday's night
    await run('2026-11-28', '01:04');
    await run('2026-11-28', '02:04'); // not a prompt hour
    expect(toGroup()).toHaveLength(4);

    // Sunday is closed (open Wed–Sat): no prompt.
    await run('2026-11-29', '22:03');
    expect(toGroup()).toHaveLength(4);
  });

  it('snapshots and crowd-prompt jobs are registered on the scheduler', () => {
    const { ctx } = createApp(testConfig(), db, { bot: { now: () => new Date(), log: () => {} } });
    expect(buildScheduler(ctx, () => new Date()).names()).toEqual(expect.arrayContaining(['snapshots', 'crowd-prompt']));
  });
});
