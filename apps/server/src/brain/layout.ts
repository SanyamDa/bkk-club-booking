import { and, asc, eq, ne } from 'drizzle-orm';
import type { Actor } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import { brainNotes, clubs, tables, zones, type BrainNote } from '../db/schema.js';
import { compileSnapshot } from './compile.js';
import { createNote, updateNote } from './notes.js';

/**
 * The layout note (spec §8.2): generated from the club's zones and tables, never typed, and
 * regenerated after every table or zone change. No prices: those come from the booking system.
 * It is saved live without approval because it is the club's own table data.
 */

export const LAYOUT_SLUG = 'layout';
const SYSTEM: Actor = { type: 'system', id: 'layout' };

export function layoutBody(zs: { id: string; name: string; nameTh: string | null }[], ts: { zoneId: string; code: string; minPax: number; maxPax: number }[]): string {
  const lines = ["Floor layout, generated from the club's tables. Change the tables in Settings, not this note.", 'ผังร้าน สร้างจากรายการโต๊ะของร้าน แก้ไขที่หน้าตั้งค่าโต๊ะ'];
  for (const z of zs) {
    const own = ts.filter((t) => t.zoneId === z.id);
    if (!own.length) continue;
    const maxGuests = own.reduce((s, t) => s + t.maxPax, 0);
    lines.push('', `## ${z.name}${z.nameTh && z.nameTh !== z.name ? ` (${z.nameTh})` : ''}`, `${own.length} tables, up to ${maxGuests} guests in all.`);
    for (const t of own) lines.push(`- ${t.code}: ${t.minPax}–${t.maxPax} guests`);
  }
  return lines.join('\n');
}

/**
 * Creates or refreshes the club's layout note. With no active tables left, the note is retired
 * and the brain recompiled, so old table codes stop being served; returns null then.
 * Runs in one transaction that first locks the club row, so two table edits at once cannot each
 * create a layout note.
 */
export async function regenerateLayoutNote(db: Db, clubId: string, now: Date): Promise<BrainNote | null> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.select({ id: clubs.id }).from(clubs).where(eq(clubs.id, clubId)).for('update');
    const zs = await tx.select().from(zones).where(eq(zones.clubId, clubId)).orderBy(asc(zones.sort), asc(zones.name));
    const ts = await tx
      .select()
      .from(tables)
      .where(and(eq(tables.clubId, clubId), eq(tables.active, true)))
      .orderBy(asc(tables.sort), asc(tables.code));
    const existing = await tx.query.brainNotes.findFirst({
      where: and(eq(brainNotes.clubId, clubId), eq(brainNotes.slug, LAYOUT_SLUG), eq(brainNotes.type, 'layout'), ne(brainNotes.status, 'retired')),
    });
    if (!ts.length) {
      if (existing) {
        await tx.update(brainNotes).set({ status: 'retired', updatedAt: now }).where(eq(brainNotes.id, existing.id));
        await compileSnapshot(tx, clubId, now);
      }
      return null;
    }
    const bodyMd = layoutBody(zs, ts);
    if (existing) {
      if (existing.bodyMd === bodyMd) return existing;
      return updateNote(tx, clubId, existing.id, { bodyMd }, SYSTEM, now);
    }
    return createNote(tx, { clubId, title: 'Floor layout', type: 'layout', bodyMd, source: 'manual', slug: LAYOUT_SLUG, status: 'live', frontmatter: { generated: true } }, SYSTEM, now);
  });
}
