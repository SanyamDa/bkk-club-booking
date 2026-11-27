import { expireStaleHolds } from '../bookings/service.js';
import type { AppContext } from '../http/context.js';
import { startAlertChecks } from '../platform/alert-checks.js';

/**
 * Starts all background work for a running server. Returns a function that stops it.
 * main.ts calls this once; new jobs are registered here, never in main.ts.
 */
export async function startBackground(ctx: AppContext, now: () => Date): Promise<() => Promise<void>> {
  // Release holds whose time ran out and tell the guest (spec §5.2 step 6).
  const sweeper = setInterval(async () => {
    try {
      const expired = await expireStaleHolds(ctx.deps.db, now());
      for (const b of expired) await ctx.notifier.holdExpired(b);
    } catch (err) {
      ctx.deps.log('Hold sweeper failed', err);
    }
  }, 30_000);

  const stopAlertChecks = startAlertChecks(ctx, now); // A15: until B's scheduler: scheduler.register('alert-checks', ...)
  const stopClubReports = (await import('../platform/club-report.js')).startClubReports(ctx, now); // A16b: until B's scheduler: scheduler.register('club-report', ...)
  const stopBrainExpiry = (await import('./brain-expiry.js')).startBrainExpiry(ctx, now); // B15: until B2's scheduler: scheduler.register('brain-expiry', ...)

  return async () => {
    clearInterval(sweeper);
    stopAlertChecks();
    stopClubReports();
    stopBrainExpiry();
  };
}
