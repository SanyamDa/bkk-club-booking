import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { brainNotes, events, type Club } from '../db/schema.js';

/**
 * Gaps (spec §6.6, plan B19): questions the bot could not answer, from `faq.missed` events (B16
 * emits them with `props.topic` and the guest's question in `raw.text`). Grouped by topic, or by
 * the lower-cased question when there is no topic; most frequent first. A gap is closed by a live
 * note whose `frontmatter.gapTopic` is the gap's key, approved after the last time it was asked.
 * A live club never sees test events; the demo club sees its own.
 */
export interface BrainGap {
  key: string;
  topic: string | null;
  count: number;
  lastAskedAt: string;
  question: string | null;
}

export const GAP_WINDOW_DAYS = 30;

const questionOf = (raw: unknown): string | null => {
  const text = raw && typeof raw === 'object' ? (raw as { text?: unknown }).text : undefined;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
};

export async function listGaps(db: Db, club: Club, now: Date, opts: { days?: number } = {}): Promise<BrainGap[]> {
  const since = new Date(now.getTime() - (opts.days ?? GAP_WINDOW_DAYS) * 86_400_000);
  const conds = [eq(events.clubId, club.id), eq(events.type, 'faq.missed'), gte(events.occurredAt, since)];
  if (club.status !== 'demo') conds.push(eq(events.isTest, false));
  const rows = await db
    .select({ occurredAt: events.occurredAt, props: events.props, raw: events.raw })
    .from(events)
    .where(and(...conds))
    .orderBy(desc(events.occurredAt));

  const gaps = new Map<string, BrainGap & { last: Date }>();
  for (const r of rows) {
    const topic = typeof r.props.topic === 'string' && r.props.topic ? r.props.topic : null;
    const question = questionOf(r.raw);
    const key = topic ?? question?.toLowerCase();
    if (!key) continue;
    const g = gaps.get(key);
    if (g) g.count++;
    // Rows come newest first: the first row of a key holds its last question and time.
    else gaps.set(key, { key, topic, count: 1, lastAskedAt: r.occurredAt.toISOString(), question, last: r.occurredAt });
  }

  const answered = new Map<string, Date>();
  const live = await db
    .select({ frontmatter: brainNotes.frontmatter, approvedAt: brainNotes.approvedAt, updatedAt: brainNotes.updatedAt })
    .from(brainNotes)
    .where(and(eq(brainNotes.clubId, club.id), eq(brainNotes.status, 'live')));
  for (const n of live) {
    const topic = (n.frontmatter as { gapTopic?: unknown } | null)?.gapTopic;
    if (typeof topic !== 'string') continue;
    const at = n.approvedAt ?? n.updatedAt;
    const prev = answered.get(topic);
    if (!prev || at > prev) answered.set(topic, at);
  }

  return [...gaps.values()]
    .filter((g) => {
      const at = answered.get(g.key);
      return !at || g.last > at;
    })
    .sort((a, b) => b.count - a.count || b.last.getTime() - a.last.getTime())
    .map(({ last: _last, ...g }) => g);
}
