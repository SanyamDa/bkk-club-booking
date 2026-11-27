import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { approveDeposit, BookingError, latestDeposit, requestDeposit, type Actor } from '../../bookings/service.js';
import type { Db } from '../../db/client.js';
import { alerts, clubs, deposits, type Club } from '../../db/schema.js';
import { raiseAlert, type AlertInput } from '../../platform/alerts.js';
import { isFeatureOn } from '../../platform/features.js';

/**
 * Payment gateway option (plan A20b, spec §11.2 Phase 3 option). A gateway takes the deposit
 * instead of the PromptPay slip, and its signed webhook confirms the booking through B's booking
 * service. Each provider (Opn first, see `opn.ts`) implements `PaymentGateway`.
 */

export interface PaymentCharge {
  chargeId: string;
  /** Where the guest pays (hosted page or QR image). */
  payUrl: string;
}

/** A verified webhook delivery, reduced to what confirmation needs. */
export interface PaymentEvent {
  eventId: string;
  chargeId: string;
  status: 'successful' | 'failed' | 'pending';
  amountSatang: number;
  /** Upper case ISO 4217, e.g. `THB`. */
  currency: string;
  /** From the charge metadata we set in `createCharge`. */
  clubId?: string;
  bookingId?: string;
}

export interface PaymentGateway {
  readonly provider: string;
  /** Opens a charge. Must be idempotent per `depositId`: the same deposit gets the same charge. */
  createCharge(club: Club, req: { bookingId: string; depositId: string; amountSatang: number; returnUrl: string }): Promise<PaymentCharge>;
  /** The signature of a delivery, read from its headers (the route passes the request's header getter). */
  signatureOf(header: (name: string) => string | undefined): string | undefined;
  /** The event when the signature is valid for this body, else null. Never throws. */
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null;
}

/** Gateways by provider name, as used in `/webhooks/payments/:provider`. */
export type PaymentGateways = Record<string, PaymentGateway>;

/** `deposits.slip_trans_ref` of a gateway deposit. */
export const chargeRef = (provider: string, chargeId: string) => `${provider}:${chargeId}`;

/**
 * Starts the gateway deposit for a held booking: moves it to `awaiting_payment` through
 * `requestDeposit` (B2), marks the deposit `method = 'gateway'` and opens the charge.
 * Returns null when the club's `payment_gateway` switch is off (the caller keeps the slip flow)
 * or when there is nothing to pay. A booking of another club throws `BookingError('not_found')`.
 */
export async function startGatewayDeposit(
  db: Db,
  club: Club,
  gateway: PaymentGateway,
  bookingId: string,
  returnUrl: string,
  now: Date,
): Promise<PaymentCharge | null> {
  if (!(await isFeatureOn(db, club.id, 'payment_gateway'))) return null;
  const booking = await requestDeposit(db, club, bookingId, now);
  if (booking.status !== 'awaiting_payment') return null;
  const deposit = await latestDeposit(db, booking.id);
  if (!deposit || deposit.clubId !== club.id || deposit.status !== 'pending') return null;
  const charge = await gateway.createCharge(club, {
    bookingId: booking.id,
    depositId: deposit.id,
    amountSatang: deposit.amountSatang,
    returnUrl,
  });
  await db
    .update(deposits)
    .set({ method: 'gateway', slipTransRef: chargeRef(gateway.provider, charge.chargeId) })
    .where(and(eq(deposits.id, deposit.id), eq(deposits.clubId, club.id)));
  return charge;
}

/**
 * Raises the alert unless the same one (club, kind, text, which names the charge) is still open:
 * a provider resends a delivery we answered with an error, and staff need one alert, not one per retry.
 */
async function alertOnce(db: Db, input: AlertInput, now: Date): Promise<void> {
  const [open] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.clubId, input.clubId), eq(alerts.kind, input.kind), eq(alerts.textEn, input.text.en), isNull(alerts.resolvedAt)))
    .limit(1);
  if (!open) await raiseAlert(db, input, now);
}

