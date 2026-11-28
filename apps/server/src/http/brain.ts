import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BRAIN_TOKEN_CAP, BRAIN_TOKEN_WARN, BrainCapError, latestSnapshot } from '../brain/compile.js';
import { listGaps } from '../brain/gaps.js';
import { exportObsidianFolder } from '../brain/export.js';
import { bodyLimit } from 'hono/body-limit';
import { importObsidianFolder, importPastedText, importPhoto } from '../brain/import.js';
import { MAX_IMPORT_IMAGE_BYTES, OcrError } from '../brain/ocr.js';
import { BrainLintError } from '../brain/lint.js';
import { approveNote, createNote, listNotes, noteVersions, rejectNote, updateNote } from '../brain/notes.js';
import { brainNotes, type BrainNote } from '../db/schema.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import { actorOf } from './staff-settings.js';
import type { AppContext } from './context.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const createBody = z.object({
  title: z.string().trim().min(1).max(120),
  type: z.enum(['faq', 'policy', 'event', 'learned']),
  bodyMd: z.string().trim().min(1).max(20_000),
  validFrom: DATE.nullable().optional(),
  validUntil: DATE.nullable().optional(),
  /** The gap this note answers ([Write an answer]); stored as `frontmatter.gapTopic`. */
  gapTopic: z.string().trim().min(1).max(200).optional(),
});
const patchBody = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    bodyMd: z.string().trim().min(1).max(20_000).optional(),
    validFrom: DATE.nullable().optional(),
    validUntil: DATE.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0);

type Fm = { question?: unknown; hostReply?: unknown; takeovers?: unknown; gapTopic?: unknown };
const str = (v: unknown) => (typeof v === 'string' ? v : null);

const view = (n: BrainNote) => ({
  id: n.id,
  slug: n.slug,
  title: n.title,
  type: n.type,
  status: n.status,
  bodyMd: n.bodyMd,
  source: n.source,
  validFrom: n.validFrom,
  validUntil: n.validUntil,
  reviewBy: n.reviewBy,
  approvedAt: n.approvedAt?.toISOString() ?? null,
  updatedAt: n.updatedAt.toISOString(),
  supersedesId: n.supersedesId,
  gapTopic: str((n.frontmatter as Fm | null)?.gapTopic),
});

function fail(c: Context<AuthEnv>, err: unknown) {
  if (err instanceof BrainLintError) return c.json({ error: 'lint', issues: err.issues, fix: err.fix }, 422);
  if (err instanceof BrainCapError) return c.json({ error: 'over_cap', tokenCount: err.tokenCount }, 409);
  throw err;
}

/**
 * Brain manager (plan B19, spec §6.6), mounted at `/api/staff`: notes grouped by type, the
 * approval queue, gaps, and approve / edit / reject. Owner and manager only. A note id of another
 * club is 404, checked before the body is read.
 */
