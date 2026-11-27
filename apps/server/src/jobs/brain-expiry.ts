import { and, eq, gte, isNotNull, lt, lte, ne } from 'drizzle-orm';
import { compileSnapshot } from '../brain/compile.js';
import { deactivateNoteCases } from '../brain/testset.js';
import type { Db } from '../db/client.js';
import { brainNotes, clubs, platformFlags, type BrainNote } from '../db/schema.js';
import { bangkokParts, toDateString } from '../lib/time.js';
import { raiseAlert } from '../platform/alerts.js';
import { clubToday } from '../platform/club-settings.js';
import { mondayOf } from '../platform/club-report.js';

/**
 * Note expiry (spec §8.4, plan B15). A live note past its `validUntil` is retired and the club's
 * brain recompiled without it. Notes past `reviewBy` stay live and are listed for review. Once a
 * week (Monday from 10:00 Bangkok) each club gets a digest of both as an `info` alert.
 */

export const DIGEST_HOUR = 10;
const DAY_MS = 86_400_000;

export async function runBrainExpiry(db: Db, now: Date): Promise<{ expired: number }> {
  let expired = 0;
  for (const club of await db.select().from(clubs)) {
    const today = clubToday(club, now);
    const due = await db
      .select()
      .from(brainNotes)
      .where(and(eq(brainNotes.clubId, club.id), eq(brainNotes.status, 'live'), isNotNull(brainNotes.validUntil), lt(brainNotes.validUntil, today)));
    if (!due.length) continue;
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      for (const n of due) {
        await tx
          .update(brainNotes)
          .set({ status: 'retired', frontmatter: { ...(n.frontmatter as Record<string, unknown>), retiredReason: 'expired', retiredOn: today }, updatedAt: now })
          .where(eq(brainNotes.id, n.id));
      }
      await deactivateNoteCases(tx, club.id, due.map((n) => n.id));
      await compileSnapshot(tx, club.id, now);
    });
    expired += due.length;
  }
  return { expired };
}

export interface BrainDigest {
  /** Notes that expired in the last 7 days. */
  expired: BrainNote[];
  /** Live notes past their review date. */
  dueForReview: BrainNote[];
}

export async function brainDigest(db: Db, clubId: string, now: Date): Promise<BrainDigest> {
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  if (!club) return { expired: [], dueForReview: [] };
  const today = clubToday(club, now);
  const retired = await db
    .select()
    .from(brainNotes)
    .where(and(eq(brainNotes.clubId, clubId), eq(brainNotes.status, 'retired'), gte(brainNotes.updatedAt, new Date(now.getTime() - 7 * DAY_MS))));
  const dueForReview = await db
    .select()
    .from(brainNotes)
    .where(and(eq(brainNotes.clubId, clubId), eq(brainNotes.status, 'live'), isNotNull(brainNotes.reviewBy), lte(brainNotes.reviewBy, today)));
  return {
    expired: retired.filter((n) => (n.frontmatter as Record<string, unknown>).retiredReason === 'expired'),
    dueForReview: dueForReview.sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

export const digestFlagKey = (clubId: string, weekStart: string) => `brain-digest:${clubId}:${weekStart}`;

function digestText(d: BrainDigest): { en: string; th: string } {
  const list = (ns: BrainNote[]) => ns.map((n) => n.title).join(', ');
  const en: string[] = ['Weekly brain check.'];
  const th: string[] = ['สรุปคลังความรู้ประจำสัปดาห์'];
  if (d.expired.length) {
    en.push(`Expired and removed: ${list(d.expired)}.`);
    th.push(`หมดอายุและนำออกแล้ว: ${list(d.expired)}`);
  }
  if (d.dueForReview.length) {
    en.push(`Due for review: ${list(d.dueForReview)}.`);
    th.push(`ถึงเวลาทบทวน: ${list(d.dueForReview)}`);
  }
  return { en: en.join(' '), th: th.join(' ') };
}

/** Once per club per week, from Monday 10:00 Bangkok; nothing is sent when the digest is empty. */
export async function sendBrainDigests(db: Db, now: Date): Promise<void> {
  const p = bangkokParts(now);
  const monday = mondayOf(toDateString(p.year, p.month, p.day));
  if (monday === toDateString(p.year, p.month, p.day) && p.hour < DIGEST_HOUR) return;
  for (const club of await db.select().from(clubs).where(ne(clubs.status, 'onboarding'))) {
    const key = digestFlagKey(club.id, monday);
    const [done] = await db.select({ key: platformFlags.key }).from(platformFlags).where(eq(platformFlags.key, key)).limit(1);
    if (done) continue;
    const digest = await brainDigest(db, club.id, now);
    const claimed = await db
      .insert(platformFlags)
      .values({ key, value: { expired: digest.expired.length, dueForReview: digest.dueForReview.length }, updatedBy: 'system', updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!claimed.length || (!digest.expired.length && !digest.dueForReview.length)) continue;
    await raiseAlert(db, { clubId: club.id, level: 'info', kind: 'brain_digest', text: digestText(digest) }, now);
  }
}

