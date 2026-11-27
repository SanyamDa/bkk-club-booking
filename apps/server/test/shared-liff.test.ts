import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { clubs, platformFlags, type Club } from '../src/db/schema.js';
import { dbCredentialStore } from '../src/line/credentials.js';
import { createApp } from '../src/app.js';
import { fakeLiffEndpointUpdater, fakeSetupClients, realLiffEndpointUpdater, runLineSetup } from '../src/line/setup.js';
import { fakeLineTokenIssuer } from '../src/line/tokens.js';
import { setClubCredential } from '../src/platform/credentials.js';
import { platformLoginChannel, platformLoginSummary, setPlatformLoginChannel } from '../src/platform/login-channel.js';
import { setupTwoClubs } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

const KEY = randomBytes(32);
const T0 = new Date('2026-11-27T08:00:00Z');
const PLATFORM = { channelId: '2009999999', channelSecret: 'platform-login-secret-7c1d', liffId: '2009999999-Shared', setBy: 'user_founder' };

async function withClubs<T>(fn: (h: Awaited<ReturnType<typeof setupTwoClubs>>) => Promise<T>) {
  const h = await setupTwoClubs();
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

const reload = async (db: Awaited<ReturnType<typeof setupTwoClubs>>['db'], id: string) =>
  (await db.query.clubs.findFirst({ where: eq(clubs.id, id) }))!;

describe('shared LIFF and platform login channel (A4b)', () => {
  it('platform login channel round trip, and the stored value holds no plaintext', () =>
    withClubs(async ({ db }) => {
      expect(await platformLoginChannel(db, KEY)).toBeNull();
      expect(await platformLoginSummary(db)).toBeNull();
      const res = await setPlatformLoginChannel(db, KEY, PLATFORM, T0);
      expect(res).toEqual({ last4: '7c1d', setAt: T0 });
      expect(await platformLoginChannel(db, KEY)).toEqual({
        channelId: PLATFORM.channelId,
        channelSecret: PLATFORM.channelSecret,
        liffId: PLATFORM.liffId,
        shared: true,
      });
      expect(await platformLoginSummary(db)).toEqual({ liffId: PLATFORM.liffId, last4: '7c1d', setBy: 'user_founder', setAt: T0 });
      const [flag] = await db.select().from(platformFlags).where(eq(platformFlags.key, 'line_login'));
      const stored = JSON.stringify(flag!.value);
      expect(stored).not.toContain(PLATFORM.channelSecret);
      expect((flag!.value as { key_ref: string }).key_ref).toBe('env:CREDENTIALS_KEY:v1');
    }));

  it('club with no own login credential resolves the platform channel with shared true', () =>
    withClubs(async ({ db, clubB }) => {
      await setPlatformLoginChannel(db, KEY, PLATFORM, T0);
      const store = dbCredentialStore(db, KEY, fakeLineTokenIssuer());
      expect(await store.login(await reload(db, clubB.id))).toEqual({
        channelId: PLATFORM.channelId,
        channelSecret: PLATFORM.channelSecret,
        liffId: PLATFORM.liffId,
        shared: true,
      });
    }));

  it('club with its own line_login credential uses it over the platform one', () =>
    withClubs(async ({ db, clubB }) => {
      await setPlatformLoginChannel(db, KEY, PLATFORM, T0);
      await setClubCredential(db, KEY, { clubId: clubB.id, kind: 'line_login', secret: { channelId: '2001111111', channelSecret: 'own-secret', liffId: '2001111111-Own' }, setBy: 'user_founder' }, T0);
      const club = await reload(db, clubB.id);
      expect(club.liffId).toBe('2001111111-Own');
      const store = dbCredentialStore(db, KEY, fakeLineTokenIssuer());
      expect(await store.login(club)).toEqual({ channelId: '2001111111', channelSecret: 'own-secret', liffId: '2001111111-Own', shared: false });
    }));

  it('no platform channel and no own credential returns null', () =>
    withClubs(async ({ db, clubB }) => {
      const store = dbCredentialStore(db, KEY, fakeLineTokenIssuer());
      expect(await store.login(clubB)).toBeNull();
    }));

  it('saving the platform channel fills liff_id on clubs that have none', () =>
    withClubs(async ({ db, clubA, clubB }) => {
      // clubA has its own login credential, so it keeps its own LIFF id (null here).
      await setClubCredential(db, KEY, { clubId: clubA.id, kind: 'line_login', secret: { channelId: '2002222222', channelSecret: 'a-secret' }, setBy: 'user_founder' }, T0);
      await setPlatformLoginChannel(db, KEY, PLATFORM, T0);
      expect((await reload(db, clubB.id)).liffId).toBe(PLATFORM.liffId);
      expect((await reload(db, clubA.id)).liffId).toBeNull();
    }));

  it('saving the platform channel sets the shared LIFF endpoint once, with the platform login channel', () =>
    withClubs(async ({ db }) => {
      const update = vi.fn(async () => {});
      await setPlatformLoginChannel(db, KEY, PLATFORM, T0, { publicUrl: 'https://club.example/', update });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(
        { channelId: PLATFORM.channelId, channelSecret: PLATFORM.channelSecret },
        PLATFORM.liffId,
        'https://club.example/liff/details',
      );
    }));

  it('LINE_FAKE selects the fake LIFF endpoint updater', () =>
    withClubs(async ({ db }) => {
      const app = createApp(testConfig({ LINE_FAKE: true }), db, { bot: { log: () => {} } });
      expect(app.ctx.updateLiffEndpoint).toBe(fakeLiffEndpointUpdater);
      expect(createApp(testConfig(), db, { bot: { log: () => {} } }).ctx.updateLiffEndpoint).toBe(realLiffEndpointUpdater);
    }));

  it('runLineSetup skips the LIFF endpoint step for a shared channel', async () => {
    const updateLiffEndpoint = vi.fn(async () => {});
    const club = { id: 'c', slug: 'c', liffId: PLATFORM.liffId, settings: { mapUrl: 'https://maps.example', accentColor: '#C9A45C' } } as unknown as Club;
    const login = { channelId: PLATFORM.channelId, channelSecret: PLATFORM.channelSecret, liffId: PLATFORM.liffId, shared: true };
    const clients = { ...fakeSetupClients('fake-token', login), updateLiffEndpoint };
    const report = await runLineSetup({ club, clients, login, publicUrl: 'https://club.example', sampleMessages: [], webhookRetries: 1, retryDelayMs: 0 });
    expect(updateLiffEndpoint).not.toHaveBeenCalled();
    const step = report.steps.find((s) => s.name === 'Booking form (LIFF)');
    expect(step?.ok).toBe(true);
    expect(step?.detail).toMatch(/shared/i);
    expect(report.ok).toBe(true);
  });
});
