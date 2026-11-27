import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { Outbox } from '../line/outbox.js';
import type { BotDeps } from './flow.js';
import { Links } from './links.js';

/** Test and caller overrides for the bot's dependencies. B adds each new dependency's fake here. */
export interface BotDepOptions {
  now?: () => Date;
  log?: BotDeps['log'];
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
  };
}
