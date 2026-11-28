import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { cancelBooking, createManualBooking, markArrived } from '../src/bookings/service.js';
import { alerts, auditLog, bookings, bookingStatusHistory, clubs, events, guests, messages, type Club } from '../src/db/schema.js';
import { buildScheduler } from '../src/jobs/index.js';
import { releaseAt, releaseNow } from '../src/jobs/no-show.js';
import { reminderDueAt, remindNow } from '../src/jobs/reminders.js';
import { fastForward } from '../src/demo/reset.js';
import { addDays } from '../src/lib/time.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupDb } from './helpers.js';
import { adminCookie, testConfig } from './helpers/track-a.js';

const config = testConfig({ PUBLIC_URL: 'http://localhost:5173', DEV_SIMULATOR: true });
const STAFF = { type: 'staff' as const, id: 'user_1' };

// FRIDAY_AFTERNOON is 15:00 Bangkok. Fixture: arrival by 23:30; defaults: reminder 18:00, grace 30 min.
const at = (hhmm: string, date = FRIDAY) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h - 7, m));
};

let ctx: Awaited<ReturnType<typeof setupDb>>;
let app: ReturnType<typeof createApp>;
let clock: Date;
let club: Club;

beforeEach(async () => {
  ctx = await setupDb();
  club = ctx.club;
  clock = FRIDAY_AFTERNOON;
  app = createApp(config, ctx.db, { bot: { now: () => clock, log: () => {} } });
});
afterEach(async () => {
  await ctx.close();
});

const db = () => ctx.db;
const req = (path: string, init?: RequestInit) => app.app.request(path, init);
let simCookie: Promise<string> | undefined;
beforeEach(() => {
  simCookie = undefined;
});
async function sim(userId: string, body: Record<string, unknown>) {
  simCookie ??= adminCookie(app);
  const res = await req('/api/dev/demo/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await simCookie },
    body: JSON.stringify({ userId, displayName: 'Ari', ...body }),
  });
  expect(res.status).toBe(200);
}

/** A confirmed booking for tonight on `tableId`, owned by simulator guest `userId`. */
async function confirmedFor(userId: string, tableId = 'table_demo_B1', nightDate = FRIDAY) {
  await sim(userId, { type: 'follow' });
  const guest = (await db().query.guests.findFirst({ where: eq(guests.lineUserId, `SIM-${userId}`) }))!;
  const b = await createManualBooking(db(), club, { tableId, nightDate, pax: 4, name: 'Ari', depositPaid: true }, STAFF, clock);
  await db().update(bookings).set({ guestId: guest.id }).where(eq(bookings.id, b.id));
  return { ...b, guestId: guest.id };
}

const bookingOf = async (id: string) => (await db().query.bookings.findFirst({ where: eq(bookings.id, id) }))!;
const eventsOf = async (id: string, type: string) =>
  db().select().from(events).where(and(eq(events.bookingId, id), eq(events.type, type)));
const historyOf = (id: string) =>
  db().select().from(bookingStatusHistory).where(eq(bookingStatusHistory.bookingId, id)).orderBy(asc(bookingStatusHistory.at));
const guestOut = (guestId: string) =>
  db().select().from(messages).where(and(eq(messages.guestId, guestId), eq(messages.direction, 'out'))).orderBy(asc(messages.createdAt));
const staffOut = () => db().select().from(messages).where(eq(messages.target, 'staff')).orderBy(asc(messages.createdAt));
/** B19b: B10's staff notices are `raiseAlert` alerts. */
const alertsOf = (bookingId: string, kind: string) => db().select().from(alerts).where(and(eq(alerts.bookingId, bookingId), eq(alerts.kind, kind)));
const lastOut = async (guestId: string) => {
  const out = await guestOut(guestId);
  return out[out.length - 1]!.payload as any;
};
const setSettings = async (patch: Partial<Club['settings']>) => {
  club = { ...club, settings: { ...club.settings, ...patch } };
  await db().update(clubs).set({ settings: club.settings }).where(eq(clubs.id, club.id));
};
const run = (name: string, now: Date) => buildScheduler(app.ctx, () => now).runOnce(name, now);

