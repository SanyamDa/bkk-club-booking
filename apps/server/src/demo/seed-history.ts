import { and, eq, gt, sql } from 'drizzle-orm';
import { STATUS_EVENTS, type EventType } from '../data/event-types.js';
import { emit, type EventInput } from '../data/events.js';
import type { Db } from '../db/client.js';
import {
  bookings,
  bookingStatusHistory,
  conversations,
  crowdRatings,
  deposits,
  doorCounts,
  events,
  guests,
  handoffEpisodes,
  messages,
  posBills,
  type BookingSource,
  type BookingStatus,
  type Club,
} from '../db/schema.js';
import { listTableOptions, type TableOption } from '../bookings/service.js';
import { ensureNights } from '../jobs/nights.js';
import { addDays, currentNightDate, weekdayOf } from '../lib/time.js';

/**
 * Velora's seeded activity (plan B7, spec §12.4). Every row has a deterministic id:
 * `seed_hist_*` for the six weeks of history before tonight, `seed_tonight_*` for tonight.
 * `resetDemoClub` deletes everything else (and the old `seed_tonight_*` rows) and re-runs
 * `seedTonight`. Content (zones, tables, prices, policies, brain notes, profile) is not activity.
 *
 * Rows are written directly, not through the booking service, because they describe the past:
 * each booking's status path gets its `booking_status_history` rows and the same events
 * `changeStatus` would have written (through `emit`), at the times of the path, so the nightly
 * completeness check matches them. Events get their seed id after `emit` (see `tagEvents`).
 * Every guest, booking and event is `is_test` (Velora is a demo club).
 */

export const SEED_HIST = 'seed_hist_';
export const SEED_TONIGHT = 'seed_tonight_';

/** Weeks of history before tonight. */
export const HISTORY_WEEKS = 6;
const HISTORY_SEED = 0x7e10a;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
type Rng = ReturnType<typeof prng>;

/** Bangkok wall clock on `date` at `hour` (24 and more roll into the next day). */
const bkk = (date: string, hour: number, minute = 0) => new Date(Date.parse(`${date}T00:00:00+07:00`) + hour * HOUR + minute * MIN);

const pad = (n: number, w = 4) => String(n).padStart(w, '0');

const FIRST_NAMES = ['Ploy', 'Nat', 'Beam', 'Mild', 'Ton', 'Fern', 'Bank', 'Mint', 'Arm', 'Pim', 'James', 'Sophie', 'Kenji', 'Yuna', 'Lucas', 'Mia', 'Dao', 'Golf', 'Praew', 'Oat'];
const LAST_INITIALS = ['S.', 'K.', 'T.', 'P.', 'W.', 'C.', 'R.', 'L.'];
const NATIONALITIES = ['TH', 'TH', 'TH', 'TH', 'TH', 'TH', 'SG', 'JP', 'GB', 'US', 'AU', 'KR'];
const GUEST_POOL = 80;

/** Takeover topics: the first six are in the FAQs, the last three are Velora's deliberate gaps. */
const TOPICS: { topic: string; text: string }[] = [
  { topic: 'dress_code', text: 'Can I wear sneakers?' },
  { topic: 'birthday', text: 'It is my friend’s birthday, can you do something special?' },
  { topic: 'large_group', text: 'We are 15 people, can we sit together?' },
  { topic: 'parking', text: 'Is there parking near the club?' },
  { topic: 'running_late', text: 'We will be 30 minutes late, is that ok?' },
  { topic: 'bottle_keep', text: 'Can we keep our bottle for next week?' },
  { topic: 'private_room', text: 'Can we hire a private room for a company party?' },
  { topic: 'wheelchair', text: 'My friend uses a wheelchair, is the club accessible?' },
  { topic: 're_entry', text: 'Can we go out for a smoke and come back in?' },
];

