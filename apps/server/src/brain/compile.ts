import { createHash } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { brainNotes, brainSnapshots, brainTestRuns, clubs, type BrainNote } from '../db/schema.js';
import { newId } from '../lib/util.js';
import { clubToday } from '../platform/club-settings.js';

/**
 * Snapshot compile (spec §8.2, plan B15). The whole live brain becomes one fixed text, so the
 * provider's prompt cache stays identical between requests. The text depends only on the notes
 * (no time stamps), so the same notes always give the same hash.
 */

export const BRAIN_TOKEN_WARN = 40_000;
export const BRAIN_TOKEN_CAP = 60_000;

export type BrainSnapshot = typeof brainSnapshots.$inferSelect;
export type CompileResult =
  | { status: 'published' | 'unchanged'; snapshot: BrainSnapshot; warn: boolean }
  | { status: 'over_cap'; tokenCount: number };

/** Thrown when an approval would push the brain over the cap; the approval is rolled back. */
export class BrainCapError extends Error {
  constructor(readonly tokenCount: number) {
    super(`brain over_cap: ${tokenCount} tokens (cap ${BRAIN_TOKEN_CAP})`);
    this.name = 'BrainCapError';
  }
}

/** No tokenizer dependency: about 4 UTF-8 bytes per token (a Thai character counts about 0.75). */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/** §8.4 "which source wins": policy, then FAQ, then learned. Layout and events sit between. */
const TYPE_ORDER: Record<string, number> = { policy: 0, faq: 1, layout: 2, event: 3, learned: 4 };

type CompilableNote = Pick<BrainNote, 'slug' | 'title' | 'type' | 'bodyMd' | 'validUntil'>;

/** Pure: the compiled text of the given notes, in a fixed order. */
export function compileText(notes: readonly CompilableNote[]): string {
  const sorted = [...notes].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const parts = sorted.map((n) => {
    const meta = `note: ${n.slug} | type: ${n.type}${n.validUntil ? ` | until: ${n.validUntil}` : ''}`;
    return `## ${n.title}\n${meta}\n\n${n.bodyMd.trim()}`;
  });
  return `# Club brain\n\n${parts.join('\n\n---\n\n')}\n`;
}

/** True when a live note belongs in the brain on `today` (club night date). */
export function inDate(n: Pick<BrainNote, 'validFrom' | 'validUntil'>, today: string): boolean {
  return (!n.validFrom || n.validFrom <= today) && (!n.validUntil || n.validUntil >= today);
}

export async function liveNotesFor(db: Db, clubId: string, today: string): Promise<BrainNote[]> {
  const rows = await db.select().from(brainNotes).where(and(eq(brainNotes.clubId, clubId), eq(brainNotes.status, 'live')));
  return rows.filter((n) => inDate(n, today));
}

export async function latestSnapshot(db: Db, clubId: string): Promise<BrainSnapshot | undefined> {
  const [row] = await db.select().from(brainSnapshots).where(eq(brainSnapshots.clubId, clubId)).orderBy(desc(brainSnapshots.version)).limit(1);
  return row;
}

/**
 * Compiles the club's live, in-date notes. Over the cap: writes nothing. Same hash as the latest
 * snapshot: writes nothing. Pass the transaction as `db` when called inside one.
 */
export async function compileSnapshot(db: Db, clubId: string, now: Date): Promise<CompileResult> {
  // Lock the club row so two compiles for one club run one after the other (inside a transaction
  // the lock holds to commit), instead of both taking version latest+1.
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId)).for('update');
  if (!club) throw new Error(`unknown club ${clubId}`);
  const text = compileText(await liveNotesFor(db, clubId, clubToday(club, now)));
  const tokenCount = estimateTokens(text);
  if (tokenCount > BRAIN_TOKEN_CAP) return { status: 'over_cap', tokenCount };
  const hash = createHash('sha256').update(text).digest('hex');
  const warn = tokenCount >= BRAIN_TOKEN_WARN;
  const latest = await latestSnapshot(db, clubId);
  if (latest && latest.hash === hash) return { status: 'unchanged', snapshot: latest, warn };
  const [snapshot] = await db
    .insert(brainSnapshots)
    .values({ id: newId(), clubId, version: (latest?.version ?? 0) + 1, compiledText: text, tokenCount, hash, createdAt: now })
    .returning();
  await queueTestRun(db, clubId, 'snapshot', snapshot!.version, now);
  return { status: 'published', snapshot: snapshot!, warn };
}

/**
 * B17: queues a run of the club's test set (spec §8.5). The `brain-testset` job runs it later, so
 * a compile never waits on the model (§8.3 step 6). One pending run per club: a later compile or
 * model change updates the waiting run instead of adding another.
 */
export async function queueTestRun(
  db: Db,
  clubId: string,
  trigger: 'snapshot' | 'model_change' | 'manual',
  snapshotVersion: number | null,
  now: Date,
): Promise<void> {
  const [waiting] = await db
    .select({ id: brainTestRuns.id })
    .from(brainTestRuns)
    .where(and(eq(brainTestRuns.clubId, clubId), eq(brainTestRuns.status, 'pending'), ne(brainTestRuns.trigger, 'sample_review')))
    .limit(1);
  if (waiting) {
    await db.update(brainTestRuns).set({ trigger, snapshotVersion }).where(eq(brainTestRuns.id, waiting.id));
    return;
  }
  await db.insert(brainTestRuns).values({ id: newId(), clubId, trigger, snapshotVersion, createdAt: now });
}
