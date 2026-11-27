import type { Booking, Deposit } from '../../db/schema.js';

/**
 * One bill as the POS reports it, normalised (spec §11.3). Times are instants; the club night is
 * derived from `openedAt` with the club's `nightEndHour`. `tableCode` is null for a bill with no
 * table (bar walk-in); `ref` is the POS's own bill number, unique per club.
 */
export interface PosBill {
  ref: string;
  tableCode: string | null;
  covers: number | null;
  openedAt: Date | null;
  closedAt: Date | null;
  totalSatang: number | null;
}

/**
 * Provider-agnostic POS adapter (spec §11.3 "Plan" step 2). Every level is optional except report
 * import, which every POS supports (L0b). Live levels (L1–L3: Papaya, Loyverse) add the rest later.
 */
export interface PosAdapter {
  /** Vendor id stored on the club, e.g. 'wongnai_foodstory', 'csv'. */
  readonly vendor: string;
  /** L0b: parse the POS's exported sales report. Never throws on bad rows; returns them in `errors`. */
  importReport(file: string): { bills: PosBill[]; errors: string[] };
  /** L1: closed bills of one club night (YYYY-MM-DD). */
  fetchClosedBills?(nightDate: string): Promise<PosBill[]>;
  /** L2: open the bill on the table at check-in and record the deposit as a prepayment. */
  openBillAtCheckIn?(booking: Booking, deposit: Deposit | undefined): Promise<{ ref: string }>;
  /** L3: live total, table move, guest count. */
  onBillUpdated?(handler: (bill: PosBill) => void | Promise<void>): void;
}
