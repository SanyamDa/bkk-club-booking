import { createHash } from 'node:crypto';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Actor } from '../bookings/service.js';
import { emit } from '../data/events.js';
import type { Db } from '../db/client.js';
import { brainNotes, brainNoteVersions, clubs, type BrainNote, type Club } from '../db/schema.js';
import { addDays } from '../lib/time.js';
import { newId } from '../lib/util.js';
import { clubToday } from '../platform/club-settings.js';
import { BrainCapError, compileSnapshot } from './compile.js';
import { assertLint, type NoteType } from './lint.js';

/**
 * Brain notes (spec §8.2, §8.4, plan B15). Every note is club-scoped, versioned and linted on save.
 * Drafts never reach the compiled brain; approving a note (or saving a live one) recompiles it.
 */

export type NoteStatus = 'draft' | 'live' | 'retired';
export type NoteSource = 'onboarding' | 'manual' | 'takeover' | 'import';
export const REVIEW_AFTER_DAYS = 90;

export interface NewNote {
  clubId: string;
  title: string;
  type: NoteType;
  bodyMd: string;
  source: NoteSource;
  /** Defaults to a slug of the title, made unique in the club. */
  slug?: string;
  /** `live` only for notes that need no approval (generated layout). Default `draft`. */
  status?: 'draft' | 'live';
  frontmatter?: Record<string, unknown>;
  validFrom?: string | null;
  /** Required for `event` notes (lint). */
  validUntil?: string | null;
  /** Defaults to club today + 90 days for every type but `event`. */
  reviewBy?: string | null;
  sourceEpisodeId?: string | null;
  /** The note this one replaces once approved; it keeps that note's slug. */
  supersedesId?: string | null;
}

export type NotePatch = Partial<Pick<NewNote, 'title' | 'bodyMd' | 'validFrom' | 'validUntil' | 'frontmatter'>>;

const inTx = <T>(db: Db, fn: (tx: Db) => Promise<T>) => db.transaction(async (txRaw) => fn(txRaw as unknown as Db));

async function loadClub(db: Db, clubId: string): Promise<Club> {
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  if (!club) throw new Error(`unknown club ${clubId}`);
  return club;
}

export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * A slug that is the same every time for the same text, also when the text has no Latin letters
 * or digits (a Thai-only title): then a hash of the text. Re-imports and re-applies dedupe on it.
 */
export function stableSlug(text: string): string {
  return slugify(text) || `n-${createHash('sha256').update(text.trim()).digest('hex').slice(0, 12)}`;
}

