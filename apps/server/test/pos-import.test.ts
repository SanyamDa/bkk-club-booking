import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable } from '../src/bookings/service.js';
import type { Db } from '../src/db/client.js';
import { bookings, events, posBills, tables, type Club } from '../src/db/schema.js';
import { importPosReport, parseReport, WONGNAI_FOODSTORY_COLUMN_MAP, type PosColumnMap } from '../src/integrations/pos/csv-import.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { loginAs, makeUser, staffUrl, testConfig } from './helpers/track-a.js';

const SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures', 'pos-report-synthetic.csv'), 'utf8');

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

/** An arrived booking on `code` for Friday night. */
async function arrivedBooking(club: Club, code: string, pax: number) {
  const [table] = await db.select().from(tables).where(and(eq(tables.clubId, club.id), eq(tables.code, code)));
  const guest = await makeGuest(db, { clubId: club.id });
  const b = await holdTable(db, club, { guestId: guest.id, tableId: table!.id, nightDate: FRIDAY, pax }, FRIDAY_AFTERNOON);
  await db.update(bookings).set({ status: 'arrived', arrivedAt: FRIDAY_AFTERNOON, holdExpiresAt: null }).where(eq(bookings.id, b.id));
  return b;
}

const billsOf = (club: Club) => db.select().from(posBills).where(eq(posBills.clubId, club.id));

describe('POS report import, level L0 (plan A11, spec §11.3)', () => {
  it('parses the synthetic report with the column map: table_code, covers, Bangkok times, satang totals', () => {
    const { bills, errors } = parseReport(SAMPLE, WONGNAI_FOODSTORY_COLUMN_MAP);
    expect(errors).toEqual([]);
    expect(bills).toHaveLength(4);
    expect(bills[0]).toEqual({
      ref: 'INV-0001',
      tableCode: 'B1',
      covers: 6,
      openedAt: new Date('2026-11-27T15:15:00Z'),
      closedAt: new Date('2026-11-27T19:40:00Z'),
      totalSatang: 1_845_000,
    });
    expect(bills[2]!.tableCode).toBeNull();
    expect(bills[3]!.totalSatang).toBe(2_690_050);
  });

  it('the column map is swappable: a different header set parses with its own map', () => {
    const map: PosColumnMap = { ...WONGNAI_FOODSTORY_COLUMN_MAP, billRef: ['Receipt'], tableCode: ['Tbl'], covers: ['Pax'], openedAt: ['Opened'], closedAt: ['Closed'], total: ['Amount'] };
    const csv = 'Receipt,Tbl,Pax,Opened,Closed,Amount\nR9,T2,3,2026-11-27 21:00,2026-11-27 23:00,1000\n';
    const { bills } = parseReport(csv, map);
    expect(bills).toEqual([{ ref: 'R9', tableCode: 'T2', covers: 3, openedAt: new Date('2026-11-27T14:00:00Z'), closedAt: new Date('2026-11-27T16:00:00Z'), totalSatang: 100_000 }]);
  });

  it('a report missing a required column is rejected with the column named', () => {
    const { bills, errors } = parseReport('Table,Guests\nB1,4\n', WONGNAI_FOODSTORY_COLUMN_MAP);
    expect(bills).toEqual([]);
    expect(errors[0]).toMatch(/billRef/);
  });

  it('import maps rows to pos_bills, matches a booking by table and night, and leaves walk-ins without a booking', async () => {
    const booking = await arrivedBooking(clubA, 'B1', 6);
    const result = await importPosReport(db, clubA, SAMPLE, { now: FRIDAY_AFTERNOON });
    expect(result).toMatchObject({ imported: 4, created: 4, updated: 0, matched: 1, walkIns: 3, errors: [] });

    const rows = await billsOf(clubA);
    expect(rows).toHaveLength(4);
    const byRef = new Map(rows.map((r) => [r.providerBillId, r]));
    expect(byRef.get('INV-0001')).toMatchObject({ bookingId: booking.id, tableCode: 'B1', covers: 6, totalSatang: 1_845_000 });
    expect(byRef.get('INV-0002')).toMatchObject({ bookingId: null, tableCode: 'T1', covers: 2 });
    expect(byRef.get('INV-0003')).toMatchObject({ bookingId: null, tableCode: null });
    // Opened 01:30 Saturday Bangkok: still Friday's night (nightEndHour 6), but V2 has no booking.
    expect(byRef.get('INV-0004')!.bookingId).toBeNull();

    const matchedEvents = await db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, 'pos.bill_matched')));
    expect(matchedEvents).toHaveLength(1);
    expect(matchedEvents[0]).toMatchObject({ bookingId: booking.id, dataOrigin: 'pos', nightDate: FRIDAY });
  });

  it('re-importing the same report is idempotent and updates changed totals in place', async () => {
    await importPosReport(db, clubA, SAMPLE, { now: FRIDAY_AFTERNOON });
    const changed = SAMPLE.replace('"3,200.00"', '"3,900.00"');
    const again = await importPosReport(db, clubA, changed, { now: FRIDAY_AFTERNOON });
    expect(again).toMatchObject({ imported: 4, created: 0, updated: 4 });
    const rows = await billsOf(clubA);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.providerBillId === 'INV-0002')!.totalSatang).toBe(390_000);
    const closed = await db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, 'pos.bill_closed')));
    expect(closed).toHaveLength(4);
  });

  it('the same bill ref in two clubs is two bills, and a booking of another club is never matched', async () => {
    await arrivedBooking(clubB, 'V2', 6);
    await importPosReport(db, clubA, SAMPLE, { now: FRIDAY_AFTERNOON });
    const b = await importPosReport(db, clubB, SAMPLE, { now: FRIDAY_AFTERNOON });
    expect(b.created).toBe(4);
    expect(await billsOf(clubA)).toHaveLength(4);
    const rowsA = await billsOf(clubA);
    expect(rowsA.every((r) => r.bookingId === null)).toBe(true);
  });
});