/** Bookings per night by weekday (Wed–Sat), before the random spread. */
const DEMAND: Record<number, number> = { 3: 6, 4: 13, 5: 15, 6: 18 };
/** Walk-in door entries per night by weekday. */
const WALK_INS: Record<number, number> = { 3: 60, 4: 160, 5: 220, 6: 260 };

type Writer = ReturnType<typeof writer>;

/** Collects rows with deterministic ids and writes them in a few batched inserts. */
function writer(club: Club, prefix: string) {
  const n: Record<string, number> = {};
  const id = (kind: string) => `${prefix}${kind}_${pad((n[kind] = (n[kind] ?? 0) + 1))}`;
  return {
    id,
    prefix,
    club,
    guests: [] as (typeof guests.$inferInsert)[],
    bookings: [] as (typeof bookings.$inferInsert)[],
    deposits: [] as (typeof deposits.$inferInsert)[],
    history: [] as (typeof bookingStatusHistory.$inferInsert)[],
    conversations: [] as (typeof conversations.$inferInsert)[],
    messages: [] as (typeof messages.$inferInsert)[],
    handoffs: [] as (typeof handoffEpisodes.$inferInsert)[],
    bills: [] as (typeof posBills.$inferInsert)[],
    door: [] as (typeof doorCounts.$inferInsert)[],
    crowd: [] as (typeof crowdRatings.$inferInsert)[],
    events: [] as EventInput[],
  };
}

async function insertAll<T>(tx: Db, table: Parameters<Db['insert']>[0], rows: T[]) {
  for (let i = 0; i < rows.length; i += 300) await tx.insert(table).values(rows.slice(i, i + 300) as never);
}