export type PaymentOutcomeCode =
  | 'confirmed'
  | 'already_confirmed'
  | 'ignored'
  | 'unknown_charge'
  | 'charge_mismatch'
  | 'amount_mismatch'
  | 'table_lost'
  | 'not_confirmable';

export interface PaymentOutcome {
  outcome: PaymentOutcomeCode;
  /** The club of the matched deposit, when one matched. */
  clubId?: string;
  bookingId?: string;
}

const baht = (satang: number) => `฿${(satang / 100).toLocaleString('en-US')}`;

/**
 * Applies one verified gateway event. A successful charge whose amount and currency match its
 * deposit confirms the booking through `approveDeposit` (history, audit and `deposit.verified` in
 * one transaction). Anything that needs a human raises an urgent alert and confirms nothing.
 */
export async function applyPaymentEvent(db: Db, provider: string, event: PaymentEvent, now: Date): Promise<PaymentOutcome> {
  const deposit = await db.query.deposits.findFirst({
    where: and(eq(deposits.method, 'gateway'), eq(deposits.slipTransRef, chargeRef(provider, event.chargeId))),
  });
  if (!deposit) {
    // Money taken for a charge we cannot place: tell the club named in the metadata, if it exists.
    if (event.status === 'successful' && event.clubId) {
      const club = await db.query.clubs.findFirst({ where: eq(clubs.id, event.clubId) });
      if (club) {
        await alertOnce(
          db,
          {
            clubId: club.id,
            level: 'urgent',
            kind: 'payment_unmatched',
            text: {
              en: `A ${baht(event.amountSatang)} gateway payment (${event.chargeId}) matches no booking. Check it in the payment dashboard.`,
              th: `มีการชำระเงิน ${baht(event.amountSatang)} ผ่านเกตเวย์ (${event.chargeId}) ที่ไม่ตรงกับการจองใด กรุณาตรวจสอบ`,
            },
          },
          now,
        );
      }
    }
    return { outcome: 'unknown_charge' };
  }
  const where = { clubId: deposit.clubId, bookingId: deposit.bookingId };

  if ((event.clubId && event.clubId !== deposit.clubId) || (event.bookingId && event.bookingId !== deposit.bookingId)) {
    await alertOnce(
      db,
      {
        ...where,
        level: 'urgent',
        kind: 'payment_charge_mismatch',
        text: {
          en: `Gateway charge ${event.chargeId} names another booking than its deposit. Not confirmed; check it.`,
          th: `รายการชำระ ${event.chargeId} ระบุการจองไม่ตรงกับมัดจำ ยังไม่ยืนยัน กรุณาตรวจสอบ`,
        },
      },
      now,
    );
    return { outcome: 'charge_mismatch', ...where };
  }
  if (event.status !== 'successful') return { outcome: 'ignored', ...where };
  if (deposit.status === 'verified') return { outcome: 'already_confirmed', ...where };

  if (event.currency.toUpperCase() !== 'THB' || event.amountSatang !== deposit.amountSatang) {
    await alertOnce(
      db,
      {
        ...where,
        level: 'urgent',
        kind: 'payment_amount_mismatch',
        text: {
          en: `Gateway payment ${event.chargeId} was ${event.currency.toUpperCase()} ${event.amountSatang / 100}, deposit is ${baht(deposit.amountSatang)}. Not confirmed; check it.`,
          th: `ยอดชำระ ${event.chargeId} คือ ${event.currency.toUpperCase()} ${event.amountSatang / 100} แต่มัดจำคือ ${baht(deposit.amountSatang)} ยังไม่ยืนยัน กรุณาตรวจสอบ`,
        },
      },
      now,
    );
    return { outcome: 'amount_mismatch', ...where };
  }

  const actor: Actor = { type: 'system', id: `payments:${provider}` };
  try {
    await approveDeposit(db, deposit.clubId, deposit.bookingId, actor, now);
    return { outcome: 'confirmed', ...where };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;
    // Two deliveries at once: the other one confirmed it.
    const fresh = await db.query.deposits.findFirst({ where: eq(deposits.id, deposit.id) });
    if (fresh?.status === 'verified') return { outcome: 'already_confirmed', ...where };
    const lost = err.code === 'table_taken';
    await alertOnce(
      db,
      {
        ...where,
        level: 'urgent',
        kind: lost ? 'payment_table_lost' : 'payment_not_confirmable',
        text: lost
          ? {
              en: `A guest paid ${baht(deposit.amountSatang)} by gateway after their hold ran out and the table was taken. Reassign or refund.`,
              th: `แขกชำระ ${baht(deposit.amountSatang)} ผ่านเกตเวย์หลังหมดเวลาจองและโต๊ะถูกจองแล้ว กรุณาจัดโต๊ะใหม่หรือคืนเงิน`,
            }
          : {
              en: `A guest paid ${baht(deposit.amountSatang)} by gateway but the booking can no longer be confirmed. Check it and refund if needed.`,
              th: `แขกชำระ ${baht(deposit.amountSatang)} ผ่านเกตเวย์แต่ยืนยันการจองไม่ได้แล้ว กรุณาตรวจสอบและคืนเงินหากจำเป็น`,
            },
      },
      now,
    );
    return { outcome: lost ? 'table_lost' : 'not_confirmable', ...where };
  }
}

