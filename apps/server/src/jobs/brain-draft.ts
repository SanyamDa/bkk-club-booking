import { and, count, eq, gte, inArray, max } from 'drizzle-orm';
import { GAP_WINDOW_DAYS, listGaps } from '../brain/gaps.js';
import type { LearnClient } from '../brain/learn.js';
import { runLearning, type LearnRunResult } from '../brain/learn.js';
import { alertBrainWaiting } from '../bot/alerts.js';
import type { Db } from '../db/client.js';
import { alerts, brainNotes, clubs, events } from '../db/schema.js';

/**
 * The `brain-draft` job (plan B18, spec §8.3): every minute, every newly ended takeover goes
 * through the learning loop in one batch, so a draft is in the approval queue within 60 seconds of
 * the takeover being resolved. The same run expires takeover drafts unreviewed for 4 weeks.
 * B19b: a club that got a new draft gets one needs-input `brain_draft_waiting` alert (one open per
 * club; `alertBrainWaiting` skips while one is open). The same run raises needs-input `gap_waiting`
 * (spec §6.4 "a gap is waiting for a written answer") for a club with unanswered gaps (§6.6:
 * `faq.missed` in the last 30 days with no live note closing it), at most once per new miss.
 */
export const BRAIN_DRAFT_EVERY_MS = 60_000;

export async function runBrainDraft(
  deps: { db: Db; learn?: LearnClient | null; log: (msg: string, err?: unknown) => void },
  now: Date,
): Promise<LearnRunResult> {
  const res = await runLearning({ db: deps.db, client: deps.learn ?? null, log: deps.log }, now);
  const drafted = res.episodes.filter((e) => e.outcome === 'drafted').length;
  if (res.episodes.length || res.expired) {
    deps.log(`brain-draft: ${res.episodes.length} episodes, ${drafted} drafted, ${res.expired} drafts expired`);
  }
  await alertDraftsWaiting(deps.db, res, now);
  await alertGapsWaiting(deps.db, now);
  return res;
}

/** One `brain_draft_waiting` alert per club that got a draft this run, with the club's waiting count. */
async function alertDraftsWaiting(db: Db, res: LearnRunResult, now: Date): Promise<void> {
  const noteIds = res.episodes.flatMap((e) => (e.outcome === 'drafted' && e.noteId ? [e.noteId] : []));
  if (!noteIds.length) return;
  const clubIds = [
    ...new Set((await db.select({ clubId: brainNotes.clubId }).from(brainNotes).where(inArray(brainNotes.id, noteIds))).map((r) => r.clubId)),
  ];
  const waiting = await db
    .select({ clubId: brainNotes.clubId, n: count() })
    .from(brainNotes)
    .where(and(inArray(brainNotes.clubId, clubIds), eq(brainNotes.status, 'draft')))
    .groupBy(brainNotes.clubId);
  for (const w of waiting) await alertBrainWaiting(db, { clubId: w.clubId, kind: 'brain_draft_waiting', count: Number(w.n) }, now);
}

/**
 * Unanswered gaps a club needs before `gap_waiting` is raised. The plan sets no count above one,
 * so any gap in the B19 gaps list (asked at least once in 30 days, not closed by a live note) counts.
 */
export const GAP_WAITING_MIN_GAPS = 1;

/**
 * One `gap_waiting` alert per club with unanswered gaps. A club is looked at only when it has a
 * `faq.missed` newer than its last `gap_waiting` alert (open or resolved), so a resolved alert is
 * raised again only after a new miss, never every minute.
 */
async function alertGapsWaiting(db: Db, now: Date): Promise<void> {
  const since = new Date(now.getTime() - GAP_WINDOW_DAYS * 86_400_000);
  const missed = await db
    .select({ clubId: events.clubId, lastMiss: max(events.occurredAt) })
    .from(events)
    .where(and(eq(events.type, 'faq.missed'), gte(events.occurredAt, since)))
    .groupBy(events.clubId);
  for (const m of missed) {
    if (!m.clubId || !m.lastMiss) continue;
    const [last] = await db
      .select({ at: max(alerts.createdAt) })
      .from(alerts)
      .where(and(eq(alerts.clubId, m.clubId), eq(alerts.kind, 'gap_waiting')));
    if (last?.at && last.at >= m.lastMiss) continue;
    const club = await db.query.clubs.findFirst({ where: eq(clubs.id, m.clubId) });
    if (!club) continue;
    const gaps = await listGaps(db, club, now);
    if (gaps.length < GAP_WAITING_MIN_GAPS) continue;
    await alertBrainWaiting(db, { clubId: club.id, kind: 'gap_waiting', count: gaps.length }, now);
  }
}