/** Writes the collected rows, then the events through `emit`, and gives the new events seed ids. */
async function flush(tx: Db, w: Writer) {
  await insertAll(tx, guests, w.guests);
  await insertAll(tx, conversations, w.conversations);
  await insertAll(tx, bookings, w.bookings);
  await insertAll(tx, deposits, w.deposits);
  await insertAll(tx, bookingStatusHistory, w.history);
  await insertAll(tx, messages, w.messages);
  await insertAll(tx, handoffEpisodes, w.handoffs);
  await insertAll(tx, posBills, w.bills);
  await insertAll(tx, doorCounts, w.door);
  await insertAll(tx, crowdRatings, w.crowd);
  const [last] = await tx.select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` }).from(events);
  for (const e of w.events) await emit(tx, e, { strict: true });
  // `emit` gives every event a random id. These are this club's events written just above.
  await tx
    .update(events)
    .set({ id: sql`${`${w.prefix}ev_`} || lpad(${events.seq}::text, 7, '0')` })
    .where(and(eq(events.clubId, w.club.id), gt(events.seq, Number(last?.seq ?? 0))));
}

interface Step {
  to: BookingStatus;
  at: Date;
  actor: EventInput['actorType'];
  reason?: string;
}

/**
 * A booking with its whole status path: history rows and the events `changeStatus` writes for
 * each step (`booking.status_changed` plus the `STATUS_EVENTS` of the new status).
 */
function addBooking(
  w: Writer,
  b: { guestId: string; option: TableOption; nightDate: string; pax: number; source: BookingSource; createdAt: Date; holdExpiresAt?: Date | null; arrivedPax?: number },
  path: Step[],
  deposit?: { status: 'pending' | 'review' | 'verified'; method: 'promptpay_slip' | 'manual' | 'cash' },
) {
  const id = w.id('booking');
  const final = path[path.length - 1]!;
  const depositId = deposit && b.option.depositSatang > 0 ? w.id('deposit') : undefined;
  const at = (s: BookingStatus) => path.find((p) => p.to === s)?.at ?? null;
  w.bookings.push({
    id,
    clubId: w.club.id,
    refCode: `${w.club.settings.refPrefix}-${id.startsWith(SEED_HIST) ? 'H' : 'T'}${pad(w.bookings.length + 1)}`,
    guestId: b.guestId,
    tableId: b.option.table.id,
    nightDate: b.nightDate,
    pax: b.pax,
    status: final.to,
    source: b.source,
    holdExpiresAt: b.holdExpiresAt ?? null,
    minSpendSatang: b.option.minSpendSatang,
    depositSatang: b.option.depositSatang,
    rulesVersion: w.club.settings.rulesVersion,
    rulesAcceptedAt: b.createdAt,
    arrivedAt: at('arrived'),
    arrivedPax: at('arrived') ? (b.arrivedPax ?? b.pax) : null,
    cancelledAt: at('cancelled'),
    cancelReasonCode: final.to === 'cancelled' ? (final.reason ?? null) : null,
    noShowAt: at('no_show'),
    statusReason: null,
    isTest: true,
    createdAt: b.createdAt,
    updatedAt: final.at,
  });
  if (depositId) {
    w.deposits.push({
      id: depositId,
      clubId: w.club.id,
      bookingId: id,
      amountSatang: b.option.depositSatang,
      method: deposit!.method,
      status: deposit!.status,
      slipReceivedAt: at('payment_review'),
      verifiedBy: deposit!.status === 'verified' ? 'staff' : null,
      verifiedAt: deposit!.status === 'verified' ? at('confirmed') : null,
      createdAt: at('awaiting_payment') ?? b.createdAt,
    });
  }
  let from: BookingStatus | null = null;
  for (const step of path) {
    w.history.push({ id: w.id('hist'), bookingId: id, fromStatus: from, toStatus: step.to, at: step.at, actorType: step.actor, reasonCode: step.reason ?? null });
    const base = {
      clubId: w.club.id,
      occurredAt: step.at,
      actorType: step.actor,
      dataOrigin: 'first_party' as const,
      bookingId: id,
      guestId: b.guestId,
      tableId: b.option.table.id,
      zoneId: b.option.zone.id,
      nightDate: b.nightDate,
      isTest: true,
    };
    w.events.push({ ...base, type: 'booking.status_changed', props: { from, to: step.to, reason_code: step.reason ?? null } });
    for (const type of STATUS_EVENTS[step.to] ?? []) {
      if (type.startsWith('deposit.') && !depositId) continue;
      w.events.push({ ...base, type, props: stepProps(type, from, step, depositId, b.option.depositSatang, b.arrivedPax ?? b.pax) });
    }
    from = step.to;
  }
  return id;
}

function stepProps(type: EventType, from: BookingStatus | null, step: Step, depositId: string | undefined, amount: number, arrivedPax: number): EventInput['props'] {
  switch (type) {
    case 'table.held':
      return { hold_minutes: 10 };
    case 'hold.expired':
    case 'booking.cancelled':
      return { reason_code: step.reason ?? null };
    case 'booking.abandoned':
      return { last_step: from, reason_code: step.reason ?? null };
    case 'deposit.qr_sent':
    case 'deposit.verified':
      return { depositId: depositId!, amount_satang: amount };
    case 'slip.received':
      return { depositId: depositId! };
    case 'booking.checked_in':
      return { arrived_pax: arrivedPax };
    default:
      return {};
  }
}

/** A guest with a typed question; with `topic`, a host took over and replied. Returns the inbound message id. */
function addChat(w: Writer, guestId: string, convs: Map<string, string>, at: Date, text: string, topic?: string, open = false) {
  let convId = convs.get(guestId);
  if (!convId) {
    convId = w.id('conv');
    convs.set(guestId, convId);
    // `mode` is left to the column default ('bot'): only chat/episodes.ts writes it (plan B14b).
    w.conversations.push({ id: convId, clubId: w.club.id, guestId, updatedAt: at });
  }
  const inId = w.id('msg');
  w.messages.push({ id: inId, clubId: w.club.id, guestId, direction: 'in', kind: 'text', payload: { type: 'text', text }, authorType: 'guest', occurredAt: at, processedAt: at, createdAt: at });
  w.events.push({ clubId: w.club.id, type: 'message.received', occurredAt: at, actorType: 'guest', dataOrigin: 'line_chat', channel: 'line', guestId, conversationId: convId, props: { kind: 'text', attachments: 0, messageId: inId }, raw: { text }, isTest: true });
  if (!topic) return { inId, convId };
  const started = new Date(at.getTime() + MIN);
  const base = { clubId: w.club.id, actorType: 'bot' as const, dataOrigin: 'first_party' as const, guestId, conversationId: convId, isTest: true };
  w.events.push({ ...base, type: 'handoff.requested', occurredAt: started, props: { trigger: 'guest_request' } });
  if (open) {
    w.handoffs.push({ id: w.id('handoff'), clubId: w.club.id, conversationId: convId, startedAt: started, trigger: 'guest_request', reason: text, firstMessageId: inId, lastMessageId: inId, topic });
    return { inId, convId };
  }
  const replyAt = new Date(started.getTime() + 4 * MIN);
  const outId = w.id('msg');
  w.messages.push({ id: outId, clubId: w.club.id, guestId, direction: 'out', kind: 'text', payload: { type: 'text', text: 'Thanks for asking! A host will sort this out for you.' }, authorType: 'staff', occurredAt: replyAt, sentVia: 'push', deliveryStatus: 'sent', createdAt: replyAt });
  const ended = new Date(replyAt.getTime() + 2 * MIN);
  w.handoffs.push({ id: w.id('handoff'), clubId: w.club.id, conversationId: convId, startedAt: started, endedAt: ended, trigger: 'guest_request', reason: text, firstMessageId: inId, lastMessageId: outId, endedBy: 'staff', topic });
  w.events.push({ ...base, type: 'host.replied', occurredAt: replyAt, actorType: 'staff', props: { latency_ms: replyAt.getTime() - started.getTime() } });
  w.events.push({ ...base, type: 'handoff.resolved', occurredAt: ended, actorType: 'staff', props: { durationSec: (ended.getTime() - started.getTime()) / 1000 } });
  return { inId, convId };
}

function poolGuests(w: Writer, rng: Rng, n: number, createdAt: Date): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = w.id('guest');
    const name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_INITIALS)}`;
    const nationality = rng.pick(NATIONALITIES);
    w.guests.push({
      id,
      clubId: w.club.id,
      // SIM- ids: a push to a seeded guest goes to the simulator gateway, never to a real LINE user.
      lineUserId: `SIM-${id}`,
      displayName: name,
      name,
      phone: `08${pad(rng.int(0, 99_999_999), 8)}`,
      nationality,
      lang: nationality === 'TH' ? 'th' : 'en',
      consentAt: createdAt,
      isTest: true,
      createdAt,
      updatedAt: createdAt,
    });
    out.push(id);
  }
  return out;
}

