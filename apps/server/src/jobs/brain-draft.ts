import type { LearnClient } from '../brain/learn.js';
import { runLearning, type LearnRunResult } from '../brain/learn.js';
import type { Db } from '../db/client.js';

/**
 * The `brain-draft` job (plan B18, spec §8.3): every minute, every newly ended takeover goes
 * through the learning loop in one batch, so a draft is in the approval queue within 60 seconds of
 * the takeover being resolved. The same run expires takeover drafts unreviewed for 4 weeks.
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
  return res;
}
