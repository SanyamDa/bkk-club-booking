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

Blockers and `it.todo`: none in A4b. A5's gate tests that depend on B5 stay `it.todo` until B5 merges (plan A5). B5 done (2026-11-27): `linkLiffSub` replaced the direct compare when `shared` is true, and the A5 gate test is a real test.

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

## 2026-11-27 — A2 (club check on every route)

Landed on `track-a` (not merged yet). Every `/api/staff` route now lives under `/clubs/:slug/...` behind `requireClubRole`. Night view, bookings, cancel, arrived, no-show, handoffs, alerts and slip allow `owner|manager|host|door`; approve, reject, settings, line-setup and line-status allow `owner|manager`. Every id lookup is club-scoped (`getBookingView`, the service mutations, `getConversationForClub`, `getDepositForClub`). Another club's id on the user's own slug answers 404; another club's slug answers 403. `/api/staff/me` and `/api/staff/logout` are removed: use `/api/auth/me` and `/api/auth/logout`. Nothing is exported from `http/staff.ts`.

Published interfaces (`test/helpers/track-a.ts`):

```ts
export function staffUrl(slug: string, path: string): string // `/api/staff/clubs/${slug}${path}`
export function routeTable(app: { routes: readonly { method: string; path: string }[] }, prefix: string): { method: string; path: string }[]
export function makeUser(db: Db, opts: { email: string; clubId?: string; role?: MembershipRole; platformAdmin?: boolean }): Promise<TestUser>
export function loginAs(app: TestApp, user: TestUser): Promise<string> // cookie; adds a TOTP code for admins
export function isolationFixtures(db: Db, club: Club): Promise<Record<string, string>> // keys like 'bookings/:id'
export interface TestUser { id: string; email: string; password: string; totpSecret: string | null; ... }
```

`AuthEnv` (`src/http/auth.ts`), what `requireClubRole(app, ...roles: Role[])` puts on `c.var`:

```ts
export type AuthEnv = {
  Variables: {
    user: User;
    session: Session;
    club: Club;
    membership: ClubMembership | null; // null when access comes from a support grant
    supportGrant: SupportGrant | null;
    actor: Actor; // staff: { type: 'staff', id, sessionId }; support/platform: { type: 'platform', id, sessionId, supportGrantId }
  };
};
```

Web (`apps/web/src/api.tsx`): `export const staffPath = (club: string, path: string) => \`/api/staff/clubs/${encodeURIComponent(club)}${path}\``; every staff page now calls the slugged routes.

Requests for Track B: every router mounted under `/api/staff` or `/api/admin` must put its routes under `/clubs/:slug` (or be added to `UNSCOPED_ALLOWLIST` in `isolation.test.ts`). Each new route param needs a fixture key in `track-b.ts`'s `isolationFixtures`; the key is the segment before the param plus the param (e.g. `nights/:id`). The isolation tests fail on a param with no fixture. `requireClubRole` sets `c.var.club`, `c.var.session` (use `session.idHash`; sessions have no `id` column), `c.var.supportGrant` and `c.var.actor`.

Blockers and `it.todo`: none. Row-level security (A2b) stays deferred (assumed). The browser walk of the staff pages on the slugged routes is still to be done by a human.

## 2026-11-27 — A5 (founder console API v1)

Landed on `track-a` (not merged yet): `http/admin/{index,clubs,line-wizard,controls,platform,support,debug,data}.ts`, `platform/{health,club-templates,support}.ts`, mounted at `/api/admin` behind `requirePlatformAdmin`. `auth.ts` gains support-grant handling: read-only grants refuse writes with 403 `support_read_only`, every request under a grant writes one `audit_log` row (`action 'support.request'`), and responses carry `X-Support-Session`, the value `<club name>, ends <HH:MM>` (Bangkok time) percent-encoded with `encodeURIComponent` (a Thai club name is not a valid header ByteString; read it with `decodeURIComponent`). Under a support grant (read or write), `POST .../conversations/:id/reply` answers 403 `support_no_guest_messages` (spec §16.1 q8: a support session never messages a guest as the club).

Published interfaces:

```ts
// platform/support.ts
export function isGloballyStopped(db: Db): Promise<boolean> // platform_flags['global_stop'] is true or { stopped: true }
export const GLOBAL_STOP_FLAG = 'global_stop'
// platform/club-templates.ts
export function newClubSettings(slug: string, now: Date): ClubSettings
export function baseRefPrefix(slug: string): string
export function uniqueRefPrefix(slug: string, taken: Iterable<string>): string
// ops_events rows kind 'line_setup': detail = { report: SetupReport, quota: { used: number; limit: number } | null } (limit 0 = no limit)

// platform/support.ts (continued)
export const SUPPORT_GRANT_MINUTES = 60
export class SupportError extends Error { constructor(readonly code: 'not_found' | 'ended') }
export async function createSupportGrant(db: Db, input: { userId: string; sessionId?: string; club: Club; reason: string; ticketRef?: string | null; ip?: string }, now: Date): Promise<SupportGrant>
export async function elevateSupportGrant(db: Db, input: { id: string; userId: string; sessionId?: string; reason: string; ip?: string }, now: Date): Promise<SupportGrant>
export async function endSupportGrant(db: Db, input: { id: string; userId: string; sessionId?: string; ip?: string }, now: Date): Promise<SupportGrant>
export async function activeGrantsOf(db: Db, userId: string, now: Date): Promise<SupportGrant[]>

// platform/health.ts
export type LineSetupDetail = { report: SetupReport; quota: { used: number; limit: number } | null }
export type QuotaView = { limit: number; used: number; pct: number; warn: boolean }
export const QUOTA_WARN_PCT = 80
export function quotaView(q: { used: number; limit: number } | null | undefined): QuotaView | null
export interface ClubHealth { slug; name; status: Club['status']; lineConnected; webhookOk; lineCheckedAt: string | null; lastInboundAt: string | null; failures24h: number; quota: QuotaView | null; handoffsPastTimeout: number; depositsInReview: number; staffGroupLinked: boolean; botPaused: boolean }
export async function clubHealth(db: Db, club: Club, now: Date): Promise<ClubHealth>

// http/auth.ts
export function supportSessionHeader(club: Club, grant: SupportGrant): string
export async function recordAuthFailure(db: Db, userId: string, now: Date): Promise<number>
export const MAX_AUTH_FAILURES = MAX_FAILURES

// http/context.ts: AppContext gains
lineTokens: LineTokenIssuer;

// http/admin/controls.ts (helpers for other admin routers)
export const jsonBody = (c: Context) => Promise<unknown>
export async function freshTotpRefusal(app: AppContext, c: Context<AuthEnv>, body: unknown): Promise<Response | null>
export async function adminAudit(...)
export async function notifyStaffGroup(app: AppContext, club: Club, text: string)
export async function clubBySlug(db: Db, slug: string): Promise<Club | undefined>
// http/admin/line-wizard.ts
export const LIVE_TEST_WINDOW_MS = 60_000
// http/admin/data.ts
export const HEALTH_DAYS = 7
```

Admin routes under `/api/admin`: `GET|POST /clubs`, `GET|PATCH /clubs/:slug`, `PUT /clubs/:slug/profile`, `POST /clubs/:slug/pause`, `PUT /clubs/:slug/promptpay`, `PUT /clubs/:slug/greeting`, `POST /clubs/:slug/line`, `GET /clubs/:slug/line/status`, `POST /clubs/:slug/line/live-test`, `POST /clubs/:slug/tester-code`, `GET /clubs/:slug/credentials`, `GET /clubs/:slug/webhooks`, `GET /clubs/:slug/messages`, `GET /clubs/:slug/conversations/:id/timeline`, `GET /clubs/:slug/bookings/:id/timeline`, `POST /clubs/:slug/webhooks/:id/replay`, `POST /clubs/:slug/test-message`, `GET|POST /global-stop`, `GET|POST /platform/line-login`, `GET|POST /support`, `POST /support/:id/elevate`, `POST /support/:id/end`, `GET /data/health`, `GET /events`.

Fresh TOTP for credential, PromptPay, greeting and platform login changes: JSON body field `totp`; missing → 401 `totp_required`, wrong → 401 `invalid_totp`. Wrong codes count like failed logins (`recordAuthFailure` in `http/auth.ts`); the fifth revokes the session and locks the account, answering 401 `totp_locked`. `POST .../line` checks the new channel id and secret with LINE (`ctx.lineTokens`) before saving and answers 400 with a failed 'LINE credentials' `SetupReport` when LINE refuses them. Staff-group notices after a committed change never fail the request. `POST /api/admin/global-stop` writes `{ stopped: boolean }`.

Requests for Track B:
- B3: done (2026-11-27, see sync/track-b.md). `isGloballyStopped` is called, `recordLineSetup` uses `recordOps`, replay calls `processDelivery` dry run, and the four `it.todo` tests are real.
- B0: publish `applyClubContent`; `template: 'velora-like'` answers 501 `not_ready` until then.
- B5: done (2026-11-27). `console-created club: details read with a valid ID token...` is a real test.
- B6: done (2026-11-27). `POST .../tester-code` calls `issueTesterCode` and returns `{ code, expiresAt }` once; the todo is a real test.