/**
 * In-memory gateway for tests and local development. Charges are `chrg_fake_<n>`, idempotent per
 * deposit. Deliveries are signed with HMAC-SHA256 of the body in header `x-fake-signature`.
 * Its webhook body has the Opn event shape (`data.object = 'charge'`).
 */
export function fakePaymentGateway(secret = 'fake-payment-secret') {
  const charges: { chargeId: string; clubId: string; bookingId: string; depositId: string; amountSatang: number; returnUrl: string }[] = [];
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex');
  const gateway: PaymentGateway & { sign(body: string): string; charges: typeof charges } = {
    provider: 'fake',
    charges,
    sign,
    async createCharge(club, req) {
      let c = charges.find((x) => x.depositId === req.depositId);
      if (!c) {
        c = { chargeId: `chrg_fake_${charges.length + 1}`, clubId: club.id, ...req };
        charges.push(c);
      }
      return { chargeId: c.chargeId, payUrl: `https://pay.fake.test/${c.chargeId}` };
    },
    signatureOf: (header) => header('x-fake-signature'),
    verifyWebhook(rawBody, signature) {
      if (!signature || !safeEqualHex(signature, sign(rawBody))) return null;
      return parseOpnEvent(rawBody);
    },
  };
  return gateway;
}

/** Constant-time compare of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

const STATUSES = new Set(['successful', 'failed', 'pending']);

/** An Opn (Omise) `charge.*` event body as a `PaymentEvent`, or null when it is not one. */
export function parseOpnEvent(rawBody: string): PaymentEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const ev = body as { id?: unknown; data?: Record<string, unknown> };
  const charge = ev.data;
  if (!charge || charge.object !== 'charge' || typeof charge.id !== 'string') return null;
  if (typeof charge.amount !== 'number' || !Number.isInteger(charge.amount) || typeof charge.currency !== 'string') return null;
  const status = typeof charge.status === 'string' && STATUSES.has(charge.status) ? (charge.status as PaymentEvent['status']) : 'failed';
  const meta = (charge.metadata && typeof charge.metadata === 'object' ? charge.metadata : {}) as Record<string, unknown>;
  return {
    eventId: typeof ev.id === 'string' ? ev.id : charge.id,
    chargeId: charge.id,
    status,
    amountSatang: charge.amount,
    currency: charge.currency.toUpperCase(),
    clubId: typeof meta.club_id === 'string' ? meta.club_id : undefined,
    bookingId: typeof meta.booking_id === 'string' ? meta.booking_id : undefined,
  };
}
