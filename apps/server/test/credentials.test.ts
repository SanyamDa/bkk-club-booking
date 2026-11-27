import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { clubCredentials, type Club } from '../src/db/schema.js';
import { dbCredentialStore } from '../src/line/credentials.js';
import { GatewayRegistry } from '../src/line/gateway.js';
import { fakeSetupClients } from '../src/line/setup.js';
import { fakeLineTokenIssuer, type LineTokenIssuer } from '../src/line/tokens.js';
import { decryptSecret, encryptSecret } from '../src/platform/crypto.js';
import { credentialSummary, setClubCredential } from '../src/platform/credentials.js';
import { setupTwoClubs } from './helpers.js';
import { secretLeakRecorder, staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const KEY = randomBytes(32);
const T0 = new Date('2026-11-27T08:00:00Z');
const MIN = 60_000;

/** testConfig plus the A3 keys (typed loosely until A3's Config lands everywhere). */
const configWith = (over: Record<string, unknown>): Config => testConfig(over as Partial<Config>);

function countingIssuer(opts: { fail?: boolean } = {}) {
  const calls: { channelId: string; channelSecret: string }[] = [];
  const issuer: LineTokenIssuer = {
    async accessToken(channelId, channelSecret) {
      if (opts.fail) throw new Error('issuer must not be called');
      calls.push({ channelId, channelSecret });
      return `tok-${channelSecret}-${calls.length}`;
    },
  };
  return { issuer, calls };
}

async function withClubs<T>(fn: (h: Awaited<ReturnType<typeof setupTwoClubs>>) => Promise<T>) {
  const h = await setupTwoClubs();
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

const setLine = (db: Parameters<typeof setClubCredential>[0], club: Club, channelSecret: string, now = T0) =>
  setClubCredential(db, KEY, { clubId: club.id, kind: 'line_messaging', secret: { channelId: '1650000000', channelSecret }, setBy: 'user_founder' }, now);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('club credentials (A4)', () => {
  it('encrypt round trip and tamper detection', () => {
    const blob = encryptSecret('hello secret', KEY);
    expect(blob.startsWith('v1:')).toBe(true);
    expect(decryptSecret(blob, KEY)).toBe('hello secret');
    const [v, iv, tag, data] = blob.split(':') as [string, string, string, string];
    const bytes = Buffer.from(data, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => decryptSecret([v, iv, tag, bytes.toString('base64')].join(':'), KEY)).toThrow();
  });

  it('stored row contains no plaintext', () =>
    withClubs(async ({ db, clubB }) => {
      const secret = 'super-secret-channel-value-9f3a';
      const res = await setLine(db, clubB, secret);
      expect(res.last4).toBe('9f3a');
      const [row] = await db.select().from(clubCredentials).where(eq(clubCredentials.clubId, clubB.id));
      expect(row!.ciphertext).not.toContain(secret);
      expect(row!.keyRef).toBe('env:CREDENTIALS_KEY:v1');
      expect(row!.setBy).toBe('user_founder');
      expect(await credentialSummary(db, clubB.id)).toEqual([{ kind: 'line_messaging', last4: '9f3a', setBy: 'user_founder', setAt: T0 }]);
    }));

  it('store returns the channel secret and a token from the issuer', () =>
    withClubs(async ({ db, clubB }) => {
      await setLine(db, clubB, 'secret-one');
      const { issuer, calls } = countingIssuer();
      const store = dbCredentialStore(db, KEY, issuer);
      expect(await store.channelSecret(clubB)).toBe('secret-one');
      expect(calls).toHaveLength(0);
      expect(await store.line(clubB)).toEqual({ channelSecret: 'secret-one', accessToken: 'tok-secret-one-1' });
      expect(calls).toEqual([{ channelId: '1650000000', channelSecret: 'secret-one' }]);
    }));

  it('token cached for 10 minutes', () =>
    withClubs(async ({ db, clubB }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
      await setLine(db, clubB, 'secret-one');
      const { issuer, calls } = countingIssuer();
      const store = dbCredentialStore(db, KEY, issuer);
      await store.line(clubB);
      vi.setSystemTime(new Date(T0.getTime() + 9 * MIN));
      await store.line(clubB);
      expect(calls).toHaveLength(1);
      vi.setSystemTime(new Date(T0.getTime() + 11 * MIN));
      await store.line(clubB);
      expect(calls).toHaveLength(2);
    }));

  it('gateway uses a new token after the 10-minute cache expires', () =>
    withClubs(async ({ db, clubB }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
      await setLine(db, clubB, 'secret-one');
      const { issuer, calls } = countingIssuer();
      const reg = new GatewayRegistry(dbCredentialStore(db, KEY, issuer));
      const first = await reg.forClub(clubB);
      expect(first.live).toBe(true);
      vi.setSystemTime(new Date(T0.getTime() + 5 * MIN));
      expect(await reg.forClub(clubB)).toBe(first);
      vi.setSystemTime(new Date(T0.getTime() + 11 * MIN));
      const later = await reg.forClub(clubB);
      expect(later).not.toBe(first);
      expect(calls).toHaveLength(2);
    }));

  it('credential change replaces the gateway', () =>
    withClubs(async ({ db, clubB }) => {
      await setLine(db, clubB, 'secret-one');
      const { issuer, calls } = countingIssuer();
      const reg = new GatewayRegistry(dbCredentialStore(db, KEY, issuer));
      const first = await reg.forClub(clubB);
      await setLine(db, clubB, 'secret-two');
      const next = await reg.forClub(clubB);
      expect(next).not.toBe(first);
      expect(calls.at(-1)).toEqual({ channelId: '1650000000', channelSecret: 'secret-two' });
    }));

  it('webhook signature check does not call the issuer', () =>
    withClubs(async ({ db, clubB }) => {
      await setLine(db, clubB, 'hook-secret');
      const { issuer } = countingIssuer({ fail: true });
      const app = createApp(testConfig(), db, { credentials: dbCredentialStore(db, KEY, issuer), bot: { log: () => {} } });
      const body = JSON.stringify({ destination: 'x', events: [] });
      const send = (sig: string) => app.app.request(`/line/webhook/${clubB.slug}`, { method: 'POST', headers: { 'x-line-signature': sig }, body });
      const good = await send(createHmac('sha256', 'hook-secret').update(body).digest('base64'));
      expect(good.status).toBe(200);
      const bad = await send(createHmac('sha256', 'wrong').update(body).digest('base64'));
      expect(bad.status).toBe(401);
      await app.settle();
    }));

  it('LINE_FAKE selects the fake issuer and fake setup clients', () =>
    withClubs(async ({ db, clubB }) => {
      const fetchStub = vi.fn(async (input: unknown) => {
        throw new Error(`unexpected fetch to ${String(input)}`);
      });
      vi.stubGlobal('fetch', fetchStub);
      await setLine(db, clubB, 'any-made-up-secret');
      const app = createApp(configWith({ CREDENTIALS_KEY: KEY, LINE_FAKE: true }), db, { bot: { log: () => {} } });
      const creds = await app.ctx.credentials.line(clubB);
      expect(creds).toEqual({ channelSecret: 'any-made-up-secret', accessToken: 'fake-token' });
      expect(app.ctx.lineSetupClients).toBe(fakeSetupClients);
      const bot = await app.ctx.lineSetupClients('fake-token', null).api.getBotInfo();
      expect(bot.basicId).toBeTruthy();
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await fakeLineTokenIssuer().accessToken('a', 'b')).toBe('fake-token');
    }));

  it('settings shows lineConnected for a club whose credentials are only in the database', () =>
    withClubs(async ({ db, clubA }) => {
      vi.stubEnv('DEMO_LINE_CHANNEL_SECRET', '');
      vi.stubEnv('DEMO_LINE_ACCESS_TOKEN', '');
      try {
        const app = createApp(configWith({ CREDENTIALS_KEY: KEY, LINE_FAKE: true }), db, { bot: { log: () => {} } });
        const cookie = await staffCookie(app, clubA);
        const read = async () =>
          (await (await app.app.request(staffUrl(clubA.slug, '/settings'), { headers: { cookie } })).json()) as { lineConnected: boolean };
        expect((await read()).lineConnected).toBe(false);
        await setLine(db, clubA, 'db-only-secret');
        expect((await read()).lineConnected).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    }));

  it('no admin or staff response body contains a stored secret', () =>
    withClubs(async ({ db, clubA }) => {
      const leaks = secretLeakRecorder();
      const secrets = ['msg-secret-aaaa-1111', 'login-secret-bbbb-2222'];
      leaks.track(...secrets);
      await setLine(db, clubA, secrets[0]!);
      await setClubCredential(db, KEY, { clubId: clubA.id, kind: 'line_login', secret: { channelId: '2000000001', channelSecret: secrets[1]! }, setBy: 'user_founder' }, T0);
      const app = createApp(configWith({ CREDENTIALS_KEY: KEY, LINE_FAKE: true, PUBLIC_URL: 'https://club.example' }), db, {
        bot: { log: () => {} },
        onResponse: leaks.onResponse,
      });
      const cookie = await staffCookie(app, clubA);
      for (const path of ['/settings', '/line-status', '/night', '/handoffs', '/alerts']) {
        await app.app.request(staffUrl(clubA.slug, path), { headers: { cookie } });
      }
      await app.app.request(staffUrl(clubA.slug, '/line-setup'), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
      expect(leaks.records.length).toBeGreaterThan(3);
      expect(leaks.records.some((r) => JSON.stringify(r.body).includes('lineConnected'))).toBe(true);
      leaks.assertNoLeak();
      // The recorder itself catches a leak.
      leaks.onResponse({ method: 'GET', path: '/x', status: 200, body: { s: secrets[0] } });
      expect(() => leaks.assertNoLeak()).toThrow(/leaked in GET \/x/);
    }));
});
