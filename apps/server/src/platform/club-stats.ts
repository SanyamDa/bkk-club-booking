import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channels, events, messages, platformFlags } from '../db/schema.js';
import type { EventType } from '../data/event-types.js';
import { bangkokAt, bookingFigures, chatFigures, MANUAL_SOURCES, nightRange, testGuestIds, type NightRange } from './club-report.js';
import { quotaView, type QuotaView } from './health.js';
import { lastKnownQuota } from './line-probe.js';

/**
 * Club stats page (spec §6.5, plan A16): one page per club for any range of nights. The booking,
 * deposit, no-show, G1 and G9 figures come from the helpers the weekly report (A16b) uses, so both
 * pages agree for the same week. Test rows are left out for every club that is not `demo`.
 */
export interface ClubStats {
  clubId: string;
  /** Nights, YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  /** Held bookings (confirmed, arrived, completed, no-show): made by the bot against made by staff. */
  bookings: { total: number; bot: number; manual: number; cancelled: number };
  /** G1: share of held bookings with no staff help. */
  noStaffHelpRate: number | null;
  /** G9 and takeovers by topic (§3.2). */
  deflection: { conversations: number; deflected: number; rate: number | null };
  takeoversByTopic: { topic: string; n: number }[];
  /** G2: inbound guest message to the next bot or staff message to that guest. */
  firstResponse: { medianMs: number | null; answered: number; unanswered: number };
  /** G8: takeover start to the first staff message to that guest. */
  handoffResponse: { medianMs: number | null; replied: number; waiting: number };
  /** G5: an attempt's first event (`booking.started`) to its `booking.confirmed`. */
  bookingTime: { medianMs: number | null; bookings: number };
  deposits: { count: number; satang: number };
  minSpendBookedSatang: number;
  /** G6. */
  noShowRate: number | null;
  messagesByChannel: { channel: string; in: number; out: number }[];
  /** The current month's push quota from the last LINE check (A5/A9); null before any reading. */
  pushQuota: QuotaView | null;
  /** `ai.call` cost in the range, and in the Bangkok calendar month of `to` against the club's cap. */
  aiCost: { rangeUsdMicros: number; monthUsdMicros: number; capUsdMicros: number | null };
  /** §14.10 funnel: distinct attempts reaching each step, and the drop from the step before. */
  funnel: { step: FunnelStep; n: number; dropOff: number }[];
}

export type FunnelStep = 'started' | 'night' | 'pax' | 'table' | 'details' | 'rules' | 'paid' | 'confirmed';

const FUNNEL: [FunnelStep, EventType][] = [
  ['started', 'booking.started'],
  ['night', 'night.selected'],
  ['pax', 'pax.selected'],
  ['table', 'table.held'],
  ['details', 'details.submitted'],
  ['rules', 'rules.accepted'],
  ['paid', 'deposit.verified'],
  ['confirmed', 'booking.confirmed'],
];
const AI_CALL: EventType = 'ai.call';
const STARTED: EventType = 'booking.started';
const CONFIRMED: EventType = 'booking.confirmed';

/**
 * Where the club's monthly AI cost cap lives: `platform_flags[key].value.usdMicros`. B16
 * (`brain/answer.ts`) enforces it; with no row B16 applies `DEFAULT_AI_COST_CAP_USD_MICROS` and this
 * page shows no cap.
 */
export const aiCostCapKey = (clubId: string) => `ai-cost-cap:${clubId}`;

/** Most nights one request may cover. */
export const MAX_STATS_NIGHTS = 366;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** The Bangkok calendar month that `date` (YYYY-MM-DD) falls in, as instants [from, to). */
function bangkokMonth(date: string): { from: Date; to: Date } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: bangkokAt(first, 0), to: bangkokAt(next, 0) };
}

async function rangeEvents(db: Db, r: NightRange, types: EventType[], from = r.from, to = r.to) {
  const rows = await db
    .select({ id: events.id, type: events.type, occurredAt: events.occurredAt, attemptId: events.attemptId, props: events.props, isTest: events.isTest })
    .from(events)
    .where(and(eq(events.clubId, r.club.id), inArray(events.type, types), gte(events.occurredAt, from), lt(events.occurredAt, to)));
  return rows.filter((e) => r.withTest || !e.isTest);
}

