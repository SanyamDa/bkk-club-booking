import { expireStaleHolds } from '../bookings/service.js';
import type { AppContext } from '../http/context.js';
import { sweepGrantInboxUsers } from '../integrations/chatwoot/provision.js';
import { runAlertChecks } from '../platform/alert-checks.js';
import { sendWeeklyReports } from '../platform/club-report.js';
import { runBrainExpiry, sendBrainDigests } from './brain-expiry.js';
import { runNightlyCheck } from './nightly-check.js';
import { Scheduler } from './scheduler.js';

const MINUTE = 60_000;

/**
 * Every background job, registered and not started (plan B2). Jobs are registered here and nowhere
 * else; each runs under its `platform_flags` lock (`jobs/scheduler.ts`). Tests call `runOnce`.
 */
export function buildScheduler(ctx: AppContext, now: () => Date): Scheduler {
  const db = ctx.deps.db;
  const s = new Scheduler(db, now, ctx.deps.log);
  // Release holds whose time ran out and tell the guest (spec §5.2 step 6).
  s.register('hold-expiry', 30_000, async (at) => {
    const expired = await expireStaleHolds(db, at);
    for (const b of expired) await ctx.notifier.holdExpired(b);
  });
  s.register('nightly-check', 15 * MINUTE, async (at) => {
    await runNightlyCheck(db, at);
  });
  s.register('alert-checks', MINUTE, (at) => runAlertChecks(ctx, at)); // A15
  s.register('chatwoot-grant-sweep', MINUTE, async (at) => {
    await sweepGrantInboxUsers(db, ctx.chatwoot, at, ctx.deps.log); // A13
  });
  s.register('club-report', 15 * MINUTE, (at) => sendWeeklyReports(ctx, at)); // A16b
  s.register('brain-expiry', 15 * MINUTE, async (at) => {
    await runBrainExpiry(db, at); // B15
    await sendBrainDigests(db, at);
  });
  return s;
}

/**
 * Starts all background work for a running server. Returns a function that stops it.
 * main.ts calls this once; new jobs are registered in `buildScheduler`, never in main.ts.
 */
export async function startBackground(ctx: AppContext, now: () => Date): Promise<() => Promise<void>> {
  const scheduler = buildScheduler(ctx, now);
  scheduler.start();
  return () => scheduler.stop();
}
