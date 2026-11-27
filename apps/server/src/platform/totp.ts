import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP: HMAC-SHA-1, 30 s step, 6 digits. */
const STEP_SECONDS = 30;
const DIGITS = 6;

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return bin.toString().padStart(DIGITS, '0');
}

const stepOf = (at: Date) => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

export function totp(secret: Buffer, at: Date): string {
  return hotp(secret, stepOf(at));
}

/** Accepts the code for the current step and one step either side. */
export function verifyTotp(secret: Buffer, code: string, at: Date): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const given = Buffer.from(code);
  let ok = false;
  for (const d of [-1, 0, 1]) {
    if (timingSafeEqual(Buffer.from(hotp(secret, stepOf(at) + d)), given)) ok = true;
  }
  return ok;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 20-byte secret, base32 as stored in `users.totp_secret` and shown in the otpauth URL. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUrl(secretBase32: string, account: string, issuer = 'Club Booking'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