describe('reminders (B10)', () => {
  it('reminder sent once at the configured lead time', async () => {
    const b = await confirmedFor('r1');
    expect(reminderDueAt(club, FRIDAY).toISOString()).toBe(at('18:00').toISOString());

    await run('reminders', at('17:59'));
    expect((await bookingOf(b.id)).reminderSentAt).toBeNull();

    await run('reminders', at('18:00'));
    await run('reminders', at('18:01'));
    expect((await bookingOf(b.id)).reminderSentAt?.toISOString()).toBe(at('18:00').toISOString());
    const sent = await eventsOf(b.id, 'reminder.sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.props).toEqual({ kind: 'day_of' });
    const reminders = (await guestOut(b.guestId)).filter((m) => JSON.stringify(m.payload).includes('See you tonight'));
    expect(reminders).toHaveLength(1);
    const msg = reminders[0]!.payload as any;
    expect(msg.text).toContain('B1');
    expect(msg.text).toContain('23:30');
    expect(msg.quickReply.items.map((i: any) => i.action.label)).toEqual(['Running late', 'Need to cancel', 'Location']);
    // B4: the location tap goes through GET /r/:code (link.opened), never the raw map URL.
    expect(msg.quickReply.items[2].action.uri).toMatch(/\/r\/[^/]+$/);
    expect(msg.quickReply.items[2].action.uri).not.toBe(club.settings.mapUrl);

    // A club-set time moves it.
    await setSettings({ reminderTime: '20:15' });
    expect(reminderDueAt(club, FRIDAY).toISOString()).toBe(at('20:15').toISOString());
  });

  it('a club with no map link gets no [Location] button on the reminder', async () => {
    await setSettings({ mapUrl: '' });
    const b = await confirmedFor('r-nomap');
    await run('reminders', at('18:00'));
    const msg = await lastOut(b.guestId);
    expect(msg.quickReply.items.map((i: any) => i.action.label)).toEqual(['Running late', 'Need to cancel']);
  });

  it('an afternoon reminder time, or a late night start, keeps the reminder on the night itself', async () => {
    // nightStartHour 18: a 15:00 reminder is Friday 15:00, not Saturday 15:00 (after arrival).
    await setSettings({ reminderTime: '15:00' });
    expect(reminderDueAt(club, FRIDAY).toISOString()).toBe(at('15:00').toISOString());
    const b = await confirmedFor('r-early');
    await run('reminders', at('15:01'));
    expect((await bookingOf(b.id)).reminderSentAt?.toISOString()).toBe(at('15:01').toISOString());

    // nightStartHour 20 with the default 18:00 reminder: still Friday 18:00.
    await setSettings({ reminderTime: undefined, nightStartHour: 20 });
    expect(reminderDueAt(club, FRIDAY).toISOString()).toBe(at('18:00').toISOString());
    const c = await confirmedFor('r-late-start', 'table_demo_B2');
    await run('reminders', at('18:01'));
    expect((await bookingOf(c.id)).reminderSentAt?.toISOString()).toBe(at('18:01').toISOString());

    // The after-midnight part of the night (before nightEndHour) is still the next day.
    const late = { settings: { ...club.settings, arrivalBy: '00:30', arrivalGraceMinutes: 0 } };
    expect(releaseAt(late, { nightDate: FRIDAY, runningLateMinutes: null }).toISOString()).toBe(at('00:30', addDays(FRIDAY, 1)).toISOString());
  });

  it('no reminder for another night, a cancelled booking or after the arrival time', async () => {
    const tomorrow = await confirmedFor('r2', 'table_demo_B2', addDays(FRIDAY, 1));
    const cancelled = await confirmedFor('r3', 'table_demo_B3');
    await cancelBooking(db(), club.id, cancelled.id, STAFF, { code: 'club_cancelled' }, clock);
    const late = await confirmedFor('r4', 'table_demo_B4');

    await run('reminders', at('18:05'));
    expect((await bookingOf(tomorrow.id)).reminderSentAt).toBeNull();
    expect((await bookingOf(cancelled.id)).reminderSentAt).toBeNull();
    expect((await bookingOf(late.id)).reminderSentAt).not.toBeNull();

    const missed = await confirmedFor('r5', 'table_demo_V1');
    await run('reminders', at('23:45'));
    expect((await bookingOf(missed.id)).reminderSentAt).toBeNull();
  });
});

describe('guest actions (B10)', () => {
  it('running late sets running_late_minutes and pushes the release time', async () => {
    const b = await confirmedFor('late1');
    clock = at('22:00');
    await sim('late1', { type: 'postback', data: `a=late&b=${b.id}` });
    const ask = await lastOut(b.guestId);
    expect(ask.quickReply.items.map((i: any) => i.action.label)).toEqual(['15 min', '30 min', '1 hr']);

    await sim('late1', { type: 'postback', data: `a=late&b=${b.id}&m=30` });
    const after = await bookingOf(b.id);
    expect(after.runningLateMinutes).toBe(30);
    expect(releaseAt(club, after).toISOString()).toBe(at('00:30', addDays(FRIDAY, 1)).toISOString());
    expect((await lastOut(b.guestId)).text).toContain('00:30');
    const ev = await eventsOf(b.id, 'running_late');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.props).toEqual({ minutes: 30 });
    expect(ev[0]!.actorType).toBe('guest');
    const audits = await db().select().from(auditLog).where(and(eq(auditLog.entityId, b.id), eq(auditLog.action, 'running_late')));
    expect(audits).toHaveLength(1);
    const late = await alertsOf(b.id, 'running_late');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ level: 'info' });
    expect(late[0]!.textEn).toContain('Running late: 30 min, release at 00:30');
    expect(late[0]!.conversationId).not.toBeNull();

    // An invalid number of minutes changes nothing.
    await sim('late1', { type: 'postback', data: `a=late&b=${b.id}&m=999` });
    expect((await bookingOf(b.id)).runningLateMinutes).toBe(30);
  });

  it('guest cancel shows the policy, then cancels with history and event', async () => {
    const b = await confirmedFor('c1');
    await sim('c1', { type: 'postback', data: `a=cancel&b=${b.id}` });
    const ask = await lastOut(b.guestId);
    expect(ask.text).toContain('Deposit is non-refundable');
    // A cancellation policy set in Settings replaces the first house rule.
    await setSettings({ cancellationPolicy: { en: 'Cancel 24h ahead for a refund.', th: 'ยกเลิกล่วงหน้า 24 ชม.' } });
    await sim('c1', { type: 'postback', data: `a=cancel&b=${b.id}` });
    expect((await lastOut(b.guestId)).text).toContain('Cancel 24h ahead for a refund.');
    expect(ask.quickReply.items.map((i: any) => i.action.label)).toEqual(['Yes, cancel', 'Keep booking']);
    expect((await bookingOf(b.id)).status).toBe('confirmed');

    await sim('c1', { type: 'postback', data: `a=cancel_yes&b=${b.id}` });
    const after = await bookingOf(b.id);
    expect(after.status).toBe('cancelled');
    expect(after.cancelReasonCode).toBe('guest_cancelled');
    const last = (await historyOf(b.id)).at(-1)!;
    expect([last.fromStatus, last.toStatus, last.actorType, last.reasonCode]).toEqual(['confirmed', 'cancelled', 'guest', 'guest_cancelled']);
    const ev = await eventsOf(b.id, 'booking.cancelled');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.props).toEqual({ reason_code: 'guest_cancelled' });
    expect((await lastOut(b.guestId)).text).toContain('cancelled');
    const cancelled = await alertsOf(b.id, 'cancellation');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ level: 'info' });
    expect(cancelled[0]!.textEn).toContain('Booking cancelled');

    // Another guest cannot cancel it, and a second tap is harmless.
    const other = await confirmedFor('c2', 'table_demo_B2');
    await sim('c1', { type: 'postback', data: `a=cancel_yes&b=${other.id}` });
    expect((await bookingOf(other.id)).status).toBe('confirmed');
    await sim('c1', { type: 'postback', data: `a=cancel_yes&b=${b.id}` });
    expect(await eventsOf(b.id, 'booking.cancelled')).toHaveLength(1);
  });

  it('my booking offers running late and cancel', async () => {
    const b = await confirmedFor('m1');
    await sim('m1', { type: 'postback', data: 'a=my' });
    const card = await lastOut(b.guestId);
    expect(card.type).toBe('flex');
    expect(card.quickReply.items.map((i: any) => i.action.label)).toEqual(['Change party size', 'Running late', 'Cancel', 'Talk to a host']);
  });

  it('change party size: offers the sizes the table seats, then changes pax with audit and booking.changed (§5.3)', async () => {
    const b = await confirmedFor('px1'); // B1, 4 pax
    await sim('px1', { type: 'postback', data: `a=pax_change&b=${b.id}` });
    const ask = await lastOut(b.guestId);
    const labels = ask.quickReply.items.map((i: any) => i.action.label);
    expect(labels).not.toContain('4');
    expect(labels.at(-1)).toBe('Talk to a host');
    const six = ask.quickReply.items.find((i: any) => i.action.label === '6');
    await sim('px1', { type: 'postback', data: six.action.data });
    expect((await bookingOf(b.id)).pax).toBe(6);
    expect((await lastOut(b.guestId)).text).toContain('now for 6 guests');
    const [ev] = await eventsOf(b.id, 'booking.changed');
    expect(ev!.props).toMatchObject({ field: 'pax', from_pax: 4, to_pax: 6 });
    expect(ev!.actorType).toBe('guest');
    const audits = await db().select().from(auditLog).where(and(eq(auditLog.entityId, b.id), eq(auditLog.action, 'booking_changed')));
    expect(audits).toHaveLength(1);
    // Outside the table's range: nothing changes.
    await sim('px1', { type: 'postback', data: `a=pax_set&b=${b.id}&n=40` });
    expect((await bookingOf(b.id)).pax).toBe(6);
  });
});

