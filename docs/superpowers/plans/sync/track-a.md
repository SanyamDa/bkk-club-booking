# Track A sync

## 2026-11-27 — W0 (shared contracts)

W0 is done: `npm test` (49 tests) and `npm run typecheck` pass. Track B may start B1 once this merges to main.

Published interfaces, exactly as implemented (paths relative to `apps/server/`).

### Actor and Reason — `src/bookings/service.ts`

```ts
export type Actor = {
  type: 'guest' | 'bot' | 'staff' | 'platform' | 'system';
  id?: string;
  sessionId?: string;
  supportGrantId?: string;
};

export const REASON_CODES = [
  'hold_expired',
  'guest_abandoned',
  'guest_cancelled',
  'club_cancelled',
  'payment_not_verified',
  'table_taken',
  'released',
  'other',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export type Reason = { code: ReasonCode; text?: string };
```

`Reason.text` is stored in `bookings.status_reason`, truncated to 200 characters. Audit rows get `actor_type`, `actor_id`, `session_id` and `support_grant_id`; the old `actor` column carries `actor.type` until B2.

### Booking service — `src/bookings/service.ts`

```ts
export async function holdTable(db: Db, club: Club, input: { guestId: string; tableId: string; nightDate: string; pax: number }, now: Date): Promise<Booking>
export async function submitDetails(db: Db, club: Club, bookingId: string, details: GuestDetails, now: Date)
export async function requestDeposit(db: Db, club: Club, bookingId: string, now: Date)
export async function recordSlip(db: Db, club: Club, bookingId: string, slipPath: string, now: Date)
export async function approveDeposit(db: Db, clubId: string, bookingId: string, actor: Actor, now: Date)
export async function rejectDeposit(db: Db, clubId: string, bookingId: string, actor: Actor, reason: Reason, now: Date)
export const cancelBooking = (db: Db, clubId: string, id: string, actor: Actor, reason: Reason, now: Date) => ...
export const markArrived = (db: Db, clubId: string, id: string, actor: Actor, now: Date) => ...
export const markNoShow = (db: Db, clubId: string, id: string, actor: Actor, now: Date) => ...
export async function createManualBooking(db: Db, club: Club, input: { tableId: string; nightDate: string; pax: number; name: string; phone?: string; notes?: string; depositPaid: boolean }, actor: Actor, now: Date): Promise<Booking>
export async function expireStaleHolds(db: Db, now: Date): Promise<Booking[]>
export async function latestDeposit(db: Db, bookingId: string): Promise<Deposit | undefined>
export async function bookingAwaitingSlip(db: Db, clubId: string, guestId: string, now: Date)
export async function currentBookingForGuest(db: Db, club: Club, guestId: string, now: Date)
export async function listTableOptions(db: Db, clubId: string): Promise<TableOption[]>
export async function bookingsForNight(db: Db, clubId: string, nightDate: string): Promise<Booking[]>

export interface BookingView { booking: Booking; table: Table; zone: Zone; guest: Guest; deposit?: Deposit }
export async function getBookingView(db: Db, where: { clubId: string; id?: string; refCode?: string }): Promise<BookingView | undefined>
```

Every mutation checks the booking belongs to the given club and throws `BookingError('not_found')` otherwise.

### getBookingViewByRef — `src/bookings/service.ts`

```ts
export async function getBookingViewByRef(db: Db, refCode: string): Promise<BookingView | undefined>
```

The only unscoped booking lookup (`ref_code` is globally unique). Use it only after a signed link was verified (`http/liff.ts` load, `http/media.ts`); take the club from `view.booking.clubId`.

### getDepositForClub — `src/bookings/service.ts`

```ts
export async function getDepositForClub(db: Db, clubId: string, id: string): Promise<Deposit | undefined>
```

### getConversationForClub — `src/chat/conversations.ts`

```ts
export async function getConversationForClub(db: Db, clubId: string, id: string): Promise<Conversation | undefined>
```

### CredentialStore, LoginChannel, envCredentialStore — `src/line/credentials.ts`

