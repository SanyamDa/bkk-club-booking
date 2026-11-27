import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { Outbox } from '../line/outbox.js';
import type { BotDeps } from './flow.js';
import { Links } from './links.js';
import { anthropicModelClient, type ModelClient, type ModelReply, type ModelRequest } from '../brain/answer.js';

/** Test and caller overrides for the bot's dependencies. B adds each new dependency's fake here. */
export interface BotDepOptions {
  now?: () => Date;
  log?: BotDeps['log'];
  /** B16: the AI model client. `null` turns AI answers off; omitted, built from `ANTHROPIC_API_KEY`. */
  ai?: ModelClient | null;
}

const defaultLog: BotDeps['log'] = (msg, err) => (err ? console.error(msg, err) : console.log(msg));

export function buildBotDeps(config: Config, db: Db, opts: BotDepOptions = {}): BotDeps {
  const log = opts.log ?? defaultLog;
  return {
    db,
    outbox: new Outbox(db, log),
    links: new Links(config.PUBLIC_URL, config.APP_SECRET),
    uploadsDir: join(config.DATA_DIR, 'uploads'),
    now: opts.now ?? (() => new Date()),
    log,
    ai: opts.ai !== undefined ? opts.ai : config.ANTHROPIC_API_KEY ? anthropicModelClient(config.ANTHROPIC_API_KEY) : null,
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
