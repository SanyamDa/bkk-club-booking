import type { Booking, Club } from '../db/schema.js';
import { sign } from '../lib/util.js';

/** Public URLs the bot sends to guests. Each is signed so ids can't be guessed or enumerated. */
export class Links {
  constructor(
    private publicUrl: string,
    private secret: string,
  ) {}

  private base() {
    return this.publicUrl.replace(/\/$/, '');
  }

  detailsToken(booking: Pick<Booking, 'refCode'>) {
    return sign(this.secret, 'details', booking.refCode);
  }

  /** Inside LINE via LIFF when the club has one, otherwise a plain web link (dev/simulator). */
  details(club: Club, booking: Pick<Booking, 'refCode'>) {
    const q = `ref=${encodeURIComponent(booking.refCode)}&t=${this.detailsToken(booking)}&club=${club.slug}`;
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
