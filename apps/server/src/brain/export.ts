import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { brainNotes, type BrainNote } from '../db/schema.js';

/**
 * Obsidian folder export (spec §8.2): one `<slug>.md` per note, YAML frontmatter, body with
 * `[[slug]]` links. Every frontmatter value is written as JSON, which is valid YAML, so the
 * parser below reads it back exactly. Retired notes are left out.
 */

export interface NoteFile {
  path: string;
  content: string;
}

export interface ParsedNoteFile {
  slug: string;
  title: string;
  type: string;
  status?: string;
  validFrom: string | null;
  validUntil: string | null;
  reviewBy: string | null;
  meta: Record<string, unknown>;
  bodyMd: string;
}

/** Link targets in order: `[[slug]]`, `[[slug|label]]` and `[[slug#heading]]` all give `slug`. */
export function noteLinks(bodyMd: string): string[] {
  return [...bodyMd.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1]!.trim());
}

export function serializeNote(n: BrainNote): NoteFile {
  const fm: [string, unknown][] = [
    ['title', n.title],
    ['type', n.type],
    ['status', n.status],
    ['valid_from', n.validFrom],
    ['valid_until', n.validUntil],
    ['review_by', n.reviewBy],
  ];
  const meta = (n.frontmatter ?? {}) as Record<string, unknown>;
  if (Object.keys(meta).length) fm.push(['meta', meta]);
  const head = fm.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return { path: `${n.slug}.md`, content: `---\n${head.join('\n')}\n---\n\n${n.bodyMd}\n` };
}

function readValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Hand-edited in Obsidian: plain YAML scalar.
    return raw.trim().replace(/^['"]|['"]$/g, '');
  }
}

export function parseNoteFile(file: NoteFile): ParsedNoteFile | null {
  const name = file.path.split('/').pop() ?? '';
  if (!name.endsWith('.md')) return null;
  const slug = name.slice(0, -3);
  let fm: Record<string, unknown> = {};
  let body = file.content;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(file.content);
  if (m) {
    body = file.content.slice(m[0].length);
    for (const line of m[1]!.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = readValue(line.slice(i + 1).trim());
    }
  }
  body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    slug,
    title: str(fm.title) ?? slug,
    type: str(fm.type) ?? 'faq',
    status: str(fm.status) ?? undefined,
    validFrom: str(fm.valid_from),
    validUntil: str(fm.valid_until),
    reviewBy: str(fm.review_by),
    meta: fm.meta && typeof fm.meta === 'object' ? (fm.meta as Record<string, unknown>) : {},
    bodyMd: body,
  };
}

export async function exportObsidianFolder(db: Db, clubId: string): Promise<NoteFile[]> {
  const rows = await db
    .select()
    .from(brainNotes)
    .where(and(eq(brainNotes.clubId, clubId), ne(brainNotes.status, 'retired')))
    .orderBy(asc(brainNotes.slug), asc(brainNotes.createdAt));
  // A slug with a live note and a superseding draft exports the live one.
  const bySlug = new Map<string, BrainNote>();
  for (const r of rows) if (!bySlug.has(r.slug) || r.status === 'live') bySlug.set(r.slug, r);
  return [...bySlug.values()].map(serializeNote);
}
