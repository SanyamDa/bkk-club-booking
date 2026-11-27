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
