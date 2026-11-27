import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bookings, clubs, guestNotes, guests, guestTags, posBills, tables, users, type Club, type Guest } from '../db/schema.js';
import { addDays } from '../lib/time.js';
import { newId } from '../lib/util.js';

/**
 * Guest CRM and VIP tags (spec §6.2 "add notes and VIP tags", plan A20c). Every lookup is scoped
 * to the club; a guest of another club is `not_found`. Test guests are hidden from staff once the
 * club is live (spec §9 test rows), and shown during onboarding and for the demo club.
 */

export class CrmError extends Error {
  constructor(readonly code: 'not_found' | 'bad_tag' | 'bad_request') {
    super(code);
  }
}

export const VIP_TAG = 'vip';
const MAX_TAG = 32;
const MAX_NOTE = 2000;
const ARRIVED = new Set(['arrived', 'completed']);
const HELD = ['confirmed', 'arrived', 'completed', 'no_show'] as const;

/** Trimmed, lowercase, inner spaces as one dash, 1 to 32 characters, no commas. */
export function normalizeTag(tag: string): string {
  const t = tag.trim().toLowerCase().replace(/\s+/g, '-');
  if (!t || t.length > MAX_TAG || /[,#/\\]/.test(t)) throw new CrmError('bad_tag');
  return t;
}

const hidesTestRows = (club: Pick<Club, 'status'>) => club.status === 'live' || club.status === 'paused';

async function clubGuest(db: Db, club: Pick<Club, 'id' | 'status'>, guestId: string): Promise<Guest | undefined> {
  const g = await db.query.guests.findFirst({ where: and(eq(guests.clubId, club.id), eq(guests.id, guestId)) });
  if (!g || (g.isTest && hidesTestRows(club))) return undefined;
  return g;
}

async function requireGuest(db: Db, clubId: string, guestId: string): Promise<Guest> {
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  const g = club ? await clubGuest(db, club, guestId) : undefined;
  if (!g) throw new CrmError('not_found');
  return g;
}

async function tagsOf(db: Db, clubId: string, guestIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!guestIds.length) return out;
  const rows = await db
    .select({ guestId: guestTags.guestId, tag: guestTags.tag })
    .from(guestTags)
    .where(and(eq(guestTags.clubId, clubId), inArray(guestTags.guestId, guestIds)))
    .orderBy(asc(guestTags.tag));
  for (const r of rows) out.set(r.guestId, [...(out.get(r.guestId) ?? []), r.tag]);
  return out;
}

export interface GuestSummary {
  id: string;
  name: string | null;
  displayName: string | null;
  phone: string | null;
  tags: string[];
  bookings: number;
  visits: number;
  lastNight: string | null;
}

/** The club's guests matching `q` (name, LINE name or phone, substring) and `tag`, most recent booking first. */
export async function searchGuests(db: Db, club: Pick<Club, 'id' | 'status'>, opts: { q?: string; tag?: string; limit?: number }): Promise<GuestSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const q = opts.q?.trim();
  const pattern = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : undefined;
  const tag = opts.tag ? normalizeTag(opts.tag) : undefined;
  const lastNight = sql<string | null>`max(${bookings.nightDate})`;
  const rows = await db
    .select({
      id: guests.id,
      name: guests.name,
      displayName: guests.displayName,
      phone: guests.phone,
      bookings: sql<number>`count(${bookings.id})::int`,
      visits: sql<number>`count(${bookings.id}) filter (where ${bookings.status} in ('arrived','completed'))::int`,
      lastNight,
    })
    .from(guests)
    .leftJoin(bookings, and(eq(bookings.guestId, guests.id), eq(bookings.clubId, club.id)))
    .where(
      and(
        eq(guests.clubId, club.id),
        hidesTestRows(club) ? eq(guests.isTest, false) : undefined,
        pattern ? or(ilike(guests.name, pattern), ilike(guests.displayName, pattern), ilike(guests.phone, pattern)) : undefined,
        tag
          ? inArray(
              guests.id,
              db.select({ id: guestTags.guestId }).from(guestTags).where(and(eq(guestTags.clubId, club.id), eq(guestTags.tag, tag))),
            )
          : undefined,
      ),
    )
    .groupBy(guests.id)
    .orderBy(sql`${lastNight} desc nulls last`, desc(guests.createdAt))
    .limit(limit);
  const tags = await tagsOf(db, club.id, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, tags: tags.get(r.id) ?? [] }));
}

export interface GuestProfile {
  guest: { id: string; name: string | null; displayName: string | null; phone: string | null; lang: string; createdAt: string };
  tags: string[];
  notes: { id: string; text: string; author: string | null; createdAt: string }[];
  stats: { bookings: number; visits: number; noShows: number; spendSatang: number; lastVisit: string | null };
  bookings: { id: string; ref: string; nightDate: string; status: string; pax: number; tableCode: string | null; spendSatang: number | null }[];
}

