import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { emit } from '../src/data/events.js';
import {
  BUSYNESS_RATE_LIMIT_PER_MINUTE,
  issueBusynessKey,
  levelOf,
  listBusynessKeys,
  revokeBusynessKey,
  rotateBusynessKey,
  verifyBusynessKey,
} from '../src/data/busyness.js';
import type { Db } from '../src/db/client.js';
import { auditLog, clubProfile, clubs, crowdRatings, doorCounts, nights, occupancySnapshots, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { setupTwoClubs } from './helpers.js';
import { adminCookie, staffCookie, testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club; // fixture club, status 'demo' (stands in for Velora)
let clubB: Club; // status 'live', four tables, open Wed–Sat, doors 18:00, close 06:00
let now: Date;
let app: ReturnType<typeof createApp>;

/** Bangkok wall-clock time as an instant (UTC+7). */
const bkk = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);
const TONIGHT = '2026-12-11'; // a Friday

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  now = bkk(TONIGHT, '23:10');
  app = createApp(testConfig(), db, { bot: { now: () => now, log: () => {} } });
});
afterEach(async () => {
  await close();
});

async function snapshot(
  clubId: string,
  nightDate: string,
  bucket: string,
  takenAt: Date,
  t: { active?: number; held?: number; confirmed?: number; arrived?: number; pax: number },
) {
  await db.insert(occupancySnapshots).values({
    clubId,
    nightDate,
    takenAt,
    leadBucket: bucket,
    tablesActive: t.active ?? 4,
    tablesHeld: t.held ?? 0,
    tablesConfirmed: t.confirmed ?? 0,
    tablesArrived: t.arrived ?? 0,
    paxBooked: t.pax,
    minSpendBookedSatang: 1_234_500,
    depositsVerifiedSatang: 987_600,
  });
}

const rate = (clubId: string, nightDate: string, at: Date, level: number) =>
  db.insert(crowdRatings).values({ id: newId(), clubId, nightDate, at, level, userId: 'user_door' });

async function key(kind: 'production' | 'sandbox' = 'production') {
  return (await issueBusynessKey(db, { label: `app ${kind}`, kind }, 'user_admin', now)).token;
}

async function feed(token: string, query = '') {
  const res = await app.app.request(`/data/v1/busyness${query}`, { headers: { authorization: `Bearer ${token}` } });
  return { res, body: (await res.json()) as any };
}

const clubIn = (body: any, slug: string) => body.clubs.find((c: any) => c.slug === slug);
const bucketAt = (club: any, label: string) => club.buckets.find((b: any) => b.label === label);

async function addLiveClubC() {
  await db.insert(clubs).values({ id: 'club_test_c', slug: 'test-c', name: 'Test Club C', settings: clubB.settings, status: 'live' });
}

