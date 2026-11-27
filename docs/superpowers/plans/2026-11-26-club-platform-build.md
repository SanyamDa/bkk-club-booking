# Club Platform Build Plan (two parallel Claude sessions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. You are either **Session A** or **Session B**. Do only the tasks of your track, in order, and respect the file ownership table.

**Goal:** Build everything in `clubs/SPEC.md` Draft v2 (Phases 1b, 1, 2 and 3) with two Claude sessions working in parallel on independent tracks that merge into `main` without stepping on each other.

**Architecture:** One Node/TypeScript server (Hono, Drizzle, Postgres or PGlite) and one React web app, as today. Work is split by domain. **Track A (Platform)** owns access, accounts, credentials, LINE connection, the founder console, staff surfaces, integrations (inbox, Instagram, POS) and hosting. **Track B (Guest and Data)** owns the bot, the booking service, the webhook pipeline, the data platform, the demo club Velora, and the club brain. A short **Wave 0** fixes the shared contracts (full v2 schema, club-scoped service signatures, async credentials) so both tracks then build against stable interfaces.

**Tech stack:** Node ≥ 20, TypeScript, Hono, Drizzle ORM, Postgres / PGlite, Vitest, React 19, Vite, `@line/bot-sdk`, zod. New infrastructure: Docker Compose, Chatwoot CE (Phase 2), Metabase OSS (Phase 1). Anthropic API for the brain (Phase 2).

**Spec:** `clubs/SPEC.md` (Draft v2). Backlog: `clubs/EXTENSIONS.md` (not built). Every task names the spec sections it implements; read them before starting.

**Detail level.** Wave 0 and Phase 1b are written out task by task. Phases 1, 2 and 3 are written as task lists with files, interfaces and acceptance tests. **At the start of each later phase, the owning session runs superpowers:writing-plans on its own part of that phase** to expand it into steps, because those phases depend on facts not known yet (Thai LINE behaviour, Chatwoot version, Meta approval, Wongnai report format, Thai model quality).

---

## Global Constraints

