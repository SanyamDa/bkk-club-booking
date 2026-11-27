import { and, asc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  approveDeposit,
  cancelBooking,
  expireStaleHolds,
  holdTable,
  markArrived,
  recordSlip,
  releaseTable,
  requestDeposit,
  submitDetails,
} from '../src/bookings/service.js';
import type { Db } from '../src/db/client.js';
import { auditLog, bookings, bookingStatusHistory, deposits, events, eventsDeadLetter, platformFlags, type Club } from '../src/db/schema.js';
import { buildScheduler } from '../src/jobs/index.js';
import { Scheduler } from '../src/jobs/scheduler.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

let ctx: Awaited<ReturnType<typeof setupTwoClubs>>;
let db: Db;
let clubA: Club;
beforeEach(async () => {
  ctx = await setupTwoClubs();
  db = ctx.db;
  clubA = ctx.clubA;
});
afterEach(async () => {
  await ctx.close();
});

const now = FRIDAY_AFTERNOON;
const details = { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6 };
const STAFF = { type: 'staff' as const, id: 'user_1', sessionId: 'sess_1' };

async function hold(tableId = 'table_demo_B2', at = now) {
  const g = await makeGuest(db, { clubId: clubA.id });
  return holdTable(db, clubA, { guestId: g.id, tableId, nightDate: FRIDAY, pax: 6 }, at);
}

const historyOf = (bookingId: string) =>
  db.select().from(bookingStatusHistory).where(eq(bookingStatusHistory.bookingId, bookingId)).orderBy(asc(bookingStatusHistory.at), asc(bookingStatusHistory.id));
const eventsOf = (bookingId: string) => db.select().from(events).where(eq(events.bookingId, bookingId)).orderBy(asc(events.seq));
const bookingOf = async (id: string) => (await db.query.bookings.findFirst({ where: eq(bookings.id, id) }))!;

describe('booking history (B2)', () => {
  it('every status change writes history, audit and event in one transaction', async () => {
    const step = (i: number) => new Date(now.getTime() + i * 60_000);
    const b = await hold();
    await submitDetails(db, clubA, b.id, details, step(1));
    await requestDeposit(db, clubA, b.id, step(2));
    await recordSlip(db, clubA, b.id, 'club_demo/slip.jpg', step(3));
    await approveDeposit(db, clubA.id, b.id, STAFF, step(4));
    await markArrived(db, clubA.id, b.id, STAFF, step(5), 5);

    const history = await historyOf(b.id);
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, 'held'],
      ['held', 'awaiting_payment'],
      ['awaiting_payment', 'payment_review'],
      ['payment_review', 'confirmed'],
      ['confirmed', 'arrived'],
    ]);
    expect(history.at(-1)).toMatchObject({ actorType: 'staff', actorId: 'user_1' });

    const evs = await eventsOf(b.id);
    const changed = evs.filter((e) => e.type === 'booking.status_changed');
    expect(changed.map((e) => (e.props as { to: string }).to)).toEqual(['held', 'awaiting_payment', 'payment_review', 'confirmed', 'arrived']);
    const types = evs.map((e) => e.type);
    for (const t of ['table.held', 'deposit.qr_sent', 'slip.received', 'deposit.verified', 'booking.confirmed', 'booking.checked_in'] as const) {
      expect(types).toContain(t);
    }
    expect(types.filter((t) => t === 'details.submitted')).toHaveLength(1);
    expect(evs.find((e) => e.type === 'booking.checked_in')?.props).toEqual({ arrived_pax: 5 });
    expect((await bookingOf(b.id)).arrivedPax).toBe(5);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, b.id), sql`${auditLog.action} like 'status:%'`));
    expect(audits).toHaveLength(5);
    expect(audits.find((a) => a.action === 'status:arrived')).toMatchObject({ actorType: 'staff', actorId: 'user_1', sessionId: 'sess_1' });
  });

  it('a failure rolls everything back', async () => {
    const b = await hold();
    await submitDetails(db, clubA, b.id, details, now);
    const before = (await historyOf(b.id)).length;
    // Inject: every events insert fails from here on.
    await db.execute(sql`create function b2_fail() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$`);
    await db.execute(sql`create trigger b2_fail before insert on events for each row execute function b2_fail()`);

    await expect(requestDeposit(db, clubA, b.id, now)).rejects.toThrow();

    expect((await bookingOf(b.id)).status).toBe('held');
    expect(await historyOf(b.id)).toHaveLength(before);
    expect(await db.select().from(deposits).where(eq(deposits.bookingId, b.id))).toEqual([]);
  });

  it('expired holds get history', async () => {
    const b1 = await hold('table_demo_B1');
    const b2 = await hold('table_demo_B3');
    const later = new Date(now.getTime() + 60 * 60_000);

    const expired = await expireStaleHolds(db, later);

    expect(expired.map((b) => b.id).sort()).toEqual([b1.id, b2.id].sort());
    for (const b of [b1, b2]) {
      const h = await historyOf(b.id);
      expect(h.at(-1)).toMatchObject({ fromStatus: 'held', toStatus: 'expired', reasonCode: 'hold_expired', actorType: 'system' });
      const evs = await eventsOf(b.id);
      expect(evs.map((e) => e.type)).toContain('hold.expired');
    }
  });

  it('staff cancel with a free-text reason writes a coded event', async () => {
    const b = await hold();
    const later = new Date(now.getTime() + 60_000);
    await cancelBooking(db, clubA.id, b.id, STAFF, { code: 'club_cancelled', text: 'Cancelled by the club' }, later);

    const h = (await historyOf(b.id)).at(-1)!;
    expect(h).toMatchObject({ toStatus: 'cancelled', reasonCode: 'club_cancelled' });
    const row = await bookingOf(b.id);
    expect(row).toMatchObject({ statusReason: 'Cancelled by the club', cancelReasonCode: 'club_cancelled' });
    expect(row.cancelledAt).toEqual(later);
    const evs = await eventsOf(b.id);
    const changed = evs.filter((e) => e.type === 'booking.status_changed').at(-1)!;
    expect(changed.props).toEqual({ from: 'held', to: 'cancelled', reason_code: 'club_cancelled' });
    expect(JSON.stringify(changed.raw)).toContain('Cancelled by the club');
    expect(evs.find((e) => e.type === 'booking.cancelled')?.props).toEqual({ reason_code: 'club_cancelled' });
    expect(await db.select().from(eventsDeadLetter)).toEqual([]);
    const audit = await db.query.auditLog.findFirst({ where: and(eq(auditLog.entityId, b.id), eq(auditLog.action, 'status:cancelled')) });
    expect(audit?.reason).toBe('Cancelled by the club');
  });

  it('slip after the table was taken keeps the slip', async () => {
    const b = await hold();
    await submitDetails(db, clubA, b.id, details, now);
    await requestDeposit(db, clubA, b.id, now);
    const later = new Date(now.getTime() + 30 * 60_000);
    await expireStaleHolds(db, later);
    const other = await hold('table_demo_B2', later);
    expect(other.status).toBe('held');
    const historyBefore = (await historyOf(b.id)).length;

    const result = await recordSlip(db, clubA, b.id, 'club_demo/late.jpg', later);

    expect(result).toEqual({ tableLost: true });
    const dep = await db.query.deposits.findFirst({ where: eq(deposits.bookingId, b.id) });
    expect(dep).toMatchObject({ status: 'review', slipPath: 'club_demo/late.jpg' });
    const row = await bookingOf(b.id);
    expect(row.status).toBe('expired');
    expect(row.statusReason).toMatch(/table was taken/);
    expect(await historyOf(b.id)).toHaveLength(historyBefore);
    expect((await eventsOf(b.id)).map((e) => e.type)).toContain('slip.received');
  });

  it('releaseTable sets released_at and emits table.released with no history row', async () => {
    const b = await hold();
    const historyBefore = (await historyOf(b.id)).length;
    const later = new Date(now.getTime() + 5 * 60_000);

    await db.transaction(async (tx) => releaseTable(tx as unknown as Db, b, STAFF, later));

    expect((await bookingOf(b.id)).releasedAt).toEqual(later);
    expect(await historyOf(b.id)).toHaveLength(historyBefore);
    const released = (await eventsOf(b.id)).filter((e) => e.type === 'table.released');
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ actorType: 'staff', actorId: 'user_1' });
  });
});

