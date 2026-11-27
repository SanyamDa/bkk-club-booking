import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  bookings,
  clubs,
  conversations,
  deposits,
  doorCounts,
  guests,
  handoffEpisodes,
  messages,
  platformFlags,
  posBills,
  tables,
  zones,
  type Club,
} from '../db/schema.js';
import type { AppContext } from '../http/context.js';
import { addDays, bangkokParts, currentNightDate, toDateString, weekdayOf } from '../lib/time.js';
import { formatBaht } from '../lib/util.js';
import { staffAlertSender } from './alerts.js';
import { vipSummary } from './crm.js';
import { topPromoters } from './promoters.js';

/**
 * Weekly club report (spec §14.10, §6.5, plan A16b). Shown on the staff dashboard (`GET /report`)
 * and sent once a week to the club's staff LINE group. Never in Metabase (§14.6).
 *
 * Test rows (Global Constraints) are left out for every club that is not `demo`: bookings and guests
 * with `is_test`, and rows that hang off them (deposits, POS bills, messages, takeovers). A `demo`
 * club's rows are all test rows, so its report counts them: that is the club's own demo data.
 */
export interface ClubReport {
  clubId: string;
  /** Monday, YYYY-MM-DD; the week is the seven nights weekStart..weekEnd. */
  weekStart: string;
  weekEnd: string;
  /** Bookings that held a table: confirmed, arrived, completed or no-show. */
  bookings: number;
  cancelled: number;
  /** Verified deposits of those bookings. */
  deposits: { count: number; satang: number };
  /** no_show / (arrived + completed + no_show); null with none of those. */
  noShowRate: number | null;
  /** Share of bookings not made by staff and with no staff message to the guest (G1). */
  noStaffHelpRate: number | null;
  /** Top three nights by bookings. */
  busiestNights: { nightDate: string; bookings: number }[];
  zones: { zoneId: string; name: string; nameTh: string; bookings: number }[];
  /** Average POS bill of the week's bookings; null without POS data. */
  averageSpendSatang: number | null;
  /** Top three promoters by held bookings (plan A20a); null when the club has no promoters. */
  topPromoters: { promoterId: string; name: string; code: string; bookings: number; pax: number }[] | null;
  /** Guests tagged `vip` (plan A20c): held bookings, arrivals and POS spend in the week. */
  vip: { guests: number; bookings: number; arrived: number; spendSatang: number };
  /** §3.2 G9: free-text conversations (6 h gap) with no takeover. Fallback-menu endings are not yet counted. */
  deflection: { conversations: number; deflected: number; rate: number | null };
  takeoversByTopic: { topic: string; n: number }[];
  /** Door entries (sum of clicks) against booked pax, and the Bangkok hour with the most entries. */
  door: { count: number; bookedPax: number; peakHour: number | null };
}

const HELD = ['confirmed', 'arrived', 'completed', 'no_show'] as const;
const RESOLVED = new Set(['arrived', 'completed', 'no_show']);
const MANUAL_SOURCES = new Set(['manual', 'manual_phone', 'manual_walkin']);
/** §3.2: a free-text conversation ends after a gap longer than this. */
const CONVERSATION_GAP_MS = 6 * 3600_000;
const BKK_OFFSET_MS = 7 * 3600_000;

/** The Monday of the week that `date` (YYYY-MM-DD) falls in. */
export function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** The last complete week for a club at `now`: the Monday before this week's Monday. */
export function lastCompleteWeek(club: Club, now: Date): string {
  return addDays(mondayOf(currentNightDate(now, club.settings.nightEndHour)), -7);
}

/** A Bangkok wall-clock hour on a date, as an instant. */
function bangkokAt(date: string, hour: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour) - BKK_OFFSET_MS);
}

const rate = (n: number, d: number) => (d > 0 ? n / d : null);

