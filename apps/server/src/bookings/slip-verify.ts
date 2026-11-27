import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { isUniqueViolation } from '../db/client.js';
import { bookings, bookingStatusHistory, deposits, type Booking, type Club, type Deposit } from '../db/schema.js';
import { emit, type EventInput } from '../data/events.js';
import { approveDeposit, BookingError, latestDeposit, type Actor } from './service.js';

/**
 * Automatic slip verification (B9, spec §11.2). A provider reads the QR printed on a Thai bank slip
 * and confirms the transfer with the bank; we then check amount, receiver, time and reference.
 * Any failed check, an unreadable slip or a provider outage sends the booking to `payment_review`
 * (a human decides). Nothing here ever rejects a booking.
 */

/** What the provider read from one slip. */
export interface SlipReading {
  /** The bank's transaction reference; used once per club. */
  transRef: string;
  amountSatang: number;
  /** Receiving PromptPay proxy and/or account number as the provider returns them (often masked with `x`). */
  receiver: { proxy?: string | null; account?: string | null; name?: string | null };
  transferredAt: Date;
}

export interface SlipVerifier {
  /** Coded provider name, written to `slip.auto_verified` props. */
  readonly provider: string;
  /** Reads and bank-checks one slip image. Throws when the slip is unreadable or the provider fails. */
  read(image: Buffer, opts: { signal: AbortSignal }): Promise<SlipReading>;
}

export type SlipReviewCode =
  | 'amount_low'
  | 'receiver_mismatch'
  | 'time_before_hold'
  | 'ref_reused'
  | 'provider_timeout'
  | 'provider_error'
  | 'late_slip'
  /** The deposit is a gateway charge (A20b); its `slip_trans_ref` is kept for the payment webhook. */
  | 'gateway_deposit'
  | 'not_in_review';

export type SlipOutcome = { verified: true; deposit: Deposit } | { verified: false; code: SlipReviewCode };

export const SLIP_TIMEOUT_MS = 10_000;
/** Allowed clock difference between the bank and us when checking "transfer after the hold started". */
export const SLIP_CLOCK_SKEW_MS = 5 * 60_000;

class SlipTimeout extends Error {}

/** Digits of a PromptPay id in local form (a +66 / 66 phone becomes 0...). */
function localDigits(v: string): string {
  const d = v.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('66')) return `0${d.slice(2)}`;
  if (d.length === 13 && d.startsWith('0066')) return `0${d.slice(4)}`;
  return d;
}

/**
 * True when a (possibly masked) receiver value matches the club's PromptPay id. Compared from the
 * right; `x` is a wildcard; at least 4 visible digits must match, and none may differ.
 */
export function receiverMatches(promptpayId: string | null | undefined, receiver: SlipReading['receiver']): boolean {
  if (!promptpayId) return false;
  const club = localDigits(promptpayId);
  for (const raw of [receiver.proxy, receiver.account]) {
    if (!raw) continue;
    let value = raw.toLowerCase().replace(/[^0-9x]/g, '');
    if (/^66\d{9}$/.test(value)) value = `0${value.slice(2)}`;
    if (!value || value.length > club.length) continue;
    let visible = 0;
    let ok = true;
    for (let i = 1; i <= value.length; i++) {
      const c = value[value.length - i]!;
      if (c === 'x') continue;
      if (c !== club[club.length - i]) {
        ok = false;
        break;
      }
      visible++;
    }
    if (ok && visible >= 4) return true;
  }
  return false;
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new SlipTimeout('slip provider timed out'));
    }, ms);
  });
  return Promise.race([run(ctl.signal), timeout]).finally(() => clearTimeout(timer));
}

async function holdStartedAt(db: Db, booking: Booking): Promise<Date> {
  const [row] = await db
    .select({ at: bookingStatusHistory.at })
    .from(bookingStatusHistory)
    .where(and(eq(bookingStatusHistory.bookingId, booking.id), eq(bookingStatusHistory.toStatus, 'held')))
    .orderBy(asc(bookingStatusHistory.at))
    .limit(1);
  return row?.at ?? booking.createdAt;
}

