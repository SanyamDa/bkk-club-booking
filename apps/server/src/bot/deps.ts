import { join } from 'node:path';
import { SlipOkVerifier, type SlipVerifier } from '../bookings/slip-verify.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { PaymentGateways } from '../integrations/payments/gateway.js';
import { configuredPaymentGateways } from '../integrations/payments/opn.js';
import { Outbox } from '../line/outbox.js';
import type { BotDeps } from './flow.js';
import { Links } from './links.js';
import { anthropicModelClient, type ModelClient, type ModelReply, type ModelRequest } from '../brain/answer.js';
import { anthropicLearnClient, type CheckRequest, type DraftRequest, type LearnClient } from '../brain/learn.js';
import { anthropicJudgeClient, type JudgeClient, type JudgeItem, type JudgeVerdict } from '../brain/judge.js';

/** Test and caller overrides for the bot's dependencies. B adds each new dependency's fake here. */
export interface BotDepOptions {
  now?: () => Date;
  log?: BotDeps['log'];
  /** B16: the AI model client. `null` turns AI answers off; omitted, built from `ANTHROPIC_API_KEY`. */
  ai?: ModelClient | null;
  /** B9: the slip verifier (tests pass `FakeSlipVerifier`); `null` turns automatic verification off. */
  slipVerifier?: SlipVerifier | null;
  /** A20b: payment gateways by provider (tests pass `fakePaymentGateway`); default: Opn from config. */
  payments?: PaymentGateways;
  /** B18: the note drafter (`claude-opus-5-5`; tests pass `fakeLearnClient`). `null` drafts nothing; omitted, built from `ANTHROPIC_API_KEY`. */
  learn?: LearnClient | null;
  /** B17: the answer judge (`claude-sonnet-5-5`; tests pass `fakeJudgeClient`). `null` judges nothing; omitted, built from `ANTHROPIC_API_KEY`. */
  judge?: JudgeClient | null;
}

const defaultLog: BotDeps['log'] = (msg, err) => (err ? console.error(msg, err) : console.log(msg));

export function buildBotDeps(config: Config, db: Db, opts: BotDepOptions = {}): BotDeps {
  const log = opts.log ?? defaultLog;
  const now = opts.now ?? (() => new Date());
  return {
    db,
    outbox: new Outbox(db, log, now),
    links: new Links(config.PUBLIC_URL, config.APP_SECRET),
    uploadsDir: join(config.DATA_DIR, 'uploads'),
    now,
    log,
    ai: opts.ai !== undefined ? opts.ai : config.ANTHROPIC_API_KEY ? anthropicModelClient(config.ANTHROPIC_API_KEY) : null,
    payments: opts.payments ?? configuredPaymentGateways(config),
    learn: opts.learn !== undefined ? opts.learn : config.ANTHROPIC_API_KEY ? anthropicLearnClient(config.ANTHROPIC_API_KEY) : null,
    judge: opts.judge !== undefined ? opts.judge : config.ANTHROPIC_API_KEY ? anthropicJudgeClient(config.ANTHROPIC_API_KEY) : null,
    slipVerifier:
      opts.slipVerifier !== undefined
        ? opts.slipVerifier
        : config.SLIPOK_API_KEY && config.SLIPOK_BRANCH_ID
          ? new SlipOkVerifier({ apiKey: config.SLIPOK_API_KEY, branchId: config.SLIPOK_BRANCH_ID })
          : null,
  };
}

/**
 * B16 test fake: answers each call with `respond(req)` (a reply, or a thrown error for "API down").
 * Records every request in `calls`. Never reaches Anthropic.
 */
export function fakeModelClient(
  respond: (req: ModelRequest) => Partial<ModelReply> | Promise<Partial<ModelReply>>,
): ModelClient & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async call(req) {
      calls.push(req);
      const r = await respond(req);
      return {
        toolCalls: r.toolCalls ?? [],
        text: r.text ?? '',
        usage: r.usage ?? { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/**
 * B18 test fake: `draft(req)` returns the model's JSON for one takeover (or throws for "API down");
 * `check(req)` the weekly brain check's JSON. Records every request. Never reaches Anthropic.
 */
export function fakeLearnClient(
  draft: (req: DraftRequest) => unknown,
  check: (req: CheckRequest) => unknown = () => ({ issues: [] }),
): LearnClient & { drafts: DraftRequest[]; checks: CheckRequest[] } {
  const drafts: DraftRequest[] = [];
  const checks: CheckRequest[] = [];
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const run = async (id: string, fn: () => unknown) => {
    try {
      return { id, output: await fn(), usage };
    } catch (error) {
      return { id, output: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, error };
    }
  };
  return {
    drafts,
    checks,
    async draft(reqs) {
      drafts.push(...reqs);
      return Promise.all(reqs.map((r) => run(r.id, () => draft(r))));
    },
    async check(req) {
      checks.push(req);
      return run(req.id, () => check(req));
    },
  };
}

/**
 * B17 test fake judge: `verdict(item)` grades one answer (pass or not). Batch mode is immediate:
 * `submitBatch` stores the verdicts, `collectBatch` returns them (or null while `pendingBatches`
 * holds the id). Records every judged item. Never reaches Anthropic.
 */
export function fakeJudgeClient(
  verdict: (item: JudgeItem) => boolean | Partial<JudgeVerdict> = () => true,
): JudgeClient & { judged: JudgeItem[]; batches: Map<string, JudgeItem[]>; pendingBatches: Set<string> } {
  const judged: JudgeItem[] = [];
  const batches = new Map<string, JudgeItem[]>();
  const pendingBatches = new Set<string>();
  const grade = (item: JudgeItem): JudgeVerdict => {
    judged.push(item);
    const v = verdict(item);
    const pass = typeof v === 'boolean' ? v : v.pass ?? true;
    return { id: item.id, pass, score: typeof v === 'boolean' ? (pass ? 1 : 0) : v.score ?? (pass ? 1 : 0), reason: typeof v === 'boolean' ? '' : v.reason ?? '' };
  };
  return {
    judged,
    batches,
    pendingBatches,
    async judge(items) {
      return items.map(grade);
    },
    async submitBatch(items) {
      const id = `fake_batch_${batches.size + 1}`;
      batches.set(id, items);
      return id;
    },
    async collectBatch(id) {
      if (pendingBatches.has(id)) return null;
      return (batches.get(id) ?? []).map(grade);
    },
  };
}