export async function buildClubReport(db: Db, clubId: string, weekStart: string): Promise<ClubReport> {
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  if (!club) throw new Error(`unknown club ${clubId}`);
  const start = mondayOf(weekStart);
  const end = addDays(start, 6);
  const withTest = club.status === 'demo';
  // Chat and takeover times: from the first night's end hour to the same hour seven days later.
  const from = bangkokAt(start, club.settings.nightEndHour);
  const to = bangkokAt(addDays(start, 7), club.settings.nightEndHour);

  const weekBookings = (
    await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.clubId, clubId), gte(bookings.nightDate, start), lt(bookings.nightDate, addDays(start, 7))))
  ).filter((b) => withTest || !b.isTest);
  const held = weekBookings.filter((b) => (HELD as readonly string[]).includes(b.status));
  const heldIds = held.map((b) => b.id);

  const paid = heldIds.length
    ? await db
        .select({ amount: deposits.amountSatang })
        .from(deposits)
        .where(and(eq(deposits.clubId, clubId), eq(deposits.status, 'verified'), inArray(deposits.bookingId, heldIds)))
    : [];

  const resolved = held.filter((b) => RESOLVED.has(b.status));
  const noShows = resolved.filter((b) => b.status === 'no_show').length;

  // G1: staff-made bookings and bookings whose guest got a staff message count as staff help.
  const guestIds = [...new Set(held.map((b) => b.guestId))];
  const staffMsgs = guestIds.length
    ? await db
        .select({ guestId: messages.guestId, at: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.clubId, clubId), eq(messages.authorType, 'staff'), inArray(messages.guestId, guestIds)))
    : [];
  const unaided = held.filter((b) => {
    if (MANUAL_SOURCES.has(b.source)) return false;
    const lo = b.createdAt.getTime() - CONVERSATION_GAP_MS;
    const hi = bangkokAt(addDays(b.nightDate, 1), club.settings.nightEndHour).getTime();
    return !staffMsgs.some((m) => m.guestId === b.guestId && m.at.getTime() >= lo && m.at.getTime() < hi);
  }).length;

  const byNight = new Map<string, number>();
  for (const b of held) byNight.set(b.nightDate, (byNight.get(b.nightDate) ?? 0) + 1);
  const busiestNights = [...byNight.entries()]
    .map(([nightDate, n]) => ({ nightDate, bookings: n }))
    .sort((a, b) => b.bookings - a.bookings || a.nightDate.localeCompare(b.nightDate))
    .slice(0, 3);

  const zoneRows = await db
    .select({ tableId: tables.id, zoneId: zones.id, name: zones.name, nameTh: zones.nameTh, sort: zones.sort })
    .from(tables)
    .innerJoin(zones, eq(zones.id, tables.zoneId))
    .where(eq(tables.clubId, clubId));
  const zoneOf = new Map(zoneRows.map((z) => [z.tableId, z]));
  const byZone = new Map<string, { zoneId: string; name: string; nameTh: string; sort: number; bookings: number }>();
  for (const b of held) {
    const z = zoneOf.get(b.tableId);
    if (!z) continue;
    const cur = byZone.get(z.zoneId) ?? { zoneId: z.zoneId, name: z.name, nameTh: z.nameTh, sort: z.sort, bookings: 0 };
    cur.bookings += 1;
    byZone.set(z.zoneId, cur);
  }
  const zoneList = [...byZone.values()]
    .sort((a, b) => b.bookings - a.bookings || a.sort - b.sort)
    .map(({ zoneId, name, nameTh, bookings: n }) => ({ zoneId, name, nameTh, bookings: n }));

  const bills = heldIds.length
    ? await db
        .select({ total: posBills.totalSatang })
        .from(posBills)
        .where(and(eq(posBills.clubId, clubId), inArray(posBills.bookingId, heldIds)))
    : [];
  const billTotals = bills.map((b) => b.total).filter((t): t is number => t !== null);
  const averageSpendSatang = billTotals.length ? Math.round(billTotals.reduce((s, t) => s + t, 0) / billTotals.length) : null;

  // Deflection (§3.2): runs of typed guest messages split on a 6 h gap; deflected when no takeover starts in the run.
  const testGuests = withTest
    ? new Set<string>()
    : new Set((await db.select({ id: guests.id }).from(guests).where(and(eq(guests.clubId, clubId), eq(guests.isTest, true)))).map((g) => g.id));
  const typed = (
    await db
      .select({ guestId: messages.guestId, at: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.clubId, clubId),
          eq(messages.direction, 'in'),
          eq(messages.kind, 'text'),
          gte(messages.createdAt, from),
          lt(messages.createdAt, to),
        ),
      )
  ).filter((m): m is { guestId: string; at: Date } => m.guestId !== null && !testGuests.has(m.guestId));
  const episodes = (
    await db
      .select({ guestId: conversations.guestId, startedAt: handoffEpisodes.startedAt, topic: handoffEpisodes.topic })
      .from(handoffEpisodes)
      .innerJoin(conversations, eq(conversations.id, handoffEpisodes.conversationId))
      .where(and(eq(handoffEpisodes.clubId, clubId), gte(handoffEpisodes.startedAt, from), lt(handoffEpisodes.startedAt, to)))
  ).filter((e) => !testGuests.has(e.guestId));

  const runs: { guestId: string; first: number; last: number }[] = [];
  const perGuest = new Map<string, number[]>();
  for (const m of typed) perGuest.set(m.guestId, [...(perGuest.get(m.guestId) ?? []), m.at.getTime()]);
  for (const [guestId, times] of perGuest) {
    times.sort((a, b) => a - b);
    let run = { guestId, first: times[0]!, last: times[0]! };
    for (const t of times.slice(1)) {
      if (t - run.last > CONVERSATION_GAP_MS) {
        runs.push(run);
        run = { guestId, first: t, last: t };
      } else run.last = t;
    }
    runs.push(run);
  }
  const deflected = runs.filter(
    (r) => !episodes.some((e) => e.guestId === r.guestId && e.startedAt.getTime() >= r.first && e.startedAt.getTime() <= r.last + CONVERSATION_GAP_MS),
  ).length;

  const byTopic = new Map<string, number>();
  for (const e of episodes) byTopic.set(e.topic ?? 'other', (byTopic.get(e.topic ?? 'other') ?? 0) + 1);
  const takeoversByTopic = [...byTopic.entries()]
    .map(([topic, n]) => ({ topic, n }))
    .sort((a, b) => b.n - a.n || a.topic.localeCompare(b.topic));

  // Door counts have no is_test column: they are test rows only when the club is demo (counted then).
  const clicks = await db
    .select({ at: doorCounts.at, delta: doorCounts.delta })
    .from(doorCounts)
    .where(and(eq(doorCounts.clubId, clubId), gte(doorCounts.nightDate, start), lt(doorCounts.nightDate, addDays(start, 7))));
  const perHour = new Map<number, number>();
  for (const c of clicks) if (c.delta > 0) perHour.set(bangkokParts(c.at).hour, (perHour.get(bangkokParts(c.at).hour) ?? 0) + c.delta);
  let peakHour: number | null = null;
  for (const [h, n] of perHour) if (peakHour === null || n > perHour.get(peakHour)!) peakHour = h;

  return {
    clubId,
    weekStart: start,
    weekEnd: end,
    bookings: held.length,
    cancelled: weekBookings.filter((b) => b.status === 'cancelled').length,
    deposits: { count: paid.length, satang: paid.reduce((s, p) => s + p.amount, 0) },
    noShowRate: rate(noShows, resolved.length),
    noStaffHelpRate: rate(unaided, held.length),
    busiestNights,
    zones: zoneList,
    averageSpendSatang,
    topPromoters: await topPromoters(db, clubId, start),
    vip: await vipSummary(db, clubId, start),
    deflection: { conversations: runs.length, deflected, rate: rate(deflected, runs.length) },
    takeoversByTopic,
    door: { count: clicks.reduce((s, c) => s + c.delta, 0), bookedPax: held.reduce((s, b) => s + b.pax, 0), peakHour },
  };
}

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`);

/** The staff-group text: Thai first, then English (as the alerts). */
export function clubReportText(club: Club, r: ClubReport): string {
  const nights = r.busiestNights.map((n) => `${n.nightDate} (${n.bookings})`).join(', ') || '–';
  const zonesTh = r.zones.map((z) => `${z.nameTh} ${z.bookings}`).join(', ') || '–';
  const zonesEn = r.zones.map((z) => `${z.name} ${z.bookings}`).join(', ') || '–';
  const topics = r.takeoversByTopic.map((t) => `${t.topic} ${t.n}`).join(', ') || '–';
  const spend = r.averageSpendSatang === null ? '–' : formatBaht(r.averageSpendSatang);
  const peak = r.door.peakHour === null ? '–' : `${String(r.door.peakHour).padStart(2, '0')}:00`;
  // A20 lines appear only when there is something to show, so a club without promoters or VIPs gets the A16b text.
  const promo = r.topPromoters?.length ? r.topPromoters.map((p) => `${p.name} ${p.bookings}`).join(', ') : null;
  const vip = r.vip.bookings ? `${r.vip.bookings} / ${r.vip.arrived} · ${formatBaht(r.vip.spendSatang)}` : null;
  const extraTh = [promo && `โปรโมเตอร์ยอดนิยม ${promo}`, vip && `ลูกค้า VIP จอง/มา ${vip}`].filter((l): l is string => !!l);
  const extraEn = [promo && `Top promoters ${promo}`, vip && `VIP bookings / arrived ${vip}`].filter((l): l is string => !!l);
  return [
    `[รายงานประจำสัปดาห์] ${club.name} ${r.weekStart} ถึง ${r.weekEnd}`,
    `การจอง ${r.bookings} (ยกเลิก ${r.cancelled}) · มัดจำ ${r.deposits.count} รายการ ${formatBaht(r.deposits.satang)}`,
    `ไม่มาตามนัด ${pct(r.noShowRate)} · จองเองโดยไม่ต้องใช้พนักงาน ${pct(r.noStaffHelpRate)}`,
    `คืนที่คึกคัก ${nights} · โซน ${zonesTh} · ยอดใช้จ่ายเฉลี่ย ${spend}`,
    `บอทตอบได้เอง ${pct(r.deflection.rate)} · ส่งต่อพนักงานตามหัวข้อ ${topics}`,
    `คนเข้าประตู ${r.door.count} / จองไว้ ${r.door.bookedPax} คน · ช่วงพีค ${peak}`,
    ...extraTh,
    '',
    `[Weekly report] ${club.name} ${r.weekStart} to ${r.weekEnd}`,
    `Bookings ${r.bookings} (cancelled ${r.cancelled}) · Deposits ${r.deposits.count}, ${formatBaht(r.deposits.satang)}`,
    `No-show ${pct(r.noShowRate)} · Booked with no staff help ${pct(r.noStaffHelpRate)}`,
    `Busiest nights ${nights} · Zones ${zonesEn} · Average spend ${spend}`,
    `Deflection ${pct(r.deflection.rate)} · Takeovers by topic ${topics}`,
    `Door count ${r.door.count} against ${r.door.bookedPax} booked · Peak hour ${peak}`,
    ...extraEn,
  ].join('\n');
}

/** Monday, Bangkok time, from this hour on: the previous week's report goes out. */
export const WEEKLY_REPORT_HOUR = 10;

export const reportFlagKey = (clubId: string, weekStart: string) => `club-report:${clubId}:${weekStart}`;

/**
 * Sends the last complete week's report to each club's staff group, once per week per club
 * (`platform_flags['club-report:<clubId>:<weekStart>']` is claimed before the send, so a repeat
 * or a second process never sends twice). From Monday 10:00 Bangkok. Onboarding and paused clubs
 * and clubs with no staff group are skipped. A failed send stays marked `failed` and is not retried;
 * a failure while building the report claims nothing, so the next run tries that club again.
 */
export async function sendWeeklyReports(ctx: AppContext, now: Date): Promise<void> {
  const { db } = ctx.deps;
  const sender = staffAlertSender(db);
  if (!sender) return;
  const p = bangkokParts(now);
  const today = toDateString(p.year, p.month, p.day);
  const thisMonday = mondayOf(today);
  if (now < bangkokAt(thisMonday, WEEKLY_REPORT_HOUR)) return;
  const weekStart = addDays(thisMonday, -7);
  const rows = await db.select().from(clubs).where(ne(clubs.status, 'onboarding'));
  for (const club of rows) {
    if (club.status === 'paused' || !club.staffGroupId) continue;
    try {
      const key = reportFlagKey(club.id, weekStart);
      const [done] = await db.select({ key: platformFlags.key }).from(platformFlags).where(eq(platformFlags.key, key)).limit(1);
      if (done) continue;
      // Built before the claim: a build failure (a transient DB error) leaves no marker, so the next run retries.
      const report = await buildClubReport(db, club.id, weekStart);
      const claimed = await db
        .insert(platformFlags)
        .values({ key, value: { status: 'sending' }, updatedBy: 'system', updatedAt: now })
        .onConflictDoNothing()
        .returning();
      if (claimed.length === 0) continue;
      let status = 'sent';
      try {
        await sender(club, clubReportText(club, report));
      } catch {
        status = 'failed'; // the outbox recorded and logged the failure
      }
      await db.update(platformFlags).set({ value: { status }, updatedAt: now }).where(eq(platformFlags.key, key));
    } catch (err) {
      ctx.deps.log(`Weekly club report failed for club ${club.id}`, err);
    }
  }
}
