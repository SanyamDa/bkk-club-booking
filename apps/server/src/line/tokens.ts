/**
 * Stateless LINE channel access tokens (spec §11.1.2). A token is valid for 15 minutes; we
 * cache it for 10 per club so a cached token always has minutes left for a send in flight.
 * The access token is never stored. This file is the only place that holds a token lifetime.
 */

export interface LineTokenIssuer {
  accessToken(channelId: string, channelSecret: string): Promise<string>;
}

export const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
export const TOKEN_CACHE_MS = 10 * 60_000;

/** Issues a stateless token with `POST /oauth2/v3/token` (client_credentials). */
export function realLineTokenIssuer(fetchImpl: typeof fetch = (...args) => fetch(...args)): LineTokenIssuer {
  return {
    async accessToken(channelId, channelSecret) {
      const res = await fetchImpl(LINE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: channelId, client_secret: channelSecret }).toString(),
      });
      if (!res.ok) throw new Error(`LINE token request failed: ${res.status}`);
      const json = (await res.json()) as { access_token?: string };
      if (!json.access_token) throw new Error('LINE token response had no access_token');
      return json.access_token;
    },
  };
}

/** Local fake LINE (config.LINE_FAKE): no network, always the same token. */
export function fakeLineTokenIssuer(): LineTokenIssuer {
  return { accessToken: async () => 'fake-token' };
}

/**
 * Bumped by `forgetLineToken`, so a credential change made through any store instance
 * (e.g. the console) drops every cached token of that club on the next read.
 */
const generations = new Map<string, number>();

export function forgetLineToken(clubId: string): void {
  generations.set(clubId, (generations.get(clubId) ?? 0) + 1);
}

/** Per-club in-memory token cache in front of an issuer. Clock is `Date.now`. */
export class LineTokenCache {
  private entries = new Map<string, { token: string; expiresAt: number; channelId: string; channelSecret: string; gen: number }>();

  constructor(private issuer: LineTokenIssuer) {}

  async token(clubId: string, channelId: string, channelSecret: string): Promise<string> {
    const now = Date.now();
    const gen = generations.get(clubId) ?? 0;
    const hit = this.entries.get(clubId);
    if (hit && hit.expiresAt > now && hit.gen === gen && hit.channelId === channelId && hit.channelSecret === channelSecret) {
      return hit.token;
    }
    const token = await this.issuer.accessToken(channelId, channelSecret);
    this.entries.set(clubId, { token, expiresAt: now + TOKEN_CACHE_MS, channelId, channelSecret, gen });
    return token;
  }
}
