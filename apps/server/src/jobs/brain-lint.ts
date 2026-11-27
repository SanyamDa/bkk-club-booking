import { and, eq, ne } from 'drizzle-orm';
import { latestSnapshot } from '../brain/compile.js';
import { brainCheckSchema, containsPersonalData, emitLearnCall, type LearnClient } from '../brain/learn.js';
import { lintNote } from '../brain/lint.js';
import type { Db } from '../db/client.js';
import { brainNotes, clubs, platformFlags, type Club } from '../db/schema.js';
import { bangkokParts, toDateString } from '../lib/time.js';
import { raiseAlert } from '../platform/alerts.js';
import { clubToday } from '../platform/club-settings.js';
import { mondayOf } from '../platform/club-report.js';
import { DIGEST_HOUR } from './brain-expiry.js';

/**
 * Weekly brain check (spec §8.4 "Contradictions", plan B18). Monday from 10:00 Bangkok, once per
 * club per week (claimed in `platform_flags` `brain-lint:<clubId>:<monday>`). Deterministic checks
 * (leaked prices or availability, personal data, duplicate notes) run always; `claude-opus-5-5`
 * reads the whole brain for contradictions when a client is configured. Each note with an issue
 * gets `frontmatter.lintIssues` and is pulled into review (`reviewBy` = today); the club gets one
 * `info` alert `brain_lint` listing them.
 */

export type BrainLintKind = 'contradiction' | 'duplicate' | 'price' | 'personal_data';
export interface BrainLintIssue {
  kind: BrainLintKind;
  slugs: string[];
  detail: string;
}

export const lintFlagKey = (clubId: string, monday: string) => `brain-lint:${clubId}:${monday}`;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export async function lintClubBrain(deps: { db: Db; learn?: LearnClient | null; log: (msg: string, err?: unknown) => void }, club: Club, now: Date): Promise<BrainLintIssue[]> {
  const { db } = deps;
  const live = await db.select().from(brainNotes).where(and(eq(brainNotes.clubId, club.id), eq(brainNotes.status, 'live')));
  const issues: BrainLintIssue[] = [];
  const seen = new Map<string, string>();
  for (const n of live) {
    for (const i of lintNote(n)) if (i.code !== 'event_needs_end_date') issues.push({ kind: 'price', slugs: [n.slug], detail: `"${i.match}"` });
    if (containsPersonalData(`${n.title}\n${n.bodyMd}`)) issues.push({ kind: 'personal_data', slugs: [n.slug], detail: 'personal data in the note' });
    const key = norm(n.bodyMd);
    const dup = seen.get(key);
    if (dup) issues.push({ kind: 'duplicate', slugs: [dup, n.slug], detail: 'same text' });
    else seen.set(key, n.slug);
  }
  if (deps.learn && live.length) {
    const brain = (await latestSnapshot(db, club.id))?.compiledText;
    if (brain) {
      const started = Date.now();
      const r = await deps.learn.check({ id: club.id, clubId: club.id, brain });
      await emitLearnCall(db, club, r, Date.now() - started, now);
      const parsed = r.error ? null : brainCheckSchema.safeParse(r.output);
      if (parsed?.success) {
        const slugs = new Set(live.map((n) => n.slug));
        for (const i of parsed.data.issues) {
          const known = i.slugs.filter((s) => slugs.has(s));
          if (known.length) issues.push({ kind: i.kind, slugs: known, detail: i.detail.slice(0, 300) });
        }
      } else if (r.error) deps.log(`brain check failed club ${club.id}`, r.error);
    }
  }
  const today = clubToday(club, now);
  const bySlug = new Map<string, BrainLintIssue[]>();
  for (const i of issues) for (const s of i.slugs) bySlug.set(s, [...(bySlug.get(s) ?? []), i]);
  for (const n of live) {
    const mine = bySlug.get(n.slug);
    if (!mine) continue;
    await db
      .update(brainNotes)
      .set({
        frontmatter: { ...(n.frontmatter as Record<string, unknown>), lintIssues: mine.map((i) => ({ kind: i.kind, detail: i.detail })) },
        reviewBy: n.reviewBy && n.reviewBy < today ? n.reviewBy : today,
        updatedAt: now,
      })
      .where(eq(brainNotes.id, n.id));
  }
  return issues;
}

function lintText(issues: BrainLintIssue[]): { en: string; th: string } {
  const list = issues.map((i) => `${i.kind}: ${i.slugs.join(', ')}`).join('; ');
  return { en: `Weekly brain check found ${issues.length} issue(s) to review: ${list}.`, th: `ตรวจคลังความรู้ประจำสัปดาห์ พบ ${issues.length} รายการที่ต้องทบทวน: ${list}` };
}

export async function runBrainLint(deps: { db: Db; learn?: LearnClient | null; log: (msg: string, err?: unknown) => void }, now: Date): Promise<void> {
  const p = bangkokParts(now);
  const today = toDateString(p.year, p.month, p.day);
  const monday = mondayOf(today);
  if (monday === today && p.hour < DIGEST_HOUR) return;
  for (const club of await deps.db.select().from(clubs).where(ne(clubs.status, 'onboarding'))) {
    const claimed = await deps.db
      .insert(platformFlags)
      .values({ key: lintFlagKey(club.id, monday), value: { started: now.toISOString() }, updatedBy: 'system', updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!claimed.length) continue;
    const issues = await lintClubBrain(deps, club, now);
    await deps.db.update(platformFlags).set({ value: { issues: issues.length } }).where(eq(platformFlags.key, lintFlagKey(club.id, monday)));
    if (issues.length) await raiseAlert(deps.db, { clubId: club.id, level: 'info', kind: 'brain_lint', text: lintText(issues) }, now);
  }
}