async function uniqueSlug(db: Db, clubId: string, wanted: string): Promise<string> {
  const base = wanted || `note-${newId().slice(0, 8)}`;
  const taken = new Set(
    (await db.select({ slug: brainNotes.slug }).from(brainNotes).where(and(eq(brainNotes.clubId, clubId), ne(brainNotes.status, 'retired')))).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function noteEvent(db: Db, club: Club, type: 'brain.note_drafted' | 'brain.note_approved' | 'brain.note_rejected', note: BrainNote, actor: Actor, now: Date) {
  await emit(db, {
    clubId: club.id,
    type,
    occurredAt: now,
    actorType: actor.type,
    actorId: actor.id,
    dataOrigin: 'first_party',
    props: { noteId: note.id, noteType: note.type, source: note.source },
    isTest: club.status === 'demo',
  });
}

async function publishOrThrow(tx: Db, clubId: string, now: Date): Promise<void> {
  const res = await compileSnapshot(tx, clubId, now);
  if (res.status === 'over_cap') throw new BrainCapError(res.tokenCount);
}

export async function createNote(db: Db, input: NewNote, actor: Actor, now: Date): Promise<BrainNote> {
  assertLint(input);
  const club = await loadClub(db, input.clubId);
  const today = clubToday(club, now);
  const status = input.status ?? 'draft';
  return inTx(db, async (tx) => {
    let slug: string;
    if (input.supersedesId) {
      const old = await tx.query.brainNotes.findFirst({ where: and(eq(brainNotes.id, input.supersedesId), eq(brainNotes.clubId, club.id)) });
      if (!old) throw new Error('superseded note not found');
      slug = old.slug;
    } else slug = await uniqueSlug(tx, club.id, slugify(input.slug ?? input.title));
    const [note] = await tx
      .insert(brainNotes)
      .values({
        id: newId(),
        clubId: club.id,
        slug,
        title: input.title,
        type: input.type,
        status,
        bodyMd: input.bodyMd,
        frontmatter: input.frontmatter ?? {},
        source: input.source,
        sourceEpisodeId: input.sourceEpisodeId ?? null,
        approvedBy: status === 'live' ? (actor.id ?? actor.type) : null,
        approvedAt: status === 'live' ? now : null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        reviewBy: input.reviewBy !== undefined ? input.reviewBy : input.type === 'event' ? null : addDays(today, REVIEW_AFTER_DAYS),
        supersedesId: input.supersedesId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(brainNoteVersions).values({ id: newId(), noteId: note!.id, bodyMd: note!.bodyMd, editedBy: actor.id ?? actor.type, editedAt: now });
    if (status === 'live') {
      await noteEvent(tx, club, 'brain.note_approved', note!, actor, now);
      await publishOrThrow(tx, club.id, now);
    } else await noteEvent(tx, club, 'brain.note_drafted', note!, actor, now);
    return note!;
  });
}

async function ownNote(db: Db, clubId: string, noteId: string): Promise<BrainNote> {
  const note = await db.query.brainNotes.findFirst({ where: and(eq(brainNotes.id, noteId), eq(brainNotes.clubId, clubId)) });
  if (!note) throw new Error('note not found');
  return note;
}

/** An edit: linted, a new version row, a fresh 90-day review date; a live note recompiles. */
export async function updateNote(db: Db, clubId: string, noteId: string, patch: NotePatch, actor: Actor, now: Date): Promise<BrainNote> {
  const before = await ownNote(db, clubId, noteId);
  const next = { ...before, ...patch, frontmatter: patch.frontmatter ?? before.frontmatter };
  assertLint(next);
  const club = await loadClub(db, clubId);
  return inTx(db, async (tx) => {
    const [note] = await tx
      .update(brainNotes)
      .set({
        title: next.title,
        bodyMd: next.bodyMd,
        validFrom: next.validFrom ?? null,
        validUntil: next.validUntil ?? null,
        frontmatter: next.frontmatter,
        reviewBy: before.type === 'event' ? before.reviewBy : addDays(clubToday(club, now), REVIEW_AFTER_DAYS),
        updatedAt: now,
      })
      .where(eq(brainNotes.id, before.id))
      .returning();
    if (next.bodyMd !== before.bodyMd) await tx.insert(brainNoteVersions).values({ id: newId(), noteId: before.id, bodyMd: next.bodyMd, editedBy: actor.id ?? actor.type, editedAt: now });
    if (note!.status === 'live') await publishOrThrow(tx, clubId, now);
    return note!;
  });
}

/** Draft to live, retiring the note it supersedes, and recompiles. Over the cap: throws, nothing changes. */
export async function approveNote(db: Db, clubId: string, noteId: string, actor: Actor, now: Date): Promise<BrainNote> {
  const before = await ownNote(db, clubId, noteId);
  if (before.status === 'live') return before;
  if (before.status !== 'draft') throw new Error('only a draft can be approved');
  assertLint(before);
  const club = await loadClub(db, clubId);
  return inTx(db, async (tx) => {
    const [note] = await tx
      .update(brainNotes)
      .set({ status: 'live', approvedBy: actor.id ?? actor.type, approvedAt: now, updatedAt: now })
      .where(eq(brainNotes.id, before.id))
      .returning();
    if (before.supersedesId) {
      await tx
        .update(brainNotes)
        .set({ status: 'retired', updatedAt: now })
        .where(and(eq(brainNotes.id, before.supersedesId), eq(brainNotes.clubId, clubId)));
    }
    await noteEvent(tx, club, 'brain.note_approved', note!, actor, now);
    await publishOrThrow(tx, clubId, now);
    return note!;
  });
}

/** Draft rejected (or a live note withdrawn): retired; a live one leaves the brain. */
export async function rejectNote(db: Db, clubId: string, noteId: string, actor: Actor, now: Date): Promise<BrainNote> {
  const before = await ownNote(db, clubId, noteId);
  const club = await loadClub(db, clubId);
  return inTx(db, async (tx) => {
    const [note] = await tx.update(brainNotes).set({ status: 'retired', updatedAt: now }).where(eq(brainNotes.id, before.id)).returning();
    await noteEvent(tx, club, 'brain.note_rejected', note!, actor, now);
    if (before.status === 'live') await compileSnapshot(tx, clubId, now);
    return note!;
  });
}

export async function listNotes(db: Db, clubId: string, opts: { status?: NoteStatus } = {}): Promise<BrainNote[]> {
  const where = opts.status ? and(eq(brainNotes.clubId, clubId), eq(brainNotes.status, opts.status)) : eq(brainNotes.clubId, clubId);
  return db.select().from(brainNotes).where(where).orderBy(asc(brainNotes.slug), asc(brainNotes.createdAt));
}

export async function noteVersions(db: Db, clubId: string, noteId: string) {
  await ownNote(db, clubId, noteId);
  return db.select().from(brainNoteVersions).where(eq(brainNoteVersions.noteId, noteId)).orderBy(asc(brainNoteVersions.editedAt));
}