/** One guest's history, tags and notes; undefined when the guest is not the club's (or a hidden test guest). */
export async function guestProfile(db: Db, club: Pick<Club, 'id' | 'status'>, guestId: string): Promise<GuestProfile | undefined> {
  const g = await clubGuest(db, club, guestId);
  if (!g) return undefined;
  const rows = await db
    .select({ id: bookings.id, ref: bookings.refCode, nightDate: bookings.nightDate, status: bookings.status, pax: bookings.pax, tableCode: tables.code })
    .from(bookings)
    .leftJoin(tables, eq(tables.id, bookings.tableId))
    .where(and(eq(bookings.clubId, club.id), eq(bookings.guestId, g.id)))
    .orderBy(desc(bookings.nightDate), desc(bookings.createdAt));
  const bills = rows.length
    ? await db
        .select({ bookingId: posBills.bookingId, total: posBills.totalSatang })
        .from(posBills)
        .where(and(eq(posBills.clubId, club.id), inArray(posBills.bookingId, rows.map((r) => r.id))))
    : [];
  const spendOf = new Map<string, number>();
  for (const b of bills) if (b.bookingId && b.total !== null) spendOf.set(b.bookingId, (spendOf.get(b.bookingId) ?? 0) + b.total);
  const notes = await db
    .select({ id: guestNotes.id, text: guestNotes.text, author: users.name, createdAt: guestNotes.createdAt })
    .from(guestNotes)
    .leftJoin(users, eq(users.id, guestNotes.authorId))
    .where(and(eq(guestNotes.clubId, club.id), eq(guestNotes.guestId, g.id)))
    .orderBy(desc(guestNotes.createdAt), desc(guestNotes.id));
  const visits = rows.filter((r) => ARRIVED.has(r.status));
  return {
    guest: { id: g.id, name: g.name, displayName: g.displayName, phone: g.phone, lang: g.lang, createdAt: g.createdAt.toISOString() },
    tags: (await tagsOf(db, club.id, [g.id])).get(g.id) ?? [],
    notes: notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    stats: {
      bookings: rows.length,
      visits: visits.length,
      noShows: rows.filter((r) => r.status === 'no_show').length,
      spendSatang: [...spendOf.values()].reduce((s, v) => s + v, 0),
      lastVisit: visits[0]?.nightDate ?? null,
    },
    bookings: rows.map((r) => ({ ...r, spendSatang: spendOf.get(r.id) ?? null })),
  };
}

/** Adds a tag (idempotent); returns the guest's tags. */
export async function addTag(db: Db, clubId: string, guestId: string, tag: string, actorId: string | null, now: Date): Promise<string[]> {
  const t = normalizeTag(tag);
  const g = await requireGuest(db, clubId, guestId);
  await db.insert(guestTags).values({ guestId: g.id, clubId, tag: t, createdBy: actorId, createdAt: now }).onConflictDoNothing();
  return (await tagsOf(db, clubId, [g.id])).get(g.id) ?? [];
}

/** Removes a tag (no error when absent); returns the guest's tags. */
export async function removeTag(db: Db, clubId: string, guestId: string, tag: string): Promise<string[]> {
  const g = await requireGuest(db, clubId, guestId);
  const t = tag.trim().toLowerCase().replace(/\s+/g, '-');
  await db.delete(guestTags).where(and(eq(guestTags.clubId, clubId), eq(guestTags.guestId, g.id), eq(guestTags.tag, t)));
  return (await tagsOf(db, clubId, [g.id])).get(g.id) ?? [];
}

/** Appends a staff note. Notes are never edited or deleted (data first, spec §14). */
export async function addNote(db: Db, clubId: string, guestId: string, text: string, authorId: string | null, now: Date) {
  const body = text.trim();
  if (!body || body.length > MAX_NOTE) throw new CrmError('bad_request');
  const g = await requireGuest(db, clubId, guestId);
  // Notes are listed newest first by `created_at`; keep it strictly increasing per guest so two notes in the same millisecond keep their order.
  const [last] = await db
    .select({ at: guestNotes.createdAt })
    .from(guestNotes)
    .where(and(eq(guestNotes.clubId, clubId), eq(guestNotes.guestId, g.id)))
    .orderBy(desc(guestNotes.createdAt))
    .limit(1);
  const at = last && last.at.getTime() >= now.getTime() ? new Date(last.at.getTime() + 1) : now;
  const [row] = await db.insert(guestNotes).values({ id: newId(), clubId, guestId: g.id, text: body, authorId, createdAt: at }).returning();
  return row!;
}

/**
 * VIP section of the weekly report (plan A20d): guests tagged `vip` with a held booking in the
 * week starting `weekStart`, their held bookings, arrivals and POS spend. Test rows dropped unless the club is a demo.
 */
export async function vipSummary(db: Db, clubId: string, weekStart: string): Promise<{ guests: number; bookings: number; arrived: number; spendSatang: number }> {
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  const empty = { guests: 0, bookings: 0, arrived: 0, spendSatang: 0 };
  if (!club) return empty;
  const withTest = club.status === 'demo';
  const rows = (
    await db
      .select({ id: bookings.id, guestId: bookings.guestId, status: bookings.status, isTest: bookings.isTest })
      .from(bookings)
      .innerJoin(guestTags, and(eq(guestTags.guestId, bookings.guestId), eq(guestTags.clubId, clubId), eq(guestTags.tag, VIP_TAG)))
      .where(
        and(
          eq(bookings.clubId, clubId),
          gte(bookings.nightDate, weekStart),
          lte(bookings.nightDate, addDays(weekStart, 6)),
          inArray(bookings.status, [...HELD]),
        ),
      )
  ).filter((r) => withTest || !r.isTest);
  if (!rows.length) return empty;
  const bills = await db
    .select({ total: posBills.totalSatang })
    .from(posBills)
    .where(and(eq(posBills.clubId, clubId), inArray(posBills.bookingId, rows.map((r) => r.id))));
  return {
    guests: new Set(rows.map((r) => r.guestId)).size,
    bookings: rows.length,
    arrived: rows.filter((r) => ARRIVED.has(r.status)).length,
    spendSatang: bills.reduce((s, b) => s + (b.total ?? 0), 0),
  };
}
