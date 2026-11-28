import { and, eq, ne } from 'drizzle-orm';
import type { Actor } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import { brainNotes, type BrainNote } from '../db/schema.js';
import { parseNoteFile, type NoteFile } from './export.js';
import { BrainLintError, lintNote, NOTE_TYPES, type LintIssue, type NoteType } from './lint.js';
import { createNote, stableSlug } from './notes.js';
import { checkImportImage, OcrError } from './ocr.js';

/**
 * Imports into the brain (spec §8.2, §10 Phase 2 baseline). Everything imported is a **draft**:
 * a manager approves each note before the bot uses it. A section or file that fails lint is
 * returned in `rejected` and not saved.
 */

export interface FolderImportResult {
  created: number;
  /** Drafts that replace an existing note with the same slug once approved. */
  superseding: number;
  unchanged: number;
  /** Generated layout files and non-markdown files. */
  skipped: number;
  rejected: { path: string; issues: LintIssue[] }[];
}

const asType = (t: string): NoteType => ((NOTE_TYPES as readonly string[]).includes(t) ? (t as NoteType) : 'faq');

export async function importObsidianFolder(db: Db, clubId: string, files: NoteFile[], actor: Actor, now: Date): Promise<FolderImportResult> {
  const res: FolderImportResult = { created: 0, superseding: 0, unchanged: 0, skipped: 0, rejected: [] };
  for (const file of files) {
    const p = parseNoteFile(file);
    if (!p || p.type === 'layout') {
      res.skipped++;
      continue;
    }
    const type = asType(p.type);
    const issues = lintNote({ type, title: p.title, bodyMd: p.bodyMd, validUntil: p.validUntil });
    if (issues.length) {
      res.rejected.push({ path: file.path, issues });
      continue;
    }
    // The stored slug is the slugified file name ('Dress Code.md' is 'dress-code'), so look it up that way.
    const slug = stableSlug(p.slug);
    const same = await db
      .select()
      .from(brainNotes)
      .where(and(eq(brainNotes.clubId, clubId), eq(brainNotes.slug, slug), ne(brainNotes.status, 'retired')));
    if (same.some((n) => n.bodyMd === p.bodyMd && n.title === p.title && n.validUntil === p.validUntil)) {
      res.unchanged++;
      continue;
    }
    const current = same.find((n) => n.status === 'live') ?? same[0];
    await createNote(
      db,
      {
        clubId,
        title: p.title,
        type,
        bodyMd: p.bodyMd,
        source: 'import',
        slug,
        frontmatter: p.meta,
        validFrom: p.validFrom,
        validUntil: p.validUntil,
        ...(p.reviewBy ? { reviewBy: p.reviewBy } : {}),
        supersedesId: current?.id ?? null,
      },
      actor,
      now,
    );
    if (current) res.superseding++;
    else res.created++;
  }
  return res;
}

export interface TextImportResult {
  created: BrainNote[];
  rejected: { title: string; issues: LintIssue[] }[];
}

/** Splits pasted text into sections: by markdown headings when it has any, else by blank lines. */
export function splitSections(text: string): { title: string; body: string }[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57).trimEnd()}...` : s);
  if (/^#{1,6}\s/m.test(normalized)) {
    const out: { title: string; body: string }[] = [];
    let cur: { title: string; lines: string[] } | null = null;
    for (const line of normalized.split('\n')) {
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        if (cur) out.push({ title: cur.title, body: cur.lines.join('\n').trim() });
        cur = { title: h[1]!.trim(), lines: [] };
      } else if (cur) cur.lines.push(line);
      else if (line.trim()) cur = { title: short(line.trim()), lines: [line] };
    }
    if (cur) out.push({ title: cur.title, body: cur.lines.join('\n').trim() });
    return out.filter((s) => s.body || s.title);
  }
  return normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ title: short(p.split('\n')[0]!.trim()), body: p }));
}

/** Pasted text (a pinned message, a rules page) becomes draft FAQ notes. */
export async function importPastedText(db: Db, clubId: string, text: string, actor: Actor, now: Date): Promise<TextImportResult> {
  const res: TextImportResult = { created: [], rejected: [] };
  for (const s of splitSections(text)) {
    const bodyMd = s.body || s.title;
    try {
      res.created.push(await createNote(db, { clubId, title: s.title, type: 'faq', bodyMd, source: 'import' }, actor, now));
    } catch (err) {
      if (err instanceof BrainLintError) res.rejected.push({ title: s.title, issues: err.issues });
      else throw err;
    }
  }
  return res;
}

export interface ImportImage {
  bytes: Uint8Array;
  mimeType: string;
}
/** Reads the text in a menu or house-rules photo. Production: `anthropicOcr` (`brain/ocr.ts`); tests inject a fake. */
export type OcrFn = (image: ImportImage) => Promise<string>;

/**
 * Photo import: checks size and type, reads the text, then imports it like pasted text (draft
 * notes, lint-failing sections rejected). Throws `OcrError` (no note created) when the image is
 * refused, OCR fails, or no text is found.
 */
export async function importPhoto(db: Db, clubId: string, image: ImportImage, ocr: OcrFn, actor: Actor, now: Date): Promise<TextImportResult> {
  const checked = checkImportImage(image);
  let text: string;
  try {
    text = await ocr(checked);
  } catch (err) {
    if (err instanceof OcrError) throw err;
    throw new OcrError('ocr_failed', `The photo could not be read right now (${(err as Error).message}). Try again, or paste the text instead.`.slice(0, 300));
  }
  if (!text.trim()) throw new OcrError('no_text', 'No text was found in the photo. Try a sharper photo, or paste the text instead.');
  return importPastedText(db, clubId, text, actor, now);
}
