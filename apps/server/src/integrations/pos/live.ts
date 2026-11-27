import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { bookings, events, posBills, tables, type Club } from '../../db/schema.js';
import { emit } from '../../data/events.js';
import { latestDeposit } from '../../bookings/service.js';
import { currentNightDate } from '../../lib/time.js';
import { readClubCredential } from '../../platform/credentials.js';
import { isFeatureOn } from '../../platform/features.js';
import type { PosAdapter, PosBill } from './adapter.js';
import { importPosReport, posBillId, type PosImportResult } from './csv-import.js';
import { loyverseAdapter, type LoyverseCredentials } from './loyverse.js';
import { papayaAdapter, type FetchLike, type PapayaAdapter, type PapayaCredentials } from './papaya.js';

/** What the `pos` club credential holds; `vendor` picks the adapter. */
export type PosCredentials = PapayaCredentials | LoyverseCredentials;

export interface LiveOpts {
  fetch?: FetchLike;
  /** Vendor API base override (sandbox). */
  baseUrl?: string;
}

/**
 * The club's live POS adapter, or null when the club has no `pos` credential (manual level) or
 * its `pos_sync` feature switch (A17b) is off. The switch is read per call, so it needs no restart.
 */
export async function loadPosAdapter(
  db: Db,
  key: Buffer,
  club: Club,
  opts: LiveOpts = {},
): Promise<{ creds: PapayaCredentials; adapter: PapayaAdapter } | { creds: LoyverseCredentials; adapter: PosAdapter } | null> {
  if (!(await isFeatureOn(db, club.id, 'pos_sync'))) return null;
  const creds = await readClubCredential<PosCredentials>(db, key, club.id, 'pos');
  if (!creds) return null;
  if (creds.vendor === 'papaya') {
    const rows = await db.select({ id: tables.id, code: tables.code }).from(tables).where(eq(tables.clubId, club.id));
    const codeById = new Map(rows.map((t) => [t.id, t.code]));
    return { creds, adapter: papayaAdapter(creds, { ...opts, tableCodeOf: (b) => codeById.get(b.tableId) ?? null }) };
  }
  if (creds.vendor === 'loyverse') return { creds, adapter: loyverseAdapter(creds, opts) };
  return null;
}

const isTestClub = (club: Club) => club.status === 'demo';

/**
 * L2: open the bill on the table at check-in with the verified deposit as a prepayment (spec §11.3).
 * Called after the host marks the booking arrived through our dashboard. A club without a POS that
 * can open bills is skipped (the dashboard's L0a reference stays the cashier's guide).
 */
export async function openPosBillAtCheckIn(
  db: Db,
  key: Buffer,
  club: Club,
  bookingId: string,
  opts: LiveOpts & { now: Date },
): Promise<{ status: 'opened'; ref: string } | { status: 'skipped'; reason: 'no_pos' | 'not_supported' | 'not_found' }> {
  const booking = await db.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, club.id)) });
  if (!booking) return { status: 'skipped', reason: 'not_found' };
  const live = await loadPosAdapter(db, key, club, opts);
  if (!live) return { status: 'skipped', reason: 'no_pos' };
  if (!live.adapter.openBillAtCheckIn) return { status: 'skipped', reason: 'not_supported' };
  const deposit = await latestDeposit(db, booking.id);
  const { ref } = await live.adapter.openBillAtCheckIn(booking, deposit);
  const table = await db.query.tables.findFirst({ where: eq(tables.id, booking.tableId) });
  const id = posBillId(club.id, ref);
  const values = { bookingId: booking.id, providerBillId: ref, tableCode: table?.code ?? null, covers: booking.pax, openedAt: opts.now, syncedAt: opts.now };
  await db.transaction(async (tx) => {
    await tx.insert(posBills).values({ id, clubId: club.id, ...values }).onConflictDoUpdate({ target: posBills.id, set: values });
    await emit(tx as unknown as Db, {
      clubId: club.id,
      type: 'pos.bill_opened',
      occurredAt: opts.now,
      actorType: 'system',
      dataOrigin: 'pos',
      source: `live:${live.adapter.vendor}`,
      bookingId: booking.id,
      guestId: booking.guestId,
      tableId: booking.tableId,
      nightDate: booking.nightDate,
      props: {
        billRef: ref,
        prepaidSatang: deposit?.status === 'verified' ? deposit.amountSatang : 0,
      },
      isTest: isTestClub(club),
      dedupeKey: `pos.bill_opened:${ref}`,
    });
  });
  return { status: 'opened', ref };
}

