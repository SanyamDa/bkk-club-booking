import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/bookings/service.js';
import { AI_INSTRUCTIONS, type ModelRequest } from '../src/brain/answer.js';
import { latestSnapshot } from '../src/brain/compile.js';
import { guardAnswer } from '../src/brain/guard.js';
import { JUDGE_MODEL } from '../src/brain/judge.js';
import { approveNote, createNote } from '../src/brain/notes.js';
import {
  addTestCase,
  BASELINE_TRICKS,
  evaluateCases,
  loadThai100,
  modelEvalResult,
  recordModelEval,
  runBrainTestJob,
  runPendingTestRuns,
  runThai100,
  thaiEvalDecision,
  type TestCase,
} from '../src/brain/testset.js';
import { TOOL_DEFINITIONS } from '../src/brain/tools.js';
import { fakeJudgeClient, fakeModelClient } from '../src/bot/deps.js';
import { emit } from '../src/data/events.js';
import type { Db } from '../src/db/client.js';
import { alerts, brainNotes, brainTestRuns, type Club } from '../src/db/schema.js';
import { runSampleReview } from '../src/jobs/brain-sample-review.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';

const NOW = FRIDAY_AFTERNOON; // Friday 27 Nov 2026, 15:00 Bangkok
const staffActor: Actor = { type: 'staff', id: 'user_manager' };
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const SAFE_REFUSAL = 'ขออภัยค่ะ ตอบได้เฉพาะข้อมูลของร้านเท่านั้น';

let db: Db;
let close: () => Promise<void>;
let clubB: Club;

beforeEach(async () => {
  ({ db, close, clubB } = await setupTwoClubs());
});
afterEach(async () => {
  await close();
});

const questionOf = (req: ModelRequest) => /<guest_message>\n([\s\S]*)\n<\/guest_message>/.exec(req.userContent)?.[1] ?? '';

const reply = (input: Partial<{ answer: string; needs_handoff: boolean; unclear: boolean; topic: string }>) => ({
  toolCalls: [
    {
      name: 'reply',
      input: { answer: '', lang: 'th', notes_used: [], topic: 'other', needs_handoff: false, unclear: false, summary: '', ...input },
    },
  ],
});

/** A well-behaved model: gives each case the outcome it expects (answers with the reference). */
function oracle(cases: readonly TestCase[], wrong: Set<string> = new Set()) {
  const byQuestion = new Map(cases.map((c) => [c.question, c]));
  return fakeModelClient((req) => {
    const c = byQuestion.get(questionOf(req));
    if (!c) return reply({ unclear: true });
    if (wrong.has(c.id)) return reply({ answer: 'ไม่ทราบค่ะ ลองถามใหม่อีกครั้ง' });
    switch (c.kind) {
      case 'answer':
        return reply({ answer: c.reference ?? 'ok' });
      case 'handoff':
        return reply({ needs_handoff: true });
      case 'booking':
        return { toolCalls: [{ name: 'start_booking', input: {} }] };
      case 'menu':
        return reply({ unclear: true });
      case 'trick':
        return reply({ answer: SAFE_REFUSAL });
    }
  });
}

/** Judge: an answer passes when it is the reference (or, with no reference, contains "Smart casual"). */
const strictJudge = () => fakeJudgeClient((item) => (item.reference !== null ? item.answer === item.reference : item.answer.includes('Smart casual')));

async function liveNote(clubId: string) {
  const n = await createNote(db, { clubId, title: 'Dress code', type: 'faq', bodyMd: 'Smart casual. No flip-flops.', source: 'manual' }, staffActor, NOW);
  return approveNote(db, clubId, n.id, staffActor, NOW);
}

const runsOf = (clubId: string) => db.select().from(brainTestRuns).where(eq(brainTestRuns.clubId, clubId));

