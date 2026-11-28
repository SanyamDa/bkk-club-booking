import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { latestSnapshot } from '../src/brain/compile.js';
import type { OcrFn } from '../src/brain/import.js';
import { anthropicOcr, MAX_IMPORT_IMAGE_BYTES, NO_TEXT, OCR_MODEL, type OcrMessagesClient } from '../src/brain/ocr.js';
import type { Db } from '../src/db/client.js';
import { brainNotes, type Club } from '../src/db/schema.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { loginAs, makeUser, staffUrl, testConfig } from './helpers/track-a.js';

/** Spec §8.2 photo import: OCR (Anthropic vision behind `OcrFn`) turns a photo into draft notes. Fakes only. */

const NOW = FRIDAY_AFTERNOON;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const RULES = ['# House rules', 'Age 20+ with ID.', '', '# Dress code', 'Smart casual, no flip-flops.', '', '# Bottles', 'Minimum spend 20,000 baht.'].join('\n');

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

/** A fake Anthropic client: records every request and answers with `reply` (or throws). */
function fakeClient(reply: () => string): OcrMessagesClient & { calls: Parameters<OcrMessagesClient['messages']['create']>[0][] } {
  const calls: Parameters<OcrMessagesClient['messages']['create']>[0][] = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        return { content: [{ type: 'text', text: reply(), citations: null }], stop_reason: 'end_turn' };
      },
    },
  };
}

async function setup(ocr: OcrFn | null, clubId = clubB.id, email = 'manager-b@test.local') {
  const app = createApp(testConfig(), db, { bot: { now: () => NOW, log: () => {} }, ocr });
  const manager = await makeUser(db, { email, clubId, role: 'manager' });
  const cookie = await loginAs(app, manager);
  return { app, cookie };
}

function upload(app: ReturnType<typeof createApp>, cookie: string, slug: string, bytes: Uint8Array, type = 'image/jpeg', name = 'rules.jpg') {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return app.app.request(staffUrl(slug, '/brain/import-photo'), { method: 'POST', headers: { cookie }, body: form });
}

