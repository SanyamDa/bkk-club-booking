import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { latestSnapshot } from '../brain/compile.js';
import type { JudgeClient, JudgeItem } from '../brain/judge.js';
import { JUDGE_MODEL } from '../brain/judge.js';
import { TESTSET_PASS_SCORE } from '../brain/testset.js';
import type { Db } from '../db/client.js';
import { brainTestRuns, clubs, events, platformFlags, type BrainTestRun, type Club } from '../db/schema.js';
import { bangkokParts, toDateString } from '../lib/time.js';
import { newId } from '../lib/util.js';
import { raiseAlert } from '../platform/alerts.js';

/**
 * Sampled quality review (spec §8.5, §8.6, plan B17). Once per club per Bangkok day, from 12:00,
 * up to `SAMPLE_SIZE` of yesterday's AI answers (`ai.answered`, 00:00-24:00 Bangkok) go to `claude-sonnet-5-5`
 * in batch mode, judged against the club's compiled brain. The batch is a `sample_review` row in
 * `brain_test_runs` (pending, `results.batchId`) until a later pass collects it and records the
 * score. Under `TESTSET_PASS_SCORE` raises a `needs_input` alert `ai_quality_review`.
 * A live club's sample leaves out test rows; the demo club's sample is its own test rows.
 */

export const SAMPLE_SIZE = 20;
const START_HOUR = 12;
const DAY = 24 * 3_600_000;

export const sampleReviewKey = (clubId: string, date: string) => `brain-sample-review:${clubId}:${date}`;

interface Answered {
  question?: unknown;
  answer?: unknown;
}

/** 00:00 Bangkok of a `YYYY-MM-DD` date, as an instant (Bangkok is UTC+7 all year). */
const bangkokMidnight = (date: string) => new Date(`${date}T00:00:00+07:00`);

/**
 * Submits the day's sample for one club (claimed once per day): yesterday's Bangkok day,
 * 00:00 to 24:00. A failed submit gives the claim back, so a later pass retries. Returns the run, or null.
 */
async function submitClubSample(db: Db, judge: JudgeClient, club: Club, date: string, now: Date): Promise<BrainTestRun | null> {
  const key = sampleReviewKey(club.id, date);
  const claimed = await db
    .insert(platformFlags)
    .values({ key, value: { at: now.toISOString() }, updatedBy: 'system', updatedAt: now })
    .onConflictDoNothing()
    .returning();
  if (claimed.length === 0) return null;
  const dayEnd = bangkokMidnight(date);
  const dayStart = new Date(dayEnd.getTime() - DAY);
  const conds = [eq(events.clubId, club.id), eq(events.type, 'ai.answered'), gte(events.occurredAt, dayStart), lt(events.occurredAt, dayEnd)];
  if (club.status !== 'demo') conds.push(eq(events.isTest, false));
  const rows = await db.select({ id: events.id, raw: events.raw, lang: events.lang }).from(events).where(and(...conds)).orderBy(desc(events.occurredAt)).limit(SAMPLE_SIZE);
  const snapshot = await latestSnapshot(db, club.id);
  const items: JudgeItem[] = [];
  for (const r of rows) {
    const raw = (r.raw ?? {}) as Answered;
    if (typeof raw.question !== 'string' || typeof raw.answer !== 'string') continue;
    items.push({ id: r.id, question: raw.question, answer: raw.answer, reference: null, brain: snapshot?.compiledText ?? '', lang: r.lang ?? 'th' });
  }
  if (items.length === 0) return null;
  let batchId: string;
  try {
    batchId = await judge.submitBatch(items);
  } catch (err) {
    await db.delete(platformFlags).where(eq(platformFlags.key, key));
    throw err;
  }
  const [run] = await db
    .insert(brainTestRuns)
    .values({
      id: newId(),
      clubId: club.id,
      trigger: 'sample_review',
      snapshotVersion: snapshot?.version ?? null,
      model: JUDGE_MODEL,
      total: items.length,
      results: { batchId, date, eventIds: items.map((i) => i.id) },
      createdAt: now,
    })
    .returning();
  return run!;
}

/** Collects one submitted batch. True when it was finished and recorded. */
async function collectRun(db: Db, judge: JudgeClient, run: BrainTestRun, now: Date): Promise<boolean> {
  const results = run.results as { batchId?: string; date?: string; eventIds?: string[] };
  if (!results.batchId) return false;
  const verdicts = await judge.collectBatch(results.batchId);
  if (!verdicts) return false;
  const passed = verdicts.filter((v) => v.pass).length;
  const total = verdicts.length;
  const score = total ? passed / total : 1;
  const ok = score >= TESTSET_PASS_SCORE;
  await db
    .update(brainTestRuns)
    .set({
      status: ok ? 'passed' : 'failed',
      total,
      passed,
      score,
      results: { ...results, verdicts: verdicts.map((v) => ({ eventId: v.id, pass: v.pass, score: v.score, reason: v.reason.slice(0, 300) })) },
      finishedAt: now,
    })
    .where(eq(brainTestRuns.id, run.id));
  if (!ok) {
    const pct = Math.round(score * 100);
    await raiseAlert(
      db,
      {
        clubId: run.clubId,
        level: 'needs_input',
        kind: 'ai_quality_review',
        text: {
          en: `Daily AI answer review: ${passed} of ${total} sampled answers passed (${pct}%). Check the failed answers and the notes they used.`,
          th: `ตรวจคำตอบบอทประจำวัน: ผ่าน ${passed} จาก ${total} คำตอบที่สุ่ม (${pct}%) กรุณาตรวจคำตอบที่ไม่ผ่านและโน้ตที่ใช้`,
        },
      },
      now,
    );
  }
  return true;
}

/**
 * Job body (`brain-sample-review`): collects submitted batches, then from 12:00 Bangkok submits
 * each live or demo club's daily sample. No judge client: does nothing.
 */
export async function runSampleReview(
  db: Db,
  judge: JudgeClient | null,
  now: Date,
  log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err),
): Promise<void> {
  if (!judge) return;
  const pending = await db.select().from(brainTestRuns).where(and(eq(brainTestRuns.trigger, 'sample_review'), eq(brainTestRuns.status, 'pending')));
  for (const run of pending) {
    try {
      await collectRun(db, judge, run, now);
    } catch (err) {
      log(`sample review ${run.id} not collected`, err);
    }
  }

  const p = bangkokParts(now);
  if (p.hour < START_HOUR) return;
  const date = toDateString(p.year, p.month, p.day);
  const clubRows = await db.select().from(clubs).where(inArray(clubs.status, ['live', 'demo']));
  // One club's failure (a judge outage) does not hold up the others.
  for (const club of clubRows) {
    try {
      const run = await submitClubSample(db, judge, club, date, now);
      if (run) await collectRun(db, judge, run, now);
    } catch (err) {
      log(`sample review for club ${club.id} failed; retried next pass`, err);
    }
  }
}
