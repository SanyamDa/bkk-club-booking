import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Actor } from '../src/bookings/service.js';
import { BRAIN_TOKEN_CAP, compileSnapshot, compileText, estimateTokens, latestSnapshot } from '../src/brain/compile.js';
import { exportObsidianFolder, noteLinks } from '../src/brain/export.js';
import { importObsidianFolder, importPastedText, importPhoto } from '../src/brain/import.js';
import { regenerateLayoutNote } from '../src/brain/layout.js';
import { BrainLintError, lintNote } from '../src/brain/lint.js';
import { approveNote, createNote, listNotes, noteVersions, updateNote } from '../src/brain/notes.js';
import type { Db } from '../src/db/client.js';
import { VELORA } from '../src/demo/velora-content.js';
import { alerts, brainNotes, brainSnapshots, events, tables, type Club } from '../src/db/schema.js';
import { brainDigest, runBrainExpiry, sendBrainDigests } from '../src/jobs/brain-expiry.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { loginAs, makeUser, staffUrl, testConfig } from './helpers/track-a.js';

const NOW = FRIDAY_AFTERNOON; // Friday 27 Nov 2026, 15:00 Bangkok
const staffActor: Actor = { type: 'staff', id: 'user_manager' };

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
});
afterEach(async () => {
  await close();
});

const notesOf = (clubId: string) => db.select().from(brainNotes).where(eq(brainNotes.clubId, clubId));

async function liveFaq(clubId: string, title: string, bodyMd: string, slug?: string) {
  const n = await createNote(db, { clubId, title, type: 'faq', bodyMd, source: 'manual', slug }, staffActor, NOW);
  return approveNote(db, clubId, n.id, staffActor, NOW);
}

