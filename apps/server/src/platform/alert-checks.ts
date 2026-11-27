import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { bookingsForNight } from '../bookings/service.js';
import { alerts, clubs, deposits, tables, zones, type Club } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { AppContext } from '../http/context.js';
import { bangkokParts, toDateString } from '../lib/time.js';
import { formatBaht } from '../lib/util.js';
import type { LineSetupDetail } from './health.js';
import { openAlert, raiseAlert, resolveOpenAlerts } from './alerts.js';
import { lastKnownQuota, probeLine, recentLineSetups, recordLineSetup } from './line-probe.js';

export const LINE_DISCONNECTED = 'line_disconnected';
export const QUOTA_EXHAUSTED = 'quota_exhausted';
export const DAILY_SUMMARY = 'daily_summary';

/** How often the timed check probes LINE itself when no fresher `line_setup` row exists. */
export const LINE_PROBE_EVERY_MS = 10 * 60_000;

/**
 * The club's current LINE state: the newest `line_setup` row (wizard, status check or an earlier
 * probe), or a fresh probe of LINE when that row is missing or older than LINE_PROBE_EVERY_MS. The
 * probe is recorded as a `line_setup` row, so a revoked token or a used-up quota is seen between
 * founder checks. Undefined when the club has no LINE credentials and no row (not connected yet).
 */
async function currentLineState(ctx: AppContext, club: Club, now: Date): Promise<LineSetupDetail | undefined> {
  const { db } = ctx.deps;
  const [latest] = await recentLineSetups(db, club.id, 1);
  if (latest && now.getTime() - latest.at.getTime() < LINE_PROBE_EVERY_MS) return latest.detail;
  const probe = await probeLine(ctx, club);
  if (!probe.configured) return latest?.detail;
  const detail: LineSetupDetail = { report: probe.report, quota: probe.quota };
  await recordLineSetup(db, club, detail, { type: 'system' }, 'probe', now);
  return detail;
}

/**
 * Raises `kind` once while `active` holds and resolves it when the condition clears, so a later
 * occurrence alerts again (plan A15: "not repeated while it lasts").
 */
async function condition(db: Db, club: Club, kind: string, active: boolean, text: { en: string; th: string }, now: Date) {
  const open = await openAlert(db, club.id, kind);
  if (active && !open) await raiseAlert(db, { clubId: club.id, level: 'urgent', kind, text }, now);
  if (!active && open) await resolveOpenAlerts(db, club.id, kind, now);
}

async function lineChecks(ctx: AppContext, club: Club, now: Date) {
  const { db } = ctx.deps;
  const detail = await currentLineState(ctx, club, now);
  // A club with no LINE credentials and no setup row is not "disconnected", it is not connected yet.
  if (!detail) return;
  const step = (name: string) => detail.report?.steps?.find((s) => s.name === name);
  const creds = step('LINE credentials');
  const webhook = step('Webhook');
  const disconnected = Boolean((creds && !creds.ok) || (webhook && !webhook.ok));
  await condition(
    db,
    club,
    LINE_DISCONNECTED,
    disconnected,
    {
      en: `LINE is disconnected for ${club.name}. Guests get no replies. Open LINE setup.`,
      th: `LINE ของ ${club.name} ขาดการเชื่อมต่อ ลูกค้าจะไม่ได้รับข้อความตอบกลับ กรุณาเปิดหน้าตั้งค่า LINE`,
    },
    now,
  );
  // A row without a reading (a failed check) does not mean the quota recovered: use the last one.
  const q = detail.quota ?? (await lastKnownQuota(db, club.id));
  const exhausted = Boolean(q && q.limit > 0 && q.used >= q.limit);
  await condition(
    db,
    club,
    QUOTA_EXHAUSTED,
    exhausted,
    {
      en: `LINE message quota is used up for ${club.name} (${q?.used ?? 0}/${q?.limit ?? 0}). Pushes will fail until the plan is upgraded or the month resets.`,
      th: `โควตาข้อความ LINE ของ ${club.name} หมดแล้ว (${q?.used ?? 0}/${q?.limit ?? 0}) ข้อความแบบ push จะส่งไม่ได้จนกว่าจะอัปเกรดแพ็กเกจหรือขึ้นเดือนใหม่`,
    },
    now,
  );
}