/** The open nights of the six weeks before `tonight` (tonight excluded). */
export function historyNights(club: Club, tonight: string): string[] {
  const out: string[] = [];
  for (let i = HISTORY_WEEKS * 7; i >= 1; i--) {
    const d = addDays(tonight, -i);
    if (club.settings.openWeekdays.includes(weekdayOf(d)) && !club.settings.closedDates.includes(d)) out.push(d);
  }
  return out;
}

/**
 * Six weeks of Velora nights before tonight: bookings (completed, no-show, cancelled, expired),
 * deposits, POS bills, chats with takeovers, door counts and crowd ratings. Same `now`, same rows.
 * Call with the transaction handle.
 */
export async function seedHistory(tx: Db, club: Club, now: Date): Promise<void> {
  const rng = prng(HISTORY_SEED);
  const w = writer(club, SEED_HIST);
  const tonight = currentNightDate(now, club.settings.nightEndHour);
  const nights = historyNights(club, tonight);
  // One `nights` row per past date, open or closed (B8b), so night views have their rows.
  await ensureNights(tx, club, addDays(tonight, -HISTORY_WEEKS * 7), HISTORY_WEEKS * 7, now);
  const pool = poolGuests(w, rng, GUEST_POOL, bkk(addDays(tonight, -HISTORY_WEEKS * 7 - 7), 12));
  const convs = new Map<string, string>();

  for (const night of nights) {
    const wd = weekdayOf(night);
    const options = rng.shuffle(await listTableOptions(tx, club.id, night));
    const count = Math.min(options.length, (DEMAND[wd] ?? 6) + rng.int(-2, 2));
    let arrivedPax = 0;
    const nightGuests: string[] = [];
    for (const option of options.slice(0, count)) {
      const guestId = rng.pick(pool);
      nightGuests.push(guestId);
      const pax = rng.int(option.table.minPax, option.table.maxPax);
      const manual = rng.next() < 0.1;
      const lead = wd >= 4 ? rng.int(0, 9) : rng.int(0, 3);
      const createdAt = bkk(addDays(night, -lead), rng.int(12, 21), rng.int(0, 59));
      const roll = rng.next();
      const outcome = roll < 0.08 ? 'cancelled' : roll < 0.13 ? 'expired' : roll < 0.21 ? 'no_show' : 'completed';
      const arrive = bkk(night, 22 + rng.int(0, 1), rng.int(0, 59));
      const paid = option.depositSatang > 0;
      const t = (m: number) => new Date(createdAt.getTime() + m * MIN);

      let path: Step[];
      if (manual) {
        path = [{ to: 'confirmed', at: createdAt, actor: 'staff' }];
      } else if (outcome === 'expired') {
        path = [{ to: 'held', at: createdAt, actor: 'guest' }, ...(paid ? [{ to: 'awaiting_payment' as const, at: t(3), actor: 'guest' as const }] : []), { to: 'expired', at: t(10), actor: 'system', reason: 'hold_expired' }];
      } else {
        path = [
          { to: 'held', at: createdAt, actor: 'guest' },
          ...(paid
            ? [
                { to: 'awaiting_payment' as const, at: t(2), actor: 'guest' as const },
                { to: 'payment_review' as const, at: t(6), actor: 'guest' as const },
              ]
            : []),
          { to: 'confirmed', at: t(paid ? 25 : 3), actor: paid ? 'staff' : 'guest' },
        ];
      }
      if (outcome === 'cancelled') path.push({ to: 'cancelled', at: bkk(night, 16, rng.int(0, 59)), actor: 'guest', reason: 'guest_cancelled' });
      if (outcome === 'no_show') path.push({ to: 'no_show', at: bkk(night, 24, 15), actor: 'staff' });
      if (outcome === 'completed') {
        path.push({ to: 'arrived', at: arrive, actor: 'staff' }, { to: 'completed', at: bkk(night, 27, rng.int(0, 45)), actor: 'system' });
      }
      // A cancellation can come before the booking was made only when the booking is same-day: keep time order.
      if (outcome === 'cancelled' && path[path.length - 1]!.at <= path[path.length - 2]!.at) path[path.length - 1]!.at = new Date(path[path.length - 2]!.at.getTime() + 30 * MIN);

      const arrived = outcome === 'completed' ? Math.max(1, pax - (rng.next() < 0.2 ? 1 : 0)) : pax;
      const deposit = manual
        ? paid && rng.next() < 0.5
          ? { status: 'verified' as const, method: 'cash' as const }
          : undefined
        : outcome === 'expired'
          ? paid
            ? { status: 'pending' as const, method: 'promptpay_slip' as const }
            : undefined
          : { status: 'verified' as const, method: 'promptpay_slip' as const };
      if (!manual) addChat(w, guestId, convs, new Date(createdAt.getTime() - 3 * MIN), `Hi, a table for ${pax} please`);
      const id = addBooking(w, { guestId, option, nightDate: night, pax, source: manual ? 'manual_phone' : 'line', createdAt, arrivedPax: arrived }, path, deposit);

      if (outcome === 'completed') {
        arrivedPax += arrived;
        const billId = w.id('bill');
        const total = Math.round((option.minSpendSatang * (1 + rng.next() * 0.6)) / 10_000) * 10_000;
        const closed = path[path.length - 1]!.at;
        w.bills.push({ id: billId, clubId: club.id, bookingId: id, providerBillId: billId, tableCode: option.table.code, covers: arrived, openedAt: arrive, closedAt: closed, totalSatang: total, syncedAt: closed });
        w.events.push({ clubId: club.id, type: 'booking.completed', occurredAt: closed, actorType: 'system', dataOrigin: 'first_party', bookingId: id, guestId, tableId: option.table.id, zoneId: option.zone.id, nightDate: night, props: { billRef: billId, totalSatang: total }, isTest: true });
      }
    }

    // Takeovers: one or two guests a night ask something a host answers.
    const takeovers = wd >= 5 ? 2 : 1;
    for (let i = 0; i < takeovers && nightGuests.length; i++) {
      const topic = rng.pick(TOPICS);
      addChat(w, rng.pick(nightGuests), convs, bkk(night, 18 + rng.int(0, 3), rng.int(0, 59)), topic.text, topic.topic);
    }

    // Door counts: table guests as they arrive, walk-ins in a wave that peaks around 00:30.
    const walkIns = Math.round((WALK_INS[wd] ?? 60) * (0.8 + rng.next() * 0.4));
    const slots = [22, 22.5, 23, 23.5, 24, 24.5, 25, 25.5, 26];
    const weights = [1, 2, 4, 6, 8, 9, 6, 3, 1];
    const totalW = weights.reduce((s, x) => s + x, 0);
    let total = 0;
    let given = 0;
    slots.forEach((slot, i) => {
      const at = bkk(night, Math.floor(slot), (slot % 1) * 60 + rng.int(0, 20));
      const walk = i === slots.length - 1 ? walkIns - given : Math.round((walkIns * weights[i]!) / totalW);
      given += walk;
      const table = i < 4 ? Math.round(arrivedPax / 4) : 0;
      for (const [delta, kind] of [
        [walk, 'walk_in'],
        [table, 'table_guest'],
      ] as const) {
        if (delta <= 0) continue;
        total += delta;
        w.door.push({ id: w.id('door'), clubId: club.id, nightDate: night, at, delta, kind });
        w.events.push({ clubId: club.id, type: 'door.count', occurredAt: at, actorType: 'staff', dataOrigin: 'first_party', nightDate: night, props: { count_in: delta, count_out: 0, total }, isTest: true });
      }
    });

    // Crowd ratings, 1–5, through the night.
    const peak = wd >= 5 ? 5 : wd === 4 ? 4 : 3;
    for (const [hour, base] of [
      [23, peak - 2],
      [24, peak - 1],
      [25, peak],
      [26, peak - 1],
    ] as const) {
      const at = bkk(night, hour, rng.int(0, 15));
      const level = Math.max(1, Math.min(5, base + rng.int(-1, 0)));
      w.crowd.push({ id: w.id('crowd'), clubId: club.id, nightDate: night, at, level });
      w.events.push({ clubId: club.id, type: 'crowd.rated', occurredAt: at, actorType: 'staff', dataOrigin: 'first_party', nightDate: night, props: { rating: level }, isTest: true });
    }
  }
  await flush(tx, w);
}