describe('B15 brain store', () => {
  it('note with a price is rejected at save', async () => {
    const cases = [
      'Minimum spend is 15,000 for VIP tables.',
      'Minimum spend 2.5k for VIP',
      'Minimum spend 10k for VIP',
      'Entry costs ฿500 after midnight.',
      'ค่าเข้า 500 บาท',
      'มัดจำ 3000 ก่อนวันงาน',
      'Tables are still available tonight.',
    ];
    for (const bodyMd of cases) {
      await expect(createNote(db, { clubId: clubB.id, title: 'Prices', type: 'faq', bodyMd, source: 'manual' }, staffActor, NOW)).rejects.toBeInstanceOf(BrainLintError);
    }
    expect(await notesOf(clubB.id)).toHaveLength(0);

    // The Velora baseline FAQs and policies pass (they state no prices).
    for (const f of VELORA.faqs) {
      expect(lintNote({ type: 'faq', title: f.slug, bodyMd: `${f.answer_en}\n\n${f.answer_th}` }), f.slug).toEqual([]);
    }
    for (const p of VELORA.policies) expect(lintNote({ type: 'policy', title: 'policy', bodyMd: `${p.en}\n\n${p.th}` }), p.en).toEqual([]);

    // Times and durations near the word "deposit" are not amounts.
    expect(lintNote({ type: 'faq', title: 'Cancel', bodyMd: 'Your deposit is refunded if you cancel 24 hours before. Doors open 20:00.' })).toEqual([]);
    const err = await createNote(db, { clubId: clubB.id, title: 'P', type: 'faq', bodyMd: 'Deposit 2000', source: 'manual' }, staffActor, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrainLintError);
    expect((err as BrainLintError).issues[0]!.code).toBe('price');
    expect((err as BrainLintError).fix).toBe('prices');

    // An edit is linted the same way and leaves the note unchanged.
    const ok = await createNote(db, { clubId: clubB.id, title: 'Dress code', type: 'faq', bodyMd: 'Smart casual.', source: 'manual' }, staffActor, NOW);
    await expect(updateNote(db, clubB.id, ok.id, { bodyMd: 'Smart casual. Entry 300 baht.' }, staffActor, NOW)).rejects.toBeInstanceOf(BrainLintError);
    expect((await notesOf(clubB.id))[0]!.bodyMd).toBe('Smart casual.');
    expect(await noteVersions(db, clubB.id, ok.id)).toHaveLength(1);
  });

  it('compile is deterministic and hashed', async () => {
    await liveFaq(clubB.id, 'Parking', 'Valet at the front door. See [[dress-code]].', 'parking');
    await liveFaq(clubB.id, 'Dress code', 'Smart casual, no sportswear.', 'dress-code');
    await createNote(db, { clubId: clubB.id, title: 'Draft only', type: 'faq', bodyMd: 'Not live yet.', source: 'manual' }, staffActor, NOW);

    const snap = (await latestSnapshot(db, clubB.id))!;
    expect(snap.version).toBe(2); // one per approval
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.compiledText).toContain('Valet at the front door');
    expect(snap.compiledText).not.toContain('Not live yet');
    expect(snap.tokenCount).toBe(estimateTokens(snap.compiledText));
    // Notes are ordered by slug inside a type, whatever order they were written in.
    expect(snap.compiledText.indexOf('Dress code')).toBeLessThan(snap.compiledText.indexOf('Parking'));

    // Same notes, same text, same hash; recompiling writes no new version.
    const again = await compileSnapshot(db, clubB.id, new Date(NOW.getTime() + 3_600_000));
    expect(again.status).toBe('unchanged');
    expect(await db.select().from(brainSnapshots).where(eq(brainSnapshots.clubId, clubB.id))).toHaveLength(2);
    const notes = await listNotes(db, clubB.id, { status: 'live' });
    expect(compileText([...notes].reverse())).toBe(compileText(notes));
    expect(compileText(notes)).toBe(snap.compiledText);

    // Another club's brain is its own.
    expect(await latestSnapshot(db, clubA.id)).toBeUndefined();
  });

  it('over 60k refuses to publish', async () => {
    const big = 'Smart casual and friendly staff. '.repeat(Math.ceil((BRAIN_TOKEN_CAP * 4) / 33) + 10);
    expect(estimateTokens(big)).toBeGreaterThan(BRAIN_TOKEN_CAP);
    await liveFaq(clubB.id, 'Small', 'Valet parking.', 'small');
    const before = (await latestSnapshot(db, clubB.id))!;
    const n = await createNote(db, { clubId: clubB.id, title: 'Huge', type: 'faq', bodyMd: big, source: 'manual' }, staffActor, NOW);
    await expect(approveNote(db, clubB.id, n.id, staffActor, NOW)).rejects.toThrow(/over_cap/);
    // The approval was rolled back and the live snapshot is unchanged.
    expect((await db.query.brainNotes.findFirst({ where: eq(brainNotes.id, n.id) }))!.status).toBe('draft');
    expect((await latestSnapshot(db, clubB.id))!.version).toBe(before.version);

    // A direct compile over the cap writes nothing either.
    await db.update(brainNotes).set({ status: 'live' }).where(eq(brainNotes.id, n.id));
    const res = await compileSnapshot(db, clubB.id, NOW);
    expect(res.status).toBe('over_cap');
    expect((await latestSnapshot(db, clubB.id))!.version).toBe(before.version);
  });

  it('export then import round-trips notes and links', async () => {
    await liveFaq(clubB.id, 'Parking', 'Valet at the front door. See [[dress-code|the dress code]] and [[age]].', 'parking');
    await liveFaq(clubB.id, 'Dress code', 'Smart casual. ห้ามใส่รองเท้าแตะ', 'dress-code');
    await createNote(db, { clubId: clubB.id, title: 'Songkran party', type: 'event', bodyMd: 'Water party on the terrace.', source: 'manual', validUntil: '2027-04-15' }, staffActor, NOW);

    const files = await exportObsidianFolder(db, clubB.id);
    expect(files.map((f) => f.path).sort()).toEqual(['dress-code.md', 'parking.md', 'songkran-party.md']);
    const parking = files.find((f) => f.path === 'parking.md')!;
    expect(parking.content.startsWith('---\n')).toBe(true);
    expect(parking.content).toContain('[[dress-code|the dress code]]');
    expect(noteLinks(parking.content)).toEqual(['dress-code', 'age']);

    // Import into the other club: every note arrives, as a draft, with its links intact.
    const res = await importObsidianFolder(db, clubA.id, files, staffActor, NOW);
    expect(res).toMatchObject({ created: 3, superseding: 0, unchanged: 0, rejected: [] });
    const imported = await listNotes(db, clubA.id);
    const original = await listNotes(db, clubB.id);
    const shape = (ns: typeof original) =>
      ns.map((n) => ({ slug: n.slug, title: n.title, type: n.type, bodyMd: n.bodyMd, validUntil: n.validUntil, links: noteLinks(n.bodyMd) })).sort((a, b) => a.slug.localeCompare(b.slug));
    expect(shape(imported)).toEqual(shape(original));
    expect(imported.every((n) => n.status === 'draft' && n.source === 'import')).toBe(true);
    // Re-exporting the imported club gives the same files except the status line.
    const reexport = await exportObsidianFolder(db, clubA.id);
    const strip = (c: string) => c.replace(/^status: .*$/m, '');
    expect(reexport.map((f) => strip(f.content)).sort()).toEqual(files.map((f) => strip(f.content)).sort());

    // Import back into the same club: unchanged notes are skipped, an edited one supersedes.
    const edited = files.map((f) => (f.path === 'parking.md' ? { ...f, content: f.content.replace('front door', 'side door') } : f));
    const back = await importObsidianFolder(db, clubB.id, edited, staffActor, NOW);
    expect(back).toMatchObject({ created: 0, superseding: 1, unchanged: 2 });
    const draft = (await listNotes(db, clubB.id, { status: 'draft' })).find((n) => n.slug !== 'songkran-party')!;
    expect(draft.supersedesId).toBe(original.find((n) => n.slug === 'parking')!.id);
  });

  it('a hand-made Obsidian file name that is not a slug re-imports without duplicates', async () => {
    const files = [
      { path: 'Dress Code.md', content: '---\ntype: "faq"\n---\n\nSmart casual.\n' },
      { path: 'การแต่งกาย.md', content: '---\ntype: "faq"\n---\n\nห้ามใส่รองเท้าแตะ\n' },
    ];
    const first = await importObsidianFolder(db, clubB.id, files, staffActor, NOW);
    expect(first).toMatchObject({ created: 2, superseding: 0, unchanged: 0, rejected: [] });
    const slugs = (await notesOf(clubB.id)).map((n) => n.slug);
    expect(slugs).toContain('dress-code');
    const again = await importObsidianFolder(db, clubB.id, files, staffActor, NOW);
    expect(again).toMatchObject({ created: 0, superseding: 0, unchanged: 2 });
    expect(await notesOf(clubB.id)).toHaveLength(2);
    // An edited file supersedes the note with the same slug.
    const edited = await importObsidianFolder(db, clubB.id, [{ ...files[0]!, content: files[0]!.content.replace('Smart casual.', 'Smart casual, no shorts.') }], staffActor, NOW);
    expect(edited).toMatchObject({ created: 0, superseding: 1 });
    expect((await notesOf(clubB.id)).filter((n) => n.slug.startsWith('dress-code'))).toHaveLength(2);
  });

  it('pasted text becomes draft notes, never live', async () => {
    const before = (await latestSnapshot(db, clubB.id))?.version ?? 0;
    const pasted = ['# Parking', 'Valet at the front door.', '', '# Dress code', 'Smart casual, no flip-flops.', '', '# VIP', 'Minimum spend 20,000 baht.'].join('\n');
    const res = await importPastedText(db, clubB.id, pasted, staffActor, NOW);
    expect(res.created.map((n) => n.title)).toEqual(['Parking', 'Dress code']);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.issues[0]!.code).toBe('price');
    const all = await notesOf(clubB.id);
    expect(all).toHaveLength(2);
    expect(all.every((n) => n.status === 'draft' && n.source === 'import')).toBe(true);
    expect((await latestSnapshot(db, clubB.id))?.version ?? 0).toBe(before);
    const drafted = await db.select().from(events).where(and(eq(events.clubId, clubB.id), eq(events.type, 'brain.note_drafted')));
    expect(drafted).toHaveLength(2);
    expect(drafted[0]!.props).toMatchObject({ source: 'import', noteType: 'faq' });

    // Plain paragraphs without headings become one note each.
    const plain = await importPastedText(db, clubB.id, 'No sportswear after 22:00.\n\nLost property: ask at the bar.', staffActor, NOW);
    expect(plain.created).toHaveLength(2);
    expect(plain.created.every((n) => n.status === 'draft')).toBe(true);
  });

  it('photo import runs the injected OCR and makes draft notes', async () => {
    const seen: string[] = [];
    const fakeOcr = async (img: { bytes: Uint8Array; mimeType: string }) => {
      seen.push(img.mimeType);
      return '# House rules\nAge 20+ with ID.';
    };
    const res = await importPhoto(db, clubB.id, { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }, fakeOcr, staffActor, NOW);
    expect(seen).toEqual(['image/jpeg']);
    expect(res.created).toHaveLength(1);
    expect(res.created[0]).toMatchObject({ title: 'House rules', status: 'draft', source: 'import' });
  });

  it('a table change regenerates the layout note', async () => {
    const first = (await regenerateLayoutNote(db, clubB.id, NOW))!;
    expect(first).toMatchObject({ slug: 'layout', type: 'layout', status: 'live' });
    expect(first.bodyMd).toContain('V1');
    expect(first.bodyMd).not.toMatch(/฿|บาท|baht/i);
    expect(lintNote(first)).toEqual([]);
    // Unchanged tables: same note, no new version.
    await regenerateLayoutNote(db, clubB.id, NOW);
    expect(await noteVersions(db, clubB.id, first.id)).toHaveLength(1);

    // A table added through staff settings regenerates it.
    const app = createApp(testConfig(), db, { bot: { now: () => NOW, log: () => {} } });
    const manager = await makeUser(db, { email: 'manager-b@test.local', clubId: clubB.id, role: 'manager' });
    const cookie = await loginAs(app, manager);
    const res = await app.app.request(staffUrl(clubB.slug, '/tables'), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'S9', zoneId: 'zone_b_std', minPax: 2, maxPax: 6 }),
    });
    expect(res.status).toBe(201);
    const layout = (await db.query.brainNotes.findFirst({ where: and(eq(brainNotes.clubId, clubB.id), eq(brainNotes.slug, 'layout')) }))!;
    expect(layout.id).toBe(first.id);
    expect(layout.bodyMd).toContain('S9');
    expect(await noteVersions(db, clubB.id, first.id)).toHaveLength(2);
    expect((await latestSnapshot(db, clubB.id))!.compiledText).toContain('S9');
    // Club A has no layout note from club B's tables.
    expect((await notesOf(clubA.id)).some((n) => n.bodyMd.includes('S9'))).toBe(false);
  });

  it('deactivating every table retires the layout note and drops its codes from the brain', async () => {
    const first = (await regenerateLayoutNote(db, clubB.id, NOW))!;
    expect((await latestSnapshot(db, clubB.id))!.compiledText).toContain('V1');
    const app = createApp(testConfig(), db, { bot: { now: () => NOW, log: () => {} } });
    const manager = await makeUser(db, { email: 'manager-b@test.local', clubId: clubB.id, role: 'manager' });
    const cookie = await loginAs(app, manager);
    for (const t of await db.select().from(tables).where(eq(tables.clubId, clubB.id))) {
      const res = await app.app.request(staffUrl(clubB.slug, `/tables/${t.id}`), {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ active: false }),
      });
      expect(res.status, t.code).toBe(200);
    }
    const note = (await db.query.brainNotes.findFirst({ where: eq(brainNotes.id, first.id) }))!;
    expect(note.status).toBe('retired');
    const text = (await latestSnapshot(db, clubB.id))?.compiledText ?? '';
    for (const code of ['V1', 'V2', 'S1', 'S2']) expect(text).not.toContain(code);
    // Tables back: a fresh live layout note.
    await db.update(tables).set({ active: true }).where(eq(tables.clubId, clubB.id));
    const back = (await regenerateLayoutNote(db, clubB.id, NOW))!;
    expect(back).toMatchObject({ slug: 'layout', status: 'live' });
    expect((await latestSnapshot(db, clubB.id))!.compiledText).toContain('V1');
  });

  it('two layout regenerations at once make one live layout note and distinct snapshot versions', async () => {
    await Promise.all([regenerateLayoutNote(db, clubB.id, NOW), regenerateLayoutNote(db, clubB.id, NOW)]);
    const live = (await notesOf(clubB.id)).filter((n) => n.slug === 'layout' && n.status === 'live');
    expect(live).toHaveLength(1);
  });

  it('an event note without an end date is rejected', async () => {
    const err = await createNote(db, { clubId: clubB.id, title: 'Halloween', type: 'event', bodyMd: 'Costume party.', source: 'manual' }, staffActor, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrainLintError);
    expect((err as BrainLintError).issues.map((i) => i.code)).toEqual(['event_needs_end_date']);
    expect(await notesOf(clubB.id)).toHaveLength(0);
    // With an end date it saves; a plain FAQ gets a 90-day review date instead.
    const ev = await createNote(db, { clubId: clubB.id, title: 'Halloween', type: 'event', bodyMd: 'Costume party.', source: 'manual', validUntil: '2026-10-31' }, staffActor, NOW);
    expect(ev.validUntil).toBe('2026-10-31');
    const faq = await createNote(db, { clubId: clubB.id, title: 'Age', type: 'faq', bodyMd: '20+ with ID.', source: 'manual' }, staffActor, NOW);
    expect(faq.reviewBy).toBe('2027-02-25');
  });

  it('an expired note is absent from the next snapshot and listed in the digest', async () => {
    await liveFaq(clubB.id, 'Parking', 'Valet at the front door.', 'parking');
    const ev = await createNote(db, { clubId: clubB.id, title: 'Black party', type: 'event', bodyMd: 'Dress in black.', source: 'manual', validUntil: '2026-11-28' }, staffActor, NOW);
    await approveNote(db, clubB.id, ev.id, staffActor, NOW);
    expect((await latestSnapshot(db, clubB.id))!.compiledText).toContain('Dress in black');

    // Monday 30 Nov 2026, 11:00 Bangkok: the Saturday night is over.
    const monday = new Date('2026-11-30T04:00:00Z');
    expect(await runBrainExpiry(db, monday)).toMatchObject({ expired: 1 });
    const snap = (await latestSnapshot(db, clubB.id))!;
    expect(snap.compiledText).not.toContain('Dress in black');
    expect(snap.compiledText).toContain('Valet at the front door');
    const row = (await db.query.brainNotes.findFirst({ where: eq(brainNotes.id, ev.id) }))!;
    expect(row.status).toBe('retired');
    // Running again changes nothing.
    expect(await runBrainExpiry(db, monday)).toMatchObject({ expired: 0 });

    const digest = await brainDigest(db, clubB.id, monday);
    expect(digest.expired.map((n) => n.id)).toEqual([ev.id]);
    expect(digest.dueForReview).toEqual([]);

    // The weekly digest goes out once as an info alert.
    await sendBrainDigests(db, monday);
    await sendBrainDigests(db, new Date(monday.getTime() + 3_600_000));
    const sent = await db.select().from(alerts).where(and(eq(alerts.clubId, clubB.id), eq(alerts.kind, 'brain_digest')));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.level).toBe('info');
    expect(sent[0]!.textEn).toContain('Black party');
    expect(await db.select().from(alerts).where(and(eq(alerts.clubId, clubA.id), eq(alerts.kind, 'brain_digest')))).toHaveLength(0);

    // A note past its review date stays in the brain and is listed for review.
    const later = new Date('2027-03-01T04:00:00Z');
    const due = await brainDigest(db, clubB.id, later);
    expect(due.dueForReview.map((n) => n.slug)).toEqual(['parking']);
    await runBrainExpiry(db, later);
    expect((await latestSnapshot(db, clubB.id))!.compiledText).toContain('Valet at the front door');
  });
});
