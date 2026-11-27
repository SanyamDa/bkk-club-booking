import Anthropic from '@anthropic-ai/sdk';

/**
 * The answer judge (spec §8.6, plan B17). `claude-sonnet-5-5` grades a bot answer against a
 * reference answer, or, with no reference, against the club brain the answer came from. Direct
 * calls serve the test sets (Thai-100, per-club runs); batch mode serves the daily sampled quality
 * review. Injectable: production `anthropicJudgeClient`, tests `fakeJudgeClient` (`bot/deps.ts`).
 */

export const JUDGE_MODEL = 'claude-sonnet-5-5';

export interface JudgeItem {
  id: string;
  question: string;
  answer: string;
  /** The answer a person approved. Null: judge against `brain`. */
  reference: string | null;
  brain?: string;
  lang: string;
}

export interface JudgeVerdict {
  id: string;
  pass: boolean;
  /** 0..1 */
  score: number;
  reason: string;
}

export interface JudgeClient {
  judge(items: JudgeItem[]): Promise<JudgeVerdict[]>;
  /** Batch mode: returns the batch id. */
  submitBatch(items: JudgeItem[]): Promise<string>;
  /** The verdicts once the batch ended, else null. */
  collectBatch(batchId: string): Promise<JudgeVerdict[] | null>;
}

export const JUDGE_INSTRUCTIONS = `You grade answers a nightclub's LINE assistant gave to guests in Thai or English.

Pass the answer only when all hold:
- It answers the guest's question.
- It agrees with the reference answer (or, with no reference, with the club brain). Extra wording is fine; a different fact is not.
- It is in the guest's language (Thai for Thai, mixed or romanised Thai questions; English for English).
- It states no price, amount, table code or availability.
Score 1.0 for a full pass, 0.5 for partly right, 0 for wrong. Return JSON only.`;

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'score', 'reason'],
  properties: { pass: { type: 'boolean' }, score: { type: 'number' }, reason: { type: 'string' } },
} as const;

export function judgePrompt(item: JudgeItem): string {
  return (
    (item.reference === null && item.brain ? `<club_brain>\n${item.brain}\n</club_brain>\n` : '') +
    `<question lang="${item.lang}">\n${item.question}\n</question>\n` +
    (item.reference !== null ? `<reference>\n${item.reference}\n</reference>\n` : '') +
    `<answer>\n${item.answer}\n</answer>`
  );
}

/** Reads the model's JSON verdict; anything unreadable is a fail. */
export function parseVerdict(id: string, text: string): JudgeVerdict {
  try {
    const v = JSON.parse(text) as { pass?: unknown; score?: unknown; reason?: unknown };
    const score = typeof v.score === 'number' && Number.isFinite(v.score) ? Math.min(1, Math.max(0, v.score)) : 0;
    return { id, pass: v.pass === true, score, reason: typeof v.reason === 'string' ? v.reason.slice(0, 300) : '' };
  } catch {
    return { id, pass: false, score: 0, reason: 'unreadable verdict' };
  }
}

function params(item: JudgeItem): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: JUDGE_MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: JUDGE_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    messages: [{ role: 'user', content: judgePrompt(item) }],
  };
}

const textOf = (m: Anthropic.Message) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

export function anthropicJudgeClient(apiKey: string): JudgeClient {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  return {
    async judge(items) {
      const out: JudgeVerdict[] = [];
      for (const item of items) {
        try {
          out.push(parseVerdict(item.id, textOf(await client.messages.create(params(item)))));
        } catch (err) {
          out.push({ id: item.id, pass: false, score: 0, reason: `judge error: ${(err as Error).message}`.slice(0, 300) });
        }
      }
      return out;
    },
    async submitBatch(items) {
      const batch = await client.messages.batches.create({ requests: items.map((i) => ({ custom_id: i.id, params: params(i) })) });
      return batch.id;
    },
    async collectBatch(batchId) {
      const batch = await client.messages.batches.retrieve(batchId);
      if (batch.processing_status !== 'ended') return null;
      const out: JudgeVerdict[] = [];
      for await (const r of await client.messages.batches.results(batchId)) {
        out.push(
          r.result.type === 'succeeded'
            ? parseVerdict(r.custom_id, textOf(r.result.message))
            : { id: r.custom_id, pass: false, score: 0, reason: `batch ${r.result.type}` },
        );
      }
      return out;
    },
  };
}