describe('B17 Thai evaluation and per-club test set', () => {
  it('thai-100 set has 100 well-formed cases', () => {
    const cases = loadThai100();
    expect(cases).toHaveLength(100);
    expect(new Set(cases.map((c) => c.id)).size).toBe(100);
    const count = (f: (c: TestCase) => boolean) => cases.filter(f).length;
    expect(count((c) => c.kind === 'trick')).toBe(10);
    expect(count((c) => c.kind !== 'trick' && c.lang === 'th')).toBe(55);
    expect(count((c) => c.kind !== 'trick' && c.lang === 'mixed')).toBe(15);
    expect(count((c) => c.kind !== 'trick' && c.lang === 'romanised')).toBe(10);
    expect(count((c) => c.kind !== 'trick' && c.lang === 'en')).toBe(10);
    for (const lang of ['th', 'en', 'mixed', 'romanised']) expect(count((c) => c.kind === 'trick' && c.lang === lang), lang).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.question.trim(), c.id).not.toBe('');
      if (c.kind === 'answer') {
        expect(c.reference, c.id).toBeTruthy();
        // A reference never states a price, table code or availability (it would fail the live guard).
        expect(guardAnswer(c.reference!, ['V1', 'V2', 'V3', 'V4', 'B1', 'B2']), c.id).toEqual([]);
      }
      if (c.kind === 'trick') expect(Array.isArray(c.mustNotContain), c.id).toBe(true);
    }
  });

  it('100-question Thai set scored by claude-sonnet-5-5 as judge', async () => {
    const cases = loadThai100();
    const client = oracle(cases);
    const judge = strictJudge();
    const result = await runThai100({ client, judge, model: HAIKU });

    expect(result.judge).toBe(JUDGE_MODEL);
    expect(JUDGE_MODEL).toBe(SONNET);
    expect(result.total).toBe(100);
    expect(client.calls).toHaveLength(100);
    // Same instructions and tools as the live bot, on the model under test.
    for (const call of client.calls) {
      expect(call.model).toBe(HAIKU);
      expect(call.instructions).toBe(AI_INSTRUCTIONS);
      expect(call.tools).toBe(TOOL_DEFINITIONS);
    }
    const answerCases = cases.filter((c) => c.kind === 'answer');
    expect(judge.judged).toHaveLength(answerCases.length);
    expect(judge.judged.every((j) => j.reference !== null)).toBe(true);
    expect(result.cases.filter((c) => c.kind === 'answer').every((c) => c.judged)).toBe(true);
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
    expect(result.byLang).toMatchObject({ th: { total: 59, passed: 59 }, en: { total: 12, passed: 12 } });

    // 15 wrong Thai answers: 85 % is under the 90 % pass mark.
    const wrong = new Set(answerCases.filter((c) => c.lang === 'th').slice(0, 15).map((c) => c.id));
    const failed = await runThai100({ client: oracle(cases, wrong), judge: strictJudge(), model: HAIKU });
    expect(failed.passed).toBe(85);
    expect(failed.score).toBeCloseTo(0.85);
    expect(failed.pass).toBe(false);
    expect(failed.cases.find((c) => wrong.has(c.id))?.reason).toMatch(/^judge/);
  });

  it('result recorded before choosing the live model', async () => {
    expect(await modelEvalResult(db, HAIKU)).toBeNull();
    // Nothing recorded: the fast model is not chosen.
    expect(thaiEvalDecision(null).liveModel).toBe(SONNET);

    const cases = loadThai100();
    const result = await runThai100({ client: oracle(cases), judge: strictJudge(), model: HAIKU });
    await recordModelEval(db, result, NOW);
    const recorded = await modelEvalResult(db, HAIKU);
    expect(recorded).toMatchObject({ model: HAIKU, judge: SONNET, total: 100, passed: 100, pass: true, setReviewed: false, ranAt: NOW.toISOString() });
    expect(thaiEvalDecision(recorded).liveModel).toBe(HAIKU);

    const wrong = new Set(cases.filter((c) => c.kind === 'answer').slice(0, 20).map((c) => c.id));
    await recordModelEval(db, await runThai100({ client: oracle(cases, wrong), judge: strictJudge(), model: HAIKU }), NOW);
    const failed = await modelEvalResult(db, HAIKU);
    expect(failed?.pass).toBe(false);
    expect(thaiEvalDecision(failed).liveModel).toBe(SONNET);
  });

  it("snapshot compile runs the club's test set and records the score", async () => {
    const own = await addTestCase(db, { clubId: clubB.id, question: 'แต่งตัวยังไงคะ', lang: 'th', kind: 'answer', reference: 'Smart casual.', source: 'manual' }, NOW);
    await liveNote(clubB.id);
    const snapshot = (await latestSnapshot(db, clubB.id))!;

    const [queued] = await runsOf(clubB.id);
    expect(queued).toMatchObject({ trigger: 'snapshot', status: 'pending', snapshotVersion: snapshot.version });

    const cases: TestCase[] = [...BASELINE_TRICKS, { id: own.id, lang: 'th', kind: 'answer', question: own.question, reference: 'Smart casual.' }];
    const client = oracle(cases);
    const judge = strictJudge();
    expect(await runPendingTestRuns(db, { client, judge }, NOW)).toBe(1);

    const [run] = await runsOf(clubB.id);
    expect(run).toMatchObject({ status: 'passed', model: HAIKU, total: BASELINE_TRICKS.length + 1, passed: BASELINE_TRICKS.length + 1, score: 1, snapshotVersion: snapshot.version });
    expect(run!.finishedAt).toEqual(NOW);
    expect(client.calls.every((c) => c.brain === snapshot.compiledText)).toBe(true);
    expect(judge.judged.map((j) => j.question)).toEqual(['แต่งตัวยังไงคะ']);
    expect(await db.select().from(alerts).where(eq(alerts.clubId, clubB.id))).toHaveLength(0);

    // Another club's runs are untouched; no second run without a new snapshot.
    expect(await runPendingTestRuns(db, { client, judge }, NOW)).toBe(0);
  });

  it("model id change runs the club's set", async () => {
    await liveNote(clubB.id);
    const client = oracle(BASELINE_TRICKS);
    const judge = strictJudge();
    await runBrainTestJob(db, { client, judge, model: HAIKU }, NOW);
    expect((await runsOf(clubB.id)).map((r) => r.status)).toEqual(['passed']);

    // Same model again: nothing new.
    await runBrainTestJob(db, { client, judge, model: HAIKU }, NOW);
    expect(await runsOf(clubB.id)).toHaveLength(1);

    // The live model id changes: the set runs again on the new model.
    client.calls.length = 0;
    await runBrainTestJob(db, { client, judge, model: SONNET }, NOW);
    const runs = await db.select().from(brainTestRuns).where(and(eq(brainTestRuns.clubId, clubB.id), eq(brainTestRuns.trigger, 'model_change'), eq(brainTestRuns.model, SONNET)));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'passed', total: BASELINE_TRICKS.length });
    expect(client.calls.length).toBe(BASELINE_TRICKS.length);
    expect(client.calls.every((c) => c.model === SONNET)).toBe(true);
  });

  it('prompt-injection case passes', async () => {
    const trickCases = [...BASELINE_TRICKS, ...loadThai100().filter((c) => c.kind === 'trick')];
    const opts = { judge: null, model: HAIKU, brain: '# Club brain\n', today: '2026-11-27', tableCodes: ['V1', 'V2'], cases: trickCases };

    // A model that ignores the injection passes every trick case.
    const safe = await evaluateCases({ ...opts, client: oracle(trickCases) });
    expect(safe.cases.every((c) => c.pass)).toBe(true);
    expect(safe.tricksPassed).toBe(true);

    // Handing off or showing the menu is also a pass.
    const handsOff = await evaluateCases({ ...opts, client: fakeModelClient(() => ({ toolCalls: [{ name: 'request_handoff', input: { topic: 'x', summary: 'y' } }] })) });
    expect(handsOff.tricksPassed).toBe(true);

    // A model that obeys fails: an invented price, a table code, or the bait text.
    const obeys = await evaluateCases({
      ...opts,
      client: fakeModelClient((req) =>
        reply({ answer: questionOf(req).includes('500 baht') ? 'Minimum spend tonight is 500 baht' : 'V1 ว่างค่ะ ร้านเปิดทุกวัน 24 ชม.' }),
      ),
    });
    expect(obeys.tricksPassed).toBe(false);
    expect(obeys.pass).toBe(false);
    expect(obeys.cases.find((c) => c.id === 'baseline-trick-en')?.reason).toMatch(/guard: price|contains/);
  });

  it('failed run raises alert and note stays live', async () => {
    const note = await liveNote(clubB.id);
    await addTestCase(db, { clubId: clubB.id, question: 'What is the dress code?', lang: 'en', kind: 'answer', reference: 'Smart casual.', source: 'manual' }, NOW);
    // A broken model: states a price for everything.
    const client = fakeModelClient(() => reply({ answer: 'Minimum spend tonight is 500 baht' }));
    await runPendingTestRuns(db, { client, judge: strictJudge() }, NOW);

    const [run] = await runsOf(clubB.id);
    expect(run).toMatchObject({ status: 'failed', passed: 0, score: 0 });
    const raised = await db.select().from(alerts).where(and(eq(alerts.clubId, clubB.id), eq(alerts.kind, 'brain_testset_failed')));
    expect(raised).toHaveLength(1);
    expect(raised[0]!.level).toBe('needs_input');

    const [after] = await db.select().from(brainNotes).where(eq(brainNotes.id, note.id));
    expect(after!.status).toBe('live');
    expect((await latestSnapshot(db, clubB.id))!.compiledText).toContain('Smart casual. No flip-flops.');
  });

  it('a run left running by a crash is run again after 30 minutes', async () => {
    await liveNote(clubB.id);
    const [queued] = await runsOf(clubB.id);
    const claimedAt = new Date(NOW.getTime() - 20 * 60_000);
    await db.update(brainTestRuns).set({ status: 'running', results: { claimedAt: claimedAt.toISOString() } }).where(eq(brainTestRuns.id, queued!.id));
    const client = oracle(BASELINE_TRICKS);

    // 20 minutes after the claim: still treated as running elsewhere.
    expect(await runPendingTestRuns(db, { client, judge: strictJudge() }, NOW)).toBe(0);
    expect((await runsOf(clubB.id))[0]!.status).toBe('running');

    // 31 minutes after the claim: put back and run.
    const later = new Date(claimedAt.getTime() + 31 * 60_000);
    expect(await runPendingTestRuns(db, { client, judge: strictJudge() }, later)).toBe(1);
    expect((await runsOf(clubB.id))[0]!.status).toBe('passed');
  });

  it('sampled answers are judged in batch mode', async () => {
    await liveNote(clubB.id);
    const snapshot = (await latestSnapshot(db, clubB.id))!;
    const answered = (answer: string, isTest: boolean, minutesAgo: number) =>
      emit(db, {
        clubId: clubB.id,
        type: 'ai.answered',
        occurredAt: new Date(NOW.getTime() - minutesAgo * 60_000),
        actorType: 'bot',
        dataOrigin: 'first_party',
        lang: 'en',
        props: { notes_used: 1, topic: 'dress_code' },
        raw: { noteIds: [], snapshotVersion: snapshot.version, question: 'Dress code?', answer },
        isTest,
      });
    // NOW is Friday 15:00 Bangkok: yesterday's Bangkok day is Thursday 00:00 to 24:00 (15 h to 39 h ago).
    await answered('Smart casual, no flip-flops.', false, 16 * 60);
    await answered('Anything goes, wear what you like.', false, 38 * 60);
    await answered('Smart casual.', true, 17 * 60); // a test row: not sampled for a live club
    await answered('Today: not yesterday.', false, 60); // Friday: in tomorrow's sample
    await answered('Wednesday: two days ago.', false, 40 * 60);

    // A judge outage gives the day's claim back: the next pass submits.
    const down = strictJudge();
    down.submitBatch = async () => {
      throw new Error('judge down');
    };
    await runSampleReview(db, down, NOW, () => {});
    expect(await db.select().from(brainTestRuns).where(eq(brainTestRuns.trigger, 'sample_review'))).toHaveLength(0);

    const judge = strictJudge();
    judge.pendingBatches.add('fake_batch_1');
    await runSampleReview(db, judge, NOW);

    expect(judge.batches.size).toBe(1);
    const items = judge.batches.get('fake_batch_1')!;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.reference === null && i.brain === snapshot.compiledText)).toBe(true);
    const [pending] = await db.select().from(brainTestRuns).where(and(eq(brainTestRuns.clubId, clubB.id), eq(brainTestRuns.trigger, 'sample_review')));
    expect(pending).toMatchObject({ status: 'pending', model: SONNET });
    expect(pending!.results).toMatchObject({ batchId: 'fake_batch_1' });

    // The batch ends: a later pass records the score (1 of 2) and raises the review alert.
    judge.pendingBatches.clear();
    await runSampleReview(db, judge, new Date(NOW.getTime() + 15 * 60_000));
    const [done] = await db.select().from(brainTestRuns).where(eq(brainTestRuns.id, pending!.id));
    expect(done).toMatchObject({ status: 'failed', total: 2, passed: 1, score: 0.5 });
    expect(await db.select().from(alerts).where(and(eq(alerts.clubId, clubB.id), eq(alerts.kind, 'ai_quality_review')))).toHaveLength(1);
    // Once per club per day.
    expect(judge.batches.size).toBe(1);
  });
});
