import { randomBytes } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { platformFlags, supportGrants } from '../../db/schema.js';
import { decryptSecret, encryptSecret } from '../../platform/crypto.js';

/**
 * Chatwoot CE platform client and per-club provisioning (spec §6.3, plan A13).
 *
 * One shared Chatwoot install (infra/chatwoot). Each club gets one Chatwoot account with an API
 * inbox, an agent bot attached to it and our booking panel as a dashboard app. The ids live in
 * `platform_flags['chatwoot:<clubId>']` (no migration); the Chatwoot tokens in that row are
 * encrypted with CREDENTIALS_KEY (A4 scheme). Each step is saved as it completes, so a retry
 * skips what is done and creates nothing twice.
 *
 * Managers sign in through `inboxSsoUrl`: one Chatwoot user per (our user, club), a member of
 * that club's account only, mapped in `platform_flags['chatwoot:<clubId>:user:<userId>']`.
 */

export class ChatwootError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`Chatwoot ${status} on ${path}: ${detail}`);
  }
}

export class InboxNotProvisioned extends Error {
  constructor(clubId: string) {
    super(`club ${clubId} has no Chatwoot account yet`);
  }
}

export interface ChatwootClient {
  readonly url: string;
  /** Calls Chatwoot; `token` defaults to the platform app token. Throws ChatwootError on non-2xx. */
  request<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, token?: string): Promise<T>;
}

/** Per-call Chatwoot timeout: a hung Chatwoot must not hold club creation or a staff request for minutes. */
export const CHATWOOT_TIMEOUT_MS = 10_000;

/** `null` when CHATWOOT_URL or CHATWOOT_PLATFORM_TOKEN is unset: provisioning and the inbox routes are skipped. */
export function chatwootClient(config: Pick<Config, 'CHATWOOT_URL' | 'CHATWOOT_PLATFORM_TOKEN'>, fetchImpl: typeof fetch = (...a) => fetch(...a)): ChatwootClient | null {
  const base = config.CHATWOOT_URL?.replace(/\/$/, '');
  const platformToken = config.CHATWOOT_PLATFORM_TOKEN;
  if (!base || !platformToken) return null;
  return {
    url: base,
    async request(method, path, body, token) {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', api_access_token: token ?? platformToken },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CHATWOOT_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) throw new ChatwootError(res.status, path, text.slice(0, 200));
      return (text ? JSON.parse(text) : {}) as never;
    },
  };
}

export interface ChatwootClubState {
  accountId?: number;
  adminUserId?: number;
  /** Encrypted access token of the club's platform-owned admin user (creates inboxes, bots, apps). */
  adminTokenEnc?: string;
  adminLinked?: boolean;
  inboxId?: number;
  agentBotId?: number;
  /** Encrypted Agent Bot access token; A14 posts bot messages with it. */
  botTokenEnc?: string;
  botAttached?: boolean;
  dashboardAppId?: number;
  provisionedAt?: string;
}

export type InboxStatus = 'ready' | 'partial' | 'failed' | 'not_configured';

export const chatwootFlagKey = (clubId: string) => `chatwoot:${clubId}`;
const userFlagKey = (clubId: string, userId: string) => `chatwoot:${clubId}:user:${userId}`;

/** `conversations.external_ref` of a conversation mirrored into Chatwoot (A14 writes it). */
export const chatwootConversationRef = (accountId: number | string, conversationId: number | string) => `cw:${accountId}:${conversationId}`;

/** Where Chatwoot calls us back (A14 serves these). */
export const chatwootCallbackUrl = (publicUrl: string, clubId: string) => `${publicUrl.replace(/\/$/, '')}/integrations/chatwoot/${clubId}/callback`;
export const chatwootBotUrl = (publicUrl: string, clubId: string) => `${publicUrl.replace(/\/$/, '')}/integrations/chatwoot/${clubId}/bot`;
export const inboxPanelUrl = (publicUrl: string, slug: string) => `${publicUrl.replace(/\/$/, '')}/inbox-panel?club=${encodeURIComponent(slug)}`;

