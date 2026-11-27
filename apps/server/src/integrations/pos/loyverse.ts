import type { PosAdapter, PosBill } from './adapter.js';
import type { FetchLike } from './papaya.js';

/**
 * Loyverse spend sync (plan A19, spec §11.3 L1 "spend only"). Loyverse's public API (v1.0) reads
 * paid receipts after they close; open bills cannot be read or created, so there is no check-in
 * or live level. One pasted access token per club.
 *
 * The table to match on is unverified (spec §11.3): we use the receipt's open-ticket name
 * (`order`), which clubs usually name after the table, and expect imperfect matching.
 */
export const LOYVERSE_API_BASE = 'https://api.loyverse.com/v1.0';

/** The `pos` club credential for a Loyverse club (`setClubCredential`, kind `pos`). */
export interface LoyverseCredentials {
  vendor: 'loyverse';
  token: string;
  /** Optional: only receipts of this store (a token can see every store of the account). */
  storeId?: string;
}

/** The receipt fields we read (Loyverse `GET /receipts`). Money is THB. */
export interface LoyverseReceipt {
  receipt_number: string;
  receipt_type?: 'SALE' | 'REFUND';
  created_at?: string;
  receipt_date?: string;
  cancelled_at?: string | null;
  total_money?: number;
  order?: string | null;
  dining_option?: string | null;
  store_id?: string;
}

const dateOf = (v: string | null | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function loyverseReceiptToBill(r: LoyverseReceipt): PosBill {
  return {
    ref: r.receipt_number,
    tableCode: r.order?.trim() || null,
    covers: null,
    // A receipt exists only once the bill is paid: no open time.
    openedAt: null,
    closedAt: dateOf(r.receipt_date ?? r.created_at),
    totalSatang: typeof r.total_money === 'number' ? Math.round(r.total_money * 100) : null,
  };
}

export function loyverseAdapter(creds: LoyverseCredentials, opts: { fetch?: FetchLike; baseUrl?: string } = {}): PosAdapter {
  const http = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? LOYVERSE_API_BASE).replace(/\/$/, '');
  return {
    vendor: 'loyverse',
    importReport: () => ({ bills: [], errors: ['Loyverse receipts are pulled through the API; there is no report to import'] }),

    /** Closed (paid, not cancelled, not refund) receipts of one club night, noon to noon Bangkok time. */
    async fetchClosedBills(nightDate: string) {
      const from = new Date(`${nightDate}T12:00:00+07:00`);
      const to = new Date(from.getTime() + 24 * 3600 * 1000);
      const bills: PosBill[] = [];
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ created_at_min: from.toISOString(), created_at_max: to.toISOString(), limit: '250' });
        if (creds.storeId) q.set('store_id', creds.storeId);
        if (cursor) q.set('cursor', cursor);
        const res = await http(`${base}/receipts?${q}`, { headers: { authorization: `Bearer ${creds.token}`, accept: 'application/json' } });
        if (!res.ok) throw new Error(`loyverse GET /receipts: HTTP ${res.status}`);
        const body = (await res.json()) as { receipts?: LoyverseReceipt[]; cursor?: string | null };
        for (const r of body.receipts ?? []) {
          if (r.cancelled_at || (r.receipt_type ?? 'SALE') !== 'SALE') continue;
          bills.push(loyverseReceiptToBill(r));
        }
        cursor = body.cursor || undefined;
      } while (cursor);
      return bills;
    },
  };
}
