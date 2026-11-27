import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function derive(pw: string, salt: Buffer, opts: ScryptOptions, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pw.normalize('NFKC'), salt, keylen, { ...opts, maxmem: 128 * opts.N! * opts.r! * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** scrypt with a 16-byte random salt, stored as `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(pw, salt, { N, r: R, p: P }, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0)) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (expected.length === 0) return false;
  const actual = await derive(pw, salt, { N: n, r, p }, expected.length);
  return timingSafeEqual(actual, expected);
}

/** A fixed hash to verify against when the account does not exist, so timing does not reveal it. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

/** A readable random initial password (about 120 bits). */
export function generatePassword(): string {
  return randomBytes(15).toString('base64url');
}