describe('brain photo import (OCR)', () => {
  it('image upload creates draft notes', async () => {
    const client = fakeClient(() => RULES);
    const { app, cookie } = await setup(anthropicOcr(client));
    const before = (await latestSnapshot(db, clubB.id))?.version ?? 0;

    const res = await upload(app, cookie, clubB.slug, JPEG);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: { title: string; status: string; source: string }[]; rejected: { title: string; issues: { code: string }[] }[] };
    expect(body.created.map((n) => n.title)).toEqual(['House rules', 'Dress code']);
    expect(body.created.every((n) => n.status === 'draft' && n.source === 'import')).toBe(true);
    // A section with a price fails the price lint and is not saved.
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.issues[0]!.code).toBe('price');
    expect(await notesOf(clubB.id)).toHaveLength(2);
    expect((await latestSnapshot(db, clubB.id))?.version ?? 0).toBe(before);

    // The adapter sent the image to the OCR model as base64 with its sniffed type.
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.model).toBe(OCR_MODEL);
    expect(OCR_MODEL).toBe('claude-haiku-5-5');
    const content = call.messages[0]!.content as { type: string; source?: { type: string; media_type: string; data: string } }[];
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(JPEG).toString('base64') } });
    expect(String(call.system)).toMatch(/price/i);
  });

  it('the sniffed type is sent, not the declared one', async () => {
    const client = fakeClient(() => '# Parking\nValet at the front door.');
    const { app, cookie } = await setup(anthropicOcr(client));
    const res = await upload(app, cookie, clubB.slug, PNG, 'image/jpeg', 'menu.jpg');
    expect(res.status).toBe(200);
    const content = client.calls[0]!.messages[0]!.content as { source?: { media_type: string } }[];
    expect(content[0]!.source!.media_type).toBe('image/png');
  });

  it('OCR failure gives a clear error and no note', async () => {
    const client: OcrMessagesClient = {
      messages: {
        async create() {
          throw new Error('529 overloaded');
        },
      },
    };
    const { app, cookie } = await setup(anthropicOcr(client));
    const res = await upload(app, cookie, clubB.slug, JPEG);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('ocr_failed');
    expect(body.message).toMatch(/could not be read/);
    expect(body.message).toMatch(/paste the text/);
    expect(await notesOf(clubB.id)).toHaveLength(0);

    // A photo with no readable text is a clear error too, and makes no note.
    const blank = await setup(anthropicOcr(fakeClient(() => NO_TEXT)), clubB.id, 'manager-b2@test.local');
    const res2 = await upload(blank.app, blank.cookie, clubB.slug, JPEG);
    expect(res2.status).toBe(422);
    expect(((await res2.json()) as { error: string }).error).toBe('no_text');
    expect(await notesOf(clubB.id)).toHaveLength(0);

    // A thrown plain OcrFn error is wrapped the same way.
    const plain = await setup(async () => {
      throw new Error('boom');
    }, clubB.id, 'manager-b3@test.local');
    const res3 = await upload(plain.app, plain.cookie, clubB.slug, JPEG);
    expect(res3.status).toBe(502);
    expect(((await res3.json()) as { error: string }).error).toBe('ocr_failed');
  });

  it('size and type limits', async () => {
    const client = fakeClient(() => '# Parking\nValet.');
    const { app, cookie } = await setup(anthropicOcr(client));

    // Over 5 MB: 413, before any OCR call.
    const big = new Uint8Array(MAX_IMPORT_IMAGE_BYTES + 1);
    big.set(JPEG);
    const tooBig = await upload(app, cookie, clubB.slug, big);
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: string }).error).toBe('too_large');

    // Not an image (even when it claims to be one): 415.
    const pdf = await upload(app, cookie, clubB.slug, new TextEncoder().encode('%PDF-1.7 rules'), 'image/jpeg', 'rules.jpg');
    expect(pdf.status).toBe(415);
    expect(((await pdf.json()) as { error: string; message: string }).message).toMatch(/JPEG, PNG, WebP or GIF/);
    const text = await upload(app, cookie, clubB.slug, new TextEncoder().encode('just text'), 'text/plain', 'rules.txt');
    expect(text.status).toBe(415);

    // No file field: 400.
    const none = await app.app.request(staffUrl(clubB.slug, '/brain/import-photo'), { method: 'POST', headers: { cookie }, body: new FormData() });
    expect(none.status).toBe(400);

    expect(client.calls).toHaveLength(0);
    expect(await notesOf(clubB.id)).toHaveLength(0);
  });

  it('no OCR provider configured gives 503 and no note', async () => {
    const { app, cookie } = await setup(null);
    const res = await upload(app, cookie, clubB.slug, JPEG);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('ocr_not_configured');
    expect(await notesOf(clubB.id)).toHaveLength(0);
  });

  it('cross-club isolation', async () => {
    const client = fakeClient(() => '# Parking\nValet at the front door.');
    // A manager of club A cannot import into club B.
    const a = await setup(anthropicOcr(client), clubA.id, 'manager-a@test.local');
    const res = await upload(a.app, a.cookie, clubB.slug, JPEG);
    expect([403, 404]).toContain(res.status);
    expect(client.calls).toHaveLength(0);
    expect(await notesOf(clubB.id)).toHaveLength(0);

    // Their own import lands only in club A.
    const own = await upload(a.app, a.cookie, clubA.slug, JPEG);
    expect(own.status).toBe(200);
    expect((await notesOf(clubA.id)).filter((n) => n.title === 'Parking')).toHaveLength(1);
    expect(await notesOf(clubB.id)).toHaveLength(0);
  });

  it('staff below manager cannot import a photo', async () => {
    const client = fakeClient(() => '# Parking\nValet.');
    const app = createApp(testConfig(), db, { bot: { now: () => NOW, log: () => {} }, ocr: anthropicOcr(client) });
    const host = await makeUser(db, { email: 'host-b@test.local', clubId: clubB.id, role: 'host' });
    const res = await upload(app, await loginAs(app, host), clubB.slug, JPEG);
    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });
});