```ts
export interface ClubLineCredentials { channelSecret: string; accessToken: string }
export type LoginChannel = { channelId: string; channelSecret: string; liffId: string | null; shared: boolean };
export interface CredentialStore {
  channelSecret(club: Club): Promise<string | null>; // webhook signatures only; never issues a token
  line(club: Club): Promise<ClubLineCredentials | null>;
  login(club: Club): Promise<LoginChannel | null>;
}
export function envCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore
```

The env store reads the env var names on the club row (`lineChannelSecretEnv`, `lineAccessTokenEnv`, `lineLoginChannelIdEnv`, `lineLoginChannelSecretEnv`); `login` returns `shared: false`. A4 adds a DB-backed store.

### GatewayRegistry — `src/line/gateway.ts`

```ts
export const SIM_USER_PREFIX = 'SIM-';
export class GatewayRegistry {
  readonly dev: DevLineGateway;
  constructor(credentials: CredentialStore);
  forClub(club: Club, lineUserId?: string | null): Promise<LineGateway>;
}
```

Simulator ids use the dev gateway. A club with no credentials uses the dev gateway. Credentials are read on every call. The cached real gateway per club is rebuilt when the access token changes.

### Notifier — `src/bot/notify.ts`

```ts
export class Notifier {
  constructor(deps: BotDeps, gateways: GatewayRegistry);
  confirmed(clubId: string, bookingId: string): Promise<void>;
  rejected(clubId: string, bookingId: string): Promise<void>;
  cancelled(clubId: string, bookingId: string, reasonText: string): Promise<void>;
  holdExpired(booking: Booking): Promise<void>;
  hostReply(clubId: string, guestId: string, text: string, _actor: Actor): Promise<void>;
}
```

Each method sends nothing when the booking or guest belongs to another club.

### buildBotDeps / BotDepOptions — `src/bot/deps.ts`

```ts
export interface BotDepOptions {
  now?: () => Date;
  log?: BotDeps['log'];
}
export function buildBotDeps(config: Config, db: Db, opts: BotDepOptions = {}): BotDeps
```

B adds each new dependency's fake to `BotDepOptions`.

### startBackground — `src/jobs/index.ts`

```ts
export async function startBackground(ctx: AppContext, now: () => Date): Promise<() => Promise<void>>
```

`main.ts` calls it once and the returned function stops all jobs. Register new jobs here, never in `main.ts`. W0 registers only the 30 s hold sweeper.

### EVENT_TYPES, EventInput, emit — `src/data/event-types.ts`, `src/data/events.ts`

```ts
export const EVENT_TYPES = [ 'guest.first_seen', /* ... spec §14.2 table ... */ 'booking.status_changed' ] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type EventInput = {
  clubId: string;
  type: EventType;
  occurredAt: Date;
  actorType: 'guest' | 'bot' | 'staff' | 'platform' | 'system';
  actorId?: string;
  channel?: string;
  dataOrigin: 'first_party' | 'line_chat' | 'line_profile' | 'instagram' | 'pos';
  source?: string;
  guestId?: string;
  conversationId?: string;
  bookingId?: string;
  tableId?: string;
  zoneId?: string;
  nightDate?: string;
  attemptId?: string;
  causeId?: string;
  lang?: string;
  props?: Record<string, string | number | boolean | null>;
  raw?: unknown;
  isTest: boolean;
  dedupeKey?: string;
};

export async function emit(tx: Db, e: EventInput, _opts?: { strict?: boolean }): Promise<void>
```

W0 stub: one insert with `v: 1`, and a repeated `(club_id, dedupe_key)` is skipped. B1 owns `EVENT_TYPES` and adds versions, props validation, privacy classes and the dead letter. `strict` is unused until then.

### Test helpers — `test/helpers.ts`, `test/fixtures/club.ts`

```ts
export async function setupDb() // { ...openDb handle, club }; fixture club seeded
export const CLUB_B_ID = 'club_test_b';
export async function setupTwoClubs(): Promise<{ db: Db; close: () => Promise<void>; clubA: Club; clubB: Club }>
export async function makeGuest(db: Db, opts: { clubId?: string; lineUserId?: string } = {})
export const FRIDAY_AFTERNOON = new Date('2026-11-27T08:00:00Z');
export const FRIDAY = '2026-11-27';

// test/fixtures/club.ts
export const FIXTURE_CLUB_ID = 'club_demo';
export const FIXTURE_CLUB_SLUG = 'demo';
export const fixtureSettings: ClubSettings;
export async function seedFixtureClub(db: Db): Promise<void>
```