describe('no-show job (B10)', () => {
  it('no-show after the release time releases the table', async () => {
    const b = await confirmedFor('n1');
    expect(releaseAt(club, b).toISOString()).toBe(at('00:00', addDays(FRIDAY, 1)).toISOString());

    await run('no-show', at('23:59'));
    expect((await bookingOf(b.id)).status).toBe('confirmed');

    const release = at('00:00', addDays(FRIDAY, 1));
    await run('no-show', release);
    const after = await bookingOf(b.id);
    expect(after.status).toBe('no_show');
    expect(after.noShowAt?.toISOString()).toBe(release.toISOString());
    expect(after.releasedAt?.toISOString()).toBe(release.toISOString());
    const last = (await historyOf(b.id)).at(-1)!;
    expect([last.fromStatus, last.toStatus, last.actorType, last.reasonCode]).toEqual(['confirmed', 'no_show', 'system', 'released']);
    expect(await eventsOf(b.id, 'booking.no_show')).toHaveLength(1);
    expect(await eventsOf(b.id, 'table.released')).toHaveLength(1);
    const noArrival = await alertsOf(b.id, 'no_arrival');
    expect(noArrival).toHaveLength(1);
    expect(noArrival[0]).toMatchObject({ level: 'urgent' });
    // Urgent: the staff group gets it in the same call.
    expect((await staffOut()).some((m) => JSON.stringify(m.payload).includes('Not arrived at release time'))).toBe(true);

    // The table is free again for the same night.
    const again = await createManualBooking(db(), club, { tableId: 'table_demo_B1', nightDate: FRIDAY, pax: 4, name: 'Bo', depositPaid: false }, STAFF, release);
    expect(again.status).toBe('confirmed');

    // A second run does nothing more.
    await run('no-show', new Date(release.getTime() + 60_000));
    expect(await eventsOf(b.id, 'table.released')).toHaveLength(1);
  });

  it('running late delays the no-show, and autoNoShow off keeps the booking', async () => {
    const b = await confirmedFor('n2');
    await db().update(bookings).set({ runningLateMinutes: 60 }).where(eq(bookings.id, b.id));
    await run('no-show', at('00:30', addDays(FRIDAY, 1)));
    expect((await bookingOf(b.id)).status).toBe('confirmed');
    await run('no-show', at('01:00', addDays(FRIDAY, 1)));
    expect((await bookingOf(b.id)).status).toBe('no_show');

    const kept = await confirmedFor('n3', 'table_demo_B2');
    await setSettings({ autoNoShow: false });
    await run('no-show', at('03:00', addDays(FRIDAY, 1)));
    expect((await bookingOf(kept.id)).status).toBe('confirmed');
    // The host is still told, once: the club marks the no-show itself.
    await run('no-show', at('03:01', addDays(FRIDAY, 1)));
    const noArrival = await db().select().from(alerts).where(and(eq(alerts.bookingId, kept.id), eq(alerts.kind, 'no_arrival')));
    expect(noArrival).toHaveLength(1);
    expect(noArrival[0]!.level).toBe('urgent');

    // A club that does not let running late move the release time.
    await setSettings({ autoNoShow: true, runningLateExtendsRelease: false, arrivalGraceMinutes: 0 });
    const fresh = await bookingOf(kept.id);
    expect(releaseAt(club, { ...fresh, runningLateMinutes: 60 }).toISOString()).toBe(at('23:30').toISOString());
  });

  it('a checked-in booking is never marked no-show', async () => {
    const b = await confirmedFor('n4');
    await markArrived(db(), club.id, b.id, STAFF, at('23:00'), 4);
    await run('no-show', at('02:00', addDays(FRIDAY, 1)));
    const after = await bookingOf(b.id);
    expect(after.status).toBe('arrived');
    expect(after.releasedAt).toBeNull();
    expect(await eventsOf(b.id, 'table.released')).toHaveLength(0);
  });

  it('fast-forward to the reminder time sends the reminder, and to the release time releases the table, for that booking only', async () => {
    const chosen = await confirmedFor('f1');
    const other = await confirmedFor('f2', 'table_demo_B2');

    // The demo control (B7 `fastForward`, widened by B10) runs `remindNow` / `releaseNow`.
    expect((await fastForward(app.ctx, club.id, 'reminder', chosen.id, clock))?.id).toBe(chosen.id);
    expect((await bookingOf(chosen.id)).reminderSentAt).not.toBeNull();
    expect((await bookingOf(other.id)).reminderSentAt).toBeNull();
    expect(await eventsOf(chosen.id, 'reminder.sent')).toHaveLength(1);
    expect(await fastForward(app.ctx, club.id, 'reminder', chosen.id, clock)).toBeUndefined(); // once only
    expect(await remindNow(app.ctx, club.id, chosen.id, clock)).toBe(false);

    const released = await fastForward(app.ctx, club.id, 'release', chosen.id, clock);
    expect(released?.status).toBe('no_show');
    expect((await bookingOf(chosen.id)).status).toBe('no_show');
    expect((await bookingOf(chosen.id)).releasedAt).not.toBeNull();
    expect((await bookingOf(other.id)).status).toBe('confirmed');
    expect(await fastForward(app.ctx, club.id, 'release', chosen.id, clock)).toBeUndefined();

    // Another club's id does nothing.
    expect(await releaseNow(app.ctx, 'club_other', other.id, clock)).toBe(false);
    expect((await bookingOf(other.id)).status).toBe('confirmed');
  });

  it('both jobs are registered on the scheduler', () => {
    const names = buildScheduler(app.ctx, () => clock).names();
    expect(names).toContain('reminders');
    expect(names).toContain('no-show');
    expect(names).toContain('completion'); // §7.1
  });
});

