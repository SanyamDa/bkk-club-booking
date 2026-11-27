import { and, count, eq, inArray } from 'drizzle-orm';
import type { LearnClient } from '../brain/learn.js';
import { runLearning, type LearnRunResult } from '../brain/learn.js';
import { alertBrainWaiting } from '../bot/alerts.js';
import type { Db } from '../db/client.js';
import { brainNotes } from '../db/schema.js';

/**
 * The `brain-draft` job (plan B18, spec §8.3): every minute, every newly ended takeover goes
 * through the learning loop in one batch, so a draft is in the approval queue within 60 seconds of
 * the takeover being resolved. The same run expires takeover drafts unreviewed for 4 weeks.
 * B19b: a club that got a new draft gets one needs-input `brain_draft_waiting` alert (one open per
 * club; `alertBrainWaiting` skips while one is open).
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
