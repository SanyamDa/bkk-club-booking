import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { approveNote, createNote, rejectNote } from '../src/brain/notes.js';
import {
  approveDeposit,
  cancelBooking,
  createManualBooking,
  expireHold,
  markArrived,
  rejectDeposit,
  releaseNoShow,
} from '../src/bookings/service.js';
import { EVENT_TYPES, STATUS_EVENTS, type EventType } from '../src/data/event-types.js';
import type { Db } from '../src/db/client.js';
import { bookings, events, guests, nights, posBills, type Club } from '../src/db/schema.js';
import { applyLiveBill } from '../src/integrations/pos/live.js';
import { posBillId } from '../src/integrations/pos/csv-import.js';
import type { CredentialStore } from '../src/line/credentials.js';
import type { LineGateway, Message } from '../src/line/gateway.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupDb } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

/**
 * Plan B4b: every event the B4b table gives to B2, B4 and B4b fires in a real flow (signed LINE
 * webhooks through the bot, the LIFF form, the booking service), and every declared event type has
 * an emitter in `src` whose test asserts it.
 */
const SECRET = 'emit-coverage-secret';
const SATURDAY = '2026-11-28';
const SUNDAY = '2026-11-29'; // the fixture club opens Wed–Sat
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
const STAFF = { type: 'staff' as const, id: 'user_emit_cov' };

type Sent = { via: 'reply' | 'push'; to: string; messages: Message[] };

function fakeGateway(over: Partial<LineGateway> = {}): LineGateway & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    live: true,
    sent,
    reply: async (to, msgs) => void sent.push({ via: 'reply', to, messages: msgs }),
    push: async (to, msgs) => void sent.push({ via: 'push', to, messages: msgs }),
    getContent: async () => FAKE_JPEG,
    getProfile: async () => ({ displayName: 'Coverage guest', language: 'en' }),
    loading: async () => {},
    ...over,
  };
}

const credentials: CredentialStore = {
  channelSecret: async () => SECRET,
  line: async () => ({ channelSecret: SECRET, accessToken: 'fake-token' }),
  login: async () => null,
};

let db: Db;
let close: () => Promise<void>;
let club: Club;
let clock: Date;
let created: ReturnType<typeof createApp>;
let gw: ReturnType<typeof fakeGateway>;

function useGateway(g: ReturnType<typeof fakeGateway>) {
  gw = g;
  created.ctx.gateways.forClub = async () => gw;
}

beforeEach(async () => {
  ({ db, close, club } = await setupDb());
  clock = FRIDAY_AFTERNOON;
  created = createApp(testConfig({ PUBLIC_URL: 'http://localhost:5173' }), db, { bot: { now: () => clock, log: () => {} }, credentials });
  useGateway(fakeGateway());
});
afterEach(async () => {
  await created.settle();
  await close();
});

// ---------- LINE webhook helpers ----------

type Body = Record<string, unknown>;

function lineEvent(userId: string, body: Body) {
  const id = newId();
  return {
    mode: 'active',
    timestamp: clock.getTime(),
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId },
    ...(body.type === 'unfollow' ? {} : { replyToken: `rt-${id}` }),
    ...body,
  };
}