/** Spec §6.1: "Daily 17:00 summary", Bangkok time. */
export const DAILY_SUMMARY_HOUR = 17;

/** Bookings that count for tonight's summary (confirmed, or already in). */
const SUMMARY_STATUSES = new Set(['confirmed', 'arrived', 'completed']);

/**
 * Once a day at 17:00 Bangkok (spec §6.1): tonight's bookings by zone, deposits collected and the
 * expected minimum spend, to the feed (level info, so it reaches LINE only when the club switched
 * info alerts on).
 */
async function dailySummary(db: Db, club: Club, now: Date) {
  const p = bangkokParts(now);
  if (p.hour < DAILY_SUMMARY_HOUR) return;
  const today = toDateString(p.year, p.month, p.day);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const since = new Date(Date.UTC(y, m - 1, d, DAILY_SUMMARY_HOUR) - 7 * 3600_000);
  const [done] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.clubId, club.id), eq(alerts.kind, DAILY_SUMMARY), gte(alerts.createdAt, since)))
    .limit(1);
  if (done) return;
  const night = today;
  const rows = (await bookingsForNight(db, club.id, night)).filter((b) => SUMMARY_STATUSES.has(b.status));
  const zoneRows = await db
    .select({ tableId: tables.id, zoneId: zones.id, zone: zones.name, zoneTh: zones.nameTh, sort: zones.sort })
    .from(tables)
    .innerJoin(zones, eq(zones.id, tables.zoneId))
    .where(eq(tables.clubId, club.id));
  const zoneOf = new Map(zoneRows.map((z) => [z.tableId, z]));
  const byZone = new Map<string, { en: string; th: string; sort: number; n: number }>();
  for (const b of rows) {
    const z = zoneOf.get(b.tableId);
    const key = z?.zoneId ?? '';
    const cur = byZone.get(key) ?? { en: z?.zone ?? 'Other', th: z?.zoneTh ?? 'อื่น ๆ', sort: z?.sort ?? 999, n: 0 };
    cur.n += 1;
    byZone.set(key, cur);
  }
  const zonesSorted = [...byZone.values()].sort((a, b) => a.sort - b.sort);
  const ids = rows.map((b) => b.id);
  const paid = ids.length
    ? await db
        .select({ amount: deposits.amountSatang })
        .from(deposits)
        .where(and(eq(deposits.clubId, club.id), eq(deposits.status, 'verified'), inArray(deposits.bookingId, ids)))
    : [];
  const depositsSatang = paid.reduce((sum, r) => sum + r.amount, 0);
  const minSpendSatang = rows.reduce((sum, b) => sum + b.minSpendSatang, 0);
  const zonesEn = zonesSorted.length ? zonesSorted.map((z) => `${z.en} ${z.n}`).join(', ') : 'none';
  const zonesTh = zonesSorted.length ? zonesSorted.map((z) => `${z.th} ${z.n}`).join(', ') : 'ไม่มี';
  await raiseAlert(
    db,
    {
      clubId: club.id,
      level: 'info',
      kind: DAILY_SUMMARY,
      text: {
        en: `Tonight ${night}: ${rows.length} bookings (${zonesEn}). Deposits collected ${formatBaht(depositsSatang)}. Expected minimum spend ${formatBaht(minSpendSatang)}.`,
        th: `คืนนี้ ${night}: จอง ${rows.length} โต๊ะ (${zonesTh}) มัดจำที่ได้รับ ${formatBaht(depositsSatang)} ยอดใช้จ่ายขั้นต่ำที่คาด ${formatBaht(minSpendSatang)}`,
      },
    },
    now,
  );
}

/** Timed alert checks (spec §6.4), run every minute by the `alert-checks` job. Paused and onboarding clubs are skipped. */
export async function runAlertChecks(ctx: AppContext, now: Date): Promise<void> {
  const { db } = ctx.deps;
  const rows = await db.select().from(clubs).where(ne(clubs.status, 'onboarding'));
  for (const club of rows) {
    if (club.status === 'paused') continue;
    try {
      await lineChecks(ctx, club, now);
      await dailySummary(db, club, now);
    } catch (err) {
      ctx.deps.log(`Alert checks failed for club ${club.id}`, err);
    }
  }
}