- Money is integer **satang** everywhere. Display as ฿ with thousands separators.
- Time zone `Asia/Bangkok`. Night dates are `YYYY-MM-DD` strings in club local time.
- Every table carries `club_id`. Every query is scoped by club. Routes addressed by a booking, conversation or deposit ID check that the row belongs to the caller's club (spec §12.1).
- A new club is created, configured and connected with **no code change, no environment variable and no deploy** (P1, §12.1).
- Club credentials (LINE, POS, Instagram) are stored **encrypted in the database** with the key outside it, and are **never returned by any API or shown after entry**; only `last4`, who set them and when (§13).
- Every LINE webhook delivery is written to `raw_webhooks` **before** the server answers 200 (§13.1 #9, §14.2).
- Every booking state change, its `booking_status_history` row, its `audit_log` row and its `events` row are written in **one transaction** (§13.1 #11, §14.2).
- `events.props` holds only coded values (enums, ids, counts). Free text, names and phone numbers go in `events.raw` or `guests` (§9).
- Every row made by the simulator, a demo club (`clubs.status = 'demo'`) or an onboarding dry run carries `is_test = true`. Test rows never block a real table and never reach a cross-club figure or the busyness feed (§9, §12.4).
- Cross-club views and the busyness feed read only events with `data_origin` in (`first_party`, `pos`) (§14.8).
- The platform is the data controller and consent is handled (owner decision). Do not add consent gates or legal blockers to data collection; do keep the data secure.
- Thai and English for every guest and staff string (§13 Localisation).
- No new runtime dependency for anything a few lines of `node:crypto` or the standard library can do (password hashing, AES-GCM, TOTP, random ids).
- AI model IDs: `claude-haiku-5-5` (live answers), `claude-opus-5-5` (batch drafting and weekly lint), `claude-sonnet-5-5` (fallback and judge) (§8.6).
- Demo club name is **Velora**; code id `club_demo`, slug `demo`, display name `Velora (Demo)`.

## Review Focus

Failure modes the spec implies that are easy to miss. Each has an owning test below.

1. **Cross-club access through an ID.** A user of club A requests club B's booking, conversation or deposit by ID, including through new routes added later. Expected: 404 every time. Test: `isolation.test.ts › every staff and admin route refuses another club's ids` (A2), which walks the root app's route table (`routeTable(app, prefix)`), so routes from either track's routers are covered automatically.
2. **Crash between "200 OK" and processing.** LINE does not resend a delivery we acknowledged. Expected: a delivery stored but not processed is processed after restart. Test: `webhook-durability.test.ts › unprocessed raw webhook is replayed on startup` (B3).
3. **Redelivery and duplicate events.** LINE may redeliver the same event; staff may double-tap a button. Expected: one message row, one event, one state change. Tests: `webhook-durability.test.ts › redelivered webhook event id is processed once` (B3), `events.test.ts › same dedupe_key inserts one row` (B1).
4. **Test data leaking into real figures.** A Velora or simulator booking appears in a cross-club view or the busyness feed, or blocks a real table. Tests: `is-test.test.ts › simulator and demo rows carry is_test` (B6), `busyness.test.ts › demo club never appears` (Phase 3, B).
5. **Secrets leaking back out.** A credential value appears in any API response, log line or error. Test: `credentials.test.ts › no admin or staff response body contains a stored secret` (A4), which scans every JSON response in the admin and staff test suites for the plaintext.

---

## How the two sessions work together

### Setup (once, by the human, before either session starts)

The working tree has uncommitted work (spec v2, `clubs/EXTENSIONS.md`, Velora rename). Commit it to `main` first so both tracks branch from the same point:

```bash
git checkout -b spec-v2 && git add -A && git commit -m "Spec v2: platform goals, founder console, data platform, Velora"
# merge spec-v2 into main (PR or fast-forward), then:
git worktree add ../bkk-club-booking-a -b track-a main
git worktree add ../bkk-club-booking-b -b track-b main
```

Open Session A in `../bkk-club-booking-a` and Session B in `../bkk-club-booking-b`. Each session runs `npm install` and `npm test` in its own worktree first; all tests must pass before Task 1.

### Branch and merge rules

- Each task (or a small group of tasks noted in the plan) goes on a short branch from fresh `main`: `a/<task-id>-<slug>` or `b/<task-id>-<slug>`. Rebase on `origin/main` at the start of each task and again before opening the pull request.
- A pull request merges only when `npm test` and `npm run typecheck` pass and the session's own review (below) is done.
- Merge small and often (at least daily). Long-lived branches are what make two sessions collide.

### File ownership

The owner may change a file freely. The other track may only make the listed **shared edits**; anything else goes through the owner (leave a request in your sync file, below).

| Path | Owner | Shared edits allowed to the other track |
|---|---|---|
| `apps/server/src/config.ts`, `.env.example` | A | add one config key with its default |
| `apps/server/src/main.ts` | A | none after W0; B wires all start-up and background work inside `jobs/index.ts` |
| `apps/server/src/app.ts`, `apps/server/src/http/context.ts`, `apps/web/src/main.tsx` | A | add one route mount line; B8 replaces the `/api/dev` mount line and adds the `/api/admin/sim` mount line. B adds bot dependencies in `bot/deps.ts`, never in the `createApp` body |
| `apps/server/src/http/auth.ts`, `http/staff.ts`, `http/admin/**`, `http/integrations.ts` | A | B5 removes `staffLinkCode` from the settings response and adds the route `POST /api/staff/clubs/:slug/staff-link-code` (see B5) |
| `apps/server/src/platform/**` (users, sessions, support, credentials, totp, crypto) | A | none |
| `apps/server/src/line/gateway.ts`, `line/setup.ts`, `line/credentials.ts`, `line/idtoken.ts` | A | none |
| `apps/server/src/integrations/**` (Chatwoot bridge, Instagram, POS) | A | none |
| `apps/server/src/db/schema/platform.ts` | A | none |
| `apps/web/src/pages/staff/**` (except `staff/brain/**`), `apps/web/src/pages/admin/**`, `apps/web/src/pages/onboard/**`, `apps/web/src/api.tsx` | A | B adds API helpers for its own pages, and one nav item in `pages/staff/Layout.tsx` for the brain pages (B19). B5 changes the staff-group line in `pages/staff/Settings.tsx` to an "Issue link code" button |
| `infra/**`, `Dockerfile`, `docker-compose.yml` | A | B adds the Metabase service block |
| `apps/server/src/bot/**`, `bookings/**`, `http/webhook.ts`, `http/liff.ts`, `http/dev.ts`, `http/demo.ts`, `http/data.ts`, `http/door.ts`, `http/brain.ts`, `line/outbox.ts` | B | none (B makes the `raiseAlert` calls, see A15 and B19b) |
| `apps/server/src/data/**`, `jobs/**`, `demo/**`, `brain/**`, `chat/**` | B | none |
| `apps/server/src/jobs/index.ts`, `apps/server/src/bot/deps.ts` | B (W0 creates both; B owns them from then on) | none |
| `apps/server/src/db/schema/core.ts`, `db/schema/data.ts`, `db/schema/brain.ts`, `db/seed.ts` | B | none |
| `apps/web/src/pages/Simulator.tsx`, `pages/Details.tsx`, `pages/door/**`, `pages/staff/brain/**` | B | none |
| `apps/server/drizzle/**` (migrations) | whoever holds the migration lock | see below |
| `apps/server/test/helpers.ts` | Wave 0 (A); frozen after | add new helpers in `test/helpers/<track>.ts` instead |
| `apps/server/test/fixtures/club.ts` | Wave 0 (A); frozen after | none |
| `apps/server/test/helpers/track-a.ts` | A (created in W0) | none |
| `apps/server/test/helpers/track-b.ts` | B (W0 creates it with an empty `isolationFixtures`) | none |
| `apps/server/test/flow.test.ts`, `test/bookings.test.ts`, `test/live-line.test.ts` | B | A does not edit the test bodies: the config literal, the staff login and the staff URLs live in `test/helpers/track-a.ts` (`testConfig`, `staffCookie`, `staffUrl`, `adminCookie`), which A changes in A1 to A3. One exception: A1 replaces the `/api/staff/login` 401 assert in `flow.test.ts` |

**Frozen contracts.** The `Actor` type and the booking-service signatures in W0 Interfaces are frozen after W0. A change goes through the sync file first and lands as one pull request that updates every call site.

### Migration lock

Drizzle numbers migrations and keeps one journal file, so two sessions generating migrations at once always conflict. Wave 0 creates **every table in spec §9 "Added in v2"** in one migration, plus the base-spec tables and columns listed in W0 Decisions that the code lacks, so most of the build needs no new migration. Every task states **Migration: yes/no**; "yes" means take the lock. When a session still needs a schema change:

1. Rebase on `origin/main`.
2. Change only your own schema file, run `npm run db:generate`, commit schema + migration alone.
3. Open that pull request alone and merge it at once (it is tiny). Note it in your sync file.
4. The other session rebases before its next `db:generate`. If `drizzle/meta/_journal.json` conflicts anyway: drop your migration, rebase, regenerate.
5. A column on a table in the other track's schema file is requested in your sync file; the owning session generates the migration.
6. SQL outside Drizzle's schema (views, roles) ships as a custom migration (`drizzle-kit generate --custom`) under the same lock, so it is in the journal and runs on PGlite in tests.

### Sync files (how the sessions talk)

Each session keeps one append-only file, committed with its pull requests:

- `docs/superpowers/plans/sync/track-a.md` (only Session A writes)
- `docs/superpowers/plans/sync/track-b.md` (only Session B writes)

Each entry: date, task id, what merged, **any interface published or changed (exact signature)**, requests for the other track, blockers. Read the other track's file after every rebase. If the session tools list the other session (ListAgents), also send it a one-line message when you publish an interface it waits on.

### Review (each session reviews its own work, and the other's at phase ends)

- **Per task:** follow superpowers:subagent-driven-development: a fresh implementer subagent, then a fresh reviewer subagent checks the task against this plan and the spec sections it names. Fix every confirmed issue before merging.
- **Per pull request:** run `/code-review` on the branch diff. Run superpowers:verification-before-completion before saying a task is done: paste the passing test command output in the pull request.
- **At each phase gate:** each session reviews the *other* track's merged diff for that phase (`git diff <phase-start-tag>..main -- <other track's paths>`), files findings in its own sync file, and the owner fixes them. The phase is closed when both sessions mark it green in their sync files and the gate checks below pass. Tag `main` as `phase-<n>-done`.

### Standard task loop (applies to every task below)

Each task's steps follow this loop. Tasks list only the tests and the decisions; the loop is not repeated.

1. Write the named failing tests with the stated assertions.
2. Run `npm test -w @club/server -- <test file>`; expect the new tests to FAIL for the stated reason.
3. Implement the stated signatures in the stated files.
4. Run the test file again; expect PASS. Then run `npm test` and `npm run typecheck` from the repo root; expect all green.
5. Commit with a message naming the task id, e.g. `A1: per-person accounts and server-side sessions`.

Web pages have no unit test harness today. For a web task, the check is: `npm run typecheck`, then run the app (`npm run dev`) and walk the stated flow in a browser, and state in the pull request what was walked.

---

## Wave 0: contracts (Session A does W0; Session B does B0 at the same time)

Session B must not start B1 until W0 is merged to `main`.

### Task W0: Shared contracts (Session A)

**Spec:** §9 (whole), §12.1, §13 Security.

**Files:**
- Create: `apps/server/src/db/schema/core.ts` (move every existing table from `schema.ts` here, unchanged except the `+` columns of §9), `db/schema/platform.ts`, `db/schema/data.ts`, `db/schema/brain.ts`
- Modify: `apps/server/src/db/schema.ts` (becomes a barrel: `export * from './schema/core.js'` and the other three)
- Create: `apps/server/drizzle/0002_v2.sql` (generated) 
- Create: `apps/server/src/line/credentials.ts`
- Create: `apps/server/src/bot/deps.ts`, `apps/server/src/jobs/index.ts` (both B-owned after W0; see Interfaces)
- Modify: `apps/server/src/line/gateway.ts`, `http/context.ts`, `app.ts`, `http/webhook.ts`, `bot/flow.ts`, `bot/notify.ts`, `http/staff.ts`, `http/liff.ts`, `http/dev.ts` (only for the async gateway, the new service signatures with `Actor`, and `buildBotDeps` in `createApp`)
- Modify: `apps/server/src/bookings/service.ts` (signatures only, see below)
- Modify: `apps/server/src/main.ts`: replace the 30 s hold sweeper (the `setInterval` block) with `const stopBackground = await startBackground(ctx, () => new Date())`, replace `clearInterval(sweeper)` in `shutdown` with `await stopBackground()`, and delete the staff link code log line
- Modify: `apps/server/test/helpers.ts`, `apps/server/.env.example` (the comment still says "Velour (Demo)"; change to "Velora (Demo)")
- Create: `apps/server/test/fixtures/club.ts` (frozen after W0), `apps/server/test/helpers/track-a.ts`, `apps/server/test/helpers/track-b.ts`
- Modify: `apps/server/test/flow.test.ts`, `test/bookings.test.ts`, `test/live-line.test.ts`: use the `track-a.ts` helpers, so no inline `Config` literal, `/api/staff/login` call or staff URL string remains in a test body
- Test: `apps/server/test/contracts.test.ts`

**Decisions:**
- Table placement. `platform.ts`: `users`, `club_memberships`, `sessions`, `support_grants`, `club_profile`, `club_credentials`, `channels`, `invites(id, club_id, email, role, token_hash, expires_at, accepted_at, created_by)`, `platform_flags(key text PK, value jsonb, updated_by, updated_at)`. `data.ts`: `raw_webhooks`, `events`, `events_dead_letter`, `ops_events`, `occupancy_snapshots`, `door_counts`, `crowd_ratings`, `calendar_days`, `identity_map`, `booking_status_history`, `notices`, `handoff_episodes`. `brain.ts`: `brain_notes`, `brain_note_versions`, `brain_snapshots`. `core.ts`: existing tables with the §9 `+` columns on `clubs`, `messages`, `bookings`, `audit_log`, `tables`. Also create here, because the code lacks them: `pos_bills` (§9 columns plus the v2 `+` columns) and `price_rules(id, club_id, scope, scope_id, weekday, night_id, min_spend_satang, deposit_satang, priority, valid_from, valid_to)`.
- Base-spec columns the code lacks, added in the same migration so later tasks need none: `tables.floor_x, floor_y, shape, valid_from, valid_to`; `deposits.club_id` (filled from the booking) and `deposits.slip_trans_ref, slip_amount_satang, slip_receiver, slip_time` with a unique index on `(club_id, slip_trans_ref)`; `bookings.reminder_sent_at`; `conversations.external_ref`; `messages.external_id` with a unique index on `(club_id, external_id)`. The existing zone and table price columns stay, and the booking flow keeps reading them until a later B task moves pricing to `price_rules`.
- `users` also gets `failed_login_count int not null default 0` and `locked_until timestamptz` (needed for §13.1 #6; not in the spec's column list).
- `clubs.staff_link_code` becomes nullable in `0002_v2.sql` and is never dropped in this build. New code must not set it: `setupTwoClubs` and A5 `POST /api/admin/clubs` leave it null. New columns `staff_link_code_hash text`, `staff_link_code_expires_at timestamptz`. B5 stops reading and writing the old column; B5 needs no migration.
- `events.seq` is `bigserial`; `events.id` is text; unique `(club_id, dedupe_key)`.
- Keep existing column names and camelCase TS property names in the same style as today's `schema.ts`.
- Test fixture club. `test/fixtures/club.ts` holds today's ten-table club exactly as the existing tests use it: `club_demo`, slug `demo`, tables `table_demo_V1`, `V2`, `B1` to `B4`, `T1` to `T4`, same capacities and prices. `setupDb()` and `setupTwoClubs().clubA` seed this fixture, not `seedDemoClub`, so B7's Velora reseed cannot break either track's tests. Tests that need Velora content (B7 `velora.test.ts`, A16 stats) open their own database with `openDb({ dataDir: 'memory' })` and call `seedDemoClub` themselves.
- `main.ts` keeps its `seedDemoClub` call. All other start-up and background work goes through `startBackground` (below), so B never edits `main.ts` after W0.

**Interfaces (Produces):**
- `export interface CredentialStore { line(club: Club): Promise<ClubLineCredentials | null>; }` in `line/credentials.ts`, plus `export function envCredentialStore(env?: NodeJS.ProcessEnv): CredentialStore` (today's `clubCredentials` logic moved here).
- `AppContext.credentials: CredentialStore` (`http/context.ts`), built in `createApp` from `opts.credentials ?? envCredentialStore()`.
- `GatewayRegistry` constructor takes `(credentials: CredentialStore)`; `forClub(club: Club, lineUserId?: string | null): Promise<LineGateway>`. All callers `await` it.
- Booking service: every function that loads a booking by id takes the club id and throws `BookingError('not_found')` when the booking belongs to another club:
  `approveDeposit(db, clubId, bookingId, actor: Actor, now)`, `rejectDeposit(db, clubId, bookingId, actor: Actor, reason, now)`, `cancelBooking(db, clubId, id, actor: Actor, reason, now)`, `markArrived(db, clubId, id, actor: Actor, now)`, `markNoShow(db, clubId, id, actor: Actor, now)`, `getBookingView(db, where: { clubId: string; id?: string; refCode?: string })`, and the private `transition(db, clubId, bookingId, from, to, actor: Actor, now, reason?)`. `submitDetails`, `requestDeposit`, `recordSlip` already take `club` and must also check `booking.clubId === club.id`.
- `export type Actor = { type: 'guest' | 'bot' | 'staff' | 'platform' | 'system'; id?: string; sessionId?: string; supportGrantId?: string }` exported from `bookings/service.ts`. Every `actor` parameter takes `Actor`, not `string`: the functions above plus `createManualBooking` and the private `audit`. Until B2 lands, `audit()` writes `actor.type` to the old `actor` column and to `actor_type`, plus `actor_id`, `session_id`, `support_grant_id`. `Notifier.hostReply(guestId: string, text: string, actor: Actor)`. W0 call sites pass `{ type: 'staff' }`, `{ type: 'guest' }` or `{ type: 'system' }`; A2 fills in the ids.
- `bot/deps.ts` (owner B after W0): `export interface BotDepOptions { now?: () => Date; log?: BotDeps['log'] }` and `export function buildBotDeps(config: Config, db: Db, opts?: BotDepOptions): BotDeps` (today's `deps` literal from `createApp`, moved here). `createApp` gains `opts.bot?: BotDepOptions` and calls `buildBotDeps(config, db, opts.bot)`. B adds every later dependency and its test fake (B9 `SlipVerifier`, B16 Anthropic client and cost cap) to `BotDeps`, `BotDepOptions` and `buildBotDeps` only; B never edits the `createApp` body for a dependency.
- `jobs/index.ts` (owner B after W0): `export function startBackground(ctx: AppContext, now: () => Date): Promise<() => Promise<void>>` (returns a stop function). W0 body: the existing 30 s hold sweeper moved from `main.ts`. B2 and B3 replace the body; `main.ts` does not change again.
- `test/helpers.ts`: `setupTwoClubs(): Promise<{ db, close, clubA: Club, clubB: Club }>` where `clubA` is the fixture club (`test/fixtures/club.ts`) and `clubB` is a second club `club_test_b`, slug `test-b`, with two zones and four tables of its own. `setupDb()` seeds the same fixture club.
- `test/helpers/track-a.ts` (owner A): `testConfig(overrides?: Partial<Config>): Config`, `staffCookie(app, club: Club): Promise<string>`, `staffUrl(slug: string, path: string): string`, `adminCookie(app): Promise<string>`. W0 bodies keep today's behaviour: shared-password login, `/api/staff<path>`, and `adminCookie` returns the staff cookie because no admin account exists yet. A1 changes the two cookie helpers, A2 changes `staffUrl`, A3 changes `testConfig`.
- `test/helpers/track-b.ts` (owner B after W0): `isolationFixtures(db, club: Club): Promise<Record<string, string>>`, returning `{}` in W0 (see A2).

**Tests (`contracts.test.ts`):**
- `migrations create every v2 table`: query `information_schema.tables`; expect each table name listed above present, including `price_rules`, `pos_bills` and `invites`. Query `information_schema.columns`; expect each base-spec column listed in Decisions present.
- `approveDeposit with a staff Actor writes actor_type and actor_id to audit_log`.
- `markArrived refuses a booking of another club`: book a table in clubB, call `markArrived(db, clubA.id, booking.id, ...)`; expect `BookingError` with `code === 'not_found'` and the booking status unchanged.
- `getBookingView scoped by club`: same booking, `getBookingView(db, { clubId: clubA.id, id })` returns `undefined`.
- `env credential store reads the club's env names`: a club with `lineChannelSecretEnv = 'X_SECRET'` and env `{ X_SECRET: 's', ... }` returns `{ channelSecret: 's', accessToken: ... }`; missing env returns `null`.
- Existing `flow.test.ts`, `bookings.test.ts`, `live-line.test.ts` pass unchanged in meaning: update call sites and move the config literal, the staff login and the staff URLs to the `track-a.ts` helpers. Table ids and counts stay as they are, because `setupDb` seeds the fixture club.

**Migration:** yes. This is the one `0002_v2.sql`.

**Merge:** one pull request `a/w0-contracts`. After merge, write the published interfaces into `sync/track-a.md` and create `sync/track-b.md` as an empty file with a heading.

### Task B0: Baseline and Velora content (Session B, during W0)

**Spec:** §12.4.

**Files:**
- Create: `apps/server/src/demo/velora-content.ts` (pure data, no imports from `db/`)
- Create: `apps/server/src/demo/apply-content.ts` (the one writer; it needs W0's schema, so write it as the last step of B0 after rebasing on merged W0, and merge it before B1). Test: `apps/server/test/apply-content.test.ts`
- Test: `apps/server/test/velora-content.test.ts`

**Decisions:** Content plus one writer (`applyClubContent`); the Velora seed, history and reset are B7. Velora is a believable Bangkok club: zones **VIP riser**, **DJ side booth**, **high tables**, and standing/bar; 18–24 tables with codes, capacities and floor x/y; prices per zone in satang with a weekend and an event-night difference; house rules and policies in Thai and English (arrival cut-off, cancellation and deposit policy, age 20+, dress code); one event night per week; about 25 FAQ answers matching the onboarding template (§8.2, §12.2) with **three deliberate gaps** for the learning demo (choose questions a guest would really ask, e.g. birthday cake, parking, private room hire); a club profile (capacity standing and seated, district, venue type, genres, price band, usual peak hour).

**Interfaces (Produces):** `export const VELORA: { zones: VeloraZone[]; tables: VeloraTable[]; priceRules: VeloraPriceRule[]; policies: { en: string; th: string }[]; faqs: { slug: string; question_en: string; question_th: string; answer_en: string; answer_th: string }[]; gaps: { question_en: string; question_th: string; answer_en: string; answer_th: string }[]; profile: VeloraProfile; }` with the small `Velora*` types declared in the same file.
`applyClubContent(tx: Db, clubId: string, content: typeof VELORA): Promise<void>` in `demo/apply-content.ts`: inserts zones, tables, price rules and policies for that club (no history, no brain notes, no status change). Zone and table rows also carry the base price in the existing price columns, which the booking flow still reads. A5 calls it for `template: 'velora-like'`; B7 reuses it. Publish the signature in `sync/track-b.md` when it merges.

**Tests:** `every table code is unique`; `every table belongs to a declared zone`; `every FAQ has non-empty Thai and English`; `gap questions do not appear in faqs`; `prices are integers in satang`; `applyClubContent writes tables and prices for a new club id` (in `apply-content.test.ts`, against `setupTwoClubs().clubB`).

**Migration:** no.

Also: run `npm install`, `npm test`, `npm run typecheck`; fix anything that fails on a clean checkout and note it in `sync/track-b.md`.

---

## Phase 1b: Platform base (before any real club)

Gate (spec §10, §17.1): a second club is created from the console and takes a signed webhook with no deploy; isolation tests pass; the nightly check finds every booking state change in `events`; the Velora demo script runs end to end; all §13.1 fixes closed.

### Track A, Phase 1b

#### Task A1: Per-person accounts, server-side sessions, second factor

**Spec:** §4, §12.3 "Who can use it", §13 Security, §13.1 #4 #5 #6.

**Files:**
- Create: `apps/server/src/platform/passwords.ts`, `platform/sessions.ts`, `platform/totp.ts`, `http/auth.ts`, `src/scripts/create-admin.ts`
- Modify: `http/staff.ts` (remove shared-password login), `apps/server/package.json` (script `admin:create`), `apps/web/src/pages/staff/Login.tsx`
- Modify: `apps/server/test/helpers/track-a.ts` (`staffCookie` creates a manager user for the club and logs in through `POST /api/auth/login`; `adminCookie` logs in a platform admin with TOTP), `apps/server/test/flow.test.ts` (listed shared edit: replace the `/api/staff/login` 401 assert)
- Test: `apps/server/test/auth.test.ts`, `apps/server/test/totp.test.ts`

**Decisions:**
- Passwords: `node:crypto` `scrypt` with a 16-byte random salt, stored as `scrypt$N$r$p$salt$hash` (base64). Compare with `timingSafeEqual`.
- Session id: 32 random bytes, base64url, sent in an `httpOnly`, `SameSite=Lax`, `Secure` (when `PUBLIC_URL` is https) cookie named `sid`. The database stores only `sha256(sid)` in `sessions.id_hash`. Staff sessions last 12 hours; platform-admin sessions 8 hours. Logout sets `revoked_at`.
- Login limit per account: after 5 failures, `locked_until = now + 2^(failures-5) minutes` capped at 60 minutes. The response is the same `invalid_login` for unknown email, wrong password and locked account (no account probing).
- TOTP (RFC 6238, SHA-1, 30 s, 6 digits, ±1 step) required at login for `platform_role = 'admin'`. Managers optional later.
- `npm run admin:create -w @club/server -- --email a@b --name "X"` prints a one-time password and a TOTP otpauth URL once.

**Interfaces (Produces):**
- `hashPassword(pw: string): Promise<string>`, `verifyPassword(pw: string, stored: string): Promise<boolean>`
- `createSession(db, userId, meta: { ip?: string; userAgent?: string }, now: Date): Promise<{ sid: string; expiresAt: Date }>`, `loadSession(db, sid: string, now: Date): Promise<{ user: User; session: Session } | null>`, `revokeSession(db, sid: string, now: Date)`
- `totp(secret: Buffer, at: Date): string`, `verifyTotp(secret: Buffer, code: string, at: Date): boolean`
- In `http/auth.ts` (Hono middleware, set on `c.var`): `requireUser`, `requirePlatformAdmin`, `requireClubRole(...roles: Role[])` (reads `:slug`, loads the club, checks `club_memberships` or an active support grant, sets `c.var.club`, `c.var.user`, `c.var.membership`). Routes: `POST /api/auth/login {email, password, totp?}`, `POST /api/auth/logout`, `GET /api/auth/me` (returns only clubs the user belongs to).

**Tests:**
- `totp.test.ts › RFC 6238 vector`: secret ASCII `12345678901234567890`, time 59 s → `287082`; time 1111111109 s → `081804`.
- `auth.test.ts › login creates a revocable session`: login, call `/api/auth/me` with the cookie → 200; logout; same cookie → 401.
- `› session id is not stored in clear`: `sessions.id_hash` ≠ cookie value.
- `› me lists only own clubs`: user with membership in clubA only → `/me` clubs = `[clubA.slug]`.
- `› locks after five failures and hides the reason`: 5 wrong passwords then the right one → 401 `invalid_login`; after `locked_until` passes (inject `now`) → 200.
- `› platform admin needs totp`: admin without `totp` → 401 `totp_required`; wrong code → 401; right code → 200.

**Migration:** no.

#### Task A2: Club check on every route

**Spec:** §12.1, §13.1 #4 #8, §17.1 Security.

**Files:**
- Modify: `http/staff.ts` (all routes move under `/api/staff/clubs/:slug/...`, including `bookings/:id`, `conversations/:id`, `deposits/:id/slip`; use `requireClubRole`), `apps/web/src/api.tsx`, `apps/web/src/pages/staff/*.tsx` (new URLs)
- Create: `apps/server/test/isolation.test.ts`
- Test helper: `apps/server/test/helpers/track-a.ts` (created in W0) gains `loginAs(app, user): Promise<string /* cookie */>`, `makeUser(db, { email, clubId?, role?, platformAdmin? })`, `routeTable` and `isolationFixtures` (see Interfaces). `staffUrl(slug, path)` changes to return `/api/staff/clubs/<slug><path>`, so B's test files need no edit

**Decisions:** Roles allowed per route: night view, bookings, handoffs, alerts: `owner|manager|host|door`; deposit approve/reject and settings: `owner|manager`; line-setup: `owner|manager` (credential changes are console-only, A4/A5). Every id lookup goes through the club-scoped service functions from W0. Staff routes build `Actor` from `c.var.user`: `{ type: 'staff', id: user.id, sessionId }`, or `{ type: 'platform', id: user.id, sessionId, supportGrantId }` under a support grant (A5). They pass it to every booking-service call and to `notifier.hostReply`.

**Interfaces (Produces):**
- `export function routeTable(app: Hono, prefix: string): { method: string; path: string }[]` in `test/helpers/track-a.ts`. It reads the **root** app's `app.routes`, keeps paths under `prefix`, drops middleware `ALL` entries and dedupes. Tests compute `STAFF_ROUTES = routeTable(createApp(...).app, '/api/staff')` and, from A5, `ADMIN_ROUTES = routeTable(app, '/api/admin')`. Routers that B mounts under these prefixes (`http/demo.ts`, the admin simulator, `http/door.ts`, `http/brain.ts`) are therefore walked too. Nothing is exported from `http/staff.ts`.
- `isolationFixtures(db, club: Club): Promise<Record<string, string>>`, one in `test/helpers/track-a.ts` and one in `test/helpers/track-b.ts`. Each maps a route param name other than `slug` (`id`, and any new param) to the id of a row that belongs to that club. Each track adds the fixtures for the params of its own routes.

**Tests (`isolation.test.ts`):**
- `every staff and admin route refuses another club's ids`: with `setupTwoClubs`, create one booking, conversation and deposit in clubB; log in as a clubA manager; for each entry in `STAFF_ROUTES` (and `ADMIN_ROUTES` once A5 lands), substitute `:slug` with `test-b` and `:id` with clubB's ids; expect status 403 or 404 for every one, and clubB's rows unchanged. Param values come from the merged `isolationFixtures(db, clubB)` of both tracks. The test fails on any route param with no fixture, so a new route cannot pass silently.
- `own club still works`: the same manager on clubA's slug gets 200 on the night view.
- `no session → 401` on every route in `STAFF_ROUTES`.

**Migration:** no.

#### Task A3: Safe configuration

**Spec:** §13.1 #2.

**Files:** Modify `apps/server/src/config.ts`, `.env.example`, `apps/server/test/helpers/track-a.ts` (`testConfig` drops `STAFF_PASSWORD` and adds a test `CREDENTIALS_KEY`; no test body changes). Test: `apps/server/test/config.test.ts`.

**Decisions:** `loadConfig` throws when `APP_SECRET` equals the example value or is shorter than 32 characters, and when `NODE_ENV !== 'development' && NODE_ENV !== 'test'` and `DEV_SIMULATOR` is on. `STAFF_PASSWORD` is removed. New keys: `CREDENTIALS_KEY` (base64 of 32 bytes; required unless `NODE_ENV` is `development` or `test`), `ANTHROPIC_API_KEY` (optional until Phase 2). `NODE_ENV` default stays `development`; `npm start` sets `NODE_ENV=production` in the `start` script. `loadConfig` is the only place that holds the "`DEV_SIMULATOR` only in development or test" rule; B8 reads `config.DEV_SIMULATOR` and adds no `NODE_ENV` check.

**Tests:** `refuses the example APP_SECRET`; `refuses DEV_SIMULATOR outside development and test`; `refuses missing CREDENTIALS_KEY in production`; `accepts a valid production config`.

**Migration:** no.

#### Task A4: Encrypted club credentials and stateless LINE tokens

**Spec:** §11.1.2, §12.3 Onboarding, §13 Security.

**Files:**
- Create: `apps/server/src/platform/crypto.ts`, `platform/credentials.ts`, `line/tokens.ts`
- Modify: `line/credentials.ts` (add DB store), `app.ts` (use DB store, env store only as dev fallback for the demo club)
- Test: `apps/server/test/credentials.test.ts`

**Decisions:**
- AES-256-GCM, 12-byte random IV, ciphertext stored as `v1:iv:tag:data` (base64), `key_ref = 'env:CREDENTIALS_KEY:v1'` so the key can be rotated later.
- LINE Messaging credentials stored as one JSON secret `{ channelId, channelSecret }`. The access token is **never stored**: `line/tokens.ts` issues a stateless token with `POST https://api.line.me/oauth2/v3/token` (`grant_type=client_credentials`, `client_id`, `client_secret`) and caches it in memory per club for 14 minutes.
- Writes record `last4`, `set_by`, `set_at` and an `audit_log` row with before/after `last4` only.

**Interfaces (Produces):**
- `encryptSecret(plain: string, key: Buffer): string`, `decryptSecret(blob: string, key: Buffer): string`
- `setClubCredential(db, key: Buffer, input: { clubId: string; kind: 'line_messaging' | 'line_login' | 'instagram' | 'pos'; secret: object; setBy: string }, now: Date): Promise<{ last4: string; setAt: Date }>`
- `credentialSummary(db, clubId): Promise<{ kind: string; last4: string; setBy: string; setAt: Date }[]>`
- `dbCredentialStore(db, key: Buffer, tokens: LineTokenIssuer, fallback?: CredentialStore): CredentialStore`
- `interface LineTokenIssuer { accessToken(channelId: string, channelSecret: string): Promise<string> }`, `realLineTokenIssuer(fetchImpl?: typeof fetch): LineTokenIssuer`

**Tests:**
- `encrypt round trip and tamper detection`: decrypt(encrypt(x)) = x; flipping one byte of the data throws.
- `stored row contains no plaintext`: after `setClubCredential`, `club_credentials.ciphertext` does not contain the secret string.
- `store returns the channel secret and a token from the issuer` (fake issuer).
- `token cached for 14 minutes`: two calls within 14 min → issuer called once; at 15 min → twice.
- `no admin or staff response body contains a stored secret`: test hook in `createApp` (`opts.onResponse`) collects every JSON body in the admin and staff suites; none contains any secret set in the suite. Add this hook in this task and use it in A5's tests.

**Migration:** no.

#### Task A5: Founder console API v1

**Spec:** §12.3 (all), §12.2 "On the call" steps 4–6, §17.1 Founder console.

**Files:**
- Create: `apps/server/src/http/admin/index.ts` (router, `requirePlatformAdmin` on all), `admin/clubs.ts`, `admin/line-wizard.ts`, `admin/support.ts`, `admin/debug.ts`, `admin/controls.ts`, `apps/server/src/platform/support.ts`, `platform/health.ts`
- Modify: `app.ts` (mount `/api/admin`), `http/auth.ts` (support grants in `requireClubRole`)
- Test: `apps/server/test/admin.test.ts`, `apps/server/test/support.test.ts`

**Decisions:**
- **Clubs:** `GET /api/admin/clubs` returns per club: status, LINE connected, webhook endpoint matches and active (from last setup report), last inbound message time, `ops_events` failures in last 24 h, quota used, handoffs past timeout, deposits in review, `bot_paused`. `POST /api/admin/clubs {name, slug, template: 'blank' | 'velora-like'}` creates status `onboarding`. `PATCH /api/admin/clubs/:slug {status}`. `velora-like` calls B0's `applyClubContent(tx, newClubId, VELORA)` in the same transaction as the club insert; `blank` adds no zones, tables or prices. The insert does not set `staff_link_code` (nullable since W0). A founder links a club's staff group by opening a write-mode support session and using the staff route from B5.
- **LINE wizard backend:** `POST /api/admin/clubs/:slug/line {channelId, channelSecret}` stores credentials (A4), then runs the existing `runLineSetup` (tokens, webhook set + test, rich menu, message check, quota) and returns its `SetupReport`. `GET .../line/status` re-checks for the manual switches (§12.2 minute 6–8) so the wizard can show each one going green. Requires a fresh TOTP code in the body (credential change, §12.3).
- **Support sessions:** `POST /api/admin/support {clubSlug, reason, ticketRef?}` creates a `support_grants` row, mode `read`, expires in 60 min. `POST /api/admin/support/:id/elevate {reason}` sets mode `write`. `POST /api/admin/support/:id/end`. `requireClubRole` accepts an active, unexpired grant for that club; write methods (POST/PATCH/DELETE) need mode `write`. **Every request** made under a grant writes an `audit_log` row with `support_grant_id`, reason, method, path and entity ids (views included). The response carries header `X-Support-Session: <club name>, ends <HH:MM>` for the banner.
- **Debug (read-only, reads Track B tables):** `GET .../webhooks?limit&before` (`raw_webhooks` + processing result), `.../messages` (with `delivery_status`, `error`), `.../conversations/:id/timeline` (messages, events, booking changes, ordered by time), `.../bookings/:id/timeline` (`booking_status_history`), `POST .../webhooks/:id/replay` (calls B's `processDelivery(ctx, rawId, { dryRun: true })`, B3), `POST .../test-message {to: 'self' | 'staff_group'}`.
- **Controls:** `POST .../pause {paused: boolean}` sets `clubs.bot_paused` and alerts the staff group; `POST /api/admin/global-stop {stopped}` sets `platform_flags['global_stop']`. PromptPay ID, greeting/map link and LINE credentials changes need a fresh TOTP, record before/after, and notify the club's owner (staff LINE group and owner account notice).

**Interfaces (Produces):** no route list export: tests compute `ADMIN_ROUTES = routeTable(app, '/api/admin')` (A2), which also walks B's routers under `/api/admin`; `isGloballyStopped(db): Promise<boolean>` in `platform/support.ts` (B3 calls it).

**Consumes:** `processDelivery` (B3): if B3 is not merged yet, ship replay last within this task or as A5b. `raw_webhooks` write (B3): until B3 merges, the gate test asserts 200 and an inbound `messages` row for the new club; keep the `raw_webhooks` assertion as `it.todo` and enable it when B3 merges. `applyClubContent` (B0) for `template: 'velora-like'`.

**Tests:**
- `admin.test.ts › non-admin gets 403 on every ADMIN_ROUTES entry`.
- `› create club then receive a signed webhook with no restart`: create club via API, set credentials via API with a fake LINE setup client, POST a correctly signed webhook to `/line/webhook/<new slug>` → 200 and a `raw_webhooks` row for that club. (This is the Phase 1b gate test. The `raw_webhooks` assertion needs B3; see Consumes.)
- `› credential change needs fresh totp`: without code → 401 `totp_required`.
- `support.test.ts › grant expires after 60 minutes` (inject `now`): staff route on that club → 200 at 59 min, 403 at 61 min.
- `› read-only grant cannot write`: POST approve deposit → 403 `support_read_only`; after elevate → 200.
- `› every request under a grant is audited`: GET night view under a grant → one `audit_log` row with `support_grant_id` and the reason.
- `› pause stops replies within one message`: paused club, signed text webhook → inbound message stored, no outbound message, one staff alert. (Needs B3's pause check; mark `it.todo` until B3 merges, then enable.)

**Migration:** no.

#### Task A6: Founder console web v1

**Spec:** §12.3, §12.2, §12.4 step 7.

**Files:** Create `apps/web/src/pages/admin/{AdminLayout,Clubs,ClubDetail,LineWizard,SupportBanner,WebhookLog,MessageLog,Timeline,Controls}.tsx`; modify `apps/web/src/main.tsx` (mount `/admin/*`), `apps/web/src/pages/staff/Layout.tsx` (show `SupportBanner` when the `X-Support-Session` header is present).

**Decisions:** Plain React, same styling as existing staff pages, no UI library. The LINE wizard is the §12.2 minute table as six steps, each with a deep link placeholder (exact LINE URLs and Thai/English screenshots are added after the first real Thai OA test, spec §16.1 questions 1–2) and a live check that turns green. Credentials inputs are `type=password`, cleared after submit; afterwards only `last4`, setter and time are shown.

**Check:** typecheck; walk: log in as admin with TOTP → create club → paste fake credentials against the simulator → see the setup report → open a support session → banner shows the end time → end it.

**Migration:** no.

#### Task A7: Hosted 24/7

**Spec:** §12.1 last bullet, §13 Availability and Observability.

**Files:** Create `Dockerfile`, `docker-compose.yml` (app + Postgres 16 with a volume), `infra/README.md` (deploy, backup, restore, rotate `CREDENTIALS_KEY`), `infra/backup.sh` (nightly `pg_dump` to object storage).

**Decisions:** One region decision is open (spec §16.1 question 5: Thailand region preferred). Write the compose file host-neutral; the human picks the host. Health check on `/health`; restart policy `unless-stopped`; structured JSON logs to stdout; an uptime monitor on `/health` and on the webhook error rate from `ops_events`.

**Check:** `docker compose up` locally, `curl /health` → `{ "ok": true }`, a signed simulator webhook round trip works against Postgres (not PGlite). Restore drill: dump, drop, restore, app starts.

**Migration:** no.

### Track B, Phase 1b

#### Task B1: Event log core

**Spec:** §14.1, §14.2, §9 (events), §14.8.

**Files:** Create `apps/server/src/data/events.ts`, `data/event-types.ts`. Test: `apps/server/test/events.test.ts`.

**Decisions:**
- `event-types.ts` lists every event type with version `v` and allowed `props` keys, as a `const` object. Start with the types §14.2 names (message in/out, postback with entry tag, search with result count, hold created/expired/abandoned, details submitted, deposit requested, slip received, every status change, handoff start/end, notice shown/accepted, door count, crowd rating, snapshot taken).
- `props` validation: each value is a number, boolean, null, or a string matching `/^[A-Za-z0-9_:.\-]{1,64}$/`. A violation inside tests throws; in production the event goes to `events_dead_letter` with the error and processing continues.
- `data_origin` is required. `is_test` is computed by the caller (B6) and passed in.
- Dedupe: insert `ON CONFLICT (club_id, dedupe_key) DO NOTHING`.

**Interfaces (Produces):**
- `type EventInput = { clubId: string; type: EventType; occurredAt: Date; actorType: 'guest' | 'bot' | 'staff' | 'platform' | 'system'; actorId?: string; channel?: string; dataOrigin: 'first_party' | 'line_chat' | 'line_profile' | 'instagram' | 'pos'; source?: string; guestId?: string; conversationId?: string; bookingId?: string; tableId?: string; zoneId?: string; nightDate?: string; attemptId?: string; causeId?: string; lang?: string; props?: Record<string, string | number | boolean | null>; raw?: unknown; isTest: boolean; dedupeKey?: string }`
- `emit(tx: Db, e: EventInput): Promise<void>` (call it with the transaction handle so it commits with the state change)

**Tests:** `same dedupe_key inserts one row`; `free text in props is rejected` (props `{ note: 'hello world' }` throws in test mode); `rejected event goes to dead letter in production mode` (flag on `emit` options); `seq increases monotonically`.

**Migration:** no.

#### Task B2: Booking state changes in one transaction, with history

**Spec:** §7.1, §13.1 #11, §14.2, §17.1 Data.

**Files:** Modify `apps/server/src/bookings/service.ts`, `apps/server/src/jobs/index.ts` (`startBackground` builds the `Scheduler`, registers `hold-expiry` (every 30 s: `expireStaleHolds`, then `ctx.notifier.holdExpired`) and `nightly-check`, and calls `scheduler.start()`; the returned function calls `scheduler.stop()`). Create `apps/server/src/jobs/scheduler.ts`, `jobs/nightly-check.ts`. Test: `apps/server/test/booking-history.test.ts`, `apps/server/test/nightly-check.test.ts`.

**Decisions:**
- One private helper `changeStatus(tx, booking, to, actor: Actor, reason, now, extra?)` writes the `bookings` update, a `booking_status_history` row, an `audit_log` row and an `events` row (`booking.status_changed`, props `{ from, to, reason_code }`). Every path uses it: hold created (from `null` to `held`), hold expired, abandoned, details, deposit requested, slip received, approve, reject, cancel, arrived (sets `arrived_at`, takes `arrivedPax`), no-show (sets `no_show_at`), released.
- `audit()` moves inside the same transaction. `expireStaleHolds` writes history per expired booking in one transaction.
- `changeStatus` takes the W0 `Actor` and writes `actor.type` and `actor.id` to `booking_status_history`, to `audit_log` (with `sessionId`, `supportGrantId`) and to `events` (`actorType`, `actorId`). Do not change the W0 signatures.
- Every job is registered in `jobs/index.ts` and nowhere else. The 30 s hold sweeper from W0 becomes the `hold-expiry` job, so it runs under the job lock.
- `jobs/scheduler.ts`: a tiny in-process interval runner with named jobs, a per-job lock row in `platform_flags` (`job_lock:<name>`) so two app instances do not run the same job, and an injectable clock. No new dependency.
- Nightly check: for the previous night, every `booking_status_history` row has an `events` row with the same booking, `to` status and time; any mismatch writes an `ops_events` row `kind='bot_error'` with detail and makes the founder console health tile red. Zero tolerance.

**Interfaces (Produces):** `markArrived(db, clubId, id, actor: Actor, now, arrivedPax?: number)`; `Scheduler` class with `register(name: string, everyMs: number, fn: (now: Date) => Promise<void>)`, `start()`, `stop()`, `runOnce(name, now)` (for tests); `checkEventCompleteness(db, nightDate: string): Promise<{ missing: number }>`.

**Tests:**
- `every status change writes history, audit and event in one transaction`: walk a booking held → awaiting_payment → payment_review → confirmed → arrived; expect 5 history rows, 5 events with matching `to`, 5 audit rows.
- `a failure rolls everything back`: make the event insert throw (inject); expect booking status unchanged and no history row.
- `expired holds get history`.
- `nightly check finds a missing event`: delete one event row; `checkEventCompleteness` → `{ missing: 1 }` and one `ops_events` row.
- `hold expiry runs as a scheduler job`: `runOnce('hold-expiry', now)` expires a stale hold and tells the guest.

**Migration:** no.

#### Task B3: Durable webhook pipeline, ops events, bot pause

**Spec:** §13.1 #9 #10, §14.2, §12.3 Controls, §13 Reliability.

**Files:** Modify `http/webhook.ts`, `line/outbox.ts`, `bot/flow.ts`, `jobs/index.ts` (`startBackground` awaits `replayUnprocessed(ctx, now())` before it starts the scheduler; no `main.ts` edit). Create `apps/server/src/data/raw-webhooks.ts`, `data/ops.ts`. Test: `apps/server/test/webhook-durability.test.ts`.

**Decisions:**
- Order in the route: find club (unknown → `ops_events` `webhook_unknown_club`, 404) → read body → verify signature (bad → `raw_webhooks` row with `signature_ok=false` and `ops_events` `webhook_bad_signature`, 401) → insert `raw_webhooks` → answer 200 → process in background → set `processed_at` or `error`.
- Per-event dedupe on LINE `webhookEventId` (store it on the message or as an event `dedupe_key`), so redelivery is a no-op.
- `replayUnprocessed` at start-up processes rows with `processed_at IS NULL AND signature_ok` older than 10 s, oldest first.
- Outbox writes `messages.delivery_status` (`sent|failed|skipped`) and `error`; a failed send also writes `ops_events` `send_failed`.
- Bot pause: if `club.botPaused` or `isGloballyStopped(db)` (A5; until merged, read `platform_flags['global_stop']` directly), store the inbound message and events, send nothing to the guest, and alert the staff group once per conversation per pause.

**Interfaces (Produces):** `processDelivery(ctx: AppContext, rawId: string, opts?: { dryRun?: boolean }): Promise<{ events: number; replies: unknown[] }>` (dry run uses the dev gateway and a rolled-back transaction, for A5's replay); `replayUnprocessed(ctx, now): Promise<number>`; `recordOps(db, clubId: string | null, kind, detail, now)`.

**Tests:** `raw webhook stored before processing` (make processing throw; row exists with `error` set); `unprocessed raw webhook is replayed on startup`; `redelivered webhook event id is processed once`; `bad signature is recorded, not processed`; `failed send records delivery_status failed and an ops event`; `paused club stores inbound and sends nothing`; `dry run replay sends nothing and writes nothing`.

**Migration:** no.

#### Task B4: Full chat capture, entry tags, data notice

**Spec:** §5.5, §14.2, §14.3, §9 (messages +, notices).

**Files:** Modify `bot/flow.ts` (`logInbound`, every send), `bot/messages.ts` (postback data carries `s=<entry>`), `bot/i18n.ts` (notice text EN/TH with a version id), `bot/notify.ts` (`hostReply` stores the staff message with `author_type='staff'` and `author_id = actor.id`; A2 already passes the `Actor`, so A-owned `http/staff.ts` needs no edit), `apps/server/test/flow.test.ts` (the notice shifts index asserts such as `out.at(-3)`). Test: `apps/server/test/chat-capture.test.ts`.

**Decisions:**
- `logInbound` stores the **full** LINE event in `messages.payload` (today it stores a reduced payload) plus `author_type='guest'`, `channel_id`, `occurred_at` from the LINE timestamp.
- Every bot send stores `author_type='bot'`; staff replies `author_type='staff'` with `author_id`.
- Entry-point tags: rich menu buttons, greeting buttons, re-engagement and links carry `s=<code>` (`rm_book`, `greet_book`, `text_intent`, `link_<id>` ...); the tag is copied onto the booking's `attempt_id` chain and every event of that attempt.
- Every table search writes `search.performed` with props `{ night_date, pax_range, result_count }`, **including zero results**.
- First contact shows the data notice (§5.5) once, records a `notices` row (`purpose='data'`, `text_version`, `channel`, `shown_at`), and does not block the flow.

**Tests:** `inbound payload is stored whole`; `bot and guest messages have different authors`; `search with no free table records result_count 0` (§17.1 Data); `entry tag flows from postback to booking events`; `data notice shown once and recorded with its version`.

**Migration:** no.

#### Task B5: Guest-link and staff-link hardening

**Spec:** §13.1 #3 #7.

**Files:** Modify `http/liff.ts`, `bot/links.ts`, `bot/intents.ts`, `bot/flow.ts`, `db/seed.ts` (stops setting `staffLinkCode`), `apps/server/test/flow.test.ts` (the `link CODE` case). Create `bot/staff-link.ts`.
- In `http/staff.ts` (shared edit, note it in the sync file): remove `staffLinkCode` from the settings response and add `POST /api/staff/clubs/:slug/staff-link-code` (`owner|manager`; calls `issueStaffLinkCode`; returns `{ code, expiresAt }` once; writes `audit_log`). The route sits in the staff router, so `routeTable(app, '/api/staff')` covers it. It needs A2 merged (the `/clubs/:slug` prefix and `requireClubRole`); if A2 is not merged yet, do the rest of B5 first.
- In `apps/web/src/pages/staff/Settings.tsx` (shared edit): remove `staffLinkCode` from the type, and replace the `link {s.staffLinkCode}` hint with a button that calls the route and shows the code and its expiry once.
- The `main.ts` log line that printed the code is already gone (W0). No schema change: the old column stays, nullable and unused.

**Decisions:**
- Guest details link: reading guest details (`GET /api/liff/booking`) requires the same LINE ID-token check as submit; links expire at the booking's hold expiry or 24 h, whichever is sooner (signed expiry in the link).
- Staff link code: `issueStaffLinkCode` makes a random 8-character code, stores only its hash with a 10-minute expiry, and returns it once. Using it in a group that is not yet linked links that group. If the club already has a linked group, the bot asks in the new group for confirmation by a manager-only postback, then tells the old group it was replaced, and writes `audit_log`. The code is single-use. It is never logged.

**Interfaces (Produces):** `issueStaffLinkCode(db, clubId: string, userId: string, now: Date): Promise<{ code: string; expiresAt: Date }>` (B5 wires it into the staff settings route and page. A founder uses the same route under a write-mode support grant, so there is no separate admin route).

**Tests:** `details read needs an ID token` (no token → 401 `wrong_user`); `expired link is refused`; `link code works once`; `link code expires after 10 minutes`; `replacing a linked group needs confirmation and notifies the old group`; `settings response has no link code`; `issue route needs owner or manager, returns the code once, and is audited`.

**Check:** walk Settings, issue a code, type `link <code>` in the simulator staff group, and see the group linked.

**Migration:** no.

#### Task B6: Test-data marking

**Spec:** §9 last bullets, §12.4.

**Files:** Modify `bookings/service.ts`, `bot/flow.ts`, `http/dev.ts`. Create `data/test-flag.ts`. Test: `apps/server/test/is-test.test.ts`.

**Decisions:** `isTestContext({ club, lineUserId, source })` is true when the club status is `demo`, the user id starts with `SIM-`, or the source is `dry_run`. Bookings and events from such a context get `is_test = true`. The partial unique index on bookings for real tables does **not** count test rows: change it to `WHERE status IN (...) AND is_test = false`, and add a second partial index for test rows so test bookings still cannot double-book each other (this needs a migration: take the migration lock).

**Tests:** `simulator and demo rows carry is_test`; `a test booking never blocks a real booking on the same table`; `two test bookings still cannot share a table`.

**Migration:** yes (the two partial unique indexes on `bookings`).

#### Task B7: Velora seeded club, reset and fast-forward

**Spec:** §12.4 (all), §17.1 Demo club.

**Files:** Modify `db/seed.ts` (seed Velora from `demo/velora-content.ts` by calling B0's `applyClubContent`, not its own inserts), `app.ts` (one mount line). Create `demo/seed-history.ts`, `demo/reset.ts`, `http/demo.ts` (mounted at `/api/admin/demo` with A's `requirePlatformAdmin`). Test: `apps/server/test/velora.test.ts`.

**Decisions:**
- Velora has `status='demo'`. Seeded **history**: 6 weeks of nights with bookings, cancellations, no-shows, takeovers, door counts and crowd ratings, generated deterministically from a fixed seed so the stats page and data dashboard show real-looking charts. All rows `is_test`.
- Seeded **tonight** (relative to `now`): some tables booked, one hold in progress, one slip waiting review, one guest waiting for a host.
- Brain: the FAQ notes from B0 inserted as `brain_notes` with `status='live'`, `source='onboarding'`; gaps are not inserted.
- Reset: deletes every Velora row created after the seed and re-runs the tonight seed with dates moved to today. One transaction. Only for clubs with `status='demo'`.
- **Fast-forward** does not change the clock: it moves the chosen booking's timestamps into the past (hold expiry, reminder time, release time) and runs the matching job once, so other clubs are unaffected.

**Interfaces (Produces):** `resetDemoClub(db, clubId: string, now: Date)`, `fastForward(db, clubId: string, what: 'hold_expiry' | 'reminder' | 'release', bookingId: string, now: Date)`. Routes `POST /api/admin/demo/:slug/reset`, `POST /api/admin/demo/:slug/fast-forward`.

**Tests:** `reset restores the seeded tonight with today's date`; `reset refuses a non-demo club`; `reset leaves club B untouched`; `fast-forward expires the hold`; `seeded history is deterministic` (two seeds produce equal row counts and sums).

**Routes and isolation:** mount line only in `app.ts`. `isolation.test.ts` and `admin.test.ts › non-admin gets 403 on every ADMIN_ROUTES entry` must pass with the new routes (they are walked through `routeTable`). Fixtures for new route params go in `test/helpers/track-b.ts` via `isolationFixtures`. These routes take `:slug` and need platform admin, so a club-A manager gets 403.

**Migration:** no.

#### Task B8: Simulator behind admin login

**Spec:** §13.1 #1, §12.3 Simulator.

**Files:** Modify `http/dev.ts` (use `requirePlatformAdmin`, accept any club slug, mark rows test), `apps/web/src/pages/Simulator.tsx` (admin login), `app.ts` (listed shared edit: mount `/api/dev` when `config.DEV_SIMULATOR`; mount the admin-protected simulator under `/api/admin/sim` in all environments), `apps/server/test/flow.test.ts` (`sim()` and `transcript()` send `adminCookie(app)` from `test/helpers/track-a.ts`). Test: `apps/server/test/simulator-auth.test.ts`.

**Decisions:** The "development or test only" rule lives in `loadConfig` (A3). B8 reads `config.DEV_SIMULATOR` and adds no `NODE_ENV` check.

**Tests:** `simulator routes need platform-admin login`; `simulator runs against any club and marks rows test`; `/api/dev is not mounted when config.DEV_SIMULATOR is off`.

**Routes and isolation:** `isolation.test.ts` and `admin.test.ts › non-admin gets 403 on every ADMIN_ROUTES entry` must pass with the `/api/admin/sim` routes. Fixtures for new route params go in `test/helpers/track-b.ts` via `isolationFixtures`.

**Migration:** no.

**Phase 1b gate checklist** (both sessions tick in their sync files): A5 `create club then receive a signed webhook with no restart` passes; A2 isolation suite passes; B2 nightly check passes on a seeded week; Velora demo script steps 1–3 and 7 run in the simulator and on a phone (steps 4–6 and 8 need Phase 2 and Phase 1); every §13.1 row closed with the task that closed it; cross-review done.

---

## Phase 1: Pilot (House of Savoy, 4 weeks)

Gate (spec §10): G1–G8 measured; club agrees to continue; onboarding call timed against P1. Human task, start now: **Meta business verification and app review** (§11.5, longest lead item).

Expand with superpowers:writing-plans at the start of the phase.

### Track A, Phase 1

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| A8 Staff accounts and invites | §4, §12.3 Onboarding: invite by email or LINE link, set roles, disable a user | `platform/invites.ts`, `http/staff.ts`, `pages/staff/Team.tsx` | invite accepted creates membership with the role; disabled user's sessions revoked |
| A9 Settings UI | §6.2, §12.3 Club data: tables, zones, prices (with `valid_from/valid_to`), rules, greeting, PromptPay ID (TOTP + owner notice) | `http/staff.ts`, `pages/staff/Settings.tsx`, `pages/admin/ClubDetail.tsx` | price change keeps past nights' prices; PromptPay change needs TOTP and notifies owner |
| A10 Greeting and rich menu migration | §10 Phase 1, §11.1 | `line/setup.ts`, `pages/admin/LineWizard.tsx` | club's existing greeting text imported into settings; rich menu replaced and old one kept for rollback |
| A11 POS level L0: report import | §11.3 L0 (Wongnai/FoodStory CSV) | `integrations/pos/adapter.ts` (`PosAdapter` interface), `integrations/pos/csv-import.ts`, `pages/staff/PosImport.tsx` | import maps rows to `pos_bills` with `table_code`, `covers`, times; re-import is idempotent; walk-in bills have no booking. Needs a real report sample (spec §16.1 q13) before coding the column map |
| A12 Observability and load | §13 Peak load, Observability | `infra/`, `scripts/load.ts` | 50 bookings/min per club and 1,000 inbound/min total with p95 reply < 3 s (Friday 22:00–01:00 pattern); uptime alert fires on webhook error rate |

**Migration (Track A, Phase 1):** none. `invites` (A8), `price_rules` with `valid_from/valid_to` (A9) and `pos_bills` (A11) come from W0. If the phase-start writing-plans pass finds a need, take the lock.

### Track B, Phase 1

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| B9 Automatic slip verification | §11.2: amount, receiver, time after hold, transaction ref never reused per club; any failure or outage → `payment_review`, never auto-reject. Provider (SlipOK or EasySlip) picked by the human after evaluation | `bookings/slip-verify.ts` (`SlipVerifier` interface + one adapter), `bot/flow.ts`, `bot/deps.ts` (the verifier and its test fake) | each of the four checks failing → `payment_review`; provider timeout → `payment_review`; reused ref → `payment_review` |
| B10 Reminders, running late, guest cancel, no-show job | §5.2, §5.3, §7.2 | `jobs/reminders.ts`, `jobs/no-show.ts`, `jobs/index.ts` (register both jobs), `bot/flow.ts` | reminder sent once at the configured lead time; running-late sets `running_late_minutes`; no-show after the release time per rules; each writes history and events |
| B11 Door screen | §6.2 door mode, §14.3: QR scan, actual party size at check-in, clicker by guest type, large targets, dark | `pages/door/*`, `http/staff.ts` is A's: B adds `http/door.ts` mounted under `/api/staff/clubs/:slug/door` with A's `requireClubRole('door', ...)` | check-in records `arrived_pax`; clicker writes `door_counts` by kind; works with a door-role account only; mount line only in `app.ts`, and `isolation.test.ts` passes with the door routes (fixtures for new params in `test/helpers/track-b.ts` via `isolationFixtures`) |
| B12 Occupancy snapshots and crowd rating | §14.3, §17.1 Data | `jobs/snapshots.ts`, `jobs/index.ts` (register the job), `bot/notify.ts` (hourly "how full now?" to door/host), `http/door.ts` | a snapshot exists for every open club-night at every scheduled lead bucket; rating 1–5 stored with user |
| B13 Calendar days | §14.3 | `data/calendar-seed.ts` | Thai public holidays, holy days, alcohol-ban days for 2026–2027 present |
| B14 Data dashboard v1 | §14.5, §14.6, §14.10 | `infra/metabase/` (compose block, read-only DB role), a custom migration in `apps/server/drizzle/` (`drizzle-kit generate --custom`, under the migration lock) with the views in an `analytics` schema that exclude `is_test` and apply §14.8 origin rules, and the read-only role (guard the role statement so PGlite tests pass), `infra/metabase/dashboards/*.json` | Metabase connects with the read-only role and cannot write; live event stream, booking pace, funnel and per-club report render; Velora appears only in a "demo" filter |

**Migration (Track B, Phase 1):** B14 yes (the custom migration in its row). B9, B10, B11, B12 and B13 no: W0 added `deposits.slip_*`, `bookings.reminder_sent_at`, `door_counts`, `occupancy_snapshots`, `crowd_ratings` and `calendar_days`.

---

## Phase 2: Brain and inbox

Gate (spec §10): ≥ 85% of free-text booking requests correctly pre-filled; no AI-caused wrong price or availability; G9 and G10 measured; three clubs onboarded at ≤ 15 minutes each.

**Interface first (week 1 of the phase, B publishes, A consumes):** `chat/episodes.ts`:
`startEpisode(tx, { clubId, conversationId, trigger, reason, firstMessageId, now })`, `recordStaffReply(db, { clubId, conversationId, userId, text, channel, occurredAt, externalId }): Promise<{ messageId: string }>` (stores the message `author_type='staff'`, writes the event, sends to the guest through the outbox, dedupes on `externalId`), `endEpisode(tx, { episodeId, endedBy: 'staff' | 'timeout', resolverUserId?, now })`. Handoff timeout moves from lazy (today `bot/flow.ts:116–119`) to a scheduler job.

B14b (first row of the Track B table below) builds `chat/episodes.ts`. It is the first Phase 2 task for Track B and merges in week 1. **A14, A16 and B18 are blocked by B14b.**

**Mirroring contract (A14):** A's bridge does not edit B's files. It reads B's `messages` rows (inbound, bot and staff) and `handoff_episodes` status in creation order and keeps its own per-club cursor. B guarantees that every guest message, bot send and staff reply is a `messages` row before or at send time.

**Alerts interface (A publishes when A15 merges, B consumes in B19b):** `platform/alerts.ts`: `raiseAlert(db, { clubId, level: 'urgent' | 'needs_input' | 'info', kind: string, conversationId?: string, bookingId?: string, text: { en: string; th: string } }, now): Promise<void>`. It records the alert and, for `urgent`, sends to the staff group through a sender that A wires once in `createApp` to B's `outbox.toStaff`. B makes every `raiseAlert` call; A does not edit `bot/**` or `line/outbox.ts`.

### Track A, Phase 2

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| A13 Chatwoot CE install | §6.3 | `infra/chatwoot/` (compose, one shared install, per-club account) | install survives restart; backup covered by `infra/backup.sh` |
| A14 LINE ↔ Chatwoot bridge | §6.3: our server keeps the webhook and mirrors into an API-channel inbox; staff replies return via `message_created` callback → `recordStaffReply`; bot posts with the Agent Bot token; we set conversation status | `integrations/chatwoot/{client,bridge,callback}.ts`, `http/integrations.ts`, `http/staff.ts` (switch `/conversations/:id/resolve` to `endEpisode` and `/conversations/:id/reply` to `recordStaffReply`). Blocked by B14b | guest message appears in Chatwoot; staff reply reaches the guest once (callback redelivery deduped); bot messages shown as bot; inbox down → bot still answers and messages queue for mirroring; dashboard resolve closes the open episode |
| A15 Alerts | §6.4: Urgent (inbox + staff group within 5 s), Needs input (dashboard counter), Information | `platform/alerts.ts` (A creates it; signature under "Alerts interface" above), `app.ts` (wire the staff-group sender once). A does not edit `bot/**` or `line/outbox.ts`; B makes the calls in B19b. A publishes the signature in its sync file when A15 merges | urgent reaches both within 5 s; needs-input counter increments and clears on resolve |
| A16 Club stats page | §6.5: bookings made by the bot, deflection rate, takeovers by topic, any date range | `http/staff.ts` (`/stats`), `pages/staff/Stats.tsx` (reads `events`, `handoff_episodes`). Blocked by B14b | figures match a hand-counted seeded Velora week; test rows excluded for real clubs |
| A17 Full onboarding wizard | §12.2: pre-call form link, minute table, deep links, live checks, go-live switch, timing recorded per step | `pages/admin/LineWizard.tsx`, `pages/onboard/*` (pre-call form), `http/admin/onboarding.ts` | form submission creates tables, prices, rules and baseline FAQs; each step's duration stored; three real onboardings timed |

**Migration (Track A, Phase 2):** A14 no (`conversations.external_ref` and `messages.external_id` come from W0). A15: decide where alerts are stored in the phase-start writing-plans pass; a new table means yes. Others no.

### Track B, Phase 2

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| B14b Handoff episodes (first; week 1) | §6.3, §8.3: one episode per takeover, staff reply recording, timeout as a job | `chat/episodes.ts`, `jobs/handoff-timeout.ts`, `jobs/index.ts` (register the job), `bot/flow.ts` (remove the lazy timeout, call `startEpisode`), `line/outbox.ts` | handoff creates one `handoff_episodes` row; `recordStaffReply` with a repeated `externalId` sends once; the timeout job ends the episode with `endedBy='timeout'` and returns the conversation to bot mode; no mode change happens outside `chat/episodes.ts` |
| B15 Brain store | §8.2: notes with Obsidian-compatible markdown + frontmatter, versions, snapshot compile with token count, cap 60k tokens (warn 40k); save-time lint rejects prices and availability | `brain/{notes,compile,lint}.ts` | note with a price is rejected at save; compile is deterministic and hashed; over 60k refuses to publish |
| B16 AI answers | §8.1, §8.5, §8.6: whole brain in the prompt with a cache breakpoint, `claude-haiku-5-5`, fallback `claude-sonnet-5-5`; output guard: no amount, table code or availability not produced by the booking system in the same turn; per-club cost cap | `brain/answer.ts`, `brain/guard.ts`, `bot/flow.ts`, `bot/deps.ts` (Anthropic client, cost cap and their test fakes) | guard strips an invented price; cost cap reached → hand to host; Anthropic API down → hand to host |
| B17 Thai evaluation | §8.6, §16.1 q16 | `brain/eval/thai-100.jsonl`, `scripts/eval-brain.ts` | 100-question Thai set scored by `claude-sonnet-5-5` as judge; result recorded before choosing the live model |
| B18 Learning loop | §8.3, §8.4: resolved episode → redact → `claude-opus-5-5` batch draft → auto-discard price/personal data/one-off → approval queue → live; review flag after a quick re-takeover; weekly lint; gaps list | `brain/learn.ts`, `jobs/brain-draft.ts`, `jobs/brain-lint.ts`, `jobs/index.ts` (register both jobs). Blocked by B14b | draft with a phone number discarded; approved note answers the same question next time (§17.1); re-takeover within 7 days flags the note |
| B19 Brain manager UI | §6.6 | `pages/staff/brain/*`, `http/brain.ts` (under `/api/staff/clubs/:slug/brain` with A's `requireClubRole('owner','manager')`), one nav item in `pages/staff/Layout.tsx` (listed shared edit) | approve in one tap; edit creates a version; gaps list shows unanswered questions; mount line only in `app.ts`, and `isolation.test.ts` passes with the brain routes (fixtures for new params in `test/helpers/track-b.ts` via `isolationFixtures`) |
| B19b Alert call sites (after A15 merges) | §6.4 | `bot/flow.ts` and the pause alert from B3: replace the direct `outbox.toStaff` staff-alert sends with `raiseAlert(...)`. `Notifier.confirmed`'s new-booking staff message in `bot/notify.ts` stays as is unless §6.4 classes it as an alert | urgent alert reaches inbox and staff group within 5 s; a paused club raises one alert per conversation per pause through `raiseAlert` |

**Migration (Track B, Phase 2):** none planned (`handoff_episodes` and the `brain_*` tables come from W0).

---

## Phase 3: Channels, POS and busyness feed

Gate (spec §10): 3 paying clubs; one club live on Instagram; the feed publishes a level for every live club on every open night.

### Track A, Phase 3

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| A18 Instagram via Chatwoot | §11.5: native Chatwoot inbox, text + attachments, OAuth in Chatwoot UI; needs Meta approval | `integrations/chatwoot/instagram.ts`, `channels` rows | Instagram message lands in the club's inbox and as `data_origin='instagram'` events, which no cross-club view reads |
| A19 POS live sync | §11.3: Papaya (reservation at check-in with `payments[]`, webhooks `order.totalsUpdated`, two keys per outlet), Loyverse closed receipts | `integrations/pos/{papaya,loyverse}.ts` implementing `PosAdapter` | sandbox: deposit at check-in shows on the bill (§16.1 q15); webhook updates `pos_bills` totals idempotently |
| A20 Promoters, payment gateway option, guest CRM + VIP tags, reports | §10 Phase 3 | expand at phase start | expand at phase start. Payment gateway needs legal review first (§11.2) |

### Track B, Phase 3

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| B20 Shared LIFF and identity map | §11.1.1, §14.4: one LIFF app under our provider, first-use `sub` mapping, `person_id` | `data/identity.ts`, `http/liff.ts` | same LINE person at two clubs gets one `person_id`; `liff.sendMessages()` across providers verified first (§16.1 q3) |
| B21 Busyness feed v1 | §14.7: `GET /data/v1/busyness`, 5-step level per club per 30-min bucket relative to capacity, "no data" when inputs are thin, staged model (booking heat → weekday baseline × pace) | `data/busyness.ts`, `http/data.ts` (API key auth for the separate app) | level for every live club on an open night; demo club never appears; no guest-level field; reads only `first_party` and `pos` origins |
| B22 Waitlist, bottle pre-orders | §10 Phase 3 | expand at phase start | expand at phase start |

**Migration (Phase 3, both tracks):** none planned (`identity_map` and `channels` come from W0). B21 passes `isolation.test.ts` like every other route. Confirm in the phase-start writing-plans pass.

---

## Decisions the human must make (they block the named task, not the whole track)

| Decision | Blocks | Spec |
|---|---|---|
| Production host and region (Thailand preferred) | A7 go-live | §16.1 q5 |
| Staff login method (email+password assumed in A1; LINE Login could be added) | A8 | §16.1 q6 |
| Velora on production (assumed) or its own copy | B7 deploy | §16.1 q7 |
| May a founder in a support session message a guest as the club (A5 assumes no: read and fix settings only) | A5 | §16.1 q8 |
| Slip verification provider | B9 | §11.2 |
| Definition of "busy" and feed shape for the separate app | B12, B21 | §16.1 q9 q10 |
| Wongnai report sample | A11 | §16.1 q13 |

## Session start prompts

Paste one into each session after the setup step above.

**Session A:**
> You are Session A (Track A: Platform) for `docs/superpowers/plans/2026-11-26-club-platform-build.md`, working in this worktree on branch `track-a`. Read the plan header sections (Global Constraints, Review Focus, How the two sessions work together) and `clubs/SPEC.md` sections named by each task. Do Task W0 first and merge it, then A1 to A7 in order, then later phases as the plan says. Only change files your track owns or the listed shared edits. The `Actor` type and the booking-service signatures are frozen once W0 merges. Use superpowers:subagent-driven-development for each task, `/code-review` before each merge, and record merges and published interfaces in `docs/superpowers/plans/sync/track-a.md`. Read `sync/track-b.md` after every rebase. Do not merge with failing tests.

**Session B:**
> You are Session B (Track B: Guest and Data) for `docs/superpowers/plans/2026-11-26-club-platform-build.md`, working in this worktree on branch `track-b`. Read the plan header sections (Global Constraints, Review Focus, How the two sessions work together) and `clubs/SPEC.md` sections named by each task. Do Task B0 now; its last step (`applyClubContent`) and B1 start only after Session A's W0 is merged to `main` (check `sync/track-a.md`). Then B1 to B8 in order, then later phases as the plan says. Only change files your track owns or the listed shared edits. The `Actor` type and the booking-service signatures from W0 are frozen; register jobs in `jobs/index.ts` and bot dependencies in `bot/deps.ts`, not in `main.ts` or `app.ts`. Use superpowers:subagent-driven-development for each task, `/code-review` before each merge, and record merges and published interfaces in `docs/superpowers/plans/sync/track-b.md`. Read `sync/track-a.md` after every rebase. Do not merge with failing tests.
