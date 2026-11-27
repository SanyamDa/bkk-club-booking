import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const GOOD_SECRET = 'a-real-random-secret-that-is-long-enough-1234';
const PROD_KEY = randomBytes(32).toString('base64');

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { APP_SECRET: GOOD_SECRET, NODE_ENV: 'development', ...overrides } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('refuses the example APP_SECRET', () => {
    expect(() => loadConfig(env({ APP_SECRET: 'change-me-to-a-long-random-string' }))).toThrow(/APP_SECRET/);
    expect(() => loadConfig(env({ APP_SECRET: 'x'.repeat(31) }))).toThrow(/APP_SECRET/);
    expect(() => loadConfig(env({ APP_SECRET: 'x'.repeat(32) }))).not.toThrow();
  });

  it('refuses DEV_SIMULATOR outside development and test', () => {
    for (const NODE_ENV of ['production', 'staging']) {
      expect(() => loadConfig(env({ NODE_ENV, DEV_SIMULATOR: '1', CREDENTIALS_KEY: PROD_KEY }))).toThrow(/DEV_SIMULATOR/);
    }
    for (const NODE_ENV of ['development', 'test']) {
      expect(loadConfig(env({ NODE_ENV, DEV_SIMULATOR: '1' })).DEV_SIMULATOR).toBe(true);
    }
  });

  it('refuses missing CREDENTIALS_KEY in production', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'production' }))).toThrow(/CREDENTIALS_KEY/);
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', CREDENTIALS_KEY: randomBytes(16).toString('base64') })),
    ).toThrow(/CREDENTIALS_KEY/);
  });

  it('accepts a valid production config', () => {
    const c = loadConfig(env({ NODE_ENV: 'production', CREDENTIALS_KEY: PROD_KEY, ANTHROPIC_API_KEY: 'sk-test' }));
    expect(c.NODE_ENV).toBe('production');
    expect(c.DEV_SIMULATOR).toBe(false);
    expect(c.LINE_FAKE).toBe(false);
    expect(Buffer.isBuffer(c.CREDENTIALS_KEY)).toBe(true);
    expect(c.CREDENTIALS_KEY.equals(Buffer.from(PROD_KEY, 'base64'))).toBe(true);
    expect(c.ANTHROPIC_API_KEY).toBe('sk-test');
    expect('STAFF_PASSWORD' in c).toBe(false);
  });

  it('derives a development credentials key from APP_SECRET', () => {
    const expected = createHash('sha256').update('credentials:' + GOOD_SECRET).digest();
    for (const NODE_ENV of ['development', 'test']) {
      const c = loadConfig(env({ NODE_ENV }));
      expect(c.CREDENTIALS_KEY.length).toBe(32);
      expect(c.CREDENTIALS_KEY.equals(expected)).toBe(true);
    }
    const explicit = loadConfig(env({ CREDENTIALS_KEY: PROD_KEY }));
    expect(explicit.CREDENTIALS_KEY.equals(Buffer.from(PROD_KEY, 'base64'))).toBe(true);
  });

  it('refuses LINE_FAKE outside development and test', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'production', LINE_FAKE: '1', CREDENTIALS_KEY: PROD_KEY }))).toThrow(
      /LINE_FAKE/,
    );
    expect(loadConfig(env({ NODE_ENV: 'development', LINE_FAKE: '1' })).LINE_FAKE).toBe(true);
    expect(loadConfig(env({ NODE_ENV: 'test', LINE_FAKE: 'true' })).LINE_FAKE).toBe(true);
    expect(loadConfig(env()).LINE_FAKE).toBe(false);
  });
});