function eventBase(b: Booking, actor: Actor, now: Date): Omit<EventInput, 'type'> {
  return {
    clubId: b.clubId,
    occurredAt: now,
    actorType: actor.type,
    actorId: actor.id,
    dataOrigin: 'first_party',
    bookingId: b.id,
    guestId: b.guestId,
    tableId: b.tableId,
    nightDate: b.nightDate,
    attemptId: b.attemptId ?? undefined,
    isTest: b.isTest,
  };
}

/**
 * Runs the provider on a slip already stored by `recordSlip` and, when every check passes, confirms
 * the booking through `approveDeposit` (actor `system`, id `slip:<provider>`) and emits
 * `slip.auto_verified`. Otherwise the booking stays in `payment_review` and `slip.review` is emitted
 * with the code. The slip's reading is stored on the deposit (`slip_*` columns) in every case where
 * the provider answered; a reused reference is not stored again (unique per club).
 * `lateSlip`: the hold had expired before the slip arrived; spec §5.2 step 6 sends it to review.
 */
export async function verifySlip(
  db: Db,
  club: Club,
  bookingId: string,
  image: Buffer,
  verifier: SlipVerifier,
  now: Date,
  opts: { timeoutMs?: number; skewMs?: number; lateSlip?: boolean } = {},
): Promise<SlipOutcome> {
  const booking = await db.query.bookings.findFirst({ where: and(eq(bookings.id, bookingId), eq(bookings.clubId, club.id)) });
  if (!booking) throw new BookingError('not_found');
  if (booking.status !== 'payment_review') return { verified: false, code: 'not_in_review' };
  const deposit = await latestDeposit(db, bookingId);
  if (!deposit) return { verified: false, code: 'not_in_review' };
  const actor: Actor = { type: 'system', id: `slip:${verifier.provider}` };

  const review = async (tx: Db, code: SlipReviewCode): Promise<SlipOutcome> => {
    await emit(tx, { ...eventBase(booking, actor, now), type: 'slip.review', props: { depositId: deposit.id, code } });
    return { verified: false, code };
  };

  let reading: SlipReading;
  try {
    reading = await withTimeout((signal) => verifier.read(image, { signal }), opts.timeoutMs ?? SLIP_TIMEOUT_MS);
  } catch (err) {
    return review(db, err instanceof SlipTimeout ? 'provider_timeout' : 'provider_error');
  }

  const holdStart = await holdStartedAt(db, booking);
  const code = await db.transaction(async (tx): Promise<SlipReviewCode | null> => {
    const used = await tx.query.deposits.findFirst({
      where: and(eq(deposits.clubId, club.id), eq(deposits.slipTransRef, reading.transRef), ne(deposits.id, deposit.id)),
    });
    const fields = {
      slipAmountSatang: reading.amountSatang,
      slipReceiver: reading.receiver.proxy ?? reading.receiver.account ?? null,
      slipTime: reading.transferredAt,
    };
    let reused = Boolean(used);
    // A gateway deposit's slip_trans_ref holds its charge (`<provider>:<chargeId>`), which the
    // payment webhook matches on: never overwrite it with the bank's reference.
    const gateway = deposit.method === 'gateway';
    if (!reused && !gateway) {
      try {
        await tx.transaction(async (sp) => {
          await sp.update(deposits).set({ ...fields, slipTransRef: reading.transRef }).where(eq(deposits.id, deposit.id));
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        reused = true;
      }
    }
    if (reused || gateway) await tx.update(deposits).set(fields).where(eq(deposits.id, deposit.id));

    let failed: SlipReviewCode | null = null;
    if (reused) failed = 'ref_reused';
    // A slip sent for a gateway charge: the charge may still be paid, so a human decides.
    else if (gateway) failed = 'gateway_deposit';
    else if (reading.amountSatang < deposit.amountSatang) failed = 'amount_low';
    else if (!receiverMatches(club.promptpayId, reading.receiver)) failed = 'receiver_mismatch';
    else if (reading.transferredAt.getTime() < holdStart.getTime() - (opts.skewMs ?? SLIP_CLOCK_SKEW_MS)) failed = 'time_before_hold';
    else if (opts.lateSlip) failed = 'late_slip';
    if (failed) await review(tx, failed);
    return failed;
  });
  if (code) return { verified: false, code };

  try {
    await approveDeposit(db, club.id, bookingId, actor, now);
  } catch (err) {
    // Staff acted on the booking while the provider was reading: leave it to them.
    if (err instanceof BookingError) return review(db, 'not_in_review');
    throw err;
  }
  await emit(db, {
    ...eventBase(booking, actor, now),
    type: 'slip.auto_verified',
    props: { depositId: deposit.id, provider: verifier.provider, amount_satang: reading.amountSatang },
  });
  return { verified: true, deposit: (await latestDeposit(db, bookingId))! };
}

// ---------- Test fake ----------

/** A provider stand-in: returns a fixed reading, throws a given error, or never answers (`'timeout'`). */
export class FakeSlipVerifier implements SlipVerifier {
  readonly provider = 'fake';
  calls = 0;
  constructor(public result: SlipReading | Error | 'timeout') {}
  async read(_image: Buffer, opts: { signal: AbortSignal }): Promise<SlipReading> {
    this.calls++;
    const r = this.result;
    if (r === 'timeout') {
      return new Promise<never>((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (r instanceof Error) throw r;
    return r;
  }
}

// ---------- SlipOK adapter ----------

/**
 * SlipOK (https://slipok.com) adapter. Assumption until the human picks the provider (plan
 * "Decisions the human must make"): SlipOK's `POST /api/line/apikey/{branchId}` with the image as
 * `files`, key in `x-authorization`, response `data.{transRef, transDate 'YYYYMMDD', transTime
 * 'HH:mm:ss' (Bangkok), amount (baht), receiver.{proxy,account}.value}`. Swap the adapter, not the
 * interface, if EasySlip is chosen.
 */
export class SlipOkVerifier implements SlipVerifier {
  readonly provider = 'slipok';
  constructor(
    private opts: { apiKey: string; branchId: string; fetch?: typeof fetch; baseUrl?: string },
  ) {}

  async read(image: Buffer, { signal }: { signal: AbortSignal }): Promise<SlipReading> {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(image)]), 'slip.jpg');
    form.append('log', 'true');
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.baseUrl ?? 'https://api.slipok.com'}/api/line/apikey/${this.opts.branchId}`, {
      method: 'POST',
      headers: { 'x-authorization': this.opts.apiKey },
      body: form,
      signal,
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: SlipOkData } | null;
    if (!res.ok || !body?.success || !body.data) throw new Error(`slipok: ${res.status}`);
    return parseSlipOk(body.data);
  }
}

interface SlipOkData {
  transRef: string;
  transDate: string;
  transTime: string;
  amount: number;
  receiver?: { displayName?: string; name?: string; proxy?: { value?: string | null }; account?: { value?: string | null } };
}

export function parseSlipOk(d: SlipOkData): SlipReading {
  const date = `${d.transDate.slice(0, 4)}-${d.transDate.slice(4, 6)}-${d.transDate.slice(6, 8)}`;
  const transferredAt = new Date(`${date}T${d.transTime}+07:00`);
  if (!d.transRef || Number.isNaN(transferredAt.getTime()) || typeof d.amount !== 'number') throw new Error('slipok: unreadable');
  return {
    transRef: d.transRef,
    amountSatang: Math.round(d.amount * 100),
    receiver: { proxy: d.receiver?.proxy?.value ?? null, account: d.receiver?.account?.value ?? null, name: d.receiver?.name ?? d.receiver?.displayName ?? null },
    transferredAt,
  };
}