async function post(body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  const sig = signature ?? createHmac('sha256', SECRET).update(raw).digest('base64');
  const res = await created.app.request(`/line/webhook/${club.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sig },
    body: raw,
  });
  await created.settle();
  return res;
}

const send = (userId: string, body: Body) => post({ destination: 'Ubot', events: [lineEvent(userId, body)] });
const text = (u: string, t: string) => send(u, { type: 'message', message: { id: newId(), type: 'text', text: t, quoteToken: 'q' } });
const tap = (u: string, data: string) => send(u, { type: 'postback', postback: { data } });
const image = (u: string) => send(u, { type: 'message', message: { id: newId(), type: 'image', contentProvider: { type: 'line' }, quoteToken: 'q' } });

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function ev(type: EventType) {
  return db.select().from(events).where(and(eq(events.clubId, club.id), eq(events.type, type)));
}

/** The signed details link the bot sent last: `ref` and `t`. */
function detailsLink(): { ref: string; t: string } {
  const all = JSON.stringify(gw.sent);
  const links = [...all.matchAll(/liff\/details\?ref=([A-Z0-9-]+)&t=([A-Za-z0-9_.-]+)/g)];
  const last = links.at(-1)!;
  return { ref: last[1]!, t: last[2]! };
}

const DETAILS = { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6, acceptRules: true, viaChat: true };

/** A simulator-style user (`SIM-`): the LIFF form skips the ID token check, as in the simulator. */
async function bookToHold(u: string, opts: { pax?: string; table?: string } = {}) {
  await text(u, 'book a table');
  await tap(u, `a=night&d=${FRIDAY}`);
  await tap(u, `a=pax&r=${opts.pax ?? '5-8'}`);
  await tap(u, `a=table&t=${opts.table ?? 'table_demo_B1'}&d=${FRIDAY}`);
  const guest = (await db.query.guests.findFirst({ where: and(eq(guests.clubId, club.id), eq(guests.lineUserId, u)) }))!;
  return (await db.query.bookings.findFirst({ where: and(eq(bookings.guestId, guest.id), eq(bookings.status, 'held')) }))!;
}

/** Book a table, open and submit the form, confirm, send a slip, staff approve. Returns the booking id. */
async function fullBookingWalk(u: string) {
  const held = await bookToHold(u);
  const { ref, t } = detailsLink();
  expect((await created.app.request(`/api/liff/booking?ref=${ref}&t=${t}`)).status).toBe(200);
  expect((await created.app.request('/api/liff/booking/details', json({ ref, t, ...DETAILS }))).status).toBe(200);
  await tap(u, `a=confirm&b=${held.id}`);
  await image(u);
  await approveDeposit(db, club.id, held.id, STAFF, clock);
  return held.id;
}

// ---------- The plan's named tests ----------

describe('emit coverage (B4b)', () => {
  it('full booking walk emits booking.started, night.selected, pax.selected, availability.searched, table.held, details.submitted, rules.accepted, deposit.qr_sent, slip.received, booking.confirmed with one attempt_id', async () => {
    const bookingId = await fullBookingWalk('SIM-walk');
    const [started] = await ev('booking.started');
    expect(started?.attemptId).toBeTruthy();
    expect(started!.source).toBe('text_intent');
    const steps: EventType[] = [
      'booking.started',
      'night.selected',
      'pax.selected',
      'availability.searched',
      'table.held',
      'form.opened',
      'details.submitted',
      'notice.accepted',
      'rules.accepted',
      'deposit.qr_sent',
      'slip.received',
      'deposit.verified',
      'booking.confirmed',
    ];
    for (const type of steps) {
      const rows = await ev(type);
      expect(rows, type).toHaveLength(1);
      expect(rows[0]!.attemptId, type).toBe(started!.attemptId);
    }
    const [rules] = await ev('rules.accepted');
    expect(rules!.bookingId).toBe(bookingId);
    expect(rules!.props).toEqual({ rules_version: club.settings.rulesVersion });
    const [pax] = await ev('pax.selected');
    expect(pax!.props).toEqual({ pax_range: 'p5_8' });
    expect(pax!.nightDate).toBe(FRIDAY);
    const [notice] = await ev('notice.accepted');
    expect(notice!.props).toMatchObject({ purpose: 'data' });
  });

  it('abandoned attempt records last_step', async () => {
    const u = 'SIM-abandon';
    // Before the hold: night and party size picked, then a new booking tap replaces the attempt.
    await text(u, 'book a table');
    await tap(u, `a=night&d=${FRIDAY}`);
    await tap(u, 'a=pax&r=2-4');
    const [first] = await ev('booking.started');
    await tap(u, 'a=book&s=rm_book');
    const pre = await ev('booking.abandoned');
    expect(pre).toHaveLength(1);
    expect(pre[0]!.attemptId).toBe(first!.attemptId);
    expect(pre[0]!.props).toMatchObject({ last_step: 'table' });

    // After the hold, before the form: "Start over" abandons the booking at the details step.
    await tap(u, `a=night&d=${FRIDAY}`);
    await tap(u, 'a=pax&r=2-4');
    await tap(u, `a=table&t=table_demo_T1&d=${FRIDAY}`);
    await tap(u, 'a=restart&s=rm_book');
    const after = await ev('booking.abandoned');
    expect(after).toHaveLength(2);
    const held = after.find((e) => e.bookingId);
    expect(held!.props).toMatchObject({ last_step: 'details' });
    // The booking's own abandonment is the only one for that attempt.
    expect(after.filter((e) => e.attemptId === held!.attemptId)).toHaveLength(1);
  });

  it('lost hold race emits table.hold_lost_race', async () => {
    for (const u of ['SIM-a', 'SIM-b']) {
      await text(u, 'book');
      await tap(u, `a=night&d=${FRIDAY}`);
      await tap(u, 'a=pax&r=9-12');
    }
    await tap('SIM-a', `a=table&t=table_demo_V1&d=${FRIDAY}`);
    await tap('SIM-b', `a=table&t=table_demo_V1&d=${FRIDAY}`);
    const lost = await ev('table.hold_lost_race');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ tableId: 'table_demo_V1', nightDate: FRIDAY });
    expect(lost[0]!.attemptId).toBeTruthy();
  });

  it('closed night picked emits night.rejected; a full night shown emits night.sold_out_shown', async () => {
    await text('SIM-n', 'book');
    await tap('SIM-n', `a=night&d=${SUNDAY}`);
    const rejected = await ev('night.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.props).toEqual({ reason: 'closed' });
    expect(rejected[0]!.nightDate).toBe(SUNDAY);
    expect(await ev('night.selected')).toHaveLength(0);

    await db.insert(nights).values({ id: newId(), clubId: club.id, date: FRIDAY, status: 'sold_out' });
    await tap('SIM-n', `a=night&d=${FRIDAY}`);
    const shown = await ev('night.sold_out_shown');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.nightDate).toBe(FRIDAY);
  });

  it('follow, unfollow and refollow emit', async () => {
    const u = 'Ufollow';
    await send(u, { type: 'follow', follow: { isUnblocked: false } });
    expect(await ev('guest.followed')).toHaveLength(1);
    await send(u, { type: 'unfollow' });
    expect(await ev('guest.unfollowed')).toHaveLength(1);
    await send(u, { type: 'follow', follow: { isUnblocked: true } });
    expect(await ev('guest.refollowed')).toHaveLength(1);
    expect(await ev('guest.followed')).toHaveLength(1);
    expect(await ev('guest.first_seen')).toHaveLength(1);
  });

  it('message.sent carries kind, delivered and latency_ms; a failed send has delivered false', async () => {
    await text('Usend', 'where are you');
    const [received] = await ev('message.received');
    expect(received!.props).toMatchObject({ kind: 'text', attachments: 0 });
    const sent = await ev('message.sent');
    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) {
      expect(e.props).toMatchObject({ kind: 'reply', delivered: true });
      expect(typeof (e.props as { latency_ms: unknown }).latency_ms).toBe('number');
      expect(e.causeId).toBe((received!.props as { messageId: string }).messageId);
    }

    const boom = async () => {
      throw new Error('LINE down');
    };
    useGateway(fakeGateway({ reply: boom, push: boom }));
    await text('Usend', 'where are you');
    const failed = (await ev('message.sent')).filter((e) => (e.props as { delivered: boolean }).delivered === false);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.props).toMatchObject({ kind: 'push', delivered: false });
  });

  it('unknown text emits intent.unknown and bot.fallback_menu', async () => {
    await text('Uunknown', 'qwerty zxcv');
    expect(await ev('intent.unknown')).toHaveLength(1);
    expect(await ev('bot.fallback_menu')).toHaveLength(1);
    await text('Uunknown', 'where are you');
    const detected = await ev('intent.detected');
    expect(detected.map((e) => e.props)).toContainEqual({ intent: 'location' });
  });

  it('bad signature emits line.webhook.rejected', async () => {
    const res = await post({ destination: 'Ubot', events: [] }, 'forged');
    expect(res.status).toBe(401);
    const [rejected] = await ev('line.webhook.rejected');
    expect(rejected!.props).toEqual({ reason: 'bad_signature' });
  });

  it('a failing turn emits bot.error', async () => {
    useGateway(
      fakeGateway({
        getProfile: async () => {
          throw new Error('profile lookup failed');
        },
      }),
    );
    await text('Uerror', 'hello');
    const [error] = await ev('bot.error');
    expect(error!.props).toMatchObject({ step: 'message' });
  });

  it('the details form records opened, validation, identity and submit failures', async () => {
    const held = await bookToHold('Uform');
    const { ref, t } = detailsLink();
    // A real LINE guest with no login channel configured: the identity check refuses.
    expect((await created.app.request(`/api/liff/booking?ref=${ref}&t=${t}`)).status).toBe(503);
    expect((await ev('form.identity_rejected'))[0]!.props).toEqual({ code: 'login_not_configured' });

    expect((await created.app.request('/api/liff/booking/details', json({ ref, t, ...DETAILS, phone: 'x' }))).status).toBe(400);
    const [invalid] = await ev('form.validation_failed');
    expect(invalid!.props).toMatchObject({ field: 'phone' });
    expect(invalid!.bookingId).toBe(held.id);

    // A simulator guest passes the identity check; a submit after the hold ran out is refused.
    const sim = await bookToHold('SIM-form', { pax: '2-4', table: 'table_demo_T1' });
    const link = detailsLink();
    expect((await created.app.request(`/api/liff/booking?ref=${link.ref}&t=${link.t}`)).status).toBe(200);
    expect((await ev('form.opened')).map((e) => e.bookingId)).toEqual([sim.id]);
    // The guest started over in the chat: the old link's booking is no longer held.
    await tap('SIM-form', 'a=restart&s=rm_book');
    expect((await created.app.request('/api/liff/booking/details', json({ ...link, ...DETAILS, pax: 2 }))).status).toBe(409);
    expect((await ev('form.submit_rejected'))[0]!.props).toEqual({ code: 'invalid_state' });
  });

  it('a closed POS bill completes its booking (booking.completed)', async () => {
    const bookingId = await fullBookingWalk('SIM-pos');
    await markArrived(db, club.id, bookingId, STAFF, clock, 6);
    const ref = 'bill-1';
    await db.insert(posBills).values({ id: posBillId(club.id, ref), clubId: club.id, bookingId, providerBillId: ref, tableCode: 'B1', covers: 6, openedAt: clock, syncedAt: clock });
    const closedAt = new Date(clock.getTime() + 5 * 3_600_000);
    await applyLiveBill(db, club, { ref, tableCode: 'B1', covers: 6, openedAt: clock, closedAt, totalSatang: 1_500_000 }, { now: closedAt, source: 'live:papaya' });
    const [completed] = await ev('booking.completed');
    expect(completed).toMatchObject({ bookingId, dataOrigin: 'pos' });
    expect(completed!.props).toEqual({ billRef: ref, totalSatang: 1_500_000 });
    // §7.1: the bill close also moves the arrived booking to completed, with its status event.
    expect((await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) }))!.status).toBe('completed');
    const changed = (await ev('booking.status_changed')).filter((e) => e.bookingId === bookingId).map((e) => (e.props as { to: string }).to);
    expect(changed.at(-1)).toBe('completed');
  });

  it('every Phase 1b event type is emitted at least once', async () => {
    // B4b walks.
    const confirmedId = await fullBookingWalk('SIM-all');
    await send('Uall', { type: 'follow', follow: { isUnblocked: false } });
    await send('Uall', { type: 'unfollow' });
    await send('Uall', { type: 'follow', follow: { isUnblocked: true } });
    await text('Uall', 'qwerty zxcv');
    await text('SIM-x', 'book');
    await tap('SIM-x', `a=night&d=${SUNDAY}`);
    await db.insert(nights).values({ id: newId(), clubId: club.id, date: SATURDAY, status: 'sold_out' });
    await tap('SIM-x', `a=night&d=${SATURDAY}`);
    await tap('SIM-x', `a=night&d=${FRIDAY}`);
    await tap('SIM-x', 'a=pax&r=9-12');
    await tap('SIM-y', 'a=book&s=rm_book');
    await tap('SIM-y', `a=night&d=${FRIDAY}`);
    await tap('SIM-y', 'a=pax&r=9-12');
    await tap('SIM-x', `a=table&t=table_demo_V1&d=${FRIDAY}`);
    await tap('SIM-y', `a=table&t=table_demo_V1&d=${FRIDAY}`);
    await tap('SIM-y', 'a=book&s=rm_book');
    await text('Uall', 'can I talk to a person please');
    await post({ destination: 'Ubot', events: [] }, 'forged');

    // B2 transitions on other bookings.
    const held = (await db.query.bookings.findFirst({ where: and(eq(bookings.clubId, club.id), eq(bookings.status, 'held')) }))!;
    await expireHold(db, club.id, held.id, clock);
    await cancelBooking(db, club.id, confirmedId, STAFF, { code: 'club_cancelled' }, clock);
    const manual = await createManualBooking(db, club, { tableId: 'table_demo_B2', nightDate: FRIDAY, pax: 4, name: 'Walk', depositPaid: false }, STAFF, clock);
    await markArrived(db, club.id, manual.id, STAFF, clock, 4);
    const noShow = await createManualBooking(db, club, { tableId: 'table_demo_B3', nightDate: FRIDAY, pax: 4, name: 'Late', depositPaid: false }, STAFF, clock);
    await releaseNoShow(db, club.id, noShow.id, STAFF, clock);
    const second = await bookToHold('SIM-reject', { pax: '5-8', table: 'table_demo_B4' });
    const link = detailsLink();
    await created.app.request('/api/liff/booking/details', json({ ...link, ...DETAILS }));
    await tap('SIM-reject', `a=confirm&b=${second.id}`);
    await image('SIM-reject');
    await rejectDeposit(db, club.id, second.id, STAFF, { code: 'payment_not_verified' }, clock);

    const missing: EventType[] = [];
    for (const type of PHASE_1B_HERE) if ((await ev(type)).length === 0) missing.push(type);
    expect(missing).toEqual([]);
  });

  it('brain note approval and rejection emit', async () => {
    const a = await createNote(db, { clubId: club.id, title: 'Dress code', type: 'faq', bodyMd: 'Smart casual.', source: 'manual' }, STAFF, clock);
    await approveNote(db, club.id, a.id, STAFF, clock);
    const r = await createNote(db, { clubId: club.id, title: 'Parking', type: 'faq', bodyMd: 'Valet at the door.', source: 'manual' }, STAFF, clock);
    await rejectNote(db, club.id, r.id, STAFF, clock);
    expect((await ev('brain.note_approved')).map((e) => e.props)).toEqual([{ noteId: a.id, noteType: 'faq', source: 'manual' }]);
    expect((await ev('brain.note_rejected')).map((e) => e.props)).toEqual([{ noteId: r.id, noteType: 'faq', source: 'manual' }]);
  });
});

/** The names the B4b table gives B2, B4 and B4b (plus the form events B4b added), proved above. */
const PHASE_1B_HERE: EventType[] = [
  // B4b
  'guest.first_seen', 'guest.followed', 'guest.unfollowed', 'guest.refollowed',
  'notice.accepted', 'rules.accepted',
  'message.received', 'message.sent',
  'intent.detected', 'intent.unknown', 'bot.fallback_menu',
  'booking.started', 'night.selected', 'night.rejected', 'pax.selected', 'night.sold_out_shown', 'table.hold_lost_race',
  'handoff.requested',
  'line.webhook.rejected',
  'form.opened',
  // B4
  'notice.shown', 'availability.searched', 'link.opened',
  // B2
  'table.held', 'hold.expired', 'booking.abandoned', 'details.submitted', 'deposit.qr_sent', 'slip.received',
  'deposit.verified', 'deposit.rejected', 'booking.confirmed', 'booking.cancelled', 'booking.checked_in',
  'booking.no_show', 'table.released', 'booking.manual_created', 'booking.status_changed',
];

/** Proved by a dedicated case in this file rather than the all-events walk. */
const PROVED_HERE_SEPARATELY: EventType[] = [
  'bot.error', 'form.validation_failed', 'form.identity_rejected', 'form.submit_rejected', 'booking.completed',
  'brain.note_approved', 'brain.note_rejected',
];

/** Declared types with no emitter yet, each with the reason (plan B4b table). Empty: every type has one. */
const RESERVED: Partial<Record<EventType, string>> = {};

// ---------- Static coverage: every declared type has an emitter and a test ----------

const SRC = join(import.meta.dirname, '../src');
const TEST = import.meta.dirname;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Files that only read or replay events, never emit them; any other file naming a type is its emitter. */
const NOT_EMITTERS = ['data/event-types.ts', 'demo/seed-history.ts', 'platform/club-stats.ts', 'brain/gaps.ts', 'jobs/nightly-check.ts'];

describe('every declared event type has an emitter (B4b)', () => {
  const emitters = tsFiles(SRC)
    .filter((f) => !NOT_EMITTERS.some((n) => f.endsWith(n)))
    .map((f) => readFileSync(f, 'utf8'));
  const statusEvents = new Set(Object.values(STATUS_EVENTS).flat());
  const tests = readdirSync(TEST)
    .filter((f) => f.endsWith('.test.ts') && f !== 'events.test.ts' && f !== 'emit-coverage.test.ts')
    .map((f) => readFileSync(join(TEST, f), 'utf8'));
  const provedHere = new Set<EventType>([...PHASE_1B_HERE, ...PROVED_HERE_SEPARATELY]);

  it('each type is emitted somewhere in src, or reserved with a reason', () => {
    const noEmitter = EVENT_TYPES.filter((t) => !RESERVED[t] && !statusEvents.has(t) && !emitters.some((s) => s.includes(`'${t}'`)));
    expect(noEmitter).toEqual([]);
  });

  it("each type's emitter is asserted by this file or by its owning task's test", () => {
    const untested = EVENT_TYPES.filter((t) => !RESERVED[t] && !provedHere.has(t) && !tests.some((s) => s.includes(`'${t}'`)));
    expect(untested).toEqual([]);
  });
});