async function readFlag<T>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select({ value: platformFlags.value }).from(platformFlags).where(eq(platformFlags.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

async function writeFlag(db: Db, key: string, value: unknown, by: string, now: Date) {
  await db
    .insert(platformFlags)
    .values({ key, value, updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({ target: platformFlags.key, set: { value, updatedBy: by, updatedAt: now } });
}

export async function chatwootState(db: Db, clubId: string): Promise<ChatwootClubState | null> {
  return readFlag<ChatwootClubState>(db, chatwootFlagKey(clubId));
}

/** Decrypted Agent Bot token for A14, or null before provisioning reached that step. */
export async function chatwootBotToken(db: Db, key: Buffer, clubId: string): Promise<string | null> {
  const s = await chatwootState(db, clubId);
  return s?.botTokenEnc ? decryptSecret(s.botTokenEnc, key) : null;
}

export function inboxStatus(state: ChatwootClubState | null): InboxStatus {
  if (!state?.accountId) return 'failed';
  return state.provisionedAt ? 'ready' : 'partial';
}

/** Public summary for API responses: ids and status only, never tokens. */
export function inboxSummary(state: ChatwootClubState | null, status: InboxStatus = inboxStatus(state)) {
  return { status, accountId: state?.accountId ?? null, inboxId: state?.inboxId ?? null, agentBotId: state?.agentBotId ?? null };
}

/** Chatwoot wants an uppercase, lowercase, digit and special character. Nobody types it: sign-in is SSO. */
const chatwootPassword = () => `${randomBytes(24).toString('base64url')}Aa1!`;
const syntheticEmail = (local: string) => `${local.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}@club-platform.invalid`;

/**
 * Creates (or finishes creating) the club's Chatwoot account, admin user, API inbox, agent bot,
 * bot-to-inbox link and booking-panel dashboard app. Idempotent: every completed step is stored
 * before the next starts, and stored steps are skipped. Throws ChatwootError on a failed step;
 * the steps before it stay stored.
 */
export async function provisionClubInbox(
  db: Db,
  cw: ChatwootClient,
  key: Buffer,
  club: { id: string; name: string; slug: string },
  opts: { publicUrl: string; by: string; now: Date },
): Promise<ChatwootClubState> {
  const state: ChatwootClubState = { ...((await chatwootState(db, club.id)) ?? {}) };
  if (state.provisionedAt) return state;
  const save = () => writeFlag(db, chatwootFlagKey(club.id), state, opts.by, opts.now);

  if (!state.accountId) {
    const account = await cw.request<{ id: number }>('POST', '/platform/api/v1/accounts', { name: club.name });
    state.accountId = account.id;
    await save();
  }
  const accountId = state.accountId;
  if (!state.adminUserId) {
    const user = await cw.request<{ id: number; access_token: string }>('POST', '/platform/api/v1/users', {
      name: `${club.name} (platform)`,
      email: syntheticEmail(`platform.${club.id}`),
      password: chatwootPassword(),
    });
    state.adminUserId = user.id;
    state.adminTokenEnc = encryptSecret(user.access_token, key);
    await save();
  }
  if (!state.adminLinked) {
    await cw.request('POST', `/platform/api/v1/accounts/${accountId}/account_users`, { user_id: state.adminUserId, role: 'administrator' });
    state.adminLinked = true;
    await save();
  }
  const adminToken = decryptSecret(state.adminTokenEnc!, key);
  if (!state.inboxId) {
    const inbox = await cw.request<{ id: number }>(
      'POST',
      `/api/v1/accounts/${accountId}/inboxes`,
      { name: 'LINE', channel: { type: 'api', webhook_url: chatwootCallbackUrl(opts.publicUrl, club.id) } },
      adminToken,
    );
    state.inboxId = inbox.id;
    await save();
  }
  if (!state.agentBotId) {
    const bot = await cw.request<{ id: number; access_token: string }>(
      'POST',
      `/api/v1/accounts/${accountId}/agent_bots`,
      { name: 'Booking bot', description: 'Club booking bot', outgoing_url: chatwootBotUrl(opts.publicUrl, club.id) },
      adminToken,
    );
    state.agentBotId = bot.id;
    state.botTokenEnc = encryptSecret(bot.access_token, key);
    await save();
  }
  if (!state.botAttached) {
    await cw.request('POST', `/api/v1/accounts/${accountId}/inboxes/${state.inboxId}/set_agent_bot`, { agent_bot: state.agentBotId }, adminToken);
    state.botAttached = true;
    await save();
  }
  if (!state.dashboardAppId) {
    const app = await cw.request<{ id: number }>(
      'POST',
      `/api/v1/accounts/${accountId}/dashboard_apps`,
      { title: 'Bookings', content: [{ type: 'frame', url: inboxPanelUrl(opts.publicUrl, club.slug) }] },
      adminToken,
    );
    state.dashboardAppId = app.id;
    await save();
  }
  state.provisionedAt = opts.now.toISOString();
  await save();
  return state;
}

/** Runs provisioning and reports the outcome instead of throwing (club creation must not fail on the inbox). */
export async function tryProvisionClubInbox(
  db: Db,
  cw: ChatwootClient | null,
  key: Buffer,
  club: { id: string; name: string; slug: string },
  opts: { publicUrl: string; by: string; now: Date; log?: (msg: string, err?: unknown) => void },
) {
  if (!cw) return { ...inboxSummary(null, 'not_configured') };
  try {
    return inboxSummary(await provisionClubInbox(db, cw, key, club, opts));
  } catch (err) {
    opts.log?.('Chatwoot provisioning failed', err);
    const state = await chatwootState(db, club.id);
    return { ...inboxSummary(state, 'failed'), error: err instanceof ChatwootError ? `chatwoot_${err.status}` : 'chatwoot_unreachable' };
  }
}

export type ChatwootRole = 'administrator' | 'agent';

/** `platform_flags['chatwoot:<clubId>:user:<userId>']`. `grantId` is set when the login came through a support grant. */
type UserMapping = { chatwootUserId: number; role?: ChatwootRole; accountId?: number; grantId?: string | null };

/**
 * Single sign-on link into the club's Chatwoot account. The Chatwoot user is per (our user, club)
 * and is a member of this club's account only, so the link cannot reach another club's inbox.
 * Throws InboxNotProvisioned when the club has no account yet.
 */
export async function inboxSsoUrl(
  db: Db,
  cw: ChatwootClient,
  club: { id: string },
  user: { id: string; name: string },
  role: ChatwootRole,
  now: Date,
  grantId: string | null = null,
): Promise<string> {
  const state = await chatwootState(db, club.id);
  if (!state?.accountId) throw new InboxNotProvisioned(club.id);
  const key = userFlagKey(club.id, user.id);
  const mapping = (await readFlag<UserMapping>(db, key)) ?? null;
  let chatwootUserId = mapping?.chatwootUserId;
  if (!chatwootUserId) {
    const created = await cw.request<{ id: number }>('POST', '/platform/api/v1/users', {
      name: user.name,
      email: syntheticEmail(`u.${user.id}.${club.id}`),
      password: chatwootPassword(),
    });
    chatwootUserId = created.id;
    await writeFlag(db, key, { chatwootUserId }, user.id, now);
  }
  if (mapping?.role !== role || mapping?.accountId !== state.accountId || (mapping?.grantId ?? null) !== grantId) {
    await cw.request('POST', `/platform/api/v1/accounts/${state.accountId}/account_users`, { user_id: chatwootUserId, role });
    await writeFlag(db, key, { chatwootUserId, role, accountId: state.accountId, grantId } satisfies UserMapping, user.id, now);
  }
  const login = await cw.request<{ url: string }>('GET', `/platform/api/v1/users/${chatwootUserId}/login`);
  return login.url;
}

/**
 * Takes a person's Chatwoot access to one club away: removes the account membership, deletes the
 * Chatwoot user (which ends every Chatwoot session it holds) and drops our mapping, so the next
 * "Open inbox" (if still allowed) creates a fresh user at the current role. Called when a member is
 * disabled or changes role, and when a support grant ends or expires. No mapping: nothing to do.
 * Throws ChatwootError when Chatwoot refuses; the mapping is kept then, so a later call retries.
 */
export async function revokeInboxUser(db: Db, cw: ChatwootClient, clubId: string, userId: string): Promise<boolean> {
  const key = userFlagKey(clubId, userId);
  const mapping = await readFlag<UserMapping>(db, key);
  if (!mapping?.chatwootUserId) return false;
  const accountId = mapping.accountId ?? (await chatwootState(db, clubId))?.accountId;
  if (accountId) {
    await ignoreNotFound(cw.request('DELETE', `/platform/api/v1/accounts/${accountId}/account_users`, { user_id: mapping.chatwootUserId }));
  }
  await ignoreNotFound(cw.request('DELETE', `/platform/api/v1/users/${mapping.chatwootUserId}`));
  await db.delete(platformFlags).where(eq(platformFlags.key, key));
  return true;
}

const ignoreNotFound = (p: Promise<unknown>) =>
  p.catch((err) => {
    if (!(err instanceof ChatwootError && err.status === 404)) throw err;
  });

/** Best-effort `revokeInboxUser` for route hooks: never throws, logs a failure. */
export async function tryRevokeInboxUser(db: Db, cw: ChatwootClient | null, clubId: string, userId: string, log?: (msg: string, err?: unknown) => void) {
  if (!cw) return;
  try {
    await revokeInboxUser(db, cw, clubId, userId);
  } catch (err) {
    log?.(`Chatwoot revoke failed for user ${userId} in club ${clubId}`, err);
  }
}

/**
 * Revokes every Chatwoot login that came through a support grant which has since ended or expired.
 * Runs on a timer (piggybacks on A15's alert-check timer until B's scheduler exists). Returns how
 * many were revoked.
 */
export async function sweepGrantInboxUsers(db: Db, cw: ChatwootClient | null, now: Date, log?: (msg: string, err?: unknown) => void): Promise<number> {
  if (!cw) return 0;
  const rows = await db.select({ key: platformFlags.key, value: platformFlags.value }).from(platformFlags).where(like(platformFlags.key, 'chatwoot:%:user:%'));
  let revoked = 0;
  for (const row of rows) {
    const mapping = row.value as UserMapping | null;
    if (!mapping?.grantId) continue;
    const grant = await db.query.supportGrants.findFirst({ where: eq(supportGrants.id, mapping.grantId) });
    if (grant && !grant.endedAt && grant.expiresAt > now) continue;
    const m = /^chatwoot:(.+):user:(.+)$/.exec(row.key);
    if (!m) continue;
    try {
      if (await revokeInboxUser(db, cw, m[1]!, m[2]!)) revoked++;
    } catch (err) {
      log?.(`Chatwoot revoke failed for ${row.key}`, err);
    }
  }
  return revoked;
}
