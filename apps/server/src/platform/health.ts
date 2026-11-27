import { and, desc, eq, gte, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations, deposits, messages, opsEvents, type Club } from '../db/schema.js';
import type { SetupReport } from '../line/setup.js';

/** `ops_events.detail` of a `kind = 'line_setup'` row (plan A5). */
export type LineSetupDetail = { report: SetupReport; quota: { used: number; limit: number } | null };

export type QuotaView = { limit: number; used: number; pct: number; warn: boolean };

/** Quota warning threshold (spec §11.1.4). `limit` 0 means no limit. */
export const QUOTA_WARN_PCT = 80;

export function quotaView(q: { used: number; limit: number } | null | undefined): QuotaView | null {
  if (!q) return null;
  const pct = q.limit > 0 ? Math.round((q.used / q.limit) * 1000) / 10 : 0;
  return { limit: q.limit, used: q.used, pct, warn: q.limit > 0 && pct >= QUOTA_WARN_PCT };
}

export interface ClubHealth {
  slug: string;
  name: string;
  status: Club['status'];
  /** False when the club has no line_setup row yet. */
  lineConnected: boolean;
  webhookOk: boolean;
  lineCheckedAt: string | null;
  lastInboundAt: string | null;
  failures24h: number;
  quota: QuotaView | null;
  handoffsPastTimeout: number;
  depositsInReview: number;
  staffGroupLinked: boolean;
  botPaused: boolean;
}

const stepOk = (report: SetupReport | undefined, name: string) => Boolean(report?.steps.find((s) => s.name === name)?.ok);

/** The console's health tile for one club (spec §12.3 Clubs). LINE and quota come from the newest line_setup row. */
export async function clubHealth(db: Db, club: Club, now: Date): Promise<ClubHealth> {
  const [setup] = await db
    .select()
    .from(opsEvents)
    .where(and(eq(opsEvents.clubId, club.id), eq(opsEvents.kind, 'line_setup')))
    .orderBy(desc(opsEvents.at))
    .limit(1);
  const detail = setup?.detail as LineSetupDetail | undefined;
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const [inbound] = await db
    .select({ at: sql<Date | string | null>`max(${messages.createdAt})` })
    .from(messages)
    .where(and(eq(messages.clubId, club.id), eq(messages.direction, 'in')));
  const [failures] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opsEvents)
    .where(and(eq(opsEvents.clubId, club.id), ne(opsEvents.kind, 'line_setup'), gte(opsEvents.at, dayAgo)));
  const timeoutAt = new Date(now.getTime() - club.settings.handoffTimeoutMinutes * 60_000);
  const [handoffs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conversations)
    .where(
      and(
        eq(conversations.clubId, club.id),
        eq(conversations.mode, 'human'),
        isNotNull(conversations.handoffRequestedAt),
        lt(conversations.handoffRequestedAt, timeoutAt),
      ),
    );
  const [review] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deposits)
    .where(and(eq(deposits.clubId, club.id), eq(deposits.status, 'review')));
  const lastInbound = inbound?.at ? new Date(inbound.at) : null;
  return {
    slug: club.slug,
    name: club.name,
    status: club.status,
    lineConnected: stepOk(detail?.report, 'LINE credentials'),
    webhookOk: stepOk(detail?.report, 'Webhook'),
    lineCheckedAt: setup ? setup.at.toISOString() : null,
    lastInboundAt: lastInbound ? lastInbound.toISOString() : null,
    failures24h: failures?.n ?? 0,
    quota: quotaView(detail?.quota),
    handoffsPastTimeout: handoffs?.n ?? 0,
    depositsInReview: review?.n ?? 0,
    staffGroupLinked: Boolean(club.staffGroupId),
    botPaused: club.botPaused,
  };
}