/** Tables booked tonight, by code; one hold in progress and one slip waiting review. */
const TONIGHT_CONFIRMED = ['V1', 'V3', 'B2', 'B5', 'H1', 'H4'];
const TONIGHT_HELD = 'B1';
const TONIGHT_REVIEW = 'V2';

/**
 * Tonight at Velora (relative to `now`): some tables booked, one hold in progress, one slip waiting
 * review, one guest waiting for a host. Every row id starts with `seed_tonight_`. Call with the
 * transaction handle.
 */
export async function seedTonight(tx: Db, club: Club, now: Date): Promise<string> {
  const rng = prng(HISTORY_SEED + 1);
  const w = writer(club, SEED_TONIGHT);
  const night = currentNightDate(now, club.settings.nightEndHour);
  const options = await listTableOptions(tx, club.id, night);
  const byCode = (code: string) => {
    const o = options.find((x) => x.table.code === code);
    if (!o) throw new Error(`seedTonight: Velora has no table ${code}`);
    return o;
  };
  const people = poolGuests(w, rng, TONIGHT_CONFIRMED.length + 3, new Date(now.getTime() - 3 * 24 * HOUR));
  const convs = new Map<string, string>();
  const ago = (m: number) => new Date(now.getTime() - m * MIN);

  TONIGHT_CONFIRMED.forEach((code, i) => {
    const option = byCode(code);
    const createdAt = ago(60 * (30 - i * 4));
    const paid = option.depositSatang > 0;
    const t = (m: number) => new Date(createdAt.getTime() + m * MIN);
    const path: Step[] = [
      { to: 'held', at: createdAt, actor: 'guest' },
      ...(paid
        ? [
            { to: 'awaiting_payment' as const, at: t(2), actor: 'guest' as const },
            { to: 'payment_review' as const, at: t(6), actor: 'guest' as const },
          ]
        : []),
      { to: 'confirmed', at: t(paid ? 20 : 3), actor: paid ? 'staff' : 'guest' },
    ];
    addChat(w, people[i]!, convs, new Date(createdAt.getTime() - 2 * MIN), 'Hi, can I book a table tonight?');
    addBooking(w, { guestId: people[i]!, option, nightDate: night, pax: option.table.minPax + 1, source: 'line', createdAt }, path, paid ? { status: 'verified', method: 'promptpay_slip' } : undefined);
  });

  // A slip sent a few minutes ago, waiting for a manager to approve it (demo step 2).
  const review = byCode(TONIGHT_REVIEW);
  const reviewGuest = people[TONIGHT_CONFIRMED.length]!;
  addChat(w, reviewGuest, convs, ago(16), 'VIP table for 8 tonight please');
  addBooking(
    w,
    { guestId: reviewGuest, option: review, nightDate: night, pax: 8, source: 'line', createdAt: ago(15) },
    [
      { to: 'held', at: ago(15), actor: 'guest' },
      { to: 'awaiting_payment', at: ago(12), actor: 'guest' },
      { to: 'payment_review', at: ago(5), actor: 'guest' },
    ],
    { status: 'review', method: 'promptpay_slip' },
  );

  // A hold in progress: the guest is filling in the form.
  const held = byCode(TONIGHT_HELD);
  const holdGuest = people[TONIGHT_CONFIRMED.length + 1]!;
  addChat(w, holdGuest, convs, ago(3), 'Booth for 5 tonight?');
  addBooking(
    w,
    { guestId: holdGuest, option: held, nightDate: night, pax: 5, source: 'line', createdAt: ago(2), holdExpiresAt: new Date(ago(2).getTime() + club.settings.holdMinutes * MIN) },
    [{ to: 'held', at: ago(2), actor: 'guest' }],
  );

  // A guest asked for a person and is waiting for a host (one of Velora's gaps).
  const waitingGuest = people[TONIGHT_CONFIRMED.length + 2]!;
  const convId = `${SEED_TONIGHT}conv_waiting`;
  convs.set(waitingGuest, convId);
  // The one seeded `mode` write (plan B14b exception): this bulk seed writes the open episode row and
  // its handoff.requested event itself, so it sets human mode with them instead of calling startEpisode.
  w.conversations.push({ id: convId, clubId: club.id, guestId: waitingGuest, mode: 'human', handoffRequestedAt: ago(3), handoffReason: 'guest_request', updatedAt: ago(3) });
  addChat(w, waitingGuest, convs, ago(4), TOPICS.find((x) => x.topic === 'private_room')!.text, 'private_room', true);

  await flush(tx, w);
  return night;
}
