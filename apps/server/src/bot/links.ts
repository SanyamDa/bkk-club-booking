import type { Booking, Club } from '../db/schema.js';
import { sign, verifySignature } from '../lib/util.js';

/** A details link lives at most 24 hours, and never past the booking's hold expiry (plan B5). */
export const DETAILS_LINK_MAX_MS = 24 * 60 * 60_000;

type DetailsBooking = Pick<Booking, 'refCode' | 'holdExpiresAt'>;

/**
 * Checks a details-link token (`<expiry base36>.<signature>`): `ok`, `expired` (signature good but
 * past its expiry) or `bad`. The expiry is inside the signature, so it can't be extended.
 */
export function checkDetailsToken(secret: string, ref: string, token: string | undefined, now: Date): 'ok' | 'expired' | 'bad' {
  if (!token) return 'bad';
  const dot = token.indexOf('.');
  if (dot <= 0) return 'bad';
  const exp = token.slice(0, dot);
  if (!/^[0-9a-z]{1,12}$/.test(exp)) return 'bad';
  if (!verifySignature(secret, 'details', `${ref}:${exp}`, token.slice(dot + 1))) return 'bad';
  return parseInt(exp, 36) * 1000 > now.getTime() ? 'ok' : 'expired';
}

/** Public URLs the bot sends to guests. Each is signed so ids can't be guessed or enumerated. */
export class Links {
  constructor(
    private publicUrl: string,
    private secret: string,
  ) {}

  private base() {
    return this.publicUrl.replace(/\/$/, '');
  }

  /** Signed token for the details form; expires at the hold expiry or 24 h after `now`, whichever is sooner. */
  detailsToken(booking: DetailsBooking, now: Date) {
    const cap = now.getTime() + DETAILS_LINK_MAX_MS;
    const until = booking.holdExpiresAt ? Math.min(booking.holdExpiresAt.getTime(), cap) : cap;
    const exp = Math.ceil(until / 1000).toString(36);
    return `${exp}.${sign(this.secret, 'details', `${booking.refCode}:${exp}`)}`;
  }

  /** Inside LINE via LIFF when the club has one, otherwise a plain web link (dev/simulator). */
  details(club: Club, booking: DetailsBooking, now: Date) {
    const q = `ref=${encodeURIComponent(booking.refCode)}&t=${this.detailsToken(booking, now)}&club=${club.slug}`;
    return club.liffId ? `https://liff.line.me/${club.liffId}?${q}` : `${this.base()}/liff/details?${q}`;
  }

  /** PromptPay QR image, or null in demo mode when the club has no PromptPay id. */
  promptpayQr(club: Club, booking: Pick<Booking, 'id'>) {
    if (!club.promptpayId) return null;
    return `${this.base()}/media/promptpay/${booking.id}.png?s=${sign(this.secret, 'promptpay', booking.id)}`;
  }

  pass(booking: Pick<Booking, 'refCode'>) {
    return `${this.base()}/media/pass/${booking.refCode}.png?s=${sign(this.secret, 'pass', booking.refCode)}`;
  }
}