`clubA` is the fixture club (status `demo`). `clubB` is `club_test_b` (slug `test-b`, status `live`, ref prefix `TB`), with zones `zone_b_vip` and `zone_b_std` and tables `V1`, `V2`, `S1`, `S2`. `makeGuest` defaults to the fixture club.

### Track A helpers — `test/helpers/track-a.ts`

```ts
export type TestApp = Requester | { app: Requester };
export function testConfig(overrides: Partial<Config> = {}): Config      // W0: today's literal; A3 changes it
export async function staffCookie(app: TestApp, _club: Club): Promise<string> // W0: shared-password login; A1 changes it
export function staffUrl(slug: string, path: string): string           // pass the tail without /clubs/<slug>; A2 makes every path club-scoped
export async function adminCookie(app: TestApp): Promise<string>        // W0: returns the staff cookie; A1 changes it
```

### Track B helpers — `test/helpers/track-b.ts`

```ts
export async function isolationFixtures(_db: Db, _club: Club): Promise<Record<string, string>> // W0: returns {}
```


## 2026-11-27 — A1 (per-person accounts, server-side sessions, second factor)

Landed on `track-a` (not merged yet). `npm test` (89 tests, 10 files) and `npm run typecheck` pass; `npm run build -w @club/web` passes.

Tests: `test/auth.test.ts` (11 tests) and `test/totp.test.ts` (3 tests).

What landed: scrypt passwords, server-side sessions (`sid` cookie, only `sha256(sid)` stored), TOTP for platform admins, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, per-account lockout, `staff.login` events, `npm run admin:create`. The shared-password `POST /api/staff/login` is gone. `scripts/live.ts`, `README.md`, `docs/LINE-SETUP.md` and `.env.example` use `npm run admin:create` plus `LIVE_EMAIL` / `LIVE_PASSWORD`. `apps/web/src/pages/staff/Login.tsx` now asks for email and password (and a TOTP code when the server answers `totp_required`).

Published interfaces (paths relative to `apps/server/`):

```ts
// src/platform/passwords.ts
export async function hashPassword(pw: string): Promise<string>          // scrypt$N$r$p$salt$hash
export async function verifyPassword(pw: string, stored: string): Promise<boolean>
export function dummyHash(): Promise<string>                              // constant-time path for unknown email
export function generatePassword(): string

// src/platform/sessions.ts
export const SESSION_COOKIE = 'sid';
export const hashSid = (sid: string): string => ...;                     // sha256, base64url
export async function createSession(db: Db, userId: string, meta: { ip?: string; userAgent?: string }, now: Date): Promise<{ sid: string; expiresAt: Date }> // staff 12 h, admin 8 h
export async function loadSession(db: Db, sid: string, now: Date): Promise<{ user: User; session: Session } | null>
export async function revokeSession(db: Db, sid: string, now: Date): Promise<void>

// src/platform/totp.ts
export function totp(secret: Buffer, at: Date): string
export function verifyTotp(secret: Buffer, code: string, at: Date): boolean // ±1 step
export function base32Encode(buf: Buffer): string
export function base32Decode(s: string): Buffer
export function newTotpSecret(): string
export function otpauthUrl(secretBase32: string, account: string, issuer = 'Club Booking'): string

// src/http/auth.ts
export type Role = MembershipRole; // 'owner' | 'manager' | 'host' | 'door' | 'promoter'
export type AuthEnv = { Variables: { user: User; session: Session; club: Club; membership: ClubMembership | null; supportGrant: SupportGrant | null } };
export const clientIp = (c: Context): string | undefined => ...;
export function requireUser(app: AppContext): MiddlewareHandler<AuthEnv>
export function requirePlatformAdmin(app: AppContext): MiddlewareHandler<AuthEnv>
export function requireClubRole(app: AppContext, ...roles: Role[]): MiddlewareHandler<AuthEnv> // any role when none given
export async function checkClubAccess(app: AppContext, userId: string, clubId: string, roles: Role[] = []): Promise<'ok' | 'not_found' | 'forbidden'>
export async function clubsOfUser(db: Db, userId: string)
export function authRoutes(app: AppContext) // mounted at /api/auth

// src/scripts/create-admin.ts
export interface CreatedAccount { userId: string; email: string; password: string; otpauthUrl: string | null }
export async function createAccount(db: Db, argv: string[]): Promise<CreatedAccount>
```

