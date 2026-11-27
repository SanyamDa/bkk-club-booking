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

  /** B4: the data notice page linked from the notice line (spec §5.5). */
  privacy() {
    return `${this.base()}/privacy`;
  }

  /**
   * B4: a link LINE opens without telling us, sent through `GET /r/:code` so the tap is counted
   * (`link.opened`). The target comes from the club's settings, never from the link, so the
   * redirect cannot be pointed elsewhere; the signature stops forged counts.
   */
  tracked(club: Pick<Club, 'slug'>, kind: TrackedLinkKind, entry: string) {
    return `${this.base()}/r/${trackedLinkCode(this.secret, club.slug, kind, entry)}`;
  }
}

/** B4: the link kinds `GET /r/:code` serves; each maps to a club setting in `http/redirect.ts`. */
export const TRACKED_LINK_KINDS = ['map', 'drinks'] as const;
export type TrackedLinkKind = (typeof TRACKED_LINK_KINDS)[number];

/** `<kind>.<slug>.<entry>.<signature>`; slugs and entry tags never contain a dot. */
export function trackedLinkCode(secret: string, slug: string, kind: TrackedLinkKind, entry: string): string {
  const body = `${kind}.${slug}.${entry}`;
  return `${body}.${sign(secret, 'redirect', body)}`;
}

export function parseTrackedLinkCode(secret: string, code: string): { kind: TrackedLinkKind; slug: string; entry: string } | null {
  const parts = code.split('.');
  if (parts.length !== 4) return null;
  const [kind, slug, entry, sig] = parts as [string, string, string, string];
  if (!(TRACKED_LINK_KINDS as readonly string[]).includes(kind) || !/^[a-z0-9_]{1,32}$/.test(entry)) return null;
  if (!verifySignature(secret, 'redirect', `${kind}.${slug}.${entry}`, sig)) return null;
  return { kind: kind as TrackedLinkKind, slug, entry };
}
