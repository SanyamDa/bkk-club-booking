import type { Db } from '../db/client.js';
import type { Club } from '../db/schema.js';
import { readClubCredential } from '../platform/credentials.js';
import { platformLoginChannel } from '../platform/login-channel.js';
import { LineTokenCache, type LineTokenIssuer } from './tokens.js';

export interface ClubLineCredentials {
  channelSecret: string;
  accessToken: string;
}

/** A LINE Login channel. `shared` is true when the channel is the platform's own (A4b). */
export type LoginChannel = { channelId: string; channelSecret: string; liffId: string | null; shared: boolean };

/** Where a club's LINE secrets come from. The env store is today's; A4 adds a DB-backed one. */
export interface CredentialStore {
  /** Only the Messaging API channel secret, for webhook signatures. Never issues a token. */
  channelSecret(club: Club): Promise<string | null>;
  line(club: Club): Promise<ClubLineCredentials | null>;
  login(club: Club): Promise<LoginChannel | null>;
}

/** LINE secrets come from environment variables named on the club row, never from the DB. */
export function envCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const read = (name: string | null | undefined) => (name ? env[name] || undefined : undefined);
  return {
    async channelSecret(club) {
      return read(club.lineChannelSecretEnv) ?? null;
    },
    async line(club) {
      const channelSecret = read(club.lineChannelSecretEnv);
      const accessToken = read(club.lineAccessTokenEnv);
      return channelSecret && accessToken ? { channelSecret, accessToken } : null;
    },
    async login(club) {
      const channelId = read(club.lineLoginChannelIdEnv);
      const channelSecret = read(club.lineLoginChannelSecretEnv);
      return channelId && channelSecret ? { channelId, channelSecret, liffId: club.liffId ?? null, shared: false } : null;
    },
  };
}

/**
 * Secrets from `club_credentials`, encrypted with CREDENTIALS_KEY (A4). The access token is never
 * stored: `line()` issues a stateless token through the 10-minute cache in `line/tokens.ts`.
 * `fallback` answers for a club with no stored row (the env store, for the dev demo club).
 */
export function dbCredentialStore(db: Db, key: Buffer, tokens: LineTokenIssuer, fallback?: CredentialStore): CredentialStore {
  const cache = new LineTokenCache(tokens);
  const messaging = (club: Club) => readClubCredential<{ channelId: string; channelSecret: string }>(db, key, club.id, 'line_messaging');
  return {
    async channelSecret(club) {
      const own = await messaging(club);
      if (own) return own.channelSecret;
      return fallback ? fallback.channelSecret(club) : null;
    },
    async line(club) {
      const own = await messaging(club);
      if (own) return { channelSecret: own.channelSecret, accessToken: await cache.token(club.id, own.channelId, own.channelSecret) };
      return fallback ? fallback.line(club) : null;
    },
    /** A4b order: the club's own login channel, else the platform's shared one, else the fallback. */
    async login(club) {
      const own = await readClubCredential<{ channelId: string; channelSecret: string; liffId?: string }>(db, key, club.id, 'line_login');
      if (own) return { channelId: own.channelId, channelSecret: own.channelSecret, liffId: club.liffId ?? own.liffId ?? null, shared: false };
      const platform = await platformLoginChannel(db, key);
      if (platform) return platform;
      return fallback ? fallback.login(club) : null;
    },
  };
}

/** Wraps a store so it answers only for demo clubs (status 'demo'); every other club gets null. */
export function onlyDemoClubs(store: CredentialStore): CredentialStore {
  const demo = (club: Club) => club.status === 'demo';
  return {
    channelSecret: async (club) => (demo(club) ? store.channelSecret(club) : null),
    line: async (club) => (demo(club) ? store.line(club) : null),
    login: async (club) => (demo(club) ? store.login(club) : null),
  };
}
