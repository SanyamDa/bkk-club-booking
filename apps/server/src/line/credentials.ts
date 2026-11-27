import type { Club } from '../db/schema.js';

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