describe('scheduler (B2)', () => {
  it('hold expiry runs as a scheduler job', async () => {
    const { ctx: app } = createApp(testConfig(), db, { bot: { now: () => now, log: () => {} } });
    const told = vi.spyOn(app.notifier, 'holdExpired').mockResolvedValue(undefined);
    const b = await hold();
    const later = new Date(now.getTime() + 60 * 60_000);
    const scheduler = buildScheduler(app, () => later);

    await scheduler.runOnce('hold-expiry', later);

    expect((await bookingOf(b.id)).status).toBe('expired');
    expect(told).toHaveBeenCalledTimes(1);
    expect(told.mock.calls[0]![0].id).toBe(b.id);
    expect(await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, 'job_lock:hold-expiry') })).toBeUndefined();
  });

  it('a job lock held by another instance skips the run', async () => {
    const s = new Scheduler(db, () => now);
    let runs = 0;
    s.register('demo-job', 60_000, async () => {
      runs++;
    });
    await db.insert(platformFlags).values({ key: 'job_lock:demo-job', value: { owner: 'other', until: new Date(now.getTime() + 60_000).toISOString() }, updatedAt: now });

    expect(await s.runOnce('demo-job', now)).toBe(false);
    expect(runs).toBe(0);
    // A stale lock (past its `until`) is taken over.
    expect(await s.runOnce('demo-job', new Date(now.getTime() + 120_000))).toBe(true);
    expect(runs).toBe(1);
  });

  it('a lock error is logged and the run returns false', async () => {
    const broken = { insert: () => { throw new Error('connection dropped'); } } as unknown as Db;
    const logged: string[] = [];
    const s = new Scheduler(broken, () => now, (msg) => logged.push(msg));
    let runs = 0;
    s.register('demo-job', 60_000, async () => {
      runs++;
    });

    await expect(s.runOnce('demo-job', now)).resolves.toBe(false);
    expect(runs).toBe(0);
    expect(logged).toEqual(['Job demo-job: lock acquire failed']);
  });

  it('buildScheduler registers every job', () => {
    const { ctx: app } = createApp(testConfig(), db, { bot: { now: () => now, log: () => {} } });
    expect(buildScheduler(app, () => now).names().sort()).toEqual(
      [
        'alert-checks', 'brain-expiry', 'chatwoot-grant-sweep', 'club-report', 'handoff-timeout', 'hold-expiry', 'nightly-check',
        'nights', 'no-show', 'reminders', 'removal', 'retention',
      ].sort(),
    );
  });
});
