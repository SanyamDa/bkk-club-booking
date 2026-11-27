import { join } from 'node:path';
import { SlipOkVerifier, type SlipVerifier } from '../bookings/slip-verify.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { PaymentGateways } from '../integrations/payments/gateway.js';
import { configuredPaymentGateways } from '../integrations/payments/opn.js';
import { Outbox } from '../line/outbox.js';
import type { BotDeps } from './flow.js';
import { Links } from './links.js';

/** Test and caller overrides for the bot's dependencies. B adds each new dependency's fake here. */
export interface BotDepOptions {
  now?: () => Date;
  log?: BotDeps['log'];
  /** B9: the slip verifier (tests pass `FakeSlipVerifier`); `null` turns automatic verification off. */
  slipVerifier?: SlipVerifier | null;
  /** A20b: payment gateways by provider (tests pass `fakePaymentGateway`); default: Opn from config. */
  payments?: PaymentGateways;
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
    payments: opts.payments ?? configuredPaymentGateways(config),
    slipVerifier:
      opts.slipVerifier !== undefined
        ? opts.slipVerifier
        : config.SLIPOK_API_KEY && config.SLIPOK_BRANCH_ID
          ? new SlipOkVerifier({ apiKey: config.SLIPOK_API_KEY, branchId: config.SLIPOK_BRANCH_ID })
          : null,
  };
}