export async function buildClubStats(db: Db, clubId: string, from: string, to: string): Promise<ClubStats> {
  const range = await nightRange(db, clubId, from, to);
  const testGuests = await testGuestIds(db, range);
  const b = await bookingFigures(db, range);
  const chat = await chatFigures(db, range, testGuests);
  const manual = b.held.filter((bk) => MANUAL_SOURCES.has(bk.source)).length;

  // Messages of the range, test guests left out.
  const msgs = (
    await db
      .select({ guestId: messages.guestId, direction: messages.direction, authorType: messages.authorType, channelId: messages.channelId, at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.clubId, clubId), gte(messages.createdAt, range.from), lt(messages.createdAt, range.to)))
  ).filter((m) => m.guestId !== null && !testGuests.has(m.guestId));
  const outBy = new Map<string, { at: number; staff: boolean }[]>();
  for (const m of msgs) {
    if (m.direction !== 'out' || (m.authorType !== 'bot' && m.authorType !== 'staff')) continue;
    outBy.set(m.guestId!, [...(outBy.get(m.guestId!) ?? []), { at: m.at.getTime(), staff: m.authorType === 'staff' }]);
  }
  for (const list of outBy.values()) list.sort((x, y) => x.at - y.at);

  // G2.
  const responseMs: number[] = [];
  let unanswered = 0;
  for (const m of msgs) {
    if (m.direction !== 'in' || m.authorType !== 'guest') continue;
    const reply = outBy.get(m.guestId!)?.find((o) => o.at >= m.at.getTime());
    if (reply) responseMs.push(reply.at - m.at.getTime());
    else unanswered += 1;
  }

  // G8: `chatFigures` already left out test guests' takeovers.
  const handoffMs: number[] = [];
  let waiting = 0;
  for (const e of chat.episodes) {
    const reply = outBy.get(e.guestId)?.find((o) => o.staff && o.at >= e.startedAt.getTime());
    if (reply) handoffMs.push(reply.at - e.startedAt.getTime());
    else waiting += 1;
  }

  // Messages by channel; a message without a channel id is LINE (every club has a LINE channel).
  const kinds = new Map(
    (await db.select({ id: channels.id, kind: channels.kind }).from(channels).where(eq(channels.clubId, clubId))).map((c) => [c.id, c.kind as string]),
  );
  const byChannel = new Map<string, { channel: string; in: number; out: number }>();
  for (const m of msgs) {
    const channel = (m.channelId && kinds.get(m.channelId)) || 'line';
    const cur = byChannel.get(channel) ?? { channel, in: 0, out: 0 };
    cur[m.direction] += 1;
    byChannel.set(channel, cur);
  }
  const messagesByChannel = [...byChannel.values()].sort((x, y) => y.in + y.out - (x.in + x.out) || x.channel.localeCompare(y.channel));

  // Funnel and G5 from the events.
  const funnelEvents = await rangeEvents(db, range, FUNNEL.map(([, t]) => t));
  let prev = 0;
  const funnel = FUNNEL.map(([step, type], i) => {
    const n = new Set(funnelEvents.filter((e) => e.type === type).map((e) => e.attemptId ?? e.id)).size;
    const row = { step, n, dropOff: i === 0 ? 0 : prev - n };
    prev = n;
    return row;
  });
  // An attempt starts at its first event; one that started before the range is looked up.
  const startOf = new Map<string, number>();
  for (const e of funnelEvents) {
    if (e.attemptId) startOf.set(e.attemptId, Math.min(e.occurredAt.getTime(), startOf.get(e.attemptId) ?? Infinity));
  }
  const confirmed = funnelEvents.filter((e) => e.type === CONFIRMED && e.attemptId);
  const startedIn = new Set(funnelEvents.filter((e) => e.type === STARTED && e.attemptId).map((e) => e.attemptId!));
  const missing = confirmed.map((e) => e.attemptId!).filter((id) => !startedIn.has(id));
  if (missing.length) {
    const early = await db
      .select({ attemptId: events.attemptId, occurredAt: events.occurredAt })
      .from(events)
      .where(and(eq(events.clubId, clubId), eq(events.type, STARTED), inArray(events.attemptId, missing)));
    for (const e of early) startOf.set(e.attemptId!, Math.min(e.occurredAt.getTime(), startOf.get(e.attemptId!)!));
  }
  const bookingMs = confirmed.map((e) => e.occurredAt.getTime() - startOf.get(e.attemptId!)!);

  // AI cost against the cap.
  const month = bangkokMonth(to);
  const aiRange = await rangeEvents(db, range, [AI_CALL]);
  const aiMonth = await rangeEvents(db, range, [AI_CALL], month.from, month.to);
  const cost = (rows: typeof aiRange) => rows.reduce((s, e) => s + (typeof e.props.cost_usd_micros === 'number' ? e.props.cost_usd_micros : 0), 0);
  const [cap] = await db.select({ value: platformFlags.value }).from(platformFlags).where(eq(platformFlags.key, aiCostCapKey(clubId))).limit(1);
  const capUsdMicros = typeof (cap?.value as { usdMicros?: unknown } | undefined)?.usdMicros === 'number' ? (cap!.value as { usdMicros: number }).usdMicros : null;

  return {
    clubId,
    from,
    to,
    bookings: { total: b.held.length, bot: b.held.length - manual, manual, cancelled: b.cancelled },
    noStaffHelpRate: b.noStaffHelpRate,
    deflection: chat.deflection,
    takeoversByTopic: chat.takeoversByTopic,
    firstResponse: { medianMs: median(responseMs), answered: responseMs.length, unanswered },
    handoffResponse: { medianMs: median(handoffMs), replied: handoffMs.length, waiting },
    bookingTime: { medianMs: median(bookingMs), bookings: bookingMs.length },
    deposits: b.deposits,
    minSpendBookedSatang: b.held.reduce((s, bk) => s + bk.minSpendSatang, 0),
    noShowRate: b.noShowRate,
    messagesByChannel,
    pushQuota: quotaView(await lastKnownQuota(db, clubId)),
    aiCost: { rangeUsdMicros: cost(aiRange), monthUsdMicros: cost(aiMonth), capUsdMicros },
    funnel,
  };
}
