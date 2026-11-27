import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, totp, verifyTotp } from '../src/platform/totp.js';

const SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('totp', () => {
  it('RFC 6238 vector', () => {
    expect(totp(SECRET, new Date(59_000))).toBe('287082');
    expect(totp(SECRET, new Date(1_111_111_109_000))).toBe('081804');
  });

  it('accepts one step either side and nothing further', () => {
    const at = new Date(1_111_111_109_000);
    expect(verifyTotp(SECRET, totp(SECRET, new Date(at.getTime() - 30_000)), at)).toBe(true);
    expect(verifyTotp(SECRET, totp(SECRET, new Date(at.getTime() + 30_000)), at)).toBe(true);
    expect(verifyTotp(SECRET, totp(SECRET, new Date(at.getTime() - 90_000)), at)).toBe(false);
    expect(verifyTotp(SECRET, 'abcdef', at)).toBe(false);
  });

  it('base32 round-trips', () => {
    expect(base32Encode(SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(SECRET)).toBe(true);
  });
});