describe('after-visit message (§5.2 step 10)', () => {
  const SAT_14 = at('14:00', addDays(FRIDAY, 1));
  const thanks = async (guestId: string) =>
    (await guestOut(guestId)).filter((m) => JSON.stringify(m.payload).includes('Thanks for coming'));

  it('is off by default, and when on goes once the next day from 14:00 with [Book again]', async () => {
    const b = await confirmedFor('av1');
    await markArrived(db(), club.id, b.id, STAFF, at('23:00'), 4);
    await run('after-visit', SAT_14);
    expect(await thanks(b.guestId)).toHaveLength(0);

    await setSettings({ afterVisitMessage: true });
    await run('after-visit', new Date(SAT_14.getTime() - 60_000));
    expect(await thanks(b.guestId)).toHaveLength(0);
    await run('after-visit', SAT_14);
    await run('after-visit', new Date(SAT_14.getTime() + 60 * 60_000));
    const sent = await thanks(b.guestId);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.payload as any).quickReply.items.map((i: any) => i.action.label)).toEqual(['Book again']);
    expect((await eventsOf(b.id, 'reminder.sent')).map((e) => e.props)).toContainEqual({ kind: 'after_visit' });
  });

  it('skips a guest who opted out, a no-show, and a club whose push quota is nearly used up', async () => {
    await setSettings({ afterVisitMessage: true });
    const opted = await confirmedFor('av-out');
    await markArrived(db(), club.id, opted.id, STAFF, at('23:00'), 4);
    await sim('av-out', { type: 'text', text: 'stop' });
    const noShow = await confirmedFor('av-ns', 'table_demo_B2');
    await run('after-visit', SAT_14);
    expect(await thanks(opted.guestId)).toHaveLength(0);
    expect(await thanks(noShow.guestId)).toHaveLength(0);
    expect((await bookingOf(noShow.id)).status).toBe('confirmed');
  });

  it('is registered on the scheduler', () => {
    expect(buildScheduler(app.ctx, () => clock).names()).toContain('after-visit');
  });
});