export function brainRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const managers = requireClubRole(app, 'owner', 'manager');
  const base = '/clubs/:slug/brain';

  const own = (clubId: string, id: string) => db.query.brainNotes.findFirst({ where: and(eq(brainNotes.id, id), eq(brainNotes.clubId, clubId)) });

  r.get(`${base}/notes`, managers, async (c) => {
    const club = c.var.club;
    const notes = (await listNotes(db, club.id)).filter((n) => n.status !== 'retired');
    const snap = await latestSnapshot(db, club.id);
    return c.json({
      notes: notes.map(view),
      snapshot: snap ? { version: snap.version, tokenCount: snap.tokenCount, createdAt: snap.createdAt.toISOString() } : null,
      tokenWarn: BRAIN_TOKEN_WARN,
      tokenCap: BRAIN_TOKEN_CAP,
    });
  });

  r.get(`${base}/queue`, managers, async (c) => {
    const club = c.var.club;
    const all = await listNotes(db, club.id);
    const titleOf = new Map(all.map((n) => [n.id, n.title]));
    const takeovers = (n: BrainNote) => {
      const t = (n.frontmatter as Fm | null)?.takeovers;
      return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    };
    const queue = all
      .filter((n) => n.status === 'draft')
      .sort((a, b) => takeovers(b) - takeovers(a) || b.createdAt.getTime() - a.createdAt.getTime())
      .map((n) => {
        const fm = (n.frontmatter ?? {}) as Fm;
        return {
          ...view(n),
          question: str(fm.question),
          hostReply: str(fm.hostReply),
          takeovers: takeovers(n),
          replaces: n.supersedesId ? (titleOf.get(n.supersedesId) ?? null) : null,
        };
      });
    return c.json({ queue });
  });

  r.get(`${base}/gaps`, managers, async (c) => c.json({ gaps: await listGaps(db, c.var.club, app.deps.now()) }));

  r.post(`${base}/notes`, managers, async (c) => {
    const club = c.var.club;
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const { gapTopic, ...b } = body.data;
    try {
      // The manager is the approver: a note they write is live at once (plan B19).
      const note = await createNote(
        db,
        { clubId: club.id, ...b, source: 'manual', status: 'live', frontmatter: gapTopic ? { gapTopic } : {} },
        actorOf(c),
        app.deps.now(),
      );
      return c.json({ note: view(note) });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.patch(`${base}/notes/:noteId`, managers, async (c) => {
    const club = c.var.club;
    const note = await own(club.id, c.req.param('noteId'));
    if (!note || note.status === 'retired') return c.json({ error: 'not_found' }, 404);
    const body = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    try {
      return c.json({ note: view(await updateNote(db, club.id, note.id, body.data, actorOf(c), app.deps.now())) });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.get(`${base}/notes/:noteId/versions`, managers, async (c) => {
    const club = c.var.club;
    const note = await own(club.id, c.req.param('noteId'));
    if (!note) return c.json({ error: 'not_found' }, 404);
    const versions = await noteVersions(db, club.id, note.id);
    return c.json({ versions: versions.map((v) => ({ id: v.id, bodyMd: v.bodyMd, editedBy: v.editedBy, editedAt: v.editedAt.toISOString() })) });
  });

  r.post(`${base}/notes/:noteId/approve`, managers, async (c) => {
    const club = c.var.club;
    const note = await own(club.id, c.req.param('noteId'));
    if (!note) return c.json({ error: 'not_found' }, 404);
    if (note.status === 'retired') return c.json({ error: 'not_draft' }, 409);
    try {
      return c.json({ note: view(await approveNote(db, club.id, note.id, actorOf(c), app.deps.now())) });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.post(`${base}/notes/:noteId/reject`, managers, async (c) => {
    const club = c.var.club;
    const note = await own(club.id, c.req.param('noteId'));
    if (!note) return c.json({ error: 'not_found' }, 404);
    if (note.status === 'retired') return c.json({ note: view(note) });
    return c.json({ note: view(await rejectNote(db, club.id, note.id, actorOf(c), app.deps.now())) });
  });

  // Spec §8.2 seeding, §10 Phase 2 baseline: the brain as an Obsidian folder (one markdown file per
  // note), imported back as drafts, and pasted text split into draft FAQ notes. Imports are drafts.
  r.get(`${base}/export`, managers, async (c) => c.json({ files: await exportObsidianFolder(db, c.var.club.id) }));

  r.post(`${base}/import`, managers, async (c) => {
    const body = folderBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    return c.json(await importObsidianFolder(db, c.var.club.id, body.data.files, actorOf(c), app.deps.now()));
  });

  r.post(`${base}/import-text`, managers, async (c) => {
    const body = textBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const res = await importPastedText(db, c.var.club.id, body.data.text, actorOf(c), app.deps.now());
    return c.json({ created: res.created.map(view), rejected: res.rejected });
  });

  // Spec §8.2 photo import: a menu or house-rules photo (multipart `file`) is read by OCR and
  // split into draft notes like pasted text. 503 when no OCR provider is configured; 413 / 415
  // for size and type; 502 when OCR fails (no note created); 422 when no text was found.
  const photoLimit = bodyLimit({
    maxSize: MAX_IMPORT_IMAGE_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: 'too_large', message: 'The photo is too large (5 MB at most).' }, 413),
  });
  r.post(`${base}/import-photo`, managers, photoLimit, async (c) => {
    if (!app.ocr) return c.json({ error: 'ocr_not_configured', message: 'Photo import is not set up yet. Paste the text instead.' }, 503);
    if (!(c.req.header('content-type') ?? '').startsWith('multipart/form-data')) return c.json({ error: 'bad_request', message: 'Attach the photo as "file".' }, 400);
    const file = (await c.req.parseBody()).file;
    if (!(file instanceof File)) return c.json({ error: 'bad_request', message: 'Attach the photo as "file".' }, 400);
    try {
      const image = { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type };
      const res = await importPhoto(db, c.var.club.id, image, app.ocr, actorOf(c), app.deps.now());
      return c.json({ created: res.created.map(view), rejected: res.rejected });
    } catch (err) {
      if (!(err instanceof OcrError)) throw err;
      const status = err.code === 'too_large' ? 413 : err.code === 'unsupported_type' ? 415 : err.code === 'ocr_failed' ? 502 : 422;
      return c.json({ error: err.code, message: err.message }, status);
    }
  });

  return r;
}

const folderBody = z.object({
  files: z.array(z.object({ path: z.string().trim().min(1).max(300), content: z.string().max(50_000) })).min(1).max(500),
});
const textBody = z.object({ text: z.string().trim().min(1).max(50_000) });
