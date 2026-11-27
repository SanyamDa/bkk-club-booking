import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { bookings, posBills, tables, type Club } from '../../db/schema.js';
import { emit } from '../../data/events.js';
import { currentNightDate } from '../../lib/time.js';
import type { PosAdapter, PosBill } from './adapter.js';

/**
 * Which report header holds which bill field. Each field lists accepted header names (matched
 * case- and space-insensitively); the first one present wins. `billRef` is required, the rest
 * optional. Swap the whole object to support another POS's export (spec §11.3 L0b: "a one-time
 * mapping of report columns").
 */
export interface PosColumnMap {
  billRef: string[];
  tableCode: string[];
  covers: string[];
  openedAt: string[];
  closedAt: string[];
  total: string[];
}

/**
 * Column map for the Wongnai POS / FoodStory sales report.
 *
 * UNCONFIRMED UNTIL A REAL SAMPLE ARRIVES (spec §16.1 question 13). No real export has been seen:
 * these headers are guesses (English and Thai), and the fixture `test/fixtures/pos-report-synthetic.csv`
 * is synthetic. Whether the report has one row per bill with table and time at all is also
 * unconfirmed; if it gives only daily totals, L0b yields a nightly total, not spend per booking.
 * Replace this object (and the fixture) from the first real report.
 */
export const WONGNAI_FOODSTORY_COLUMN_MAP: PosColumnMap = {
  billRef: ['Bill No', 'Bill Number', 'Receipt No', 'Order No', 'เลขที่บิล', 'เลขที่ใบเสร็จ'],
  tableCode: ['Table', 'Table No', 'Table Name', 'โต๊ะ'],
  covers: ['Guests', 'Covers', 'Pax', 'จำนวนลูกค้า'],
  openedAt: ['Open Time', 'Opened At', 'Order Time', 'เวลาเปิดบิล'],
  closedAt: ['Close Time', 'Closed At', 'Paid Time', 'เวลาปิดบิล'],
  total: ['Net Sales', 'Total', 'Grand Total', 'ยอดสุทธิ'],
};

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, optional UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A Bangkok wall-clock time to an instant. Accepts `YYYY-MM-DD HH:mm[:ss]` and `DD/MM/YYYY HH:mm[:ss]`;
 * a year above 2400 is Buddhist Era and is converted. Unconfirmed format, see the column map.
 */
export function parseBangkokTime(raw: string): Date | null {
  const v = raw.trim();
  if (!v) return null;
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  if (y > 2400) y -= 543;
  const t = Date.UTC(y, mo - 1, d, Number(m[4]) - 7, Number(m[5]), Number(m[6] ?? 0));
  return Number.isNaN(t) ? null : new Date(t);
}

