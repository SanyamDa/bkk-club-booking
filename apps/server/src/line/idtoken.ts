export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type IdTokenVerifier = (idToken: string, channelId: string) => Promise<{ sub: string } | null>;

/**
 * Verifies a LIFF ID token with LINE and returns the LINE user id it belongs to.
 * https://developers.line.biz/en/reference/line-login/#verify-id-token
 */
export function lineIdTokenVerifier(fetchImpl: FetchLike = fetch): IdTokenVerifier {
  return async (idToken, channelId) => {
    try {
      const res = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: channelId }).toString(),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { sub?: unknown };
      return typeof body.sub === 'string' ? { sub: body.sub } : null;
    } catch {
      return null;
    }
  };
}
