import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Booking, Deposit } from '../../db/schema.js';
import type { PosAdapter, PosBill } from './adapter.js';

/**
 * Papaya POS live sync (plan A19, spec §11.3 L1–L3).
 *
 * UNCONFIRMED UNTIL A SANDBOX RUN (spec §16.1 question 15). No sandbox credentials exist yet: the
 * paths, field names and signature header below follow Papaya's public API description (reservation
 * with `payments[]`, order data read, signed `order.totalsUpdated` webhooks) and are pinned by fakes
 * in `test/pos-sync.test.ts`. Check every name against the sandbox and fix it here, in one place.
 */
export const PAPAYA_API_BASE = 'https://api.papayapos.com';
export const PAPAYA_SIGNATURE_HEADER = 'x-papaya-signature';

/**
 * The `pos` club credential for a Papaya club (stored with `setClubCredential`, kind `pos`).
 * Two keys per outlet: Reservations (opens the bill at check-in) and Order Data (reads bills and
 * signs webhooks). `tableChannels` maps our table code to Papaya's dine-in channel id (one per table).
 */
export interface PapayaCredentials {
  vendor: 'papaya';
  outletId: string;
  reservationsKey: string;
  orderDataKey: string;
  /** Secret Papaya signs webhooks with (HMAC-SHA256 of the raw body, hex). */
  webhookSecret: string;
  tableChannels: Record<string, string>;
}

/** An order as Papaya returns it (read API and webhook payload). */
export interface PapayaOrder {
  id: string;
  order_number?: string;
  channel_id?: string | null;
  table_name?: string | null;
  guest_count?: number | null;
  opened_at?: string | null;
  closed_at?: string | null;
  /** THB, as a decimal string or number. */
  total?: string | number | null;
  status?: string;
}

export interface PapayaWebhook {
  id: string;
  type: string;
  created_at?: string;
  data?: { order?: PapayaOrder };
}

/** Webhook types that carry a new bill state. */
export const PAPAYA_BILL_EVENTS = ['order.totalsUpdated', 'order.tableChanged', 'order.closed'] as const;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const thb = (satang: number) => (satang / 100).toFixed(2);
const satangOf = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const dateOf = (v: string | null | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** `sha256=<hex>` (or bare hex) HMAC-SHA256 of the raw body with the webhook secret. */
export function signPapaya(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifyPapayaSignature(rawBody: string, header: string | null | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const given = Buffer.from(header.trim().replace(/^sha256=/, ''), 'hex');
  const want = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface PapayaAdapter extends PosAdapter {
  readonly vendor: 'papaya';
  /** Normalise an order; the table code comes from the channel map, else the table name. */
  toBill(order: PapayaOrder): PosBill;
  /**
   * Verify and dispatch one webhook delivery to the `onBillUpdated` handlers.
   * `bad_signature`: refused, nothing dispatched. `ignored`: valid but not a bill event.
   */
  deliver(rawBody: string, signature: string | null | undefined): Promise<{ status: 'bad_signature' | 'ignored' | 'ok'; event?: PapayaWebhook; bill?: PosBill }>;
}

/**
 * `tableCodeOf` gives the table code of a booking (the adapter has no database access).
 * `fetch` is injected so tests (and the sandbox run) can see every request.
 */
export function papayaAdapter(
  creds: PapayaCredentials,
  opts: { fetch?: FetchLike; baseUrl?: string; tableCodeOf?: (booking: Booking) => string | null } = {},
): PapayaAdapter {
  const http = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? PAPAYA_API_BASE).replace(/\/$/, '');
  const outlet = encodeURIComponent(creds.outletId);
  const channelToCode = new Map(Object.entries(creds.tableChannels ?? {}).map(([code, ch]) => [ch, code]));
  const handlers: ((bill: PosBill) => void | Promise<void>)[] = [];

  const call = async <T>(key: string, path: string, init: RequestInit = {}): Promise<T> => {
    const res = await http(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`papaya ${init.method ?? 'GET'} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  const toBill = (o: PapayaOrder): PosBill => ({
    ref: String(o.id),
    tableCode: (o.channel_id ? channelToCode.get(o.channel_id) : undefined) ?? (o.table_name || null),
    covers: typeof o.guest_count === 'number' ? o.guest_count : null,
    openedAt: dateOf(o.opened_at),
    closedAt: dateOf(o.closed_at),
    totalSatang: satangOf(o.total),
  });

  return {
    vendor: 'papaya',
    toBill,

    importReport: () => ({ bills: [], errors: ['Papaya bills arrive through live sync; there is no report to import'] }),

    async openBillAtCheckIn(booking: Booking, deposit: Deposit | undefined) {
      const code = opts.tableCodeOf?.(booking) ?? null;
      const channel = code ? creds.tableChannels?.[code] : undefined;
      if (!channel) throw new Error(`papaya: no dine-in channel mapped for table ${code ?? '(unknown)'}`);
      // Only money we verified is a prepayment; an unverified slip stays off the bill (L0a covers it).
      const paid = deposit && deposit.status === 'verified' && deposit.amountSatang > 0 ? deposit : undefined;
      const body = {
        reference: booking.refCode,
        channel_id: channel,
        guest_count: booking.pax,
        status: 'checked_in',
        payments: paid
          ? [{ method: 'prepaid', amount: thb(paid.amountSatang), currency: 'THB', reference: paid.id, note: `Deposit ${booking.refCode}` }]
          : [],
      };
      const res = await call<{ id?: string; order_id?: string }>(creds.reservationsKey, `/v1/outlets/${outlet}/reservations`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const ref = res.order_id ?? res.id;
      if (!ref) throw new Error('papaya: reservation response has no order id');
      return { ref: String(ref) };
    },

    async fetchClosedBills(nightDate: string) {
      // A club night runs from noon to noon Bangkok time; closed bills of that window.
      const from = new Date(`${nightDate}T12:00:00+07:00`);
      const to = new Date(from.getTime() + 24 * 3600 * 1000);
      const bills: PosBill[] = [];
      let page: number | null = 1;
      while (page !== null) {
        const q = new URLSearchParams({ status: 'closed', closed_from: from.toISOString(), closed_to: to.toISOString(), page: String(page) });
        const res: { data?: PapayaOrder[]; next_page?: number | null } = await call(creds.orderDataKey, `/v1/outlets/${outlet}/orders?${q}`);
        for (const o of res.data ?? []) bills.push(toBill(o));
        page = res.next_page && res.next_page !== page ? res.next_page : null;
      }
      return bills;
    },

    onBillUpdated(handler) {
      handlers.push(handler);
    },

    async deliver(rawBody, signature) {
      if (!verifyPapayaSignature(rawBody, signature, creds.webhookSecret)) return { status: 'bad_signature' };
      let event: PapayaWebhook;
      try {
        event = JSON.parse(rawBody) as PapayaWebhook;
      } catch {
        return { status: 'ignored' };
      }
      if (event === null || typeof event !== 'object') return { status: 'ignored' }; // `null`, a number, a string
      const order = event.data?.order;
      if (!(PAPAYA_BILL_EVENTS as readonly string[]).includes(event.type) || !order?.id) return { status: 'ignored', event };
      const bill = toBill(order);
      for (const h of handlers) await h(bill);
      return { status: 'ok', event, bill };
    },
  };
}