The middleware are factories that take the `AppContext` first (they need `db` and `now`). This differs from the plan's `requireClubRole(...roles)`. Example: `r.post('/clubs/:slug/staff-link-code', requireClubRole(app, 'owner', 'manager'), handler)`. `requireClubRole` answers 404 `not_found` for an unknown slug and 403 `forbidden` for a club the user cannot use.

Routes: `POST /api/auth/login {email, password, totp?}` returns `{ ok: true, expiresAt }` and sets `sid`; errors are 401 `invalid_login` (unknown email, wrong password, locked), 401 `totp_required`, 401 `invalid_totp`. `POST /api/auth/logout` returns `{ ok: true }`. `GET /api/auth/me` returns `{ user: { id, email, name, platformRole }, clubs }` with only the user's own clubs. `GET /api/staff/me` still exists and returns `{ clubs }`.

`http/staff.ts` already checks the club on every route (a stopgap before A2): `/clubs/:slug/*` goes through `requireClubRole` (`owner|manager|host|door`; `settings`, `line-setup` and `line-status` need `owner|manager`). The id routes (`bookings/:id`, `conversations/:id`, `deposits/:id/slip`) go through `checkClubAccess` on the row's club: 404 when the user has no access there, and approve and reject need `owner|manager`.

Test helpers changed (`test/helpers/track-a.ts`):

```ts
export async function staffCookie(app: TestApp, club: Club, role: MembershipRole = 'manager'): Promise<string> // creates a member, logs in via POST /api/auth/login
export async function adminCookie(app: TestApp): Promise<string> // platform_role 'admin' with TOTP, at the app's clock
```

Both need the object `createApp` returns (with `.ctx`), not the bare Hono app.

Requests for Track B: none.

Blockers and `it.todo`: none.

Still to do by a human: the browser walk of the new staff login page (`apps/web/src/pages/staff/Login.tsx`) and the plan's check that `npm run live` reaches the LINE setup report with no `STAFF_PASSWORD` in `.env`.

## 2026-11-27 — A3 (safe configuration)

Landed on `track-a` (not merged yet); tests in `test/config.test.ts` (6 tests).

What landed: `loadConfig` refuses the example `APP_SECRET` and any `APP_SECRET` shorter than 32 characters. It refuses `DEV_SIMULATOR` and `LINE_FAKE` unless `NODE_ENV` is `development` or `test`. It requires `CREDENTIALS_KEY` (base64 of exactly 32 bytes) outside development and test. In development and test it derives a missing key as `sha256('credentials:' + APP_SECRET)`. `STAFF_PASSWORD` is removed. `npm start` sets `NODE_ENV=production`.

Published interfaces (`src/config.ts`):

```ts
export const EXAMPLE_APP_SECRET = 'change-me-to-a-long-random-string';
export type Config = Omit<z.infer<typeof schema>, 'CREDENTIALS_KEY'> & { CREDENTIALS_KEY: Buffer };
// keys: API_PORT, PUBLIC_URL, DATABASE_URL?, DATA_DIR, APP_SECRET, CREDENTIALS_KEY (Buffer),
//       ANTHROPIC_API_KEY?, DEV_SIMULATOR: boolean, LINE_FAKE: boolean, NODE_ENV
export function isDevOrTest(nodeEnv: string): boolean
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config
```

`loadConfig` is the only place that holds the "development or test only" rule. B8 reads `config.DEV_SIMULATOR` and adds no `NODE_ENV` check.

`testConfig` (`test/helpers/track-a.ts`) drops `STAFF_PASSWORD` and sets `CREDENTIALS_KEY: Buffer.alloc(32, 7)`, `ANTHROPIC_API_KEY: undefined` and `LINE_FAKE: false`. No test body changed.

Requests for Track B: any test that builds a `Config` literal must use `testConfig(...)`, because `CREDENTIALS_KEY` is now a `Buffer` and `STAFF_PASSWORD` no longer exists.

Blockers and `it.todo`: none.

