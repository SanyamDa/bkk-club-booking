import { and, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { deposits, rawWebhooks } from '../db/schema.js';
import { defaultUploadsDir, unlinkUnder } from '../data/removal.js';

const DAY_MS = 86_400_000;
/** Spec §14.9: raw webhook deliveries are kept 30 days, payment slips 1 year. */
export const RAW_WEBHOOK_DAYS = 30;
export const SLIP_DAYS = 365;

/** Deletes processed `raw_webhooks` older than 30 days. Unprocessed rows stay so they can be replayed. */
export async function purgeRawWebhooks(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RAW_WEBHOOK_DAYS * DAY_MS);
  const gone = await db
    .delete(rawWebhooks)
    .where(and(isNotNull(rawWebhooks.processedAt), lt(rawWebhooks.receivedAt, cutoff)))
    .returning({ id: rawWebhooks.id });
  return gone.length;
}

/** Deletes slip files older than 1 year (by `slip_received_at`, else `created_at`) and clears `slip_path`. */
export async function purgeSlips(db: Db, now: Date, uploadsDir: string = defaultUploadsDir()): Promise<number> {
  const cutoff = new Date(now.getTime() - SLIP_DAYS * DAY_MS);
  const old = and(isNotNull(deposits.slipPath), lt(sql`coalesce(${deposits.slipReceivedAt}, ${deposits.createdAt})`, cutoff));
  const paths = await db.transaction(async (tx) => {
    const rows = await tx.select({ path: deposits.slipPath }).from(deposits).where(old);
    if (rows.length) await tx.update(deposits).set({ slipPath: null }).where(old);
    return rows.map((r) => r.path!);
  });
  await unlinkUnder(uploadsDir, paths);
  return paths.length;
}

/** The daily `retention` job (plan B10b). */
export async function runRetention(db: Db, now: Date, uploadsDir: string = defaultUploadsDir()): Promise<void> {
  await purgeRawWebhooks(db, now);
  await purgeSlips(db, now, uploadsDir);
}
