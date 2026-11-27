import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { rawWebhooks } from '../db/schema.js';
import { newId } from '../lib/util.js';

/**
 * The single writer of `raw_webhooks` (plan B3). Every inbound delivery (LINE, Chatwoot Instagram,
 * POS) is stored here before it is processed, so a crash after the 200 loses nothing.
 */
export interface RawWebhookInput {
  clubId: string | null;
  /** 'line', 'chatwoot:instagram', 'pos:papaya', ... */
  channel: string;
  body: object;
  signatureOk: boolean;
  receivedAt: Date;
  /** Set when the delivery needs no processing (or was processed in the same request). */
  processedAt?: Date | null;
  error?: string | null;
}

export async function recordRawWebhook(db: Db, input: RawWebhookInput): Promise<string> {
  const id = newId();
  await db.insert(rawWebhooks).values({
    id,
    clubId: input.clubId,
    channel: input.channel,
    body: input.body,
    signatureOk: input.signatureOk,
    receivedAt: input.receivedAt,
    processedAt: input.processedAt ?? null,
    error: input.error ?? null,
  });
  return id;
}

/** The delivery was processed in full: `processed_at` set, `error` cleared. */
export async function markRawProcessed(db: Db, id: string, at: Date): Promise<void> {
  await db.update(rawWebhooks).set({ processedAt: at, error: null }).where(eq(rawWebhooks.id, id));
}

/** Processing failed: `error` set, `processed_at` left NULL so a replay picks it up. */
export async function markRawError(db: Db, id: string, error: string): Promise<void> {
  await db.update(rawWebhooks).set({ processedAt: null, error: error.slice(0, 2000) }).where(eq(rawWebhooks.id, id));
}

/** A request body as a jsonb object: parsed JSON, or the text (capped) when it is not a JSON object. */
export function rawBody(text: string): { body: object; parsed: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { body: parsed !== null && typeof parsed === 'object' ? parsed : { unparsed: text.slice(0, 10_000) }, parsed };
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