## 2026-11-27 — A4 (encrypted club credentials and stateless LINE tokens)

Landed on `track-a` (not merged yet); tests in `test/credentials.test.ts` (10 tests).

What landed: AES-256-GCM secrets in `club_credentials` (`v1:iv:tag:data`, `key_ref = 'env:CREDENTIALS_KEY:v1'`). Stateless LINE access tokens from `POST https://api.line.me/oauth2/v3/token`, cached in memory per club for 10 minutes and never stored. `createApp` uses the DB store. The env store is a fallback only in development and test, and only for clubs with status `demo`. `LINE_FAKE` selects the fake issuer, fake setup clients and fake LIFF updater. A test hook `opts.onResponse` sees every JSON response.

Published interfaces:

```ts
// src/platform/crypto.ts
export const CREDENTIALS_KEY_REF = 'env:CREDENTIALS_KEY:v1';
export function encryptSecret(plain: string, key: Buffer): string
export function decryptSecret(blob: string, key: Buffer): string // throws on tamper or wrong key
export function last4(secret: string): string

// src/platform/credentials.ts
export type CredentialKind = 'line_messaging' | 'line_login' | 'instagram' | 'pos';
export async function setClubCredential(db: Db, key: Buffer, input: { clubId: string; kind: CredentialKind; secret: object; setBy: string }, now: Date): Promise<{ last4: string; setAt: Date }>
export async function credentialSummary(db: Db, clubId: string): Promise<{ kind: string; last4: string; setBy: string; setAt: Date }[]>
export async function readClubCredential<T>(db: Db, key: Buffer, clubId: string, kind: CredentialKind): Promise<T | null>

// src/line/tokens.ts
export interface LineTokenIssuer { accessToken(channelId: string, channelSecret: string): Promise<string> }
export const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
export const TOKEN_CACHE_MS = 10 * 60_000;
export function realLineTokenIssuer(fetchImpl: typeof fetch = (...args) => fetch(...args)): LineTokenIssuer
export function fakeLineTokenIssuer(): LineTokenIssuer // returns 'fake-token'
export function forgetLineToken(clubId: string): void
export class LineTokenCache { constructor(issuer: LineTokenIssuer); token(clubId: string, channelId: string, channelSecret: string): Promise<string> }

// src/line/credentials.ts
export function dbCredentialStore(db: Db, key: Buffer, tokens: LineTokenIssuer, fallback?: CredentialStore): CredentialStore
export function onlyDemoClubs(store: CredentialStore): CredentialStore

// src/line/setup.ts
export function fakeSetupClients(_accessToken: string, login: LoginChannel | null): SetupClients // same shape as realSetupClients; every step green

// src/app.ts
export interface ResponseRecord { method: string; path: string; status: number; body: unknown }
// createApp opts gain: onResponse?: (r: ResponseRecord) => void
```

A stored `line_messaging` secret is the JSON `{ channelId, channelSecret }`. `setClubCredential` writes an `audit_log` row with the before and after `last4` only, and calls `forgetLineToken(clubId)`, so a console change applies on the next message. A `line_login` secret with a `liffId` also sets `clubs.liff_id`. `dbCredentialStore(...).channelSecret(club)` decrypts the stored secret and never calls the issuer. Tests pass `opts.credentials = dbCredentialStore(db, key, fakeIssuer)`; no other `createApp` option is needed.

Secret-leak recorder (`test/helpers/track-a.ts`), for A5's admin and support suites and any B suite that stores a secret:

```ts
export function secretLeakRecorder(): {
  records: ResponseRecord[];
  onResponse: (r: ResponseRecord) => void;   // pass to createApp(..., { onResponse })
  track: (...values: string[]) => void;
  assertNoLeak: (extra?: string[]) => void;  // throws naming the request that leaked
}
```

Requests for Track B: a club that is not `demo` now gets LINE credentials only from the database (`setClubCredential`), never from env vars. B fixtures that need a live LINE gateway for a non-demo club should store credentials with `setClubCredential` and use `fakeLineTokenIssuer()`.

Blockers and `it.todo`: none.

## 2026-11-27 — A4b (shared LIFF and platform login channel)

Landed on `track-a` (not merged yet); tests in `test/shared-liff.test.ts` (8 tests).

