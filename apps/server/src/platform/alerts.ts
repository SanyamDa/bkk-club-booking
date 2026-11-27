import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { alerts, clubAlertSettings, clubs, type Alert, type AlertLevel, type Club } from '../db/schema.js';
import { newId } from '../lib/util.js';

export type { AlertLevel };

export interface AlertInput {
  clubId: string;
  level: AlertLevel;
  kind: string;
  conversationId?: string;
  bookingId?: string;
  text: { en: string; th: string };
}

/**
 * Sends one text to the club's staff LINE group. Wired once per app in `createApp` to `outbox.toStaff`.
 * Throws when the club's LINE channel is unavailable; `raiseAlert` catches it.
 */
export type StaffAlertSender = (club: Club, text: string) => Promise<void>;

/** Keyed by database so several apps in one process (tests) each keep their own sender. */
const senders = new WeakMap<Db, StaffAlertSender>();

/** Called once in `createApp`. */
export function registerStaffAlertSender(db: Db, sender: StaffAlertSender): void {
  senders.set(db, sender);
}

const LEVEL_LABEL: Record<AlertLevel, { en: string; th: string }> = {
  urgent: { en: 'URGENT', th: 'ด่วน' },
  needs_input: { en: 'Needs input', th: 'รอข้อมูล' },
  info: { en: 'Info', th: 'แจ้งเพื่อทราบ' },
};

/** The staff-group text: Thai first, then English (staff groups are mixed). */
export function alertLineText(level: AlertLevel, text: { en: string; th: string }): string {
  const l = LEVEL_LABEL[level];
  return `[${l.th}] ${text.th}\n[${l.en}] ${text.en}`;
}

export async function infoToLine(db: Db, clubId: string): Promise<boolean> {
  const [row] = await db.select().from(clubAlertSettings).where(eq(clubAlertSettings.clubId, clubId));
  return row?.infoToLine ?? false;
}

export async function setInfoToLine(db: Db, clubId: string, on: boolean, updatedBy: string | null, now: Date): Promise<void> {
  await db
    .insert(clubAlertSettings)
    .values({ clubId, infoToLine: on, updatedBy, updatedAt: now })
    .onConflictDoUpdate({ target: clubAlertSettings.clubId, set: { infoToLine: on, updatedBy, updatedAt: now } });
}

/**
 * Records an alert for the dashboard feed (spec §6.4) and, for `urgent` (or `info` when the club
 * switched LINE on), sends it to the staff LINE group through the sender `createApp` wired.
 * Needs-input alerts never go to the group. A failed send is logged by the outbox, never thrown.
 */
export async function raiseAlert(db: Db, input: AlertInput, now: Date): Promise<void> {
  const id = newId();
  await db.insert(alerts).values({
    id,
    clubId: input.clubId,
    level: input.level,
    kind: input.kind,
    conversationId: input.conversationId ?? null,
    bookingId: input.bookingId ?? null,
    textEn: input.text.en,
    textTh: input.text.th,
    createdAt: now,
  });
  const toLine = input.level === 'urgent' || (input.level === 'info' && (await infoToLine(db, input.clubId)));
  const sender = senders.get(db);
  if (!toLine || !sender) return;
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, input.clubId) });
  if (!club) return;
  try {
    await sender(club, alertLineText(input.level, input.text));
  } catch {
    // The sender recorded and logged the failure; the alert stays in the feed with no sent_line_at.
    return;
  }
  await db.update(alerts).set({ sentLineAt: now }).where(eq(alerts.id, id));
}

/** The newest unresolved alert of `kind` for the club, if any (timed checks use it to avoid repeats). */
export async function openAlert(db: Db, clubId: string, kind: string): Promise<Alert | undefined> {
  const [row] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.clubId, clubId), eq(alerts.kind, kind), isNull(alerts.resolvedAt)))
    .orderBy(desc(alerts.createdAt))
    .limit(1);
  return row;
}

/** Resolves one alert of the club; `undefined` when the id is not the club's. */
export async function resolveAlert(db: Db, clubId: string, id: string, now: Date): Promise<Alert | undefined> {
  const [row] = await db.select().from(alerts).where(and(eq(alerts.clubId, clubId), eq(alerts.id, id)));
  if (!row || row.resolvedAt) return row;
  const [updated] = await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(and(eq(alerts.clubId, clubId), eq(alerts.id, id)))
    .returning();
  return updated;
}

/** Resolves every open alert of `kind` for the club (a timed condition that has cleared). */
export async function resolveOpenAlerts(db: Db, clubId: string, kind: string, now: Date): Promise<void> {
  await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(and(eq(alerts.clubId, clubId), eq(alerts.kind, kind), isNull(alerts.resolvedAt)));
}

export async function listAlerts(db: Db, clubId: string, limit = 50): Promise<Alert[]> {
  return db.select().from(alerts).where(eq(alerts.clubId, clubId)).orderBy(desc(alerts.createdAt)).limit(limit);
}

/** Open alerts per level, for the dashboard counter. */
export async function openAlertCounts(db: Db, clubId: string): Promise<Record<AlertLevel, number>> {
  const rows = await db
    .select({ level: alerts.level, n: sql<number>`count(*)::int` })
    .from(alerts)
    .where(and(eq(alerts.clubId, clubId), isNull(alerts.resolvedAt)))
    .groupBy(alerts.level);
  const out: Record<AlertLevel, number> = { urgent: 0, needs_input: 0, info: 0 };
  for (const r of rows) out[r.level] = r.n;
  return out;
}
