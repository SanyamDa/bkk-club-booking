/**
 * npm run eval:brain -w @club/server -- --model claude-haiku-5-5 [--limit 10] [--no-db]
 *
 * Runs the Thai-100 set (`src/brain/eval/thai-100.jsonl`, plan B17, spec §8.6) against the given
 * model with the live bot's instructions and tools, judged by `claude-sonnet-5-5`. Writes
 * `src/brain/eval/results/<model>.json` and, unless --no-db, records the result in
 * `platform_flags['brain-eval:thai-100:<model>']` so it is on record before the live model is chosen.
 *
 * Calls Anthropic for real: needs ANTHROPIC_API_KEY. Tests never run this script.
 * Stop the dev server first when using the embedded database: PGlite allows one process at a time.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AI_PRIMARY_MODEL, anthropicModelClient } from '../brain/answer.js';
import { anthropicJudgeClient } from '../brain/judge.js';
import { loadThai100, recordModelEval, runThai100, thaiEvalDecision } from '../brain/testset.js';

async function main() {
  const dotenv = await import('dotenv');
  dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { model: { type: 'string' }, limit: { type: 'string' }, 'no-db': { type: 'boolean' } },
    strict: true,
  });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const model = values.model ?? AI_PRIMARY_MODEL;
  const all = loadThai100();
  const cases = values.limit ? all.slice(0, Number(values.limit)) : all;

  console.log(`Thai-100: ${cases.length} cases, model ${model}, judge claude-sonnet-5-5`);
  const result = await runThai100({ client: anthropicModelClient(key), judge: anthropicJudgeClient(key), model, cases });
  const now = new Date();

  const dir = fileURLToPath(new URL('../brain/eval/results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${model}.json`;
  writeFileSync(file, JSON.stringify({ ranAt: now.toISOString(), setReviewed: false, ...result }, null, 2) + '\n');

  console.log(`Score ${(result.score * 100).toFixed(1)}% (${result.passed}/${result.total}); tricks ${result.tricksPassed ? 'all passed' : 'FAILED'}`);
  for (const [lang, b] of Object.entries(result.byLang)) console.log(`  ${lang}: ${b.passed}/${b.total}`);
  for (const c of result.cases.filter((x) => !x.pass)) console.log(`  FAIL ${c.id} (${c.kind}, ${c.outcome}): ${c.reason ?? ''}`);
  console.log(`Result written to ${file}`);

  if (!values['no-db']) {
    const { openDb } = await import('../db/client.js');
    const handle = await openDb({ url: process.env.DATABASE_URL || undefined, dataDir: process.env.DATA_DIR || '.data' });
    try {
      await recordModelEval(handle.db, result, now);
      console.log(`Recorded in platform_flags brain-eval:thai-100:${model}`);
    } finally {
      await handle.close();
    }
  }
  if (cases.length < all.length) console.log('Partial run (--limit): do not use it to choose the live model.');
  const decision = thaiEvalDecision({ model, pass: result.pass, score: result.score });
  console.log(`Live model: ${decision.liveModel} (${decision.reason}). The set still needs a native Thai speaker's review.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