describe('busyness feed (plan B21)', () => {
  it('level for every live club on a night whose nights.status is not closed', async () => {
    await addLiveClubC();
    await db.insert(nights).values({ id: newId(), clubId: clubB.id, date: TONIGHT, status: 'sold_out' });
    await snapshot(clubB.id, TONIGHT, 'live_2300', bkk(TONIGHT, '23:00'), { confirmed: 2, arrived: 1, pax: 24 });
    await rate(clubB.id, TONIGHT, bkk(TONIGHT, '23:00'), 4);

    const { res, body } = await feed(await key());
    expect(res.status).toBe(200);
    expect(body.version).toBe('v1');
    expect(body.sandbox).toBe(false);
    expect(body.clubs.map((c: any) => c.slug).sort()).toEqual(['test-b', 'test-c']);
    for (const c of body.clubs) {
      expect(c.nightDate).toBe(TONIGHT);
      expect(c.buckets).toHaveLength(24); // 18:00 to 06:00, every 30 minutes
      expect(c.buckets[0].label).toBe('18:00');
      expect(c.buckets.at(-1).label).toBe('05:30');
      for (const b of c.buckets) expect(b.noData || [1, 2, 3, 4, 5].includes(b.level)).toBe(true);
    }
    const b = clubIn(body, 'test-b');
    expect(b.night).toBe('sold_out');
    expect(b.test).toBe(false);
    expect(bucketAt(b, '23:00')).toMatchObject({ level: 4, noData: false, confidence: 'high' });
    // A future bucket is a forecast from booking heat: 3 of 4 tables = 0.75 → level 4.
    expect(bucketAt(b, '01:00')).toMatchObject({ level: 4, noData: false, confidence: 'low' });
    expect(bucketAt(b, '01:00').inputs).toContain('bookings');
    // Club C has no inputs at all: every bucket is an explicit "no data", never "quiet".
    expect(clubIn(body, 'test-c').buckets.every((x: any) => x.noData && x.level === null)).toBe(true);
    expect(levelOf(0.19)).toBe(1);
    expect(levelOf(0.8)).toBe(5);
  });

  it('a closed night lists the club with no buckets', async () => {
    await db.insert(nights).values({ id: newId(), clubId: clubB.id, date: TONIGHT, status: 'closed', closedReason: 'private_event' });
    await snapshot(clubB.id, TONIGHT, 'd0_1800', bkk(TONIGHT, '18:00'), { confirmed: 4, pax: 30 });
    const { body } = await feed(await key());
    expect(clubIn(body, 'test-b')).toMatchObject({ night: 'closed', buckets: [], method: null });
    // A night closed by the weekday rule (Sunday) is closed too.
    const sunday = await feed(await key(), '?date=2026-12-13');
    expect(clubIn(sunday.body, 'test-b')).toMatchObject({ nightDate: '2026-12-13', night: 'closed', buckets: [] });
  });

  it('demo club never appears', async () => {
    await snapshot(clubA.id, TONIGHT, 'live_2300', bkk(TONIGHT, '23:00'), { active: 10, confirmed: 9, pax: 60 });
    await rate(clubA.id, TONIGHT, bkk(TONIGHT, '23:00'), 5);
    const { res, body } = await feed(await key());
    expect(res.status).toBe(200);
    expect(body.clubs.some((c: any) => c.slug === clubA.slug)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(clubA.slug);
    expect(body.clubs.every((c: any) => c.test === false)).toBe(true);
    // Paused and onboarding clubs are not live either.
    await db.update(clubs).set({ status: 'paused' }).where(eq(clubs.id, clubB.id));
    expect((await feed(await key())).body.clubs).toEqual([]);
  });

  it('sandbox key returns only Velora, marked test', async () => {
    await snapshot(clubA.id, TONIGHT, 'live_2300', bkk(TONIGHT, '23:00'), { active: 10, confirmed: 9, pax: 60 });
    await rate(clubA.id, TONIGHT, bkk(TONIGHT, '23:00'), 5);
    await snapshot(clubB.id, TONIGHT, 'live_2300', bkk(TONIGHT, '23:00'), { confirmed: 2, pax: 20 });
    const { body } = await feed(await key('sandbox'));
    expect(body.sandbox).toBe(true);
    expect(body.clubs.map((c: any) => c.slug)).toEqual([clubA.slug]);
    expect(body.clubs[0].test).toBe(true);
    expect(bucketAt(body.clubs[0], '23:00')).toMatchObject({ level: 5, confidence: 'high' });
    expect(JSON.stringify(body)).not.toContain('test-b');
  });

  it('no guest-level field', async () => {
    await db.insert(clubProfile).values({ clubId: clubB.id, capacityStanding: 400 });
    await snapshot(clubB.id, TONIGHT, 'live_2200', bkk(TONIGHT, '22:00'), { confirmed: 3, pax: 37 });
    await db.insert(doorCounts).values({ id: newId(), clubId: clubB.id, nightDate: TONIGHT, at: bkk(TONIGHT, '22:05'), delta: 123, kind: 'walk_in', userId: 'user_door' });
    await rate(clubB.id, TONIGHT, bkk(TONIGHT, '23:00'), 3);
    const { body } = await feed(await key());

    const keys = new Set<string>();
    const numbers: number[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
      else if (typeof v === 'number') numbers.push(v);
    };
    walk(body);
    const allowed = ['version', 'generatedAt', 'sandbox', 'clubs', 'slug', 'name', 'nightDate', 'night', 'method', 'test', 'buckets', 'start', 'label', 'level', 'noData', 'confidence', 'inputs'];
    expect([...keys].filter((k) => !allowed.includes(k))).toEqual([]);
    // The only numbers are levels: no head counts, pax, table counts or spend.
    expect(numbers.every((n) => [1, 2, 3, 4, 5].includes(n))).toBe(true);
    const text = JSON.stringify(body);
    for (const leak of ['37', '123', '1234500', '987600', 'user_door']) expect(text).not.toContain(leak);
  });

  it('reads only first_party and pos origins', async () => {
    await snapshot(clubB.id, TONIGHT, 'live_2300', bkk(TONIGHT, '23:00'), { confirmed: 2, pax: 20 });
    const search = (dataOrigin: 'line_chat' | 'line_profile' | 'instagram' | 'first_party' | 'pos', isTest = false) =>
      emit(db, {
        clubId: clubB.id,
        type: 'availability.searched',
        occurredAt: bkk(TONIGHT, '20:00'),
        actorType: 'guest',
        dataOrigin,
        nightDate: TONIGHT,
        props: { night_date: TONIGHT, pax_range: '2-4', result_count: 0, tables_shown: 0 },
        isTest,
      });
    const inputsOf = async () => bucketAt(clubIn((await feed(await key())).body, 'test-b'), '01:00').inputs as string[];

    await search('line_chat');
    await search('line_profile');
    await search('instagram');
    await search('first_party', true); // a test row of a live club
    expect(await inputsOf()).not.toContain('searches');
    await search('pos');
    expect(await inputsOf()).toContain('searches');
  });

  it('thin data is no data, not quiet', async () => {
    // 6 booked guests (< 10): the forecast is not published.
    await snapshot(clubB.id, TONIGHT, 'd0_1800', bkk(TONIGHT, '18:00'), { confirmed: 1, pax: 6 });
    now = bkk(TONIGHT, '17:00'); // before doors: every bucket is a forecast
    await snapshot(clubB.id, TONIGHT, 'd0_1200', bkk(TONIGHT, '12:00'), { confirmed: 1, pax: 6 });
    let b = clubIn((await feed(await key())).body, 'test-b');
    expect(b.buckets.every((x: any) => x.noData && x.level === null && x.confidence === null)).toBe(true);

    // Enough guests booked, but after doors with neither a door count nor a crowd rating: started
    // buckets are "no data"; later buckets are still forecast.
    await snapshot(clubB.id, TONIGHT, 'live_2200', bkk(TONIGHT, '22:00'), { confirmed: 1, pax: 12 });
    now = bkk(TONIGHT, '23:10');
    b = clubIn((await feed(await key())).body, 'test-b');
    expect(bucketAt(b, '22:30')).toMatchObject({ level: null, noData: true });
    expect(bucketAt(b, '02:00')).toMatchObject({ level: 2, noData: false }); // 1 of 4 tables = 0.25
  });

  it('crowd rating and door count set the level of a started bucket', async () => {
    await db.insert(clubProfile).values({ clubId: clubB.id, capacityStanding: 400 });
    await snapshot(clubB.id, TONIGHT, 'd0_1800', bkk(TONIGHT, '18:00'), { confirmed: 1, pax: 12 });
    await db.insert(doorCounts).values([
      { id: newId(), clubId: clubB.id, nightDate: TONIGHT, at: bkk(TONIGHT, '21:10'), delta: 200, kind: 'walk_in' },
      { id: newId(), clubId: clubB.id, nightDate: TONIGHT, at: bkk(TONIGHT, '22:10'), delta: 100, kind: 'table_guest' },
    ]);
    await rate(clubB.id, TONIGHT, bkk(TONIGHT, '23:00'), 2);
    const b = clubIn((await feed(await key())).body, 'test-b');
    // 21:00 bucket: 200 of 400 = 0.5 → 3; 22:00 bucket: 300 of 400 = 0.75 → 4.
    expect(bucketAt(b, '21:00')).toMatchObject({ level: 3, confidence: 'medium' });
    expect(bucketAt(b, '21:00').inputs).toContain('door_count');
    expect(bucketAt(b, '22:00')).toMatchObject({ level: 4, confidence: 'medium' });
    // 23:00 bucket: the staff rating wins over the door count.
    expect(bucketAt(b, '23:00')).toMatchObject({ level: 2, confidence: 'high' });
    expect(bucketAt(b, '23:00').inputs).toContain('crowd_rating');
    // A rating made later than now is not read.
    await rate(clubB.id, TONIGHT, bkk(TONIGHT, '23:30'), 5);
    expect(bucketAt(clubIn((await feed(await key())).body, 'test-b'), '23:00').level).toBe(2);
  });

  it('weekday baseline and pace once 4 same-weekday nights exist', async () => {
    now = bkk(TONIGHT, '17:00');
    await snapshot(clubB.id, TONIGHT, 'd0_1200', bkk(TONIGHT, '12:00'), { confirmed: 2, pax: 20 }); // heat 0.5
    const forecast = async () => clubIn((await feed(await key())).body, 'test-b');

    let b = await forecast();
    expect(b.method).toBe('booking_heat');
    expect(bucketAt(b, '01:00')).toMatchObject({ level: 3, confidence: 'low' }); // 0.5 → 3

    // Four earlier Fridays: half the tables at 12:00 on the day, all of them by the end.
    const fridays = ['2026-12-04', '2026-11-27', '2026-11-20'];
    for (const d of fridays) {
      await snapshot(clubB.id, d, 'd0_1200', bkk(d, '12:00'), { confirmed: 2, pax: 20 });
      await snapshot(clubB.id, d, 'live_0000', bkk(d, '23:59'), { confirmed: 4, pax: 40 });
    }
    // A Thursday does not count toward the Friday baseline.
    await snapshot(clubB.id, '2026-12-10', 'd0_1200', bkk('2026-12-10', '12:00'), { confirmed: 2, pax: 20 });
    expect((await forecast()).method).toBe('booking_heat');

    const d = '2026-11-13';
    await snapshot(clubB.id, d, 'd0_1200', bkk(d, '12:00'), { confirmed: 2, pax: 20 });
    await snapshot(clubB.id, d, 'live_0000', bkk(d, '23:59'), { confirmed: 4, pax: 40 });
    b = await forecast();
    expect(b.method).toBe('baseline_pace');
    // Mean final heat 1.0 × pace (0.5 ÷ 0.5) = 1.0 → level 5.
    expect(bucketAt(b, '01:00')).toMatchObject({ level: 5, confidence: 'medium' });
    expect(bucketAt(b, '01:00').inputs).toEqual(expect.arrayContaining(['bookings', 'baseline']));
  });

  /** Four earlier Fridays: half the tables at 12:00 on the day, all of them by the end. */
  async function fourFridays() {
    for (const d of ['2026-12-04', '2026-11-27', '2026-11-20', '2026-11-13']) {
      await snapshot(clubB.id, d, 'd0_1200', bkk(d, '12:00'), { confirmed: 2, pax: 20 });
      await snapshot(clubB.id, d, 'live_0000', bkk(d, '23:59'), { confirmed: 4, pax: 40 });
    }
  }

  it('weekday baseline scales by pace against the same lead bucket', async () => {
    now = bkk(TONIGHT, '17:00');
    await fourFridays();
    await snapshot(clubB.id, TONIGHT, 'd0_1200', bkk(TONIGHT, '12:00'), { confirmed: 1, pax: 20 }); // heat 0.25
    const forecast = async () => clubIn((await feed(await key())).body, 'test-b');
    let b = await forecast();
    expect(b.method).toBe('baseline_pace');
    // Mean final heat 1.0 × pace (0.25 ÷ 0.5) = 0.5 → level 3 (not the raw heat 0.25 → 2, nor 1.0 → 5).
    expect(bucketAt(b, '01:00')).toMatchObject({ level: 3, confidence: 'medium' });

    // No earlier Friday has a snapshot at this lead bucket: pace falls back to 1.
    await snapshot(clubB.id, TONIGHT, 'd0_1500', bkk(TONIGHT, '15:00'), { confirmed: 1, pax: 20 });
    b = await forecast();
    expect(bucketAt(b, '01:00')).toMatchObject({ level: 5, confidence: 'medium' });
  });

  it('a started bucket on an older snapshot uses baseline x pace from that snapshot', async () => {
    now = bkk('2026-12-12', '01:10');
    await fourFridays();
    await snapshot(clubB.id, TONIGHT, 'd0_1200', bkk(TONIGHT, '12:00'), { confirmed: 1, pax: 20 }); // heat 0.25
    await snapshot(clubB.id, TONIGHT, 'live_0000', bkk('2026-12-12', '00:00'), { confirmed: 3, pax: 30 }); // heat 0.75
    await rate(clubB.id, TONIGHT, bkk('2026-12-12', '01:00'), 4);
    const b = clubIn((await feed(await key(), `?date=${TONIGHT}`)).body, 'test-b');
    expect(b.method).toBe('baseline_pace');
    // 22:00 rests on the 12:00 snapshot: 1.0 × (0.25 ÷ 0.5) = 0.5 → 3 (raw heat would be 2).
    expect(bucketAt(b, '22:00')).toMatchObject({ level: 3, confidence: 'medium' });
    expect(bucketAt(b, '22:00').inputs).toEqual(expect.arrayContaining(['bookings', 'baseline']));
    // A future bucket rests on the latest snapshot: 1.0 × (0.75 ÷ 1.0) = 0.75 → 4.
    expect(bucketAt(b, '03:00')).toMatchObject({ level: 4, confidence: 'medium' });
    // A rated bucket is the rating; the baseline was not applied, so it is not listed.
    expect(bucketAt(b, '01:00')).toMatchObject({ level: 4, confidence: 'high' });
    expect(bucketAt(b, '01:00').inputs).not.toContain('baseline');
  });

  it('a rotate overlapping a revoke cannot undo the revoke', async () => {
    for (const rotateFirst of [true, false]) {
      const token = await key();
      const id = token.split('_')[1]!;
      const rotate = () => rotateBusynessKey(db, id, 'user_admin', now);
      const revoke = () => revokeBusynessKey(db, id, 'user_admin', now);
      const [rotated, revoked] = rotateFirst
        ? await Promise.all([rotate(), revoke()])
        : await Promise.all([revoke(), rotate()]).then(([v, r]) => [r, v] as const);
      expect(revoked?.revokedAt).not.toBeNull();
      expect(await verifyBusynessKey(db, token)).toBeNull();
      if (rotated) expect(await verifyBusynessKey(db, rotated.token)).toBeNull();
      expect((await listBusynessKeys(db)).find((k) => k.id === id)?.revokedAt).not.toBeNull();
      // Revoked stays revoked: a later rotate is refused.
      expect(await rotate()).toBeNull();
    }
  });

  it('missing, wrong and revoked keys are 401', async () => {
    const token = await key();
    const call = (headers: Record<string, string>) => app.app.request('/data/v1/busyness', { headers });
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call({ authorization: token })).status).toBe(401); // no "Bearer "
    const id = token.split('_')[1]!;
    const forged = `bk_${id}_${'A'.repeat(43)}`;
    expect((await call({ authorization: `Bearer ${forged}` })).status).toBe(401);
    expect((await call({ authorization: `Bearer ${token}` })).status).toBe(200);
    await revokeBusynessKey(db, id, 'user_admin', now);
    const res = await call({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_key' });
  });

  it('rotating a key stops the old token', async () => {
    const cookie = await adminCookie(app);
    const issued = await app.app.request('/api/admin/busyness-keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'consumer app', kind: 'production' }),
    });
    const { key: info, token: oldToken } = (await issued.json()) as any;
    const rotated = await app.app.request(`/api/admin/busyness-keys/${info.id}/rotate`, { method: 'POST', headers: { cookie } });
    expect(rotated.status).toBe(200);
    const { token: newToken, key: after } = (await rotated.json()) as any;
    expect(newToken).not.toBe(oldToken);
    expect(after.id).toBe(info.id);
    expect(after.rotatedAt).not.toBeNull();
    expect((await feed(oldToken)).res.status).toBe(401);
    expect((await feed(newToken)).res.status).toBe(200);
    const unknown = await app.app.request('/api/admin/busyness-keys/nope/rotate', { method: 'POST', headers: { cookie } });
    expect(unknown.status).toBe(404);
  });

  it('rate limit returns 429 after 60 requests a minute', async () => {
    await db.update(clubs).set({ status: 'paused' }).where(eq(clubs.id, clubB.id)); // an empty feed keeps this fast
    const token = await key();
    for (let i = 0; i < BUSYNESS_RATE_LIMIT_PER_MINUTE; i++) expect((await feed(token)).res.status).toBe(200);
    const over = await feed(token);
    expect(over.res.status).toBe(429);
    expect(over.body).toEqual({ error: 'rate_limited' });
    expect(Number(over.res.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another key has its own budget.
    expect((await feed(await key())).res.status).toBe(200);
    // A minute later the first key may read again.
    now = new Date(now.getTime() + 61_000);
    expect((await feed(token)).res.status).toBe(200);
  });

  it('each read writes one access-log row', async () => {
    const token = await key();
    const id = token.split('_')[1]!;
    const reads = () => db.select().from(auditLog).where(and(eq(auditLog.action, 'busyness_read'), eq(auditLog.entityId, id)));
    await feed(token);
    await app.app.request('/data/v1/busyness?date=2026-12-12', { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.9' } });
    await app.app.request('/data/v1/busyness', { headers: { authorization: 'Bearer wrong' } });
    const rows = await reads();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.clubId === null && r.actorType === 'system')).toBe(true);
    expect(rows.some((r) => r.ip === '203.0.113.9' && (r.data as any).date === '2026-12-12')).toBe(true);
  });

  it('only a platform admin issues keys and the token is shown once', async () => {
    const body = JSON.stringify({ label: 'consumer app', kind: 'sandbox' });
    const staff = await staffCookie(app, clubB, 'owner');
    const denied = await app.app.request('/api/admin/busyness-keys', { method: 'POST', headers: { cookie: staff, 'content-type': 'application/json' }, body });
    expect([401, 403]).toContain(denied.status);
    expect((await app.app.request('/api/admin/busyness-keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);

    const cookie = await adminCookie(app);
    const res = await app.app.request('/api/admin/busyness-keys', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body });
    expect(res.status).toBe(201);
    const { key: info, token } = (await res.json()) as any;
    expect(token).toMatch(/^bk_/);
    expect(info).toMatchObject({ kind: 'sandbox', label: 'consumer app', revokedAt: null });
    expect(info.hash).toBeUndefined();

    const list = await app.app.request('/api/admin/busyness-keys', { headers: { cookie } });
    const text = await list.text();
    expect(JSON.parse(text).keys.map((k: any) => k.id)).toEqual([info.id]);
    expect(text).not.toContain(token);
    expect(text).not.toContain('hash');
    const bad = await app.app.request('/api/admin/busyness-keys', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'all' }) });
    expect(bad.status).toBe(400);

    const revoked = await app.app.request(`/api/admin/busyness-keys/${info.id}`, { method: 'DELETE', headers: { cookie } });
    expect(revoked.status).toBe(200);
    expect((await feed(token)).res.status).toBe(401);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, info.id));
    expect(audit.map((r) => r.action).sort()).toEqual(['busyness_key_issued', 'busyness_key_revoked']);
  });
});