describe('POST /api/staff/clubs/:slug/pos/import', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(testConfig(), db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
  });

  async function upload(cookie: string, slug: string, body: string | FormData, contentType?: string) {
    return app.app.request(staffUrl(slug, '/pos/import'), {
      method: 'POST',
      headers: { cookie, ...(contentType ? { 'content-type': contentType } : {}) },
      body,
    });
  }

  it('a manager uploads the CSV as a multipart file and gets the import summary', async () => {
    const cookie = await loginAs(app, await makeUser(db, { email: 'mgr@test.local', clubId: clubA.id, role: 'manager' }));
    const form = new FormData();
    form.append('file', new Blob([SAMPLE], { type: 'text/csv' }), 'report.csv');
    const res = await upload(cookie, clubA.slug, form);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 4, created: 4, walkIns: 4, matched: 0 });
    expect(await billsOf(clubA)).toHaveLength(4);
  });

  it('an owner may upload a raw text/csv body', async () => {
    const cookie = await loginAs(app, await makeUser(db, { email: 'own@test.local', clubId: clubA.id, role: 'owner' }));
    const res = await upload(cookie, clubA.slug, SAMPLE, 'text/csv');
    expect(res.status).toBe(200);
  });

  it('host and door get 403; another club slug gets 403', async () => {
    for (const role of ['host', 'door'] as const) {
      const cookie = await loginAs(app, await makeUser(db, { email: `${role}@test.local`, clubId: clubA.id, role }));
      expect((await upload(cookie, clubA.slug, SAMPLE, 'text/csv')).status).toBe(403);
    }
    const cookie = await loginAs(app, await makeUser(db, { email: 'mgr2@test.local', clubId: clubA.id, role: 'manager' }));
    expect((await upload(cookie, clubB.slug, SAMPLE, 'text/csv')).status).toBe(403);
    expect(await billsOf(clubB)).toHaveLength(0);
  });

  it('an empty upload or a report without the mapped columns answers 400 bad_report', async () => {
    const cookie = await loginAs(app, await makeUser(db, { email: 'mgr3@test.local', clubId: clubA.id, role: 'manager' }));
    const empty = await upload(cookie, clubA.slug, '', 'text/csv');
    expect(empty.status).toBe(400);
    const wrong = await upload(cookie, clubA.slug, 'Foo,Bar\n1,2\n', 'text/csv');
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'bad_report' });
  });

  it('a chunked upload over 5 MB with no Content-Length answers 413', async () => {
    const cookie = await loginAs(app, await makeUser(db, { email: 'mgr4@test.local', clubId: clubA.id, role: 'manager' }));
    const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent++ < 6) ctrl.enqueue(chunk);
        else ctrl.close();
      },
    });
    const res = await app.app.request(staffUrl(clubA.slug, '/pos/import'), {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/csv' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(await billsOf(clubA)).toHaveLength(0);
  });
});