What landed: one platform LINE Login channel and LIFF app, stored encrypted in `platform_flags['line_login']`. `dbCredentialStore(...).login(club)` resolves in this order: the club's own `line_login` credential (`shared: false`), then the platform channel (`shared: true`), then the fallback, then `null`. Saving the platform channel fills `clubs.liff_id` on every club that has none and no own login credential. It also sets the shared LIFF endpoint once. `runLineSetup` skips the per-club LIFF endpoint step for a shared channel.

Published interfaces:

```ts
// src/platform/login-channel.ts
export async function setPlatformLoginChannel(
  db: Db,
  key: Buffer,
  input: { channelId: string; channelSecret: string; liffId: string; setBy: string },
  now: Date,
  liffEndpoint?: { publicUrl: string; update: LiffEndpointUpdater },
): Promise<{ last4: string; setAt: Date }>
export async function platformLoginChannel(db: Db, key: Buffer): Promise<LoginChannel | null>
export async function platformLoginSummary(db: Db): Promise<{ liffId: string; last4: string; setBy: string; setAt: Date } | null>

// src/line/setup.ts
export type LiffEndpointUpdater = (login: { channelId: string; channelSecret: string }, liffId: string, url: string) => Promise<void>;
export const realLiffEndpointUpdater: LiffEndpointUpdater;
export const fakeLiffEndpointUpdater: LiffEndpointUpdater;
export const liffEndpointUrl = (publicUrl: string) => `${publicUrl.replace(/\/$/, '')}/liff/details`;
// SetupClients gains: loginShared?: boolean
// runLineSetup opts gain: login?: LoginChannel | null

// src/http/context.ts — AppContext gains:
updateLiffEndpoint: LiffEndpointUpdater; // fake under LINE_FAKE; createApp opts gain updateLiffEndpoint?
```

The extra `liffEndpoint` argument of `setPlatformLoginChannel` is beyond the plan's signature. A5's `POST /api/admin/platform/line-login` passes `{ publicUrl: config.PUBLIC_URL, update: ctx.updateLiffEndpoint }`. A failed endpoint update throws after the channel is stored, and saving again retries it.

Requests for Track B: B5 consumes `credentials.login(club)`. With `shared: true` the ID token's `sub` is our provider's id, not the id that the club's webhook sees. B5's first-use pair check (`linkLiffSub`) must replace the direct `sub === lineUserId` compare.

Blockers and `it.todo`: none in A4b. A5's gate tests that depend on B5 stay `it.todo` until B5 merges (plan A5).

## 2026-11-27 — A7 (hosted 24/7)

Landed on `track-a` (not merged yet): `Dockerfile`, `docker-compose.yml` (app and `postgres:16`, volumes `appdata` and `pgdata`, `restart: unless-stopped`, health checks on `GET /health` and `pg_isready`), `infra/README.md` (deploy, backup, restore and restore drill, rotate `CREDENTIALS_KEY`, monitoring, open points) and `infra/backup.sh` (nightly `pg_dump` to an S3-compatible store or `file://`). Logs are structured JSON on stdout.

Published interfaces (`src/lib/log.ts`, new and additive):

```ts
export type LogLevel = 'info' | 'warn' | 'error';
export function errorFields(err: unknown): Record<string, unknown>
export function logLine(level: LogLevel, msg: string, fields: Record<string, unknown> = {}, write: (line: string) => void = (line) => process.stdout.write(line)): void
export function jsonLog(msg: string, err?: unknown): void // same call shape as BotDeps['log']
```

`createApp` passes `jsonLog` to `buildBotDeps` unless `opts.bot.log` is set. `main.ts` logs with `logLine`.

Requests for Track B: in `src/bot/deps.ts`, make `defaultLog` the `jsonLog` from `../lib/log.js`. Change the `console.error` default of `Outbox`'s `log` (`line/outbox.ts`) the same way, so no code path prints plain text.

Blockers and `it.todo`: none. Still open: the production host and region (spec §16.1 question 5) and the error tracking service.

Still to do by a human: the plan's check was not run in this session. That check is `docker compose up` locally, `curl /health` giving `{ "ok": true }`, a signed simulator webhook round trip against Postgres, and the restore drill (dump, drop, restore, app starts).