Deferred (decision, superseded by "Gap closing" below: `to:'self'` now works): `POST .../test-message {to:'self'}` answered 501 `not_ready`, because no founder LINE user id is stored anywhere. Storing it needs a `users` column (migration) and a way to capture the id (e.g. the founder adds the club's OA and sends a link code); tracked by an `it.todo` in `admin-support.test.ts`. `staff_group` works. The debug webhook and message lists now write a `debug.view` audit row each (entity `raw_webhooks` / `messages`, entity id the club id, query in `data`). The velora-like club assertions are an `it.todo` in `admin.test.ts` until B0 merges.

`it.todo` waiting on Track B (10 in all):
- `admin.test.ts`: "create club then receive a signed webhook with no restart: a raw_webhooks row for that club (needs B3)"; "pause stops replies within one message" (B3); "console-created club: details read with a valid ID token is 200, with no token it is refused" (B5, now a real test); "one guest message is traceable end to end" (B3); "failed send shows in the message log with LINE's error" (B3); "a velora-like club gets complete settings, a channels row, a refPrefix no other club has, and Velora tables and prices" (B0); "tester-code route returns the code once" (B6, now a real test).
- `admin-support.test.ts`: "test-message {to: 'self'} pushes to the founder's own LINE account (needs a stored founder LINE user id)" (decision, not B); "one guest message is traceable end to end" (B3); "failed send shows in the message log with LINE's error" (B3).

## 2026-11-27 — A6 (founder console web v1)

Landed on `track-a` (not merged yet): `pages/admin/*` mounted at `/admin/*`; `SupportBanner` in the staff layout, shown when a `/api/staff/clubs/*` response carries `X-Support-Session`. Admin login goes through `/staff/login?next=/admin`. Velora-like template, tester code, webhook replay and test-message-to-self show a "not ready" message until the Track B pieces above merge. The wizard deep links are placeholders until the first real Thai OA test (spec §16.1 q1–2). `npm run typecheck` and `npm run build -w @club/web` pass.

Published interfaces (`apps/web/src/api.tsx`):

```ts
export function useSupportHeader(): string | null // decoded X-Support-Session from the last /api/staff/clubs/* response
export interface StoredSupport { id: string; clubSlug: string; clubName: string; mode: 'read' | 'write'; expiresAt: string }
export function storedSupport(): StoredSupport[] // localStorage, unexpired only
export function saveSupport(s: StoredSupport)
export function forgetSupport(id: string)
export interface SetupReport { ok: boolean; steps: { name: string; ok: boolean; detail: string }[]; bot?: { displayName: string; basicId: string; chatMode: string; addFriendUrl: string } }
export interface CredentialSummary { kind: string; last4: string; setBy: string; setAt: string }
export interface PlanInputs { expectedBookings: number; hostReplies: number; staffAlerts: number; groupSize: number }
export interface AdminClub, LineStatusAdmin
export const adminApi = { me, clubs, createClub, club, setStatus, putProfile, connectLine, lineStatus, liveTest, testerCode, startSupport, elevateSupport, endSupport, webhooks, replay, messages, timeline, testMessage, pause, globalStop, globalStopState, platformLogin, setPlatformLogin, dataHealth, events }
```

Components (`apps/web/src/pages/admin/`): `AdminLayout`, `Clubs` (+ `HealthTile`), `ClubDetail`, `LineWizard`, `SupportBanner({ club }: { club: string })`, `WebhookLog`, `MessageLog`, `Timeline({ kind }: { kind: 'conversations' | 'bookings' })`, `Controls` (+ `ClubControls`), `DataHealth`, `EventStream`; shared bits in `AdminLayout.tsx`: `fmtTime`, `errText`, `Ok`, `Json`, `TotpField`.

Requests for Track B: none beyond A5's list; the web placeholders switch on when those routes stop answering `not_ready`. Blockers and `it.todo`: none in web.

Still to do by a human: the browser walk from the plan's A6 Check line (admin login with TOTP, create club, `LINE_FAKE=1` made-up credentials and setup report, club profile, support session banner with end time, end it, event stream filtered by one conversation, Data health). It was not done in this session.

## 2026-11-27 — A8 (staff accounts and invites)

Landed on `track-a` (not merged yet). Tests: `test/invites.test.ts` (15). Blockers and `it.todo`: none. Still to do by a human: the browser walk of `/staff/team` and `/invite` (web pages `Team.tsx`, `AcceptInvite.tsx`).

Published interfaces (`apps/server/src/platform/invites.ts`, `src/http/team.ts`):

```ts
export const INVITE_DAYS = 7;
export const MIN_PASSWORD_LENGTH = 10;
export function inviteTokenHash(secret: string, token: string): string // HMAC-SHA256 keyed 'invite:' + APP_SECRET
export async function createInvite(db: Db, secret: string, input: { clubId: string; email: string; role: MembershipRole; createdBy: string | null }, now: Date): Promise<{ invite: Invite; token: string }>
export async function acceptInvite(db: Db, secret: string, token: string, account: { userId: string } | { name: string; password: string }, now: Date): Promise<{ userId: string; clubId: string; role: MembershipRole; invite: Invite }>
export async function revokeInvite(db: Db, clubId: string, id: string, now: Date): Promise<Invite>
export async function setMemberRole(db: Db, clubId: string, userId: string, role: MembershipRole)
export async function revokeUserSessions(db: Db, userId: string, now: Date): Promise<number>
export async function disableMember(db: Db, clubId: string, userId: string, now: Date): Promise<{ role: MembershipRole; sessionsRevoked: number; accountDisabled: boolean }>
export const inviteLink = (publicUrl: string, token: string) => `${publicUrl}/invite#${token}`
```

Routes (owner, manager): `GET /api/staff/clubs/:slug/team`, `POST .../team/invites {email, role, via?: 'email' | 'line'}` (201, returns `link`, `mailtoUrl`, `lineShareUrl` for LINE), `DELETE .../team/invites/:id`, `PATCH .../team/members/:userId {role}`, `POST .../team/members/:userId/disable`. Public: `POST /api/auth/invites/preview {token}`, `POST /api/auth/invites/accept {token, name?, password}` (sets `sid`; a platform admin gets `loginRequired: true` and no cookie). Errors: `403 forbidden_role`, `400 self`, `400 last_owner`, `400 weak_password`, `400 invalid_invite`, `401 invalid_login`.

Disable removes only this club's membership, revokes all the person's sessions, and sets `users.disabled_at` only when no other membership remains and the person is not a platform admin. Revoked invites have `expires_at` set to now. Audit actions: `team.invite_created`, `team.invite_revoked`, `team.invite_accepted`, `team.role_changed`, `team.member_disabled`.

Requests for Track B: add `staff.invited`, `staff.invite_accepted`, `staff.role_changed`, `staff.disabled` to `data/event-types.ts` if the funnel needs them; A8 writes `audit_log` only until then. No mailer exists, so the manager sends the link (mailto or LINE share).

## 2026-11-27 — A9 (settings UI and nights calendar)

Landed on `track-a` (not merged yet). Tests: `test/settings.test.ts` (15, plus 1 `it.todo` waiting on B13: "an election day entered from the console appears in calendar_days (needs B13 upsertCalendarDay)"). Still to do by a human: the browser walk of the staff Settings page and the nights Calendar page.

Published interfaces (`apps/server/src/platform/club-settings.ts`):

```ts
export function rulePriority(r: { scope: 'club' | 'zone' | 'table'; weekday?: number | null; nightId?: string | null }): number // club 0, zone 1, table 2; +10 weekday; +20 night_id
export async function setPriceRule(db: Db, club: Club, input: PriceInput, actor: SettingsActor, now: Date, opts?: { nightDate?: string }): Promise<PriceRule>
export async function currentPriceRules(db: Db, club: Club, now: Date): Promise<PriceRule[]>
export async function upsertNight(db: Db, club: Club, input: NightInput, actor: SettingsActor, now: Date): Promise<{ night: Night; created: boolean }>
export async function listNights(db: Db, club: Club, from: string, days: number): Promise<Night[]>
```

Staff routes (owner, manager) under `/api/staff/clubs/:slug`: `PATCH /settings`, `PUT /promptpay` and `PUT /greeting` (fresh TOTP, audited, staff-group notice), `GET /tables`, `POST|PATCH /zones[/:id]`, `POST|PATCH /tables[/:id]`, `GET|PUT /prices`, `GET|PUT /nights` (night date in the body), `GET|PUT /profile`, `GET /quota` (`warn` at 80%). Console: `GET|PUT /api/admin/clubs/:slug/nights`, `POST /api/admin/calendar-days` (validates, then calls B13's `upsertCalendarDay`; wired 2026-11-27, see track-b.md B13).

For B9b: `price_rules.valid_to` is inclusive. A change closes the open rule at yesterday and opens one from today; a second change the same day edits today's rule. An event-night price is a `scope: 'club'` rule with `night_id`. Zone price columns stay the fallback.
For B8b: a hand-edited night has `edited_by` = user id; closing needs `closed_reason`, opening clears it.
For B13: publish `upsertCalendarDay`; A9 then wires `POST /api/admin/calendar-days` and enables "an election day entered from the console appears in calendar_days".
Events: `club.settings_changed`, `club.price_changed`, `club.event_night_created` (once per night, the first time it gets an event name). Tables: new `valid_from` = today; removal sets `valid_to` = today; restore clears it.

## 2026-11-27 — A10 (greeting and rich menu migration)

Landed on `track-a` (not merged yet). Tests: `test/line-migration.test.ts` (8, plus 1 `it.todo` waiting on B4: "the replaced rich menu carries B4 s=rm_* tags"). Still to do by a human: the browser walk of the console LINE wizard migration step and rich menu rollback on the club page.

Changed interfaces (`apps/server/src/line/setup.ts`):

```ts
export interface RichMenuChange { richMenuId: string; previousRichMenuId: string | null }
export type GreetingText = { en?: string; th?: string };
// SetupClients gains: readGreeting?: () => Promise<GreetingText | null>; api.getDefaultRichMenuId
// SetupReport gains: richMenu?: RichMenuChange
// runLineSetup opts gain: keepOldRichMenu?: boolean (with refreshRichMenu: keep old menus)
export function fakeSetupClients(accessToken: string, login: LoginChannel | null, line?: FakeLineState): SetupClients
export async function rollbackRichMenu(clients: SetupClients, change: RichMenuChange): Promise<void>
```

Routes: `POST /api/admin/clubs/:slug/line/migrate {totp, greeting?: {en?, th?}}` (422 `greeting_unreadable` when nothing is pasted and LINE cannot give it; LINE's API has no greeting read, so `realSetupClients` leaves `readGreeting` unset) and `POST /api/admin/clubs/:slug/line/rich-menu/rollback` (409 `nothing_to_roll_back`). The old menu id lives in the `line.rich_menu_replaced` audit row.

For Track B: any hand-written `SetupClients` fake must provide `api.getDefaultRichMenuId`. B4 adds `s=` tags only in `menuCells`; migration rebuilds from it. B3: switch the direct `ops_events` insert in `/line/migrate` to `recordOps`.

## 2026-11-27 — A11 (POS level L0: report import)

Landed on `track-a` (not merged yet). Tests: `test/pos-import.test.ts` (10). Blockers and `it.todo`: none (the real report sample is an open question, below). Still to do by a human: the browser walk of the staff POS import page (`PosImport.tsx`). The column map and the fixture are synthetic: replace `WONGNAI_FOODSTORY_COLUMN_MAP` and `test/fixtures/pos-report-synthetic.csv` when the real report sample arrives (spec §16.1 q13).

Published interfaces (`apps/server/src/integrations/pos/`):

```ts
export interface PosBill { ref: string; tableCode: string | null; covers: number | null; openedAt: Date | null; closedAt: Date | null; totalSatang: number | null }
export interface PosAdapter { readonly vendor: string; importReport(file: string): { bills: PosBill[]; errors: string[] }; fetchClosedBills?(nightDate: string): Promise<PosBill[]>; openBillAtCheckIn?(booking, deposit): Promise<{ ref: string }>; onBillUpdated?(...) }
export function csvReportAdapter(map?: PosColumnMap, vendor?: string): PosAdapter
export async function importPosReport(db: Db, club: Club, file: string, opts: { now: Date; adapter?: PosAdapter; isTest?: boolean }): Promise<PosImportResult> // { imported, created, updated, matched, walkIns, errors }
export const posBillId = (clubId: string, ref: string) => 'pos_' + sha256(clubId + '\0' + ref)
```

Route: `POST /api/staff/clubs/:slug/pos/import` (owner, manager; multipart `file` or raw `text/csv`; 413 over 5 MB; 400 `bad_report`). Events for B1 props validation: `pos.bill_closed` (dedupe `pos.bill_closed:<ref>`, props `{billRef, covers, totalSatang}`) and `pos.bill_matched` (dedupe `pos.bill_matched:<ref>:<bookingId>`, props `{billRef, method: 'table_night'}`), both `dataOrigin: 'pos'`, `actorType: 'system'`. No unique index on `(club_id, provider_bill_id)`: idempotency comes from the deterministic id.

## 2026-11-27 — A12 (observability and load)

Landed on `track-a` (not merged yet). Tests: `test/load.test.ts` (11), `test/webhook-alert.test.ts` (5). Blockers and `it.todo`: none. No web change. `npm run load -w @club/server -- --mode sim|webhook --base --clubs --duration --scale --bookings --inbound --target-ms` (env `LOAD_CHANNEL_SECRET`, `LOAD_COOKIE`). Alert check: `infra/check-webhook-errors.sh` (cron recipe in `infra/README.md` §5). Local smoke: full rate 30 s sim, p95 11 ms, 0 errors (laptop, PGlite; not a production result).

For Track B: the script relies on postbacks `a=book` and `a=night&d=YYYY-MM-DD` and the simulator `userId` format; B8 putting `/api/dev` behind admin login means sim mode needs `LOAD_COOKIE`. Once B3's `raw_webhooks` writer merges, switch the error-rate denominator in the alert script from inbound `messages` to `raw_webhooks`.

## 2026-11-27 — A15 (alerts)

Landed on `track-a` (not merged yet). Tests: `test/alerts.test.ts` (7). Migration `drizzle/0003_alerts.sql` adds `alerts` and `club_alert_settings`. `it.todo`: none; blocker: the scheduler request below. Still to do by a human: the browser walk of the staff Feed page (`Feed.tsx`).

Alerts interface for B19b (`apps/server/src/platform/alerts.ts`, `platform/alert-checks.ts`):

```ts
export interface AlertInput { clubId: string; level: 'urgent' | 'needs_input' | 'info'; kind: string; conversationId?: string; bookingId?: string; text: { en: string; th: string } }
export async function raiseAlert(db: Db, input: AlertInput, now: Date): Promise<void>
export async function runAlertChecks(ctx: AppContext, now: Date): Promise<void>
export function registerStaffAlertSender(db: Db, sender: (club: Club, text: string) => Promise<void>): void // wired once in createApp to outbox.toStaff
```

Urgent always goes to the staff group; info only when the club's switch is on; needs-input never. A `raiseAlert` on a db that never went through `createApp` records the alert and sends nothing. Suggested `kind`s for B19b: `guest_wants_human`, `bot_unanswered`, `complaint`, `payment_review`, `no_arrival`, `bot_error`, `brain_draft_waiting`, `gap_waiting`, `booking_confirmed`, `running_late`, `cancellation`.

Routes: `GET /api/staff/clubs/:slug/feed` (`{alerts, counts}`), `GET .../feed/counts`, `POST .../feed/:id/resolve`, `GET|PUT .../alert-settings {infoToLine}` (owner, manager).

**Request for Track B (before A15 merges):** `jobs/index.ts` is B's file and the plan allows A one `scheduler.register('alert-checks', ...)` line, but no scheduler exists yet. Please either add the scheduler (then A replaces its lines with the one `register` line), or accept this stand-in: A15 adds one start line in `startBackground`, `const stopAlertChecks = startAlertChecks(ctx, now);`, and one `stopAlertChecks();` in the stop function. The 60 s timer itself lives in `platform/alert-checks.ts` (`export function startAlertChecks(ctx: AppContext, now: () => Date): () => void`). The stand-in lines are in `jobs/index.ts` on `track-a` now, marked with an `A15:` comment. A15 does not merge until B answers here.

Migration lock: `drizzle/0003_alerts.sql`, `meta/0003_snapshot.json`, `_journal.json` and the `db/schema/platform.ts` change go in their own commit and their own pull request under the lock (rebase, commit schema + migration alone, merge, note it here), before the rest of A15 is committed.

Timed checks: `runAlertChecks` probes LINE itself (bot info, webhook endpoint, quota; `platform/line-probe.ts` `probeLine`) when the club's newest `line_setup` row is older than 10 minutes, and records the probe as a `line_setup` row (`line.setup_run` with `check: 'probe'`, actor `system`). A row with no quota reading never clears `quota_exhausted`: the last known reading is used. The daily summary is sent at 17:00 Bangkok for tonight's night date (spec §6.1): bookings by zone, deposits collected (verified), expected minimum spend. A staff alert whose club LINE channel is unavailable is still recorded (feed and `messages` row) with `sent_line_at` null; `raiseAlert` never throws for a failed send.

## 2026-11-27 — Review fixes (A8, A9, A10, A11, A12)

- A8: `POST /api/auth/invites/preview` no longer returns `hasAccount`; `/accept` answers `weak_password` for a password under 10 characters before looking up the account, so invite routes do not reveal whether an email has an account.
- A9: `freshTotpRefusal` answers 403 `second_factor_not_enrolled` (no failure counted) for a user with no TOTP secret; `GET /settings` returns `secondFactorEnrolled`, and the Settings page hides the PromptPay/greeting editor without it. The owner notice for PromptPay is the staff-group message plus the before/after audit row (plan A5 Controls: "This build has no separate in-account notice").
- A10: `/line/migrate` records the quota reading after a successful run (null only on a credential failure).
- A11: the 5 MB POS upload limit is Hono's `bodyLimit` (counts chunked bodies).
- A12: `test/webhook-alert.test.ts` runs the SQL of `infra/check-webhook-errors.sh` on PGlite and the script itself with a stand-in `psql`, and checks THRESHOLD, MAX_RATE_PCT, MIN_INBOUND and the ALERT_URL call.

## 2026-11-27 — A17b (per-club feature switches)

Published in `apps/server/src/platform/features.ts`:

```ts
export const FEATURE_KEYS = ['ai_answers', 'learning_loop', 'instagram', 'pos_sync', 'alerts_line'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export const FEATURE_DEFAULTS: Record<FeatureKey, boolean>; // ai_answers false, learning_loop true, instagram false, pos_sync false, alerts_line true
export async function isFeatureOn(db: Db, clubId: string, key: FeatureKey): Promise<boolean> // reads DB every call, no cache
export async function featureSwitches(db: Db, clubId: string): Promise<Record<FeatureKey, boolean>>
```

Stored in `platform_flags['features:<clubId>']` as `{ [FeatureKey]: boolean }`. Routes: `GET` and `PATCH /api/admin/clubs/:slug/features` (body `{ key: boolean }`, unknown key 400 `unknown_feature`, audited as `club.features_changed`, no fresh TOTP).

**Request to B:** agree the key list (B consumes `ai_answers` and `learning_loop` in the brain, `alerts_line` in B19b). Ask in track-b.md for any new key; adding one is additive. A consumes `pos_sync` itself: A19's `loadPosAdapter` returns null while it is off, so a club's live POS sync starts only when the founder switches it on.

## 2026-11-27 — A13 (Chatwoot install and per-club provisioning)

Published in `apps/server/src/integrations/chatwoot/provision.ts`:

```ts
export function chatwootClient(config, fetchImpl?): ChatwootClient | null // null when CHATWOOT_URL or CHATWOOT_PLATFORM_TOKEN unset
export async function provisionClubInbox(db, cw, key, club, opts): Promise<ChatwootClubState> // idempotent: account, API inbox, agent bot, dashboard app
export async function tryProvisionClubInbox(db, cw, key, club, opts) // never throws; { status: 'ready' | 'partial' | 'failed' | 'not_configured', ... }
export async function chatwootState(db, clubId): Promise<ChatwootClubState | null>
export async function chatwootBotToken(db: Db, key: Buffer, clubId: string): Promise<string | null>
export const chatwootConversationRef = (accountId, conversationId) => `cw:${accountId}:${conversationId}`
export const chatwootCallbackUrl = (publicUrl, clubId) => `${publicUrl}/integrations/chatwoot/${clubId}/callback`
export const chatwootBotUrl = (publicUrl, clubId) => `${publicUrl}/integrations/chatwoot/${clubId}/bot`
```

- State lives in `platform_flags['chatwoot:<clubId>']` (admin and bot tokens encrypted with `CREDENTIALS_KEY`); staff-user mapping in `platform_flags['chatwoot:<clubId>:user:<userId>']`. No migration.
- Provisioning runs on `POST /api/admin/clubs` (a failure still answers 201 with `inbox.status: 'failed'`), on `POST /api/admin/clubs/:slug/inbox/provision` (retry, audited), and in the A17 wizard's apply step (step `inbox`).
- Staff routes: `GET /api/staff/clubs/:slug/inbox-sso` (owner/manager administrator, host/support agent, door 403) and `GET /api/staff/clubs/:slug/inbox-panel?account=&conversation=` (finds the conversation by `conversations.external_ref = chatwootConversationRef(...)`). 503 `inbox_not_configured`, 409 `inbox_not_provisioned`, 502 on a Chatwoot error.
- Callback mount: Chatwoot callbacks are `/integrations/chatwoot/<clubId>/{callback,bot}`, under the same `/integrations` mount as A19's POS webhooks (`http/integrations.ts`). **For A14:** add the Chatwoot handlers to `integrationRoutes`.
- Chatwoot API shapes and the `chatwoot/chatwoot:v4.1.0` tag are unverified against a live install.

## 2026-11-27 — A16b (weekly club report)

Published in `apps/server/src/platform/club-report.ts`: `buildClubReport(db, clubId, weekStart)`, `sendWeeklyReports(ctx, now)`, `startClubReports(ctx, now)` (15-minute timer). Route `GET /api/staff/clubs/:slug/report?week=YYYY-MM-DD` (owner, manager).

- Week: nights Monday to Sunday by `night_date`; chats, takeovers and staff messages from Monday `nightEndHour` Bangkok for 7 days. Test rows excluded except for `demo` clubs.
- Sent Monday from 10:00 Bangkok to the staff group via `staffAlertSender(db)` (A15 sender); marker `platform_flags['club-report:<clubId>:<weekStart>']` claimed before the send; failed sends are not retried. Onboarding, paused and no-staff-group clubs skipped.
- **Request to B:** when the scheduler lands, replace the `startClubReports` line in `jobs/index.ts` with `scheduler.register('club-report', (ctx, now) => sendWeeklyReports(ctx, now))` (any interval up to an hour).

## 2026-11-27 — A17 (full onboarding wizard)

Routes in `apps/server/src/http/admin/onboarding.ts`: `POST /api/admin/clubs/:slug/onboarding/link`, `GET /api/admin/clubs/:slug/onboarding`, `POST .../onboarding/apply`, `POST .../onboarding/timing {step, event}`; public `GET`/`PUT /api/onboard/:token`.

- Storage in `platform_flags`: `onboarding_link:<clubId>` (token SHA-256 only), `onboarding_form:<clubId>`, `onboarding:<clubId>` (per-step timings, `appliedAt`).
- Apply steps: `zones`, `tables`, `prices`, `rules`, `profile`, `faqs` (draft notes since B15; `not_ready` removed from the step status type), `promptpay` (`manual`), `inbox` (A13 provisioning).
- **Request to B:** when B15 publishes `brain/notes.ts`, A will write the submission's `faqs` as draft notes from the apply step.

## 2026-11-27 — A19 (POS live sync)

Published in `apps/server/src/integrations/pos/live.ts`: `loadPosAdapter`, `openPosBillAtCheckIn`, `applyLiveBill`, `syncClosedBills`; adapters `papaya.ts` and `loyverse.ts`.

- `pos` credential JSON: Papaya `{vendor:'papaya', outletId, reservationsKey, orderDataKey, webhookSecret, tableChannels}`; Loyverse `{vendor:'loyverse', token, storeId?}`. Live sync also needs the `pos_sync` switch on.
- Webhook: `POST <PUBLIC_URL>/integrations/pos/papaya/<slug>`, HMAC `x-papaya-signature: sha256=<hex>`; deliveries written to `raw_webhooks` (channel `pos:papaya`) directly until B3's writer merges.
- Events: `pos.bill_opened`, `pos.bill_updated` (dedupe `pos.bill_updated:<ref>:<eventId>`), plus A11's `pos.bill_closed` / `pos.bill_matched`.
- **Requests to B:** (1) a booking-service transition so a closed POS bill can complete its booking and emit `booking.completed`; (2) after B3, A switches the direct `raw_webhooks` insert to B3's writer. `syncClosedBills` has no scheduled job yet.

## 2026-11-27 — Review fixes for A13, A16b, A17, A19

- **A17 plan change (two-step apply):** the plan's acceptance item "form submission creates tables, prices, rules, baseline FAQs and club profile" is met in two steps. `PUT /api/onboard/:token` (token only, no session) stores the answers; the founder reviews them and `POST /api/admin/clubs/:slug/onboarding/apply` writes zones, tables, price rules, rules and the profile. Reason: the public form is reachable by anyone holding the link, so nothing it sends reaches club data until a signed-in founder applies it. The test is named for this (`form submission, once the founder applies it, creates ...`). Baseline FAQs still wait on B15.
- **A16b, Velora seed:** "report figures match hand-counted seeded Velora week" waits on B7's Velora history seed (not on this branch). `test/club-report.test.ts` has an `it.todo` for it; the hand-counted figures are checked on a fixture week for now. **Request to B:** when B7 merges, publish the seeded week's dates; A adds the Velora case.
- **A16b, `jobs/index.ts` stand-in (same request as A15):** the scheduler does not exist yet, so A16b adds two lines, not one: `const stopClubReports = (await import('../platform/club-report.js')).startClubReports(ctx, now);` in `startBackground` and `stopClubReports();` in the stop function (the start line carries the `A16b:` comment). **Request to B:** accept this stand-in or land the scheduler (then A replaces both lines with the one `register` line). A16b does not merge until B answers here.
- **A16b:** `sendWeeklyReports` now builds the report before it claims the week's marker, so a build failure (a DB error) leaves no marker and the next run retries. Only a failed send stays `failed`.
- **A13 access:** a read-only support grant gets 403 `support_read_only` on `GET /inbox-sso` (a Chatwoot agent can message guests). Chatwoot access is revoked (account membership removed, Chatwoot user deleted, which ends its sessions, mapping dropped) when a member is disabled or changes role (`http/team.ts`), when a support grant is ended (`POST /api/admin/support/:id/end`), and when a grant expires (`sweepGrantInboxUsers`, run on A15's 60 s alert-check timer until the scheduler exists; then it needs its own `register` line). New exports in `integrations/chatwoot/provision.ts`: `revokeInboxUser`, `tryRevokeInboxUser`, `sweepGrantInboxUsers`, `CHATWOOT_TIMEOUT_MS` (10 s per Chatwoot call).
- **A13 deploy rule:** `CHATWOOT_URL` must be on the same registrable domain as `PUBLIC_URL`; the booking panel iframe signs in with our `SameSite=Lax` session cookie (`infra/chatwoot/README.md`).
- **A19:** the Papaya webhook stores only `{ rejected: 'bad_signature', bytes }` for an unsigned delivery, never its body, and answers 429 after 20 bad-signature deliveries per club and IP per minute, or 60 per club per minute (in memory, one process). A signed body that is not a JSON object (`null`) is stored as `{ unparsed }` and ignored. `createApp(..., { posFetch })` / `AppContext.posFetch` is the POS fetch test hook; the staff `arrived` route passes it to `openPosBillAtCheckIn`, and a test now drives that route.

## 2026-11-27 — Status: A13, A16b, A17, A17b, A19 (end of session)

Suite on track-a: 28 test files, 266 passed, 14 `it.todo`; `npm run typecheck` and `npm run build -w @club/web` green. Exact signatures below are as implemented.

### A13 (Chatwoot inbox) — status

Landed: shared Chatwoot CE compose (`infra/chatwoot/docker-compose.yml`, `README.md`), per-club provisioning on club create, retry route, staff SSO and booking-panel routes, revoke on role change, disable and grant end/expiry, Chatwoot dump in `infra/backup.sh`, `CHATWOOT_URL` / `CHATWOOT_PLATFORM_TOKEN` config. Web: `/inbox-panel` page (`InboxPanel`) and `OpenInboxButton` in the staff layout.

```ts
// apps/server/src/integrations/chatwoot/provision.ts
export class ChatwootError extends Error
export class InboxNotProvisioned extends Error
export const CHATWOOT_TIMEOUT_MS = 10_000;
export function chatwootClient(config: Pick<Config, 'CHATWOOT_URL' | 'CHATWOOT_PLATFORM_TOKEN'>, fetchImpl: typeof fetch = (...a) => fetch(...a)): ChatwootClient | null
export type InboxStatus = 'ready' | 'partial' | 'failed' | 'not_configured';
export const chatwootFlagKey = (clubId: string) => `chatwoot:${clubId}`;
export const chatwootConversationRef = (accountId: number | string, conversationId: number | string) => `cw:${accountId}:${conversationId}`;
export const chatwootCallbackUrl = (publicUrl: string, clubId: string) => string; // <publicUrl>/integrations/chatwoot/<clubId>/callback
export const chatwootBotUrl = (publicUrl: string, clubId: string) => string;      // <publicUrl>/integrations/chatwoot/<clubId>/bot
export const inboxPanelUrl = (publicUrl: string, slug: string) => string;         // <publicUrl>/inbox-panel?club=<slug>
export async function chatwootState(db: Db, clubId: string): Promise<ChatwootClubState | null>
export async function chatwootBotToken(db: Db, key: Buffer, clubId: string): Promise<string | null>
export function inboxStatus(state: ChatwootClubState | null): InboxStatus
export function inboxSummary(state: ChatwootClubState | null, status: InboxStatus = inboxStatus(state))
export async function provisionClubInbox(db: Db, cw: ChatwootClient, key: Buffer, club: { id: string; name: string; slug: string }, opts: { publicUrl: string; by: string; now: Date }): Promise<ChatwootClubState>
export async function tryProvisionClubInbox(db: Db, cw: ChatwootClient | null, key: Buffer, club: { id: string; name: string; slug: string }, opts: { publicUrl: string; by: string; now: Date; log?: (msg: string, err?: unknown) => void })
export type ChatwootRole = 'administrator' | 'agent';
export async function inboxSsoUrl(db: Db, cw: ChatwootClient, club: { id: string }, user: { id: string; name: string }, role: ChatwootRole, now: Date, grantId: string | null = null): Promise<string>
export async function revokeInboxUser(db: Db, cw: ChatwootClient, clubId: string, userId: string): Promise<boolean>
export async function tryRevokeInboxUser(db: Db, cw: ChatwootClient | null, clubId: string, userId: string, log?: (msg: string, err?: unknown) => void)
export async function sweepGrantInboxUsers(db: Db, cw: ChatwootClient | null, now: Date, log?: (msg: string, err?: unknown) => void): Promise<number>
// AppContext.chatwoot: ChatwootClient | null; createApp(..., { chatwootFetch?: typeof fetch })
```

Routes: `POST /api/admin/clubs/:slug/inbox/provision`; `GET /api/staff/clubs/:slug/inbox-sso`; `GET /api/staff/clubs/:slug/inbox-panel?account=&conversation=`.

- **Requests to B:** when the scheduler lands, give `sweepGrantInboxUsers` its own `register` line (it rides A15's alert-check timer today). A14 (not B) adds the Chatwoot callback and bot handlers to `integrationRoutes`.
- **Blockers:** Chatwoot API shapes and the `v4.1.0` image tag are not checked against a live install. No `it.todo` in `chatwoot-provision.test.ts`.
- **Browser walk:** still to be done by a human (open inbox from the staff layout, booking panel iframe inside Chatwoot).

### A16b (weekly club report) — status

Landed: report builder, Monday 10:00 Bangkok send to the staff group, staff route and web page `/staff/report` (`Report`).

```ts
// apps/server/src/platform/club-report.ts
export interface ClubReport { clubId; weekStart; weekEnd; bookings; cancelled; deposits: { count; satang }; noShowRate: number | null; noStaffHelpRate: number | null; busiestNights: { nightDate; bookings }[]; zones: { zoneId; name; nameTh; bookings }[]; averageSpendSatang: number | null; topPromoters: null; deflection: { conversations; deflected; rate: number | null }; takeoversByTopic: { topic; n }[]; door: { count; bookedPax; peakHour: number | null } }
export function mondayOf(date: string): string
export function lastCompleteWeek(club: Club, now: Date): string
export async function buildClubReport(db: Db, clubId: string, weekStart: string): Promise<ClubReport>
export function clubReportText(club: Club, r: ClubReport): string
export const WEEKLY_REPORT_HOUR = 10;
export const reportFlagKey = (clubId: string, weekStart: string) => `club-report:${clubId}:${weekStart}`;
export async function sendWeeklyReports(ctx: AppContext, now: Date): Promise<void>
export function startClubReports(ctx: AppContext, now: () => Date): () => void
// apps/server/src/platform/alerts.ts
export function staffAlertSender(db: Db): StaffAlertSender | undefined
```

Route: `GET /api/staff/clubs/:slug/report?week=YYYY-MM-DD` (owner, manager).

- **Requests to B:** (1) accept the two-line `jobs/index.ts` stand-in or land the scheduler, then A switches to `scheduler.register('club-report', (ctx, now) => sendWeeklyReports(ctx, now))`; (2) after B7 merges, publish the seeded Velora week's dates.
- **it.todo waiting on B:** `club-report.test.ts`: `report figures match the hand-counted B7-seeded Velora week (waits on B7 seed)`.
- **Browser walk:** still to be done by a human (`/staff/report` as owner and as manager).

### A17 (full onboarding wizard) — status

Landed: founder link, public pre-call form, founder review and apply, per-step timings. Web: `/onboard/:token` (`OnboardForm`), `OnboardingPanel` inside the LINE wizard page.

```ts
// apps/server/src/http/admin/onboarding.ts
export const LINK_TTL_MS = 14 * 86_400_000;
export const ONBOARDING_STEPS = ['login', 'messaging_api', 'credentials', 'connect', 'response_settings', 'live_test', 'staff_login', 'plan_check', 'go_live'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const onboardingForm: z.ZodObject<...>; export type OnboardingForm = z.infer<typeof onboardingForm>;
export function onboardingAdminRoutes(app: AppContext)   // mounted under /api/admin
export function onboardPublicRoutes(app: AppContext)     // mounted at /api/onboard
```

Routes: `POST /api/admin/clubs/:slug/onboarding/link`, `GET /api/admin/clubs/:slug/onboarding`, `POST /api/admin/clubs/:slug/onboarding/apply`, `POST /api/admin/clubs/:slug/onboarding/timing`; `GET` / `PUT /api/onboard/:token`.

- **Requests to B:** publish `brain/notes.ts` (B15) so apply can write the baseline FAQs as draft notes.
- **it.todo waiting on B:** `onboarding.test.ts`: `apply writes the baseline FAQs into the brain (needs B15 brain/notes.ts)`.
- **Browser walk:** still to be done by a human (send link, fill form on a phone, founder apply, step timings).

### A17b (per-club feature switches) — status

Landed: switches module, admin GET/PATCH, Controls panel in the founder console (`ClubFeatures` in `Controls.tsx`, `adminApi.features` / `adminApi.setFeatures`).

```ts
// apps/server/src/platform/features.ts
export const FEATURE_KEYS = ['ai_answers', 'learning_loop', 'instagram', 'pos_sync', 'alerts_line'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureSwitches = Record<FeatureKey, boolean>;
export const FEATURE_DEFAULTS: FeatureSwitches;
export const isFeatureKey = (k: string): k is FeatureKey => ...;
export const featuresFlagKey = (clubId: string) => `features:${clubId}`;
export async function featureSwitches(db: Db, clubId: string): Promise<FeatureSwitches>
export async function isFeatureOn(db: Db, clubId: string, key: FeatureKey): Promise<boolean>
```

Routes: `GET` / `PATCH /api/admin/clubs/:slug/features`.

- **Requests to B:** confirm the key list; B reads `ai_answers`, `learning_loop` (brain) and `alerts_line` (B19b) with `isFeatureOn`.
- **Blockers:** none. No `it.todo`.
- **Browser walk:** still to be done by a human (toggle each switch in the founder console).

### A19 (POS live sync) — status

Landed: Papaya and Loyverse adapters, live loader gated by `pos_sync`, bill opened at check-in from the staff `arrived` route, signed Papaya webhook with bad-signature rate limit, `applyLiveBill`, `syncClosedBills`. No web change.

```ts
// apps/server/src/integrations/pos/live.ts
export type PosCredentials = PapayaCredentials | LoyverseCredentials;
export interface LiveOpts { fetch?: FetchLike; baseUrl?: string }
export async function loadPosAdapter(db: Db, key: Buffer, club: Club, opts: LiveOpts = {}): Promise<{ creds: PapayaCredentials; adapter: PapayaAdapter } | { creds: LoyverseCredentials; adapter: PosAdapter } | null>
export async function openPosBillAtCheckIn(db: Db, key: Buffer, club: Club, bookingId: string, opts: LiveOpts & { now: Date }): Promise<{ status: 'opened'; ref: string } | { status: 'skipped'; reason: 'no_pos' | 'not_supported' | 'not_found' }>
export async function applyLiveBill(db: Db, club: Club, bill: PosBill, opts: { now: Date; source: string; eventId?: string }): Promise<'created' | 'updated' | 'unchanged'>
export async function syncClosedBills(db: Db, key: Buffer, club: Club, nightDate: string, opts: LiveOpts & { now: Date }): Promise<PosImportResult | null>
// apps/server/src/integrations/pos/papaya.ts
export const PAPAYA_API_BASE = 'https://api.papayapos.com';
export const PAPAYA_SIGNATURE_HEADER = 'x-papaya-signature';
export const PAPAYA_BILL_EVENTS = ['order.totalsUpdated', 'order.tableChanged', 'order.closed'] as const;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export function signPapaya(rawBody: string, secret: string): string
export function verifyPapayaSignature(rawBody: string, header: string | null | undefined, secret: string): boolean
export function papayaAdapter(creds: PapayaCredentials, opts: { fetch?: FetchLike; baseUrl?: string; tableCodeOf?: (booking: Booking) => string | null } = {}): PapayaAdapter
// apps/server/src/integrations/pos/loyverse.ts
export const LOYVERSE_API_BASE = 'https://api.loyverse.com/v1.0';
export function loyverseReceiptToBill(r: LoyverseReceipt): PosBill
export function loyverseAdapter(creds: LoyverseCredentials, opts: { fetch?: FetchLike; baseUrl?: string } = {}): PosAdapter
// apps/server/src/http/integrations.ts
export const BAD_SIGNATURE_LIMIT_PER_IP = 20;
export const BAD_SIGNATURE_LIMIT_PER_CLUB = 60;
export function integrationRoutes(app: AppContext)   // mounted at /integrations
// AppContext.posFetch?: FetchLike; createApp(..., { posFetch })
```

Route: `POST /integrations/pos/papaya/:slug`.

- **Requests to B:** (1) a booking-service transition so a closed POS bill completes its booking and emits `booking.completed`; (2) B3's raw-webhook writer, then A drops the direct `raw_webhooks` insert; (3) a scheduler slot for `syncClosedBills` (no job runs it yet).
- **Blockers:** Papaya and Loyverse API shapes not checked against a sandbox. No `it.todo` in `pos-sync.test.ts`.
- **Browser walk:** not applicable (no web change); the check-in bill needs a human run against a POS sandbox.

## 2026-11-27 — A18 Instagram via Chatwoot

- **Landed:** a club's Instagram inbox, created by the founder inside Chatwoot (Instagram login is Chatwoot's OAuth), is linked to the club, gets a per-club webhook, and every incoming Instagram message lands in the club's Chatwoot inbox and in our tables as `data_origin='instagram'` rows. No cross-club view reads them (spec §14.8).
- **Migration:** none. State lives in `platform_flags['chatwoot:<clubId>:instagram']` and the club's `channels` row (kind `instagram`).
- **Published (`apps/server/src/integrations/chatwoot/instagram.ts`), exact signatures:**
  - `export const INSTAGRAM_CHANNEL = 'instagram'`
  - `export interface InstagramState { inboxId: number; instagramId: string | null; webhookId?: number; tokenHash?: string; connectedAt?: string }`
  - `export class InstagramInboxMissing extends Error { constructor(clubId: string) }`
  - `export const instagramFlagKey = (clubId: string) => string` (`chatwoot:${clubId}:instagram`)
  - `export const instagramWebhookPath = (clubId: string) => string` (`/integrations/chatwoot/${clubId}/instagram`)
  - `export const instagramWebhookUrl = (publicUrl: string, clubId: string, token: string) => string`
  - `export async function instagramState(db: Db, clubId: string): Promise<InstagramState | null>`
  - `export function instagramSummary(state: InstagramState | null): { status: 'connected' | 'partial' | 'not_connected'; inboxId: number | null; instagramId: string | null; connectedAt: string | null }`
  - `export async function connectInstagram(db: Db, cw: ChatwootClient, key: Buffer, club: { id: string }, opts: { inboxId?: number; publicUrl: string; by: string; now: Date }): Promise<InstagramState>` (throws `InstagramInboxMissing` when Chatwoot has no Instagram inbox yet; throws `InboxNotProvisioned` when A13's Chatwoot account is not set up)
  - `export function verifyInstagramToken(state: InstagramState | null, token: string | undefined | null): boolean`
  - `export type InstagramApplied = 'recorded' | 'duplicate' | 'ignored'`
  - `export async function recordInstagramMessage(db: Db, club: Club, state: InstagramState, body: unknown, now: Date): Promise<InstagramApplied>`
  - `instagramAdminRoutes(app: AppContext)` in `apps/server/src/http/admin/instagram.ts`, mounted in `http/admin/index.ts`.
- **Routes:** `GET /api/admin/clubs/:slug/instagram`, `POST /api/admin/clubs/:slug/instagram/connect` (body `{ inboxId?: number }`); webhook `POST /integrations/chatwoot/:clubId/instagram?token=...` (Chatwoot does not sign these: the per-club token, stored as a SHA-256 hash, is the proof of origin; bad tokens are rate-limited like A19). Deliveries go to `raw_webhooks` with channel `chatwoot:instagram` by direct insert.
- **Rows written (B must match):** guests with `channel_id` = channels row id and `external_user_id` = Instagram sender id (`contact_inbox.source_id`), `line_user_id` null; conversations `external_ref` = `chatwootConversationRef(account, conversation)`; messages `external_id` = `cw:<account>:<message id>`; events `message.received` and `guest.first_seen` with `channel` and `data_origin` `instagram`, `source` `chatwoot`.
- **§14.8:** admin data-health counts (`http/admin/data.ts`), the cross-club event stream and the club list's last-inbound time (`platform/health.ts`) leave out Instagram rows; the club-scoped stream keeps them.
- **Requests to B:** (1) a messages writer that takes a channel id and an external id, then A switches `recordInstagramMessage` to it; (2) a unique index on `guests (club_id, channel_id, external_user_id)` (two concurrent first messages can create two guest rows today); (3) B3's raw-webhook writer / `processDelivery`, then A drops the direct insert; (4) the Metabase analytics view (B14) and busyness feed must leave out `data_origin='instagram'` rows; (5) route Instagram messages to the brain, and attach the agent bot to the Instagram inbox when the bot handles Instagram.
- **Blockers:** Meta app approval for Instagram messaging in Chatwoot. Chatwoot payload shapes (`{ payload: [...] }` inbox list, `Channel::Instagram` or `Channel::FacebookPage` with `instagram_id`, `payload.webhook.id`) not checked against a live Chatwoot. Outgoing messages (including replies typed in the Instagram app) are ignored.
- **it.todo (waiting on B):** three in `test/instagram.test.ts`: delivery through B3 `processDelivery` / raw-webhook writer; an Instagram message reaching the club's brain (B chat capture); Metabase view and busyness feed leaving out instagram rows (B14 / busyness feed).
- **Browser walk:** not applicable (no web change in A18). A human still needs to connect a real Instagram account in Chatwoot and send a message end to end.

## 2026-11-27 — A20 Phase 3: A20a promoters, A20c guest CRM and VIP tags, A20d report sections (A20b deferred)

- **Landed:** promoters with codes, links and commission (bps), booking attribution (link or manual), a promoter report and a promoter's own view; guest search, profile, tags and append-only notes; the weekly report gains `topPromoters` and `vip`. Web: `/staff/promoters` and `/staff/guests` pages, VIP tile and top promoters on `/staff/report`; a `promoter` login is sent to `/staff/promoters` and sees only that nav item. Plan rows A20a to A20d replace the old A20 row.
- **Migration:** `apps/server/drizzle/0004_a20.sql` (lock held): `promoters`, `promoter_attributions`, `guest_tags`, `guest_notes` in `db/schema/platform.ts`. Rebase before your next `db:generate`.
- **Published (`apps/server/src/platform/promoters.ts`), exact signatures:**
  - `export class PromoterError extends Error { constructor(readonly code: 'bad_code' | 'code_taken' | 'not_found' | 'bad_request') }`
  - `export function normalizeCode(code: string): string` (lowercase letters, digits, dashes, 2 to 24 characters)
  - `export function promoterLink(publicUrl: string, club: Pick<Club, 'slug'>, code: string): string` → `<PUBLIC_URL>/r/p/<slug>/<code>`
  - `export async function createPromoter(db: Db, clubId: string, input: { name: string; code: string; commissionBps?: number; userId?: string | null }, now: Date): Promise<Promoter>`
  - `export async function getPromoter(db: Db, clubId: string, id: string): Promise<Promoter | undefined>`
  - `export async function updatePromoter(db: Db, clubId: string, id: string, patch: { name?: string; commissionBps?: number; userId?: string | null; disabled?: boolean }, now: Date = new Date()): Promise<Promoter>`
  - `export async function listPromoters(db: Db, clubId: string): Promise<Promoter[]>`
  - `export async function attributeBooking(db: Db, clubId: string, bookingId: string, who: { promoterId?: string; code?: string }, via: 'link' | 'manual', actorId: string | null, now: Date): Promise<PromoterAttribution>` (throws `PromoterError('not_found')` for another club's booking or promoter, or a disabled promoter; `'link'` never replaces an existing attribution, `'manual'` does)
  - `export async function removeAttribution(db: Db, clubId: string, bookingId: string): Promise<void>`
  - `export interface PromoterReportRow { promoterId: string; name: string; code: string; commissionBps: number; bookings: number; arrived: number; noShows: number; pax: number; spendSatang: number; commissionSatang: number }`
  - `export async function promoterReport(db: Db, clubId: string, from: string, to: string): Promise<PromoterReportRow[]>`
  - `export async function topPromoters(db: Db, clubId: string, weekStart: string): Promise<{ promoterId: string; name: string; code: string; bookings: number; pax: number }[] | null>` (null when the club has no promoters)
  - `export async function promoterOwnBookings(db: Db, clubId: string, promoterId: string, from: string, to: string): Promise<{ id: string; ref: string; nightDate: string; status: string; pax: number; tableCode: string | null }[]>` (no guest name or phone)
  - Types `Promoter`, `PromoterAttribution`, `GuestNote` exported from `db/schema/platform.ts`.
- **Published (`apps/server/src/platform/crm.ts`), exact signatures:**
  - `export class CrmError extends Error { constructor(readonly code: 'not_found' | 'bad_tag' | 'bad_request') }`
  - `export const VIP_TAG = 'vip'`
  - `export function normalizeTag(tag: string): string` (trimmed, lowercase, spaces to one dash, 1 to 32 characters)
  - `export interface GuestSummary { id: string; name: string | null; displayName: string | null; phone: string | null; tags: string[]; bookings: number; visits: number; lastNight: string | null }`
  - `export async function searchGuests(db: Db, club: Pick<Club, 'id' | 'status'>, opts: { q?: string; tag?: string; limit?: number }): Promise<GuestSummary[]>`
  - `export interface GuestProfile { guest: { id; name; displayName; phone; lang; createdAt }; tags: string[]; notes: { id; text; author; createdAt }[]; stats: { bookings; visits; noShows; spendSatang; lastVisit }; bookings: { id; ref; nightDate; status; pax; tableCode; spendSatang }[] }`
  - `export async function guestProfile(db: Db, club: Pick<Club, 'id' | 'status'>, guestId: string): Promise<GuestProfile | undefined>`
  - `export async function addTag(db: Db, clubId: string, guestId: string, tag: string, actorId: string | null, now: Date): Promise<string[]>`
  - `export async function removeTag(db: Db, clubId: string, guestId: string, tag: string): Promise<string[]>`
  - `export async function addNote(db: Db, clubId: string, guestId: string, text: string, authorId: string | null, now: Date): Promise<GuestNote>`
  - `export async function vipSummary(db: Db, clubId: string, weekStart: string): Promise<{ guests: number; bookings: number; arrived: number; spendSatang: number }>`
  - `ClubReport` (`platform/club-report.ts`) gains `topPromoters: {...}[] | null` and `vip: { guests; bookings; arrived; spendSatang }`.
  - `actorOf(c)` in `http/staff-settings.ts` is now exported (used by the new routes).
- **Routes (under `/api/staff`, mounted in `http/staff.ts`):** owner/manager: `GET /clubs/:slug/promoters`, `POST /clubs/:slug/promoters`, `GET /clubs/:slug/promoters/report`, `PATCH /clubs/:slug/promoters/:promoterId`; desk roles: `PUT /clubs/:slug/bookings/:id/promoter`, `DELETE /clubs/:slug/bookings/:id/promoter`; role `promoter`: `GET /clubs/:slug/promoter/me`; owner, manager, host: `GET /clubs/:slug/guests`, `GET /clubs/:slug/guests/:guestId`, `POST /clubs/:slug/guests/:guestId/tags`, `DELETE /clubs/:slug/guests/:guestId/tags/:tag`, `POST /clubs/:slug/guests/:guestId/notes`. Isolation fixtures `promoters/:promoterId`, `guests/:guestId`, `tags/:tag` added to `test/helpers/track-a.ts`.
- **Audit:** promoter create/change, booking attribution and removal, guest tag add/remove and note add write `audit_log` rows (`promoter.*`, `guest.*`; note text is not copied into the audit row). No events yet: `data/event-types.ts` is B's.
- **Requests to B:** (1) serve `GET /r/p/:slug/:code` in `http/redirect.ts` (count the tap, carry the code into the booking flow) and call `attributeBooking(..., 'link', ...)` at the hold; (2) set `bookings.source = 'promoter'` for those holds; (3) optionally add `bookings.promoter_id` and backfill from `promoter_attributions`; (4) guest data removal must also delete `guest_tags` and `guest_notes` rows (FKs to `guests`); booking deletion must also delete its `promoter_attributions` row (FK to `bookings`); (5) add event names for promoter and guest-tag actions if the data model should carry them.
- **Blockers:** A20b payment gateway not built; blocked on a written legal review of the money flow (§11.2). Link attribution waits on B's `/r/p/...` redirect and bot hold.
- **it.todo:** none in `test/promoters.test.ts` or `test/crm.test.ts`.
- **Browser walk:** still to be done by a human: Guests page (search, tag, note), Promoters page (create, link, report), a promoter login landing on `/staff/promoters`, and the report VIP tile and top promoters. Typecheck and `npm run build -w @club/web` green.

## 2026-11-27: Track B requests closed by B0 part 2, B13, B15

The B0 request (`applyClubContent`, velora-like 501), the B13 request (`upsertCalendarDay`, A9 todo) and the B15 request (`brain/notes.ts`, A17 `faqs` step and todo) are done; earlier lines above that say "until B0/B13/B15" are historical. See `sync/track-b.md`, "Integration: B0 part 2, B1, B13, B15".

## 2026-11-27: A16 club stats page, built by Session A on track-c

- **Produces:** `buildClubStats(db: Db, clubId: string, from: string, to: string): Promise<ClubStats>` in `platform/club-stats.ts`; `GET /api/staff/clubs/:slug/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` (owner/manager, nights inclusive, at most 366; no range = last complete week) → `{ stats }`; web `pages/staff/Stats.tsx` at `/staff/stats`.
- **Shared helpers now exported from `platform/club-report.ts`** (A16b behaviour unchanged): `nightRange`, `testGuestIds`, `bookingFigures`, `chatFigures`, `bangkokAt`, `rate`, `HELD`, `MANUAL_SOURCES`, `CONVERSATION_GAP_MS`.
- **Assumptions others must match:** B16 stores the monthly AI cost cap in `platform_flags['ai-cost-cap:<clubId>'].value.usdMicros` (`aiCostCapKey`) and emits `ai.call` with `props.cost_usd_micros`. Funnel counts distinct `attempt_id` per step (`booking.started`, `night.selected`, `pax.selected`, `table.held`, `details.submitted`, `rules.accepted`, `deposit.verified`, `booking.confirmed`), so B4b's emits must carry `attempt_id`. G5 booking time is first attempt event to `booking.confirmed`. G8 reads `handoff_episodes.started_at` and the first `messages.author_type = 'staff'` row to that guest.
- **it.todo:** `club-stats.test.ts` keeps one for the B7-seeded Velora history week; until B7 merges the week is hand-seeded on `seedDemoClub`'s Velora.
- **Unverified against a real service:** none called; push quota reads the stored `lastKnownQuota`, not a live LINE call. AI cost is 0 until B16 emits `ai.call`.
- **Web:** `/staff/stats` builds; the browser walk is still to be done by a human.

## 2026-11-27 — A20b payment gateway option, built by Session A on track-a (legal gate waived by owner override)

Supersedes the A20b blocker above. Migration: none (`deposits.method` gains `'gateway'` at type level only).

Published (`apps/server/src/integrations/payments/gateway.ts`):
```ts
export interface PaymentCharge { chargeId: string; payUrl: string }
export interface PaymentEvent { eventId: string; chargeId: string; status: 'successful' | 'failed' | 'pending'; amountSatang: number; currency: string; clubId?: string; bookingId?: string }
export interface PaymentGateway {
  readonly provider: string;
  createCharge(club: Club, req: { bookingId: string; depositId: string; amountSatang: number; returnUrl: string }): Promise<PaymentCharge>; // idempotent per depositId
  signatureOf(header: (name: string) => string | undefined): string | undefined;
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null;
}
export type PaymentGateways = Record<string, PaymentGateway>;
export async function startGatewayDeposit(db: Db, club: Club, gateway: PaymentGateway, bookingId: string, returnUrl: string, now: Date): Promise<PaymentCharge | null>; // null = switch off or nothing to pay: keep the slip flow
export async function applyPaymentEvent(db: Db, provider: string, event: PaymentEvent, now: Date): Promise<PaymentOutcome>;
export function fakePaymentGateway(secret?: string): PaymentGateway & { sign(body: string): string; charges: [...] };
```
- `integrations/payments/opn.ts`: `opnGateway({ secretKey, webhookSecret, fetch?, apiBase? })`, `configuredPaymentGateways(config)` (registers `opn` when `OPN_SECRET_KEY` and `OPN_WEBHOOK_SECRET` are set; new config keys, both optional).
- `AppContext.payments: PaymentGateways`; `createApp(..., { payments })` test hook.
- Route `POST /webhooks/payments/:provider` (`http/payments.ts`): 404 unknown provider, 401 bad signature (nothing written), 409 `charge_mismatch`, else 200 `{ ok, outcome }`. Verified deliveries go to `raw_webhooks` (channel `payments:<provider>`).
- Gateway deposit row: `method = 'gateway'`, `slip_trans_ref = '<provider>:<chargeId>'`. Confirmation is `approveDeposit(..., { type: 'system', id: 'payments:<provider>' }, now)`, then `notifier.confirmed`.
- Feature key `payment_gateway` added to `FEATURE_KEYS` (default false) and the Controls panel label.
- Alert kinds (urgent): `payment_amount_mismatch`, `payment_charge_mismatch`, `payment_unmatched`, `payment_table_lost`, `payment_not_confirmable`.
- **Request to the bot/flow owner:** in `bot/flow.ts` `confirm` (and `continueBooking` for `awaiting_payment`), when `ctx.payments` has a gateway, call `startGatewayDeposit` and send `payUrl`; on null keep `M.payment` with the PromptPay QR. Needs a `payments` entry in `BotDeps`/`bot/deps.ts` and a Thai/English pay-link message. **Done (integrator):** `BotDeps.payments?: PaymentGateways` (`buildBotDeps` default `configuredPaymentGateways(config)`; `createApp` passes the same map to bot and `ctx.payments`). `confirm` (deposit > 0) and `continueBooking` (deposit `method='gateway'`) call `startGatewayDeposit` with the first gateway and send `M.paymentLink` (flex, uri button `payNow`); null or a provider throw keeps the slip flow. Return URL is `https://line.me/R/` (`PAYMENT_RETURN_URL`, assumption: back to LINE, where the confirmation arrives).
- Known: `requestDeposit` still emits `deposit.qr_sent` for a gateway deposit (no QR is sent). No webhook timestamp tolerance check (replays are no-ops anyway).
- Gateway alerts are raised once per open (club, kind, text naming the charge), so a provider retrying a 409 does not repeat the alert.
- Tests: `test/payment-gateway.test.ts` (7 passing, incl. `bot sends the gateway payment link when the switch is on, the slip flow when off`).
- **Exact outcome type:** `applyPaymentEvent` returns `PaymentOutcome = { outcome: 'confirmed' | 'already_confirmed' | 'ignored' | 'unknown_charge' | 'charge_mismatch' | 'amount_mismatch' | 'table_lost' | 'not_confirmable'; clubId?: string; bookingId?: string }`. Also exported: `chargeRef(provider, chargeId)`, `safeEqualHex(a, b)`, `parseOpnEvent(rawBody): PaymentEvent | null`, `OPN_API`, `paymentWebhookRoutes(app: AppContext)`.
- **Assumptions in place of a human decision:** provider is Opn Payments (Omise), the plan's stated option; the PromptPay slip flow stays the default and the gateway runs only with `OPN_*` keys set and the club's `payment_gateway` switch on; the return URL is `https://line.me/R/`.
- **Unverified against a real service:** Opn charge creation, webhook signature header and event shape are from its public docs; tests use `fakePaymentGateway` and a stubbed `fetch` only. No real Opn account or charge was used.
- **Web:** the Controls panel gains the `payment_gateway` label. The browser walk (switch on, guest pays by link, booking confirms) is still to be done by a human.

## 2026-11-27 · A14: LINE ↔ Chatwoot bridge, built by Session A on track-a

Published in `apps/server/src/integrations/chatwoot/`:

```ts
// client.ts
export function chatwootAccount(cw: ChatwootClient, accountId: number, token: string) // createContact, searchContact, createContactInbox, createConversation, createMessage, toggleStatus, setInboxWebhook
// bridge.ts
export const bridgeFlagKey = (clubId: string) => `chatwoot:${clubId}:bridge`;
export async function bridgeState(db: Db, clubId: string): Promise<BridgeState | null>
export function verifyBridgeToken(state: BridgeState | null, token: string | undefined | null): boolean
export async function ensureBridgeWebhook(db: Db, cw: ChatwootClient, key: Buffer, clubId: string, publicUrl: string, now: Date): Promise<BridgeState>
export function mirrorContent(kind: string, payload: unknown): string
export async function mirrorClub(db: Db, cw: ChatwootClient, key: Buffer, club: Club, opts: { now: Date; publicUrl: string; batch?: number; settleMs?: number; log? }): Promise<{ mirrored: number; pending: boolean; error?: string }>
export async function mirrorAll(ctx: AppContext, now: Date): Promise<void>
// callback.ts
export async function checkCallback(db: Db, club: Club, token: string | undefined, body: unknown): Promise<CallbackCheck>
export async function applyCallback(db: Db, checked, send: StaffReplySend, now: Date): Promise<'recorded' | 'resolved' | 'echo' | 'ignored'>
```

- Routes: `POST /integrations/chatwoot/:clubId/callback?token=` (API inbox webhook; 401 bad token, 403 account mismatch, 404 conversation not this club's, nothing written on a reject; accepted deliveries go to `raw_webhooks` channel `chatwoot:callback`), `POST /integrations/chatwoot/:clubId/bot` (no-op 200).
- Job `chatwoot-mirror` every 5 s in `jobs/index.ts` (one line). Reads `messages` of LINE guests (`guests.line_user_id` set) after a `(created_at, id)` cursor, rows older than 2 s by DB clock; stops at the first Chatwoot failure (rows wait). First run mirrors the whole history (assumption).
- Writes `conversations.external_ref = cw:<accountId>:<conversationId>`; inserts a default `conversations` row for a guest that has messages but none (conflict ignored).
- Staff reply from Chatwoot → `recordStaffReply` with `channel: 'chatwoot'`, `externalId: 'cw:<accountId>:<messageId>'`, `userId` from the A13 mapping or `chatwoot:<chatwootUserId>`. Support-grant Chatwoot users are ignored. Chatwoot `resolved` → `endOpenEpisode` with `resolverUserId: 'chatwoot'`.
- Status: human mode → Chatwoot `open`, bot mode → `pending`.
- **For B:** every guest, bot and staff message must stay a `messages` row (mirroring contract). A staff row whose `external_id` starts `cw:` is treated as already in Chatwoot and is not posted back.
- Chatwoot API shapes (contact create response, `toggle_status`, inbox PATCH `channel.webhook_url`, webhook payload `conversation.display_id`, `sender.type`) are not checked against a live install.
- **Assumptions in place of a human decision:** first run mirrors the whole message history; mirror polls every 5 s; Chatwoot account and token come from A13's stored credentials. Tests use a fake Chatwoot client; no real Chatwoot call. No web page in this task.

## Gap closing: Instagram AI answers, gap_waiting, founder LINE id

- **Instagram answers (A18 + B16):** `integrations/chatwoot/instagram-answer.ts` `answerInstagramMessage(deps, club, messageId, now)`, called by the Instagram webhook after `recordInstagramMessage` (which now returns `{ applied, messageId? }`). Same path as LINE: complaint word and handoff keyword, then `answerGuestMessage` (brain snapshot, guard, cost cap) with `channel: 'instagram'` on `AnswerSession` so `ai.*` and `faq.missed` are tagged `instagram`; handoff runs `startEpisode` plus an urgent alert. Replies go to the Chatwoot conversation as outgoing (Agent Bot token when present) and are stored as `messages` rows on the Instagram channel (`external_id` `cw:<account>:<id>`, `failed` with the error when Chatwoot refuses). Booking requests and LINE-button outcomes get `Links.tracked(club, 'line', 'instagram')` (new tracked kind `line`, redirect to `https://line.me/R/ti/p/<OA basic id>`); no LINE basic id hands to a host (`instagram_booking`). Quiet while a host has the chat; off while paused, with the club's `instagram` switch off, or with no model client or Chatwoot. Answer-path errors are logged and raise `bot_error`, never a 500.
- `chat/episodes.ts` events (`handoff.*`, `host.replied`) take channel and data origin from the guest's channel: `instagram` for an Instagram contact.
- **gap_waiting (B19b):** the `brain-draft` job raises needs-input `gap_waiting` (`alertBrainWaiting`, one open per club) when a club has unanswered gaps (`listGaps`), looking only at clubs with a `faq.missed` newer than their last `gap_waiting` alert. Threshold `GAP_WAITING_MIN_GAPS = 1` (the plan sets no count).
- **Founder LINE user id (A5):** `users.line_user_id` (migration `0010_a5_founder_line_user`), `GET`/`PUT /api/admin/me/line {lineUserId: 'U'+32 hex | null}` (audit `admin.line_user_set` / `admin.line_user_cleared`, last4 only). `test-message {to:'self'}` pushes to it through the club's gateway; 409 `no_founder_line_user` when unset, 502 `send_failed`. The 501 is gone. A LINE user id is per provider, so it reaches the founder only on OAs under the provider it came from.

## 2026-11-27 · Phase gate record (Phase 1b, then Phases 1, 2 and 3)

One session built both tracks, so this section and the same one in `track-b.md` tick each gate together. "Passes" means the named test file passed on `track-a` on 2026-11-27, run file by file (`npx vitest run test/<file>`). Device and phone items are open human checks: no device run is recorded, so none is ticked.

### Phase 1b gate checklist (plan line 742)

- [x] A5 `create club then receive a signed webhook with no restart`: `admin.test.ts` passes.
- [x] A2 isolation suite: `isolation.test.ts` passes (own slug with another club's id is 404, another club's slug is 403, no session is 401, on every staff and admin route, including the new §6.2 routes in `http/staff-bookings.ts`).
- [x] B2 nightly check on a seeded week: `velora.test.ts` (`checkEventCompleteness` on the seeded Velora nights finds `missing: 0`, `piiInProps: 0`) and `nightly-check.test.ts` pass. The job now runs five checks: the dead-letter check (`events_dead_letter` empty, §14.2) was added.
- [x] A5 `console-created club: details read with a valid ID token` with no env var set (A4b + B5): `admin.test.ts` passes.
- [x] B4b `emit-coverage.test.ts` passes.
- [x] B8b every night in the booking window has a `nights` row: `nights.test.ts › job writes a row for every date in the booking window, open and closed` passes.
- [x] Every §13.1 row closed, with the task that closed it and its test:

| §13.1 | Closed by | Test |
|---|---|---|
| 1 Simulator open | B8 | `simulator-auth.test.ts` |
| 2 Placeholder secrets | A3 | `config.test.ts` |
| 3 Staff link code | B5 | `guest-staff-link.test.ts` |
| 4 Shared password, no club check | A1, A2 | `auth.test.ts`, `isolation.test.ts` |
| 5 Session not revocable | A1 | `auth.test.ts` |
| 6 Login limit by client address | A1 | `auth.test.ts` |
| 7 Details link leaks, never expires | B5, A4b | `flow.test.ts`, `shared-liff.test.ts`, `guest-staff-link.test.ts` |
| 8 No cross-club test | A2 | `isolation.test.ts` |
| 9 Webhook keeps nothing | B3 | `webhook-durability.test.ts` |
| 10 Failures only on the console | B3 | `webhook-durability.test.ts` |
| 11 State changes outside a transaction | B2 | `booking-history.test.ts`, `nightly-check.test.ts` |

- [ ] **Open, human:** Velora demo script (§12.4) steps 1, 2 and 7, and step 4 in its Phase 1b form, on a phone. (The simulator side is covered by `velora.test.ts` and `flow.test.ts`; the phone run is not recorded.)
- [ ] **Open, human:** device check that `liff.sendMessages()` works when the LIFF app's provider differs from the OA's provider (§16.1 q3). The `viaChat=false` fallback in `http/liff.ts` is in place and tested (`flow.test.ts`).
- [x] Cross-review done: one session built both tracks, so the cross-review is the 2026-11-27 workflow review of the whole branch. Its findings and what happened to each are listed below.
- [ ] Tag `phase-1b-done`: not made. The plan tags `main`, and this branch is not merged to `main` yet (merging is the owner's step). Tag `main` when it merges with the open human items above done.

### Phase 1 gate (plan line 748)

- [x] Before the first real guest: B10b removal and retention tests pass (`removal.test.ts`, `retention.test.ts`).
- [x] Velora demo step 8 (the Velora-only board) has its data: B14 is merged and `analytics.test.ts` passes.
- [ ] **Open, human:** G1–G8 measured on the pilot club; club agrees to continue; onboarding call timed against P1; Meta business verification and app review.

### Phase 2 gate (plan line 976)

- [x] The answer path is tested with fakes: `ai-answers.test.ts` (guard strips invented prices, extraction pre-fills date, pax and table) and `brain-eval.test.ts` (Thai-100 set, per-club test set) pass.
- [ ] **Open, human:** ≥ 85% of free-text booking requests pre-filled, measured on real traffic; no AI-caused wrong price or availability on real traffic; G9 and G10 measured; three clubs onboarded at ≤ 15 minutes each; the Velora script end to end on a real phone.

### Phase 3 gate (plan line 1189)

- [x] The feed publishes a level for every live club on every open night: `busyness.test.ts › level for every live club on a night whose nights.status is not closed` passes.
- [x] Instagram path tested with a fake Chatwoot: `instagram.test.ts` passes.
- [ ] **Open, human:** 3 paying clubs; one club live on Instagram.

### Cross-review findings (2026-11-27) and outcome

- §7.1 `completed` was never set: fixed. `completeBookingTx` / `completeBooking` in `bookings/service.ts` (arrived to completed through `changeStatus`); job `completion` (every 15 min) in `jobs/completion.ts` at closing time + 2h; the POS bill close (`emitBookingCompleted`) also completes the booking on its transaction.
- §6.2 Bookings / Payments missing parts: fixed in `http/staff-bookings.ts` (`GET /clubs/:slug/bookings` search by night, status, zone, promoter, source and text; `POST /bookings/:id/change` for party size, table, night and notes through `changeBooking`; `GET /payments` slips with amount read against expected; `GET /payments/deposits.csv`, managers only), cancel body `deposit: 'forfeit' | 'refund'` (writes `forfeited` / `refunded_manual`), manual booking `kind: 'phone' | 'walkin'` (source `manual_phone` / `manual_walkin`) and `guestId` + `sendLineConfirmation`. Web: `pages/staff/Bookings.tsx`, `pages/staff/Payments.tsx`, actions and history in `BookingDetail.tsx`, booking kind in `NewBooking.tsx`.
- §6.2 Booking detail without history: fixed. The detail route returns `history` (status history with actor and reason), `audit`, `chatSummary` (handoff episodes) and `rulesVersion`.
- §6.2 Settings / §7.2: fixed. `holdMinutes` capped at 30; new `PATCH /clubs/:slug/policy` (its own route so neither form's `club.settings_changed` codes pass 64 characters) for `arrivalGraceMinutes`, `reminderTime`, `cancellationPolicy {en,th}`, `requiredFields`, `tone`, `hostHours`, `afterVisitMessage`; `cancelAsk` uses `cancellationPolicy` (unset: the first rule). Web: "Guest policy and bot" form in `Settings.tsx`.
- §12.3 three sensitive changes: fixed. `notifyOwners` in `http/admin/controls.ts` sends the staff-group text and raises a `needs_input` `sensitive_change` feed alert "For the owner: ..." that stays until resolved, so it is seen before a group is linked. Decision: no email sender exists and staff accounts hold no LINE user id on the club's provider, so the dashboard feed is the owner's direct channel.
- §6.1 / §9 `staff_groups`: decision recorded, not built. Each club links one staff LINE group (`clubs.staff_group_id`) and every staff alert goes there; per-purpose groups (bookings, payments, handoff) are not built. The spec's `staff_groups(purpose)` table is a later change: it needs a migration, a linking flow per purpose and routing in `outbox.toStaff`. Nothing in the gates depends on it.
- §9 `bookings.source`: fixed (see manual booking above).
- B4b `message.sent` inside the send try: fixed. In `line/outbox.ts` only the LINE call is in a try; `mark`, `failed` and `sentEvents` run after it in `afterSend`, which only logs. Test: `outbox-bookkeeping.test.ts`.

## 2026-11-27 · Final merge and whole-branch review

One session built both tracks; this entry is the same in `track-a.md` and `track-b.md`.

**What landed on `track-a`:**
- B4b emit coverage: every type in `EVENT_TYPES` has an emitter in `src` and an asserting test (`emit-coverage.test.ts`, `RESERVED` empty); `message.sent` bookkeeping moved out of the send try (`outbox-bookkeeping.test.ts`).
- Gaps closed: Instagram AI answers (`integrations/chatwoot/instagram-answer.ts`), `gap_waiting` alert in `jobs/brain-draft.ts`, founder LINE user id (`users.line_user_id`, migration `0010_a5_founder_line_user`, `test-message {to:'self'}` works, the 501 is gone).
- Review fixes from the spec walk: §7.1 `completed` (`jobs/completion.ts`, POS bill close); §6.2 Bookings and Payments pages and routes (`http/staff-bookings.ts`, `pages/staff/Bookings.tsx`, `pages/staff/Payments.tsx`); booking detail history; guest policy settings (`PATCH /clubs/:slug/policy`); §12.3 owner notice of sensitive changes; push budget per booking (`push-budget.test.ts`); after-visit message (`jobs/after-visit.ts`); paused clubs; floor plan page (`pages/FloorPlan.tsx`); the other items listed in the two "Cross-review findings" sections and in "Review fixes (spec gaps)".

**Merge notes:** track-c was merged into track-a before this work (`6537958`), so track-a holds every task of both tracks. The only migration added is `0010_a5_founder_line_user` (new file; no applied migration edited). Nothing is merged to `main`: merging and the `phase-1b-done` tag are the owner's step.

**Checks at commit time:** `npm test` 70 files, 706 tests passed, 0 `it.todo` left; `npm run typecheck` clean (server and web); `npm run build -w @club/web` passes (warning only: one 603 kB chunk, over Vite's 500 kB hint).

**Review findings:** fixed and decided items are listed under "Cross-review findings (2026-11-27)" in both sync files. Rejected or deferred, with reason:
- Per-purpose `staff_groups` (§6.1, §9): not built; one staff group per club; needs a migration and a linking flow per purpose. No gate depends on it.
- Rich menu cells from a per-club setting, demo reset deleting the step-7 club, and photo import (no OCR provider wired): not built.
- The [Release] [Keep 30 min] no-show prompt stays replaced by automatic release (plan B10 assumption); with `autoNoShow` off one urgent `no_arrival` alert is raised.
- Web bundle code splitting: not done; build warning only.

**Gate checklists:** ticked in the plan ("Gate status 2026-11-27" under each phase gate) and in `track-a.md` "Phase gate record". Human-only items are left unticked.

**Still needs a human:**
- Browser walks of the staff dashboard, founder console, LIFF form, floor plan, Bookings and Payments pages (built and unit-tested, never opened in a browser this session).
- Phone and device checks: Velora demo (§12.4) steps 1, 2, 7 and step 4 on a phone, the full script in Phase 2; `liff.sendMessages()` across providers (§16.1 q3); door screen on a real tablet.
- Real accounts and keys, all faked in tests: LINE Messaging and Login channels and LIFF app (and the founder's real LINE user id per provider); Meta business verification and app review, Instagram via a real Chatwoot; POS (Papaya, Loyverse) live credentials; Opn Payments (`OPN_SECRET_KEY`, `OPN_WEBHOOK_SECRET`, sub-merchant payouts); SlipOK; Anthropic API key and cost cap on real traffic; Metabase on the `analytics` schema.
- Native Thai review of every Thai string (`bot/i18n.ts`, `bot/messages.ts`, web copy) and of the Thai-100 evaluation set.
- Real-club measurements: G1–G10, ≥ 85% pre-fill, onboarding at ≤ 15 minutes, 3 paying clubs, one club live on Instagram.
- Spec open questions (§16) still open, including §16.1 q3 above; the owner decides them.
- Owner: merge `track-a` to `main` and tag `phase-1b-done`.
