import type { Db } from '../db/client.js';
import { opsEvents } from '../db/schema.js';
import { newId } from '../lib/util.js';

export type OpsKind = (typeof opsEvents.$inferInsert)['kind'];

/**
 * One `ops_events` row (plan B3): webhook rejections, bot errors, failed sends, LINE setup runs.
 * `clubId` is null when the club is unknown (a webhook to a slug that does not exist).
 * The single writer of `ops_events`; pass `tx` inside a transaction.
 */
export async function recordOps(db: Db, clubId: string | null, kind: OpsKind, detail: unknown, now: Date): Promise<void> {
  await db.insert(opsEvents).values({ id: newId(), clubId, kind, detail: detail ?? null, at: now });
}
