import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const newId = (): string => randomUUID();

/** ฿15,000 — money is always integer satang internally. */
export function formatBaht(satang: number): string {
  const baht = satang / 100;
  return `฿${baht.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function newRefCode(prefix: string): string {
  const bytes = randomBytes(4);
  let s = '';
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return `${prefix}-${s}`;
}

/** Short HMAC used to sign public links (media URLs, guest detail forms). */
export function sign(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('base64url').slice(0, 22);
}

export function verifySignature(secret: string, purpose: string, value: string, sig: string | undefined): boolean {
  if (!sig) return false;
  const expected = Buffer.from(sign(secret, purpose, value));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
