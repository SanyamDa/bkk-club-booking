import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { platformFlags } from '../db/schema.js';

type JobFn = (now: Date) => Promise<void>;
type Job = { name: string; everyMs: number; fn: JobFn; timer?: ReturnType<typeof setInterval>; running?: Promise<boolean> };

/** The `platform_flags` key of a job's lock row. */
export const jobLockKey = (name: string) => `job_lock:${name}`;

/**
 * A tiny in-process interval runner (plan B2). Each named job runs every `everyMs` under a lock row
 * in `platform_flags` (`job_lock:<name>`, value `{ owner, until }`), so two app instances never run
 * the same job at once. A lock whose `until` has passed (its instance died) is taken over. The clock
 * is injected. Every job is registered in `jobs/index.ts` and nowhere else.
 */
export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly owner = randomUUID();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
  ) {}

  register(name: string, everyMs: number, fn: JobFn): void {
    if (this.jobs.has(name)) throw new Error(`Job ${name} is already registered`);
    this.jobs.set(name, { name, everyMs, fn });
  }

  /** Registered job names (for tests and logs). */
  names(): string[] {
    return [...this.jobs.keys()];
  }

  start(): void {
    for (const job of this.jobs.values()) {
      if (job.timer) continue;
      job.timer = setInterval(() => {
        if (job.running) return; // the previous run is still going: skip this tick
        void this.runOnce(job.name, this.now());
      }, job.everyMs);
    }
  }

  /** Stops the timers and waits for runs in progress. */
  async stop(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.timer) clearInterval(job.timer);
      job.timer = undefined;
    }
    await Promise.allSettled([...this.jobs.values()].map((j) => j.running));
  }

  /**
   * Runs one job now under its lock. Returns false when another instance holds the lock. A job
   * failure is logged, not thrown, so one bad run never stops the timer.
   */
  async runOnce(name: string, now: Date): Promise<boolean> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job ${name}`);
    const run = this.locked(job, now).finally(() => {
      if (job.running === run) job.running = undefined;
    });
    job.running = run;
    return run;
  }

  private async locked(job: Job, now: Date): Promise<boolean> {
    try {
      if (!(await this.acquire(job, now))) return false;
    } catch (err) {
      // A lock error (connection drop, pool timeout) is logged; the next tick tries again.
      this.log(`Job ${job.name}: lock acquire failed`, err);
      return false;
    }
    try {
      await job.fn(now);
    } catch (err) {
      this.log(`Job ${job.name} failed`, err);
    } finally {
      await this.release(job).catch((err) => this.log(`Job ${job.name}: lock release failed`, err));
    }
    return true;
  }

  /** Lock time-to-live: long enough for a slow run, short enough that a dead instance's lock clears. */
  private ttlMs(job: Job): number {
    return Math.max(2 * job.everyMs, 60_000);
  }

  private async acquire(job: Job, now: Date): Promise<boolean> {
    const key = jobLockKey(job.name);
    const value = { owner: this.owner, until: new Date(now.getTime() + this.ttlMs(job)).toISOString() };
    const rows = await this.db
      .insert(platformFlags)
      .values({ key, value, updatedBy: 'system', updatedAt: now })
      .onConflictDoUpdate({
        target: platformFlags.key,
        set: { value, updatedBy: 'system', updatedAt: now },
        setWhere: sql`(${platformFlags.value}->>'until')::timestamptz < ${now.toISOString()}::timestamptz or ${platformFlags.value}->>'owner' = ${this.owner}`,
      })
      .returning({ key: platformFlags.key });
    return rows.length > 0;
  }

  private async release(job: Job): Promise<void> {
    await this.db
      .delete(platformFlags)
      .where(and(eq(platformFlags.key, jobLockKey(job.name)), sql`${platformFlags.value}->>'owner' = ${this.owner}`));
  }
}