/**
 * L3: apply one live bill state (a Papaya webhook) to `pos_bills`. Idempotent: a repeated delivery
 * (same `eventId`) or a state equal to the stored one changes nothing and emits nothing. A bill
 * opened at check-in keeps its booking; a bill we never saw is stored as a walk-in.
 */
export async function applyLiveBill(
  db: Db,
  club: Club,
  bill: PosBill,
  opts: { now: Date; source: string; eventId?: string },
): Promise<'created' | 'updated' | 'unchanged'> {
  const id = posBillId(club.id, bill.ref);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const updateKey = `pos.bill_updated:${bill.ref}:${opts.eventId ?? `${bill.totalSatang}:${bill.closedAt?.toISOString() ?? ''}`}`;
    if (opts.eventId) {
      const seen = await t.select({ id: events.id }).from(events).where(and(eq(events.clubId, club.id), eq(events.dedupeKey, updateKey)));
      if (seen.length) return 'unchanged';
    }
    const before = await t.query.posBills.findFirst({ where: and(eq(posBills.id, id), eq(posBills.clubId, club.id)) });
    const next = {
      providerBillId: bill.ref,
      tableCode: bill.tableCode ?? before?.tableCode ?? null,
      covers: bill.covers ?? before?.covers ?? null,
      openedAt: before?.openedAt ?? bill.openedAt,
      closedAt: bill.closedAt ?? before?.closedAt ?? null,
      totalSatang: bill.totalSatang ?? before?.totalSatang ?? null,
    };
    if (
      before &&
      before.totalSatang === next.totalSatang &&
      before.tableCode === next.tableCode &&
      before.covers === next.covers &&
      (before.closedAt?.getTime() ?? null) === (next.closedAt?.getTime() ?? null)
    ) {
      return 'unchanged';
    }
    await t
      .insert(posBills)
      .values({ id, clubId: club.id, bookingId: null, ...next, syncedAt: opts.now })
      .onConflictDoUpdate({ target: posBills.id, set: { ...next, syncedAt: opts.now } });

    const at = next.openedAt ?? next.closedAt;
    const base = {
      clubId: club.id,
      actorType: 'system' as const,
      dataOrigin: 'pos' as const,
      source: opts.source,
      bookingId: before?.bookingId ?? undefined,
      nightDate: at ? currentNightDate(at, club.settings.nightEndHour) : undefined,
      isTest: isTestClub(club),
    };
    await emit(t, {
      ...base,
      type: 'pos.bill_updated',
      occurredAt: opts.now,
      props: { billRef: bill.ref, totalSatang: next.totalSatang, tableCode: next.tableCode, covers: next.covers, eventId: opts.eventId ?? null },
      dedupeKey: updateKey,
    });
    if (next.closedAt && !before?.closedAt) {
      await emit(t, {
        ...base,
        type: 'pos.bill_closed',
        occurredAt: next.closedAt,
        props: { billRef: bill.ref, covers: next.covers, totalSatang: next.totalSatang },
        dedupeKey: `pos.bill_closed:${bill.ref}`,
      });
    }
    return before ? 'updated' : 'created';
  });
}

/**
 * L1: pull the closed bills of one night and store them through the report-import path (same
 * matching, idempotent upsert, `pos.bill_closed` / `pos.bill_matched` events).
 */
export async function syncClosedBills(
  db: Db,
  key: Buffer,
  club: Club,
  nightDate: string,
  opts: LiveOpts & { now: Date },
): Promise<PosImportResult | null> {
  const live = await loadPosAdapter(db, key, club, opts);
  if (!live?.adapter.fetchClosedBills) return null;
  const bills = await live.adapter.fetchClosedBills(nightDate);
  const pulled: PosAdapter = { vendor: live.adapter.vendor, importReport: () => ({ bills, errors: [] }) };
  return importPosReport(db, club, '', { now: opts.now, adapter: pulled });
}