/** "18,450.00" or "฿450" to satang. */
function parseSatang(raw: string): number | null {
  const v = raw.replace(/[,\s฿]/g, '');
  if (!v || !/^-?\d+(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

/** Parse a report with `map`. Rows that fail are skipped and reported by line number. */
export function parseReport(text: string, map: PosColumnMap = WONGNAI_FOODSTORY_COLUMN_MAP): { bills: PosBill[]; errors: string[] } {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return { bills: [], errors: ['the report is empty'] };
  const names = header.map(norm);
  const col = (field: keyof PosColumnMap) => {
    for (const h of map[field]) {
      const i = names.indexOf(norm(h));
      if (i >= 0) return i;
    }
    return -1;
  };
  const idx = { billRef: col('billRef'), tableCode: col('tableCode'), covers: col('covers'), openedAt: col('openedAt'), closedAt: col('closedAt'), total: col('total') };
  if (idx.billRef < 0) return { bills: [], errors: [`no column for billRef (expected one of: ${map.billRef.join(', ')})`] };

  const bills: PosBill[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const ref = cell(r, idx.billRef);
    if (!ref) return void errors.push(`line ${line}: no bill number`);
    if (seen.has(ref)) return void errors.push(`line ${line}: bill ${ref} appears twice`);
    seen.add(ref);
    const coversRaw = cell(r, idx.covers);
    const covers = coversRaw ? Number.parseInt(coversRaw, 10) : null;
    const openedRaw = cell(r, idx.openedAt);
    const closedRaw = cell(r, idx.closedAt);
    const openedAt = parseBangkokTime(openedRaw);
    const closedAt = parseBangkokTime(closedRaw);
    if ((openedRaw && !openedAt) || (closedRaw && !closedAt)) return void errors.push(`line ${line}: unreadable time`);
    const totalRaw = cell(r, idx.total);
    const totalSatang = parseSatang(totalRaw);
    if (totalRaw && totalSatang === null) return void errors.push(`line ${line}: unreadable total "${totalRaw}"`);
    bills.push({
      ref,
      tableCode: cell(r, idx.tableCode) || null,
      covers: covers !== null && Number.isFinite(covers) ? covers : null,
      openedAt,
      closedAt,
      totalSatang,
    });
  });
  return { bills, errors };
}

/** The CSV report adapter (L0b) for any POS whose export `map` describes. */
export function csvReportAdapter(map: PosColumnMap = WONGNAI_FOODSTORY_COLUMN_MAP, vendor = 'wongnai_foodstory'): PosAdapter {
  return { vendor, importReport: (file) => parseReport(file, map) };
}

/** Deterministic row id: the primary key enforces one row per (club, bill ref) without a migration. */
export const posBillId = (clubId: string, ref: string) =>
  `pos_${createHash('sha256').update(`${clubId}\0${ref}`).digest('hex').slice(0, 32)}`;

/** Bookings a bill can belong to: the guest got (or was due) a table that night. */
const MATCHABLE = ['confirmed', 'arrived', 'completed'] as const;

export interface PosImportResult {
  imported: number;
  created: number;
  updated: number;
  matched: number;
  walkIns: number;
  errors: string[];
}

/**
 * Import a sales report into `pos_bills` for `club` (spec §11.3 L0b). Re-import is idempotent:
 * a bill ref already stored for this club is updated in place. A bill is matched to a booking when
 * exactly one matchable booking of this club has the same table code on the same club night
 * (from `openedAt`, else `closedAt`); otherwise it is a walk-in with no booking.
 */
export async function importPosReport(
  db: Db,
  club: Club,
  file: string,
  opts: { now: Date; adapter?: PosAdapter; isTest?: boolean },
): Promise<PosImportResult> {
  const adapter = opts.adapter ?? csvReportAdapter();
  const { bills, errors } = adapter.importReport(file);
  const result: PosImportResult = { imported: 0, created: 0, updated: 0, matched: 0, walkIns: 0, errors };
  if (bills.length === 0) return result;

  const clubTables = await db.select().from(tables).where(eq(tables.clubId, club.id));
  const tableByCode = new Map(clubTables.map((t) => [t.code.trim().toUpperCase(), t]));
  const nightOf = (b: PosBill) => {
    const at = b.openedAt ?? b.closedAt;
    return at ? currentNightDate(at, club.settings.nightEndHour) : null;
  };
  const nights = [...new Set(bills.map(nightOf).filter((n): n is string => n !== null))];
  const candidates = nights.length
    ? await db
        .select()
        .from(bookings)
        .where(and(eq(bookings.clubId, club.id), inArray(bookings.nightDate, nights), inArray(bookings.status, [...MATCHABLE])))
    : [];
  const ids = bills.map((b) => posBillId(club.id, b.ref));
  const existing = new Set(
    (await db.select({ id: posBills.id }).from(posBills).where(and(eq(posBills.clubId, club.id), inArray(posBills.id, ids)))).map((r) => r.id),
  );
  const isTest = opts.isTest ?? club.status === 'demo';

  await db.transaction(async (tx) => {
    for (const bill of bills) {
      const id = posBillId(club.id, bill.ref);
      const night = nightOf(bill);
      const table = bill.tableCode ? tableByCode.get(bill.tableCode.trim().toUpperCase()) : undefined;
      const hits = table && night ? candidates.filter((b) => b.tableId === table.id && b.nightDate === night) : [];
      const booking = hits.length === 1 ? hits[0]! : undefined;
      const values = {
        bookingId: booking?.id ?? null,
        providerBillId: bill.ref,
        tableCode: bill.tableCode,
        covers: bill.covers,
        openedAt: bill.openedAt,
        closedAt: bill.closedAt,
        totalSatang: bill.totalSatang,
        syncedAt: opts.now,
      };
      await tx
        .insert(posBills)
        .values({ id, clubId: club.id, ...values })
        .onConflictDoUpdate({ target: posBills.id, set: values });

      result.imported++;
      if (existing.has(id)) result.updated++;
      else result.created++;
      if (booking) result.matched++;
      else result.walkIns++;

      const base = {
        clubId: club.id,
        actorType: 'system' as const,
        dataOrigin: 'pos' as const,
        source: `report:${adapter.vendor}`,
        tableId: table?.id,
        zoneId: table?.zoneId,
        nightDate: night ?? undefined,
        isTest,
      };
      if (bill.closedAt) {
        await emit(tx as unknown as Db, {
          ...base,
          type: 'pos.bill_closed',
          occurredAt: bill.closedAt,
          bookingId: booking?.id,
          props: { billRef: bill.ref, covers: bill.covers, totalSatang: bill.totalSatang },
          dedupeKey: `pos.bill_closed:${bill.ref}`,
        });
      }
      if (booking) {
        await emit(tx as unknown as Db, {
          ...base,
          type: 'pos.bill_matched',
          occurredAt: opts.now,
          bookingId: booking.id,
          guestId: booking.guestId,
          props: { billRef: bill.ref, method: 'table_night' },
          dedupeKey: `pos.bill_matched:${bill.ref}:${booking.id}`,
        });
      }
    }
  });
  return result;
}
