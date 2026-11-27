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
- `is_test` is a column on `guests`, `bookings` and `events` only (§9). It is set on the guest: a simulator guest, a registered tester, or any guest of a demo club (`clubs.status = 'demo'`). `bookings` and `events` copy it. Every other table has no such column and takes it from its guest, booking or club: a `messages`, `conversations`, `deposits` or `handoff_episodes` row is a test row when its guest or booking is one, and every row of a demo club is a test row (`door_counts`, `crowd_ratings`, `occupancy_snapshots` and `raw_webhooks` included). Test rows never block a real table and never reach a cross-club figure or the busyness feed, and a real club's occupancy snapshots count only bookings with `is_test = false` (§9, §12.4).
- Cross-club views and the busyness feed read only events with `data_origin` in (`first_party`, `pos`) (§14.8).
- The platform is the data controller and consent is handled (owner decision). Do not add consent gates or legal blockers to data collection; do keep the data secure.
- Thai and English for every guest and staff string (§13 Localisation).
- No new runtime dependency for anything a few lines of `node:crypto` or the standard library can do (password hashing, AES-GCM, TOTP, random ids).
- AI model IDs: `claude-haiku-5-5` (live answers), `claude-opus-5-5` (batch drafting and weekly lint), `claude-sonnet-5-5` (fallback and judge) (§8.6).
- Demo club name is **Velora**; code id `club_demo`, slug `demo`, display name `Velora (Demo)`.

## Review Focus

Failure modes the spec implies that are easy to miss. Each has an owning test below.

1. **Cross-club access through an ID.** A user of club A requests club B's booking, conversation or deposit by ID, including through new routes added later. Expected: 404 when the id belongs to another club and the slug is the user's own; 403 when the slug is another club's. Tests: `isolation.test.ts › own slug with another club's id returns 404` and `› another club's slug returns 403` (A2), which walk the root app's route table (`routeTable(app, prefix)`), so routes from either track's routers are covered automatically.
2. **Crash between "200 OK" and processing.** LINE does not resend a delivery we acknowledged. Expected: a delivery stored but not processed is processed after restart. Tests: `webhook-durability.test.ts › unprocessed raw webhook is replayed on startup` and `› delivery that crashed after the inbound row was stored is replied to on replay` (B3).
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
| `apps/server/src/platform/**` (users, sessions, support, credentials, login channel, totp, crypto, alerts, features, club report) | A | none |
| `apps/server/src/scripts/**`, `README.md`, `docs/LINE-SETUP.md` | A | B adds its own script files (`scripts/events-doc.ts` in B1, `scripts/eval-brain.ts` in B17) and one `package.json` script line for each |
| `apps/server/src/line/gateway.ts`, `line/setup.ts`, `line/credentials.ts`, `line/tokens.ts`, `line/idtoken.ts` | A | B4 adds `&s=rm_book`, `&s=rm_my` and `&s=rm_host` to the rich-menu postback `data` in `menuCells` of `line/setup.ts`, nothing else |
| `apps/server/src/integrations/**` (Chatwoot bridge, Instagram, POS) | A | none |
| `apps/server/src/db/schema/platform.ts` | A | none |
| `apps/web/src/pages/staff/**` (except `staff/brain/**`), `apps/web/src/pages/admin/**`, `apps/web/src/pages/onboard/**`, `apps/web/src/api.tsx` | A | B adds API helpers for its own pages, and one nav item in `pages/staff/Layout.tsx` for the brain pages (B19). B5 changes the staff-group line in `pages/staff/Settings.tsx` to an "Issue link code" button |
| `infra/**`, `Dockerfile`, `docker-compose.yml` | A | B adds the Metabase service block to `docker-compose.yml` and owns `infra/metabase/**` (B14) |
| `apps/server/src/bot/**`, `bookings/**`, `http/webhook.ts`, `http/liff.ts`, `http/dev.ts`, `http/demo.ts`, `http/data.ts`, `http/door.ts`, `http/brain.ts`, `http/redirect.ts`, `http/media.ts`, `line/outbox.ts` | B | none (B makes the `raiseAlert` calls, see A15 and B19b) |
| `apps/server/src/data/**`, `jobs/**` (except `jobs/index.ts`, which has its own row below), `demo/**`, `brain/**`, `chat/**`, `docs/EVENTS.md` (generated by B1's script) | B | none |
| `apps/server/src/line/samples.ts` | B | none (A's `http/staff.ts` only imports `sampleMessages`) |
| `apps/server/src/lib/**`, `apps/server/src/db/client.ts`, `apps/server/src/db/schema.ts` (the barrel; no change after W0), `apps/server/package.json`, root `package.json` | A | additive only, noted in the sync file: a new export in `lib/**`, or one new script line or dependency line in a `package.json` |
| `apps/server/src/jobs/index.ts`, `apps/server/src/bot/deps.ts`, `apps/server/src/data/events.ts`, `data/event-types.ts`, `apps/server/src/chat/conversations.ts` | B (W0 creates them; B owns them from then on) | in `jobs/index.ts` only: A adds one `scheduler.register` line per A-owned job (A15 `alert-checks`, A16b `club-report`); the job body lives in `platform/**` |
| `apps/server/src/db/schema/core.ts`, `db/schema/data.ts`, `db/schema/brain.ts`, `db/seed.ts` | B | none |
| `apps/web/src/pages/Simulator.tsx`, `pages/Details.tsx`, `pages/door/**`, `pages/staff/brain/**` | B | none |
| `apps/server/drizzle/**` (migrations) | whoever holds the migration lock | see below |
| `apps/server/test/helpers.ts` | Wave 0 (A); frozen after | add new helpers in `test/helpers/<track>.ts` instead |
| `apps/server/test/fixtures/club.ts` | Wave 0 (A); frozen after | none |
| `apps/server/test/helpers/track-a.ts` | A (created in W0) | none |
| `apps/server/test/helpers/track-b.ts` | B (W0 creates it with an empty `isolationFixtures`) | none |
| `apps/server/test/flow.test.ts`, `test/bookings.test.ts`, `test/live-line.test.ts` | B | A does not edit the test bodies: the config literal, the staff login and the staff URLs live in `test/helpers/track-a.ts` (`testConfig`, `staffCookie`, `staffUrl`, `adminCookie`), which A changes in A1 to A3. One exception: A1 replaces the `/api/staff/login` 401 assert in `flow.test.ts` |
| every other `apps/server/test/*.test.ts` | the track of the task that creates it | none; a task of the other track that needs a case there asks in its sync file |

**Frozen contracts.** The `Actor` and `Reason` types and the booking-service signatures in W0 Interfaces are frozen after W0. A change goes through the sync file first and lands as one pull request that updates every call site.

### Migration lock

Drizzle numbers migrations and keeps one journal file, so two sessions generating migrations at once always conflict. Wave 0 creates **every table in spec §9 "Added in v2"** in one migration, plus the base-spec tables and columns listed in W0 Decisions that the code lacks, so most of the build needs no new migration. Every task states **Migration: yes/no**; "yes" means take the lock. When a session still needs a schema change:

1. Rebase on `origin/main`.
2. Change only your own schema file, run `npm run db:generate -w @club/server -- --name <short_name>` (without `--name`, drizzle-kit gives the file a random name), commit schema + migration alone.
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
- Create: `apps/server/drizzle/0002_v2.sql` (generated with `npm run db:generate -w @club/server -- --name v2`) 
- Create: `apps/server/src/line/credentials.ts`
- Create: `apps/server/src/bot/deps.ts`, `apps/server/src/jobs/index.ts`, `apps/server/src/data/events.ts`, `data/event-types.ts`, `apps/server/src/chat/conversations.ts` (all B-owned after W0; see Interfaces)
- Modify: `apps/server/src/line/gateway.ts`, `line/setup.ts` (the `LoginChannel` type and the `loginChannel` logic move to `line/credentials.ts`), `http/context.ts`, `app.ts`, `http/webhook.ts`, `bot/flow.ts`, `bot/notify.ts`, `http/staff.ts`, `http/liff.ts`, `http/dev.ts` (only for the async gateway, `credentials.channelSecret`, `credentials.login` and `credentials.line`, the new service and `Notifier` signatures with `Actor` and `Reason`, and `buildBotDeps` in `createApp`)
- Modify: `apps/server/src/bookings/service.ts` (signatures, `getBookingViewByRef`, `getDepositForClub`, and `deposits.club_id` set on insert; see below)
- Modify: `apps/server/src/db/seed.ts` (`seedDemoClub` sets `status: 'demo'` and inserts the club's `kind = 'line'` row in `channels`; nothing else)
- Modify: `apps/server/src/main.ts`: replace the 30 s hold sweeper (the `setInterval` block) with `const stopBackground = await startBackground(ctx, () => new Date())`, replace `clearInterval(sweeper)` in `shutdown` with `await stopBackground()`, and delete the staff link code log line
- Modify: `apps/server/test/helpers.ts`, `apps/server/.env.example` (the comment still says "Velour (Demo)"; change to "Velora (Demo)")
- Create: `apps/server/test/fixtures/club.ts` (frozen after W0), `apps/server/test/helpers/track-a.ts`, `apps/server/test/helpers/track-b.ts`
- Modify: `apps/server/test/flow.test.ts`, `test/bookings.test.ts`, `test/live-line.test.ts`: use the `track-a.ts` helpers, so no inline `Config` literal, `/api/staff/login` call or staff URL string remains in a test body
- Test: `apps/server/test/contracts.test.ts`

**Decisions:**
- Table placement. `platform.ts`: `users`, `club_memberships`, `sessions`, `support_grants`, `club_profile`, `club_credentials`, `channels`, `invites(id, club_id, email, role, token_hash, expires_at, accepted_at, created_by)`, `platform_flags(key text PK, value jsonb, updated_by, updated_at)`. `data.ts`: `raw_webhooks`, `events`, `events_dead_letter`, `ops_events`, `occupancy_snapshots`, `door_counts`, `crowd_ratings`, `calendar_days`, `identity_map`, `booking_status_history`, `notices`, `handoff_episodes`, `removal_requests` (§9, §14.9). `brain.ts`: `brain_notes`, `brain_note_versions`, `brain_snapshots`. `core.ts`: existing tables with the §9 `+` columns on `clubs`, `guests`, `messages`, `bookings`, `audit_log`, `tables`. Also create here, because the code lacks them: `pos_bills` (§9 columns plus the v2 `+` columns), `price_rules(id, club_id, scope, scope_id, weekday, night_id, min_spend_satang, deposit_satang, priority, valid_from, valid_to)` and `nights(id, club_id, date, status[open|closed|sold_out], closed_reason, event_type, event_name, lineup jsonb, notes, edited_by, unique (club_id, date))`. `nights` is a base-spec table with its v2 `+` columns; `edited_by` is not in the spec's column list and marks a row a person changed, which the B8b job never overwrites. W0 only creates `nights`: the booking flow keeps reading `ClubSettings.openWeekdays` and `closedDates` until B8b.
- Base-spec columns the code lacks, added in the same migration so later tasks need none: `tables.floor_x, floor_y, shape, valid_from, valid_to`; `deposits.club_id` (not null, references `clubs`; the migration fills it from the booking before the NOT NULL is applied) and `deposits.slip_trans_ref, slip_amount_satang, slip_receiver, slip_time` with a unique index on `(club_id, slip_trans_ref)`; `bookings.reminder_sent_at`; `conversations.external_ref`; `messages.external_id` with a unique index on `(club_id, external_id)`. The existing zone and table price columns stay, and the booking flow keeps reading them until B9b (Phase 1) moves pricing to `price_rules`.
- `users` also gets `failed_login_count int not null default 0` and `locked_until timestamptz` (needed for §13.1 #6; not in the spec's column list).
- `audit_log` (§9): add `actor_type`, `actor_id`, `session_id`, `support_grant_id`, `reason`, `ip`, `before jsonb`, `after jsonb`. Today's table has `actor` and `data` and lacks the base-spec `before` and `after`. Keep `actor` and `data` so today's writers still work. Make `club_id` nullable for platform events (global stop, the platform login channel).
- `messages.processed_at timestamptz` (not in the spec's column list): set as the last step of a completed bot turn, and B3's dedupe reads it. The migration fills it from `created_at` on existing rows. W0 code does not write it yet.
- `clubs.staff_link_code` becomes nullable in `0002_v2.sql` and is never dropped in this build. New code must not set it: `setupTwoClubs` and A5 `POST /api/admin/clubs` leave it null. New columns `staff_link_code_hash text`, `staff_link_code_expires_at timestamptz`, `pending_staff_group_id text` (a new group waiting for its replacement to be confirmed, see B5). B5 stops reading and writing the old column; B5 needs no migration.
- `clubs.status text not null default 'onboarding'` (§9 values `onboarding | live | paused | demo`). The migration sets the existing `club_demo` row to `'demo'`, and `seedDemoClub` sets it on a fresh database. The fixture club (`clubA`) has `status = 'demo'` and `club_test_b` (`clubB`) has `status = 'live'`, so a test that needs a real club uses clubB. `is_test boolean not null default false` goes on `guests`, `bookings` and `events` only (§9). W0 code does not set it; B6 does.
- `clubs.bot_paused_at timestamptz` (not in the spec's column list): set to `now` together with `bot_paused`, null on resume. It identifies one pause, which B3 needs to alert once per pause. A5's pause route sets it.
- `channels` (§9): every club has one `kind = 'line'` row. The migration inserts it for each existing club; `seedDemoClub`, `test/fixtures/club.ts` and `setupTwoClubs` insert it for the clubs they create; A5's `POST /api/admin/clubs` inserts it in the same transaction as the club. `external_id` and `connected_at` are filled by the LINE setup run. `messages.channel_id` is nullable, and B4 writes this row's id on every LINE message.
- `events.seq` is `bigserial`; `events.id` is text; unique `(club_id, dedupe_key)`.
- Keep existing column names and camelCase TS property names in the same style as today's `schema.ts`.
- Test fixture club. `test/fixtures/club.ts` holds today's ten-table club exactly as the existing tests use it: `club_demo`, slug `demo`, tables `table_demo_V1`, `V2`, `B1` to `B4`, `T1` to `T4`, same capacities and prices. `setupDb()` and `setupTwoClubs().clubA` seed this fixture, not `seedDemoClub`, so B7's Velora reseed cannot break either track's tests. Tests that need Velora content (B7 `velora.test.ts`, A16 stats) open their own database with `openDb({ dataDir: 'memory' })` and call `seedDemoClub` themselves.
- `main.ts` keeps its `seedDemoClub` call. All other start-up and background work goes through `startBackground` (below), so B never edits `main.ts` after W0.

**Interfaces (Produces):**
- `export interface CredentialStore { channelSecret(club: Club): Promise<string | null>; line(club: Club): Promise<ClubLineCredentials | null>; login(club: Club): Promise<LoginChannel | null>; }` in `line/credentials.ts`, with `export type LoginChannel = { channelId: string; channelSecret: string; liffId: string | null; shared: boolean }` moved here from `line/setup.ts` (`shared` is true when the channel is the platform's own, see A4b), plus `export function envCredentialStore(env?: NodeJS.ProcessEnv): CredentialStore` (today's `clubCredentials` logic moved here; `login` holds today's `loginChannel` logic, with `liffId: club.liffId` and `shared: false`). `http/liff.ts` and `lineClientsFor` in `http/staff.ts` call `await ctx.credentials.login(club)`. Nothing calls `loginChannel(club)` after W0. The settings route's `lineConnected` becomes `(await ctx.credentials.line(club)) !== null`, so no route reads `process.env[club.*Env]` directly. `channelSecret(club)` returns only the channel secret and never issues a token. `http/webhook.ts` verifies the signature with it and calls `gateways.forClub` only inside the background work, after it has answered, so a signature check never depends on LINE's token endpoint. `envCredentialStore` implements all three.
- `AppContext.credentials: CredentialStore` (`http/context.ts`), built in `createApp` from `opts.credentials ?? envCredentialStore()`.
- `GatewayRegistry` constructor takes `(credentials: CredentialStore)`; `forClub(club: Club, lineUserId?: string | null): Promise<LineGateway>`. All callers `await` it. `forClub` calls `credentials.line(club)` on every call. The registry keeps at most one `RealLineGateway` per club and replaces it when `creds.accessToken` differs from the token the cached gateway was built with. It never caches by `club.id` alone, because A4's tokens last 15 minutes.
- Booking service: every function that loads a booking by id takes the club id and throws `BookingError('not_found')` when the booking belongs to another club:
  `approveDeposit(db, clubId, bookingId, actor: Actor, now)`, `rejectDeposit(db, clubId, bookingId, actor: Actor, reason: Reason, now)`, `cancelBooking(db, clubId, id, actor: Actor, reason: Reason, now)`, `markArrived(db, clubId, id, actor: Actor, now)`, `markNoShow(db, clubId, id, actor: Actor, now)`, `getBookingView(db, where: { clubId: string; id?: string; refCode?: string })`, and the private `transition(db, clubId, bookingId, from, to, actor: Actor, now, reason?: Reason)`. `submitDetails`, `requestDeposit`, `recordSlip` already take `club` and must also check `booking.clubId === club.id`. `requestDeposit` and `recordSlip` set `deposits.club_id` on insert.
- `getBookingViewByRef(db, refCode: string): Promise<BookingView | undefined>` in `bookings/service.ts` is the only unscoped booking lookup (`ref_code` is globally unique). It is allowed only in a route that has first verified a signed link: `load` in `http/liff.ts`, and `http/media.ts`. The caller takes the club from `view.booking.clubId`. Every other caller passes `clubId`.
- Scoped lookups for the other two ids a staff route takes: `getDepositForClub(db, clubId: string, id: string): Promise<Deposit | undefined>` in `bookings/service.ts` and `getConversationForClub(db, clubId: string, id: string): Promise<Conversation | undefined>` in `chat/conversations.ts` (owner B after W0). Both filter on `club_id` and `id` together. A2 uses them.
- `Notifier` takes the club id from its caller: `confirmed(clubId: string, bookingId: string)`, `rejected(clubId, bookingId)`, `cancelled(clubId, bookingId, reasonText: string)` (the free text shown to the guest, not a code), `hostReply(clubId: string, guestId: string, text: string, actor: Actor)` and the private `ctx(clubId, bookingId)`. `holdExpired(booking: Booking)` keeps its signature and uses `booking.clubId`. Each returns without sending when the booking or guest belongs to another club. Callers pass `turn.club.id` (flow), the club the staff route loaded, or `view.booking.clubId` (`pushReview` in `http/liff.ts`).
- `export type Actor = { type: 'guest' | 'bot' | 'staff' | 'platform' | 'system'; id?: string; sessionId?: string; supportGrantId?: string }` exported from `bookings/service.ts`. Every `actor` parameter takes `Actor`, not `string`: the functions above plus `createManualBooking` and the private `audit`. Until B2 lands, `audit()` writes `actor.type` to the old `actor` column and to `actor_type`, plus `actor_id`, `session_id`, `support_grant_id`. `Notifier.hostReply` takes an `Actor` too (signature in the `Notifier` bullet above). W0 call sites pass `{ type: 'staff' }`, `{ type: 'guest' }` or `{ type: 'system' }`; A2 fills in the ids.
- `export const REASON_CODES = ['hold_expired', 'guest_abandoned', 'guest_cancelled', 'club_cancelled', 'payment_not_verified', 'table_taken', 'released', 'other'] as const`, `export type ReasonCode = (typeof REASON_CODES)[number]` and `export type Reason = { code: ReasonCode; text?: string }`, exported from `bookings/service.ts` beside `Actor`. Every `reason` parameter of the booking functions above takes `Reason`, not `string`. `reason.code` is the only part that may reach `events.props` (B1 rejects free text there). `reason.text` is free text of up to 200 characters; it goes to `bookings.status_reason` and, from B2, to `audit_log.reason` and `events.raw`. W0 call sites in `http/staff.ts` keep today's free-text body field and pass `{ code: 'payment_not_verified', text }` for reject and `{ code: 'club_cancelled', text }` for cancel. Paths with no caller-supplied reason (hold expiry, abandon) set their own code. A new code is a change to a frozen contract (sync file first).
- `bot/deps.ts` (owner B after W0): `export interface BotDepOptions { now?: () => Date; log?: BotDeps['log'] }` and `export function buildBotDeps(config: Config, db: Db, opts?: BotDepOptions): BotDeps` (today's `deps` literal from `createApp`, moved here). `createApp` gains `opts.bot?: BotDepOptions` and calls `buildBotDeps(config, db, opts.bot)`. B adds every later dependency and its test fake (B9 `SlipVerifier`, B16 Anthropic client and cost cap) to `BotDeps`, `BotDepOptions` and `buildBotDeps` only; B never edits the `createApp` body for a dependency.
- `jobs/index.ts` (owner B after W0): `export function startBackground(ctx: AppContext, now: () => Date): Promise<() => Promise<void>>` (returns a stop function). W0 body: the existing 30 s hold sweeper moved from `main.ts`. B2 and B3 replace the body; `main.ts` does not change again.
- `data/event-types.ts` and `data/events.ts` (owner B after W0), so Track A can call `emit` before B1 merges. `export const EVENT_TYPES = [...] as const` holds every event name in the spec §14.2 table verbatim, plus `booking.status_changed`; `export type EventType = (typeof EVENT_TYPES)[number]`. `EventInput` and `emit(tx: Db, e: EventInput, opts?: { strict?: boolean }): Promise<void>` have the signature written in B1 Interfaces. W0 body: one insert with `ON CONFLICT (club_id, dedupe_key) DO NOTHING`. B1 adds versions, props keys, privacy classes, validation and the dead letter without changing the signature.
- `test/helpers.ts`: `setupTwoClubs(): Promise<{ db, close, clubA: Club, clubB: Club }>` where `clubA` is the fixture club (`test/fixtures/club.ts`, `status = 'demo'`) and `clubB` is a second club `club_test_b`, slug `test-b`, `status = 'live'`, with two zones and four tables of its own. Each has its `kind = 'line'` row in `channels`. `setupDb()` seeds the same fixture club. `makeGuest(db, opts?: { clubId?: string; lineUserId?: string })` replaces today's `makeGuest(db, lineUserId?)`, with the fixture club as the default; update the existing call sites.
- `test/helpers/track-a.ts` (owner A): `testConfig(overrides?: Partial<Config>): Config`, `staffCookie(app, club: Club): Promise<string>`, `staffUrl(slug: string, path: string): string`, `adminCookie(app): Promise<string>`. W0 bodies keep today's behaviour: shared-password login, `/api/staff<path>`, and `adminCookie` returns the staff cookie because no admin account exists yet. A1 changes the two cookie helpers, A2 changes `staffUrl`, A3 changes `testConfig`.
- `test/helpers/track-b.ts` (owner B after W0): `isolationFixtures(db, club: Club): Promise<Record<string, string>>`, returning `{}` in W0 (see A2).

**Tests (`contracts.test.ts`):**
- `migrations create every v2 table`: query `information_schema.tables`; expect each table name listed above present, including `price_rules`, `pos_bills`, `invites`, `nights` and `removal_requests`. Query `information_schema.columns`; expect each base-spec column listed in Decisions present.
- `approveDeposit with a staff Actor writes actor_type and actor_id to audit_log`.
- `cancelBooking takes a Reason and stores reason.text in status_reason`.
- `markArrived refuses a booking of another club`: book a table in clubB, call `markArrived(db, clubA.id, booking.id, ...)`; expect `BookingError` with `code === 'not_found'` and the booking status unchanged.
- `getBookingView scoped by club`: same booking, `getBookingView(db, { clubId: clubA.id, id })` returns `undefined`.
- `getConversationForClub and getDepositForClub return undefined for another club's id`.
- `every core table except clubs has a club_id column` (query `information_schema.columns`), so `deposits` cannot be missed again.
- `migration marks club_demo as demo and gives every existing club a line row in channels`; a club inserted with no status gets `onboarding`.
- `notifier does not send for another club's booking`: `notifier.confirmed(clubA.id, bookingOfB.id)` writes no outbound `messages` row.
- `registry rebuilds the gateway when the token changes`: a fake `CredentialStore` returns token `t1`, then `t2`; the second `forClub` returns a different gateway instance, and the same token twice returns the same instance.
- `env credential store reads the club's env names`: a club with `lineChannelSecretEnv = 'X_SECRET'` and env `{ X_SECRET: 's', ... }` returns `{ channelSecret: 's', accessToken: ... }`; missing env returns `null`.
- `env credential store channelSecret() needs only the secret env`: a club whose access-token env is missing still returns the secret, and `line()` returns `null`.
- `env credential store login() reads the club's login env names`: a club with `lineLoginChannelIdEnv` and `lineLoginChannelSecretEnv` set and both present in env returns the channel with `shared: false` and the club's `liffId`; missing env returns `null`.
- `emit stub writes one events row and ignores a repeated dedupe_key`.
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

**Tests:** `every table code is unique`; `every table belongs to a declared zone`; `every FAQ has non-empty Thai and English`; `gap questions do not appear in faqs`; `prices are integers in satang`; `applyClubContent writes tables and prices for a new club id` (in `apply-content.test.ts`: on a new club inserted next to `setupTwoClubs()`, because `clubB` already has tables V1, V2, S1 and S2, which Velora reuses; the test checks that `clubB` stays untouched).

**Migration:** no.

Also: run `npm install`, `npm test`, `npm run typecheck`; fix anything that fails on a clean checkout and note it in `sync/track-b.md`.

---

## Phase 1b: Platform base (before any real club)

Gate (spec §10, §17.1): a second club is created from the console and takes a signed webhook with no deploy; isolation tests pass; the nightly check finds every booking state change in `events`; the Phase 1b steps of the Velora demo script run (checklist at the end of this phase; the whole script is a Phase 2 gate item, §17.1); all §13.1 fixes closed.

### Track A, Phase 1b

#### Task A1: Per-person accounts, server-side sessions, second factor

**Spec:** §4, §12.3 "Who can use it", §13 Security, §13.1 #4 #5 #6.

**Files:**
- Create: `apps/server/src/platform/passwords.ts`, `platform/sessions.ts`, `platform/totp.ts`, `http/auth.ts`, `src/scripts/create-admin.ts`
- Modify: `http/staff.ts` (remove shared-password login), `apps/server/package.json` (script `admin:create`), `apps/web/src/pages/staff/Login.tsx`
- Modify: `apps/server/src/scripts/live.ts` (`npm run live`, the go-live path: it signs in with `STAFF_PASSWORD` at `POST /api/staff/login` today), `README.md`, `docs/LINE-SETUP.md`, `apps/server/.env.example` (replace the `STAFF_PASSWORD` steps with `npm run admin:create` and email login)
- Modify: `apps/server/test/helpers/track-a.ts` (`staffCookie` creates a manager user for the club and logs in through `POST /api/auth/login`; `adminCookie` logs in a platform admin with TOTP), `apps/server/test/flow.test.ts` (listed shared edit: replace the `/api/staff/login` 401 assert)
- Test: `apps/server/test/auth.test.ts`, `apps/server/test/totp.test.ts`

**Decisions:**
- Passwords: `node:crypto` `scrypt` with a 16-byte random salt, stored as `scrypt$N$r$p$salt$hash` (base64). Compare with `timingSafeEqual`.
- Session id: 32 random bytes, base64url, sent in an `httpOnly`, `SameSite=Lax`, `Secure` (when `PUBLIC_URL` is https) cookie named `sid`. The database stores only `sha256(sid)` in `sessions.id_hash`. Staff sessions last 12 hours; platform-admin sessions 8 hours. Logout sets `revoked_at`.
- Login limit per account: after 5 failures, `locked_until = now + 2^(failures-5) minutes` capped at 60 minutes. The response is the same `invalid_login` for unknown email, wrong password and locked account (no account probing).
- TOTP (RFC 6238, SHA-1, 30 s, 6 digits, ±1 step) required at login for `platform_role = 'admin'`. Managers optional later.
- `npm run admin:create -w @club/server -- --email a@b --name "X"` prints a generated initial password and a TOTP otpauth URL once. Nothing forces a change of that password: Phase 1b has no password-change route (it comes with A8 and the staff login method decision).
- `create-admin.ts` also takes `--club <slug> --role <role>`: it then creates a club member with that role and no TOTP, not a platform admin. `live.ts` signs in through `POST /api/auth/login` with `LIVE_EMAIL` and `LIVE_PASSWORD` from `.env` (an owner of the demo club made with that command), and stops with a message naming the command when they are missing. It keeps calling the line-setup route over HTTP: the dev server it spawns already has the PGlite data directory open, so the script cannot open the database itself.
- Emits `staff.login` (§14.2) with `emit` (W0 stub, B1 body) in the same transaction as the session insert: one event per club the user is a member of, none for a platform admin with no membership. Every Track A `emit` call passes `dataOrigin: 'first_party'` and `isTest: club.status === 'demo'`. The B4b table lists which task owns each event.

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
- `› login emits staff.login for the user's club`.
- `› create-admin with --club and --role makes a club member who can log in without totp`.

**Check:** `npm run live` reaches the LINE setup report with no `STAFF_PASSWORD` in `.env`.

**Migration:** no.

#### Task A2: Club check on every route

**Spec:** §12.1, §13.1 #4 #8, §17.1 Security.

**Files:**
- Modify: `http/staff.ts` (all routes move under `/api/staff/clubs/:slug/...`, including `bookings/:id`, `conversations/:id`, `deposits/:id/slip`; use `requireClubRole`), `apps/web/src/api.tsx`, `apps/web/src/pages/staff/*.tsx` (new URLs)
- Create: `apps/server/test/isolation.test.ts`
- Test helper: `apps/server/test/helpers/track-a.ts` (created in W0) gains `loginAs(app, user): Promise<string /* cookie */>`, `makeUser(db, { email, clubId?, role?, platformAdmin? })`, `routeTable` and `isolationFixtures` (see Interfaces). `staffUrl(slug, path)` changes to return `/api/staff/clubs/<slug><path>`, so B's test files need no edit

**Decisions:** Roles allowed per route: night view, bookings, handoffs, alerts: `owner|manager|host|door`; deposit approve/reject and settings: `owner|manager`; line-setup: `owner|manager` (credential changes are console-only, A4/A5). Every id lookup uses a club-scoped function from W0: the booking functions, `getConversationForClub` and `getDepositForClub`. `conversations/:id/resolve`, `conversations/:id/reply` and `deposits/:id/slip` call the helper first and answer 404 when it returns `undefined`; `resolve` also keeps `club_id` in its UPDATE. No route file has a `findFirst` or UPDATE by id alone. Staff routes build `Actor` from `c.var.user`: `{ type: 'staff', id: user.id, sessionId }`, or `{ type: 'platform', id: user.id, sessionId, supportGrantId }` under a support grant (A5). They pass it to every booking-service call and to `notifier.hostReply`, and pass `c.var.club.id` to every `Notifier` call (W0 signatures). The reject and cancel actions accept an optional `reasonCode` (one of `REASON_CODES`) beside the free-text `reason` and build the W0 `Reason` from both; the defaults stay `payment_not_verified` and `club_cancelled`. Events (owners per the B4b table): `GET bookings/:id` emits `staff.booking_viewed`, `GET deposits/:id/slip` emits `staff.slip_viewed`, and `conversations/:id/resolve` emits `handoff.resolved` until A14 moves that route to `endEpisode`.

**Row-level security (§12.1 "the backup"):** assumed deferred; see "Decisions the human must make". The service-layer check plus the isolation suite are the Phase 1b control. If the human chooses to build it, it is Task A2b, straight after A2: Postgres policies on every table that carries `club_id`, with the app setting `app.club_id` per transaction, shipped as a custom migration under the migration lock. Test: `rls.test.ts › a query with app.club_id set to clubA returns no clubB rows`. It touches every query path of both tracks, so agree it in the sync files before starting.

**Interfaces (Produces):**
- `export function routeTable(app: Hono, prefix: string): { method: string; path: string }[]` in `test/helpers/track-a.ts`. It reads the **root** app's `app.routes`, keeps paths under `prefix`, drops middleware `ALL` entries and dedupes. Tests compute `STAFF_ROUTES = routeTable(createApp(...).app, '/api/staff')` and, from A5, `ADMIN_ROUTES = routeTable(app, '/api/admin')`. Routers that B mounts under these prefixes (`http/demo.ts`, the admin simulator, `http/door.ts`, `http/brain.ts`) are therefore walked too. Nothing is exported from `http/staff.ts`. `/media/*` and `/api/liff/*` are public signed-link routes (B-owned): they sit outside both prefixes, are exempt from the session club check, and take the club from the booking that the signed link names (`getBookingViewByRef`, W0).
- `isolationFixtures(db, club: Club): Promise<Record<string, string>>`, one in `test/helpers/track-a.ts` and one in `test/helpers/track-b.ts`. Each maps a key to the id of a row that belongs to that club. The key is the path segment before the param plus the param, because `:id` names a booking, a conversation or a deposit depending on the route: `bookings/:id`, `conversations/:id`, `deposits/:id`, and one key for every new param. Each track adds the fixtures for the params of its own routes.

**Tests (`isolation.test.ts`):**
- `own slug with another club's id returns 404`: with `setupTwoClubs`, create one booking, conversation and deposit in clubB (plus whatever the merged `isolationFixtures(db, clubB)` of both tracks adds). Log in as a clubA manager. For each entry in `STAFF_ROUTES` that has a param besides `:slug`, substitute `:slug` with clubA's **own** slug and every other param with clubB's id for it (chosen by the fixture key, see Interfaces); expect 404 for every one, and clubB's rows unchanged (booking status, conversation mode, no outbound message, no slip bytes in the response). This is the pass that reaches the id check: with clubB's slug, `requireClubRole` answers 403 before any id lookup runs, so a route that looks up by id alone would pass. Once A5 lands, the same pass runs over every `ADMIN_ROUTES` entry that has both `:slug` and another param, as a platform admin (`adminCookie`), with `:slug` = clubA's slug and clubB's ids; expect 404.
- `another club's slug returns 403`: the same manager, `:slug` = `test-b` and clubB's ids, on every `STAFF_ROUTES` entry; expect 403 for every one, and clubB's rows unchanged. (A club manager on an `ADMIN_ROUTES` entry is covered by `admin.test.ts › non-admin gets 403 on every ADMIN_ROUTES entry`, A5.)
- Both tests fail on any route param with no fixture, so a new route cannot pass silently. They also fail on any `/api/staff` path that has no `:slug`, unless the path is in an explicit allowlist in the test file.
- `own club still works`: the same manager on clubA's slug gets 200 on the night view.
- `no session → 401` on every route in `STAFF_ROUTES`.
- `viewing a booking and a slip emits staff.booking_viewed and staff.slip_viewed` (in `apps/server/test/staff-events.test.ts`).

**Check:** typecheck; walk the staff pages (night view, a booking, a slip, Chats, Settings) logged in as a club user made with `npm run admin:create -w @club/server -- --email <email> --name <name> --club demo --role manager` (A1). No support session is needed for this walk.

**Migration:** no.

#### Task A3: Safe configuration

**Spec:** §13.1 #2.

**Files:** Modify `apps/server/src/config.ts`, `.env.example`, `apps/server/test/helpers/track-a.ts` (`testConfig` drops `STAFF_PASSWORD` and adds a test `CREDENTIALS_KEY`; no test body changes). Test: `apps/server/test/config.test.ts`.

**Decisions:** `loadConfig` throws when `APP_SECRET` equals the example value or is shorter than 32 characters, and when `NODE_ENV !== 'development' && NODE_ENV !== 'test'` and `DEV_SIMULATOR` is on. `STAFF_PASSWORD` is removed (A1 already moved `scripts/live.ts`, `README.md` and `docs/LINE-SETUP.md` off it; nothing may still read it). New keys: `CREDENTIALS_KEY` (base64 of 32 bytes; required unless `NODE_ENV` is `development` or `test`), `ANTHROPIC_API_KEY` (optional until Phase 2), `LINE_FAKE` (boolean, default off; refused unless `NODE_ENV` is `development` or `test`, the same rule as `DEV_SIMULATOR`; A4 reads it). In `development` and `test`, when `CREDENTIALS_KEY` is unset, `loadConfig` sets it to `sha256('credentials:' + APP_SECRET)` (32 bytes), so the key is always present and `setClubCredential` works in a local console; production still refuses a missing key. `NODE_ENV` default stays `development`; `npm start` sets `NODE_ENV=production` in the `start` script. `loadConfig` is the only place that holds the "`DEV_SIMULATOR` only in development or test" rule; B8 reads `config.DEV_SIMULATOR` and adds no `NODE_ENV` check.

**Tests:** `refuses the example APP_SECRET`; `refuses DEV_SIMULATOR outside development and test`; `refuses missing CREDENTIALS_KEY in production`; `accepts a valid production config`; `derives a development credentials key from APP_SECRET`; `refuses LINE_FAKE outside development and test`.

**Migration:** no.

#### Task A4: Encrypted club credentials and stateless LINE tokens

**Spec:** §11.1.2, §12.3 Onboarding, §13 Security.

**Files:**
- Create: `apps/server/src/platform/crypto.ts`, `platform/credentials.ts`, `line/tokens.ts`
- Modify: `line/credentials.ts` (add DB store), `app.ts` (use DB store, env store only as dev fallback for the demo club; the fake issuer and fake setup clients when `config.LINE_FAKE`), `line/setup.ts` (`fakeSetupClients`), `line/gateway.ts` (only if the W0 registry does not already rebuild the gateway on a token change)
- Test: `apps/server/test/credentials.test.ts`

**Decisions:**
- AES-256-GCM, 12-byte random IV, ciphertext stored as `v1:iv:tag:data` (base64), `key_ref = 'env:CREDENTIALS_KEY:v1'` so the key can be rotated later.
- LINE Messaging credentials stored as one JSON secret `{ channelId, channelSecret }`. The access token is **never stored**: `line/tokens.ts` issues a stateless token with `POST https://api.line.me/oauth2/v3/token` (`grant_type=client_credentials`, `client_id`, `client_secret`) and caches it in memory per club for 10 minutes (§11.1.2: valid 15 minutes, cached about 10, so a cached token always has minutes left for a send in flight).
- Writes record `last4`, `set_by`, `set_at` and an `audit_log` row with before/after `last4` only.
- The 10-minute cache lives only in `line/tokens.ts`. `GatewayRegistry` holds no token lifetime of its own: it follows whatever `CredentialStore.line()` returns (W0). `setClubCredential` clears that club's cached token, so a console change applies on the next message.
- `dbCredentialStore.channelSecret(club)` decrypts the stored secret and never calls the issuer (W0 contract). Tests need no new `createApp` option for a fake issuer: they pass `opts.credentials = dbCredentialStore(db, key, fakeIssuer)`.
- `dbCredentialStore.login(club)` must exist for the W0 interface. In A4 it returns `fallback.login(club)` when a fallback is given, else `null`. A4b replaces it with the real order (the club's own `line_login` credential, then the platform channel).
- Local fake LINE: when `config.LINE_FAKE` is on (A3), `createApp` uses `fakeLineTokenIssuer()` (returns `fake-token`) and `fakeSetupClients` (every setup step reports green), so the console wizard can be walked with made-up credentials and no LINE account. A3 refuses the flag outside development and test.

**Interfaces (Produces):**
- `encryptSecret(plain: string, key: Buffer): string`, `decryptSecret(blob: string, key: Buffer): string`
- `setClubCredential(db, key: Buffer, input: { clubId: string; kind: 'line_messaging' | 'line_login' | 'instagram' | 'pos'; secret: object; setBy: string }, now: Date): Promise<{ last4: string; setAt: Date }>`
- `credentialSummary(db, clubId): Promise<{ kind: string; last4: string; setBy: string; setAt: Date }[]>`
- `dbCredentialStore(db, key: Buffer, tokens: LineTokenIssuer, fallback?: CredentialStore): CredentialStore`
- `interface LineTokenIssuer { accessToken(channelId: string, channelSecret: string): Promise<string> }`, `realLineTokenIssuer(fetchImpl?: typeof fetch): LineTokenIssuer`, `fakeLineTokenIssuer(): LineTokenIssuer` (both in `line/tokens.ts`), and `fakeSetupClients` in `line/setup.ts` with the same shape as `realSetupClients`

**Tests:**
- `encrypt round trip and tamper detection`: decrypt(encrypt(x)) = x; flipping one byte of the data throws.
- `stored row contains no plaintext`: after `setClubCredential`, `club_credentials.ciphertext` does not contain the secret string.
- `store returns the channel secret and a token from the issuer` (fake issuer).
- `token cached for 10 minutes`: two calls within 10 min → issuer called once; at 11 min → twice.
- `gateway uses a new token after the 10-minute cache expires`: fake issuer and clock; `forClub` at t=0 and at t=11 min returns gateways built with different tokens.
- `credential change replaces the gateway`: after `setClubCredential` with a new channel secret, the next `forClub` uses a token issued from the new secret.
- `webhook signature check does not call the issuer`: the fake issuer throws; a correctly signed webhook is not refused at the signature step (no 401), and a badly signed one is.
- `LINE_FAKE selects the fake issuer and fake setup clients`: with the flag on, asking for a token makes no call to `api.line.me` (a fetch stub fails the test if called).
- `settings shows lineConnected for a club whose credentials are only in the database` (no env var set).
- `no admin or staff response body contains a stored secret`: test hook in `createApp` (`opts.onResponse`) collects every JSON body in the admin and staff suites; none contains any secret set in the suite. Add this hook in this task and use it in A5's tests.

**Migration:** no.

#### Task A4b: Shared LIFF and platform login channel

**Spec:** §11.1.1, §12.1 ("no environment variable"), §13.1 #7, §17.1 Onboarding.

**Files:**
- Create: `apps/server/src/platform/login-channel.ts`
- Modify: `line/credentials.ts` (`dbCredentialStore.login`), `line/setup.ts` (`runLineSetup` skips the LIFF endpoint step for a shared channel)
- Test: `apps/server/test/shared-liff.test.ts`

**Decisions:**
- One LINE Login channel and one LIFF app under **our own provider** serve every club, so a console-created club needs no login channel, no LIFF app and no env var. The human creates the channel and the LIFF app once in the LINE Developers Console (see "Decisions the human must make").
- The platform channel `{ channelId, channelSecret, liffId }` is stored once, encrypted with the A4 scheme, in `platform_flags['line_login']` as `{ ciphertext, key_ref, last4, set_by, set_at }`. No new table.
- `dbCredentialStore.login(club)` resolves in this order: the club's own `line_login` credential (`shared: false`, `liffId: club.liffId`; the per-club option of §11.1.1); else the platform channel (`shared: true`, `liffId` = the platform LIFF id); else `fallback.login(club)` (the env store, for the dev demo club only); else `null`.
- `clubs.liff_id` holds the LIFF id that the club's links use, so `bot/links.ts` keeps its synchronous `club.liffId` read. A5's `POST /api/admin/clubs` sets it to the platform LIFF id. Saving the platform channel fills it on every club that has `liff_id` null and no own `line_login` credential. A club that adds its own login channel overwrites it.
- The shared LIFF endpoint URL is set once, when the platform channel is saved. `runLineSetup` skips the per-club "Booking form (LIFF)" endpoint step when `login.shared` is true. The club is carried in the link (`club=<slug>`, already there).
- With a shared channel the ID token's `sub` is our provider's id, not the id the club's webhook sees, so the direct `sub === lineUserId` compare would refuse every real guest. The first-use pair check that replaces it is B5's (`linkLiffSub`).

**Interfaces (Produces):**
- In `platform/login-channel.ts`: `setPlatformLoginChannel(db, key: Buffer, input: { channelId: string; channelSecret: string; liffId: string; setBy: string }, now: Date): Promise<{ last4: string; setAt: Date }>`, `platformLoginChannel(db, key: Buffer): Promise<LoginChannel | null>`, `platformLoginSummary(db): Promise<{ liffId: string; last4: string; setBy: string; setAt: Date } | null>`.
- `dbCredentialStore(...).login(club)` as decided above (the signature is W0's).

**Consumes:** `CredentialStore.login` and `LoginChannel` (W0), `encryptSecret` / `decryptSecret` and `setClubCredential` kind `line_login` (A4). A5 adds the routes; B5 consumes `login()`.

**Tests (`shared-liff.test.ts`):**
- `platform login channel round trip, and the stored value holds no plaintext`.
- `club with no own login credential resolves the platform channel with shared true`.
- `club with its own line_login credential uses it over the platform one`.
- `no platform channel and no own credential returns null`.
- `saving the platform channel fills liff_id on clubs that have none`.
- `runLineSetup skips the LIFF endpoint step for a shared channel`.

**Migration:** no (`platform_flags` and `club_credentials` come from W0).

#### Task A5: Founder console API v1

**Spec:** §12.3 (all), §12.2 "On the call" steps 4–6, §17.1 Founder console.

**Files:**
- Create: `apps/server/src/http/admin/index.ts` (router, `requirePlatformAdmin` on all), `admin/clubs.ts`, `admin/line-wizard.ts`, `admin/support.ts`, `admin/debug.ts`, `admin/controls.ts`, `admin/data.ts`, `admin/platform.ts`, `apps/server/src/platform/support.ts`, `platform/health.ts`, `platform/club-templates.ts`
- Modify: `app.ts` (mount `/api/admin`), `http/auth.ts` (support grants in `requireClubRole`)
- Test: `apps/server/test/admin.test.ts`, `apps/server/test/support.test.ts`

**Decisions:**
- **Clubs:** `GET /api/admin/clubs` returns per club: status, LINE connected, webhook endpoint matches and active (from the club's newest `ops_events` row with `kind = 'line_setup'`; no row means not connected), last inbound message time, `ops_events` failures in last 24 h, quota used (`detail.quota` of the same row; `warn` at 80%, §11.1.4), handoffs past timeout, deposits in review, `bot_paused`. `POST /api/admin/clubs {name, slug, template: 'blank' | 'velora-like'}` creates status `onboarding`. `PATCH /api/admin/clubs/:slug {status}`. `velora-like` calls B0's `applyClubContent(tx, newClubId, VELORA)` in the same transaction as the club insert; `blank` adds no zones, tables or prices. Both templates write a complete `ClubSettings`, because `clubs.settings` is NOT NULL: `newClubSettings(slug: string, now: Date): ClubSettings` in `platform/club-templates.ts` is a literal that starts from today's operating values in `db/seed.ts` (`openWeekdays` Wed to Sat, `bookingWindowDays` 30, `holdMinutes` 10, night 18 to 6, `arrivalBy` '23:30', `handoffTimeoutMinutes` 30, the same accent colour, `rulesVersion` = the creation date) with empty `rules`, `greeting`, `address` and `mapUrl`, which the founder or the manager fills before go-live. The club id is `'club_' + newId()`. `refPrefix` is the first three letters of the slug in upper case, with a digit added when another club already uses that prefix. The insert also adds the club's `kind = 'line'` row in `channels` (W0). The insert does not set `staff_link_code` (nullable since W0). A founder links a club's staff group by opening a write-mode support session and using the staff route from B5. The insert sets `clubs.liff_id` to the platform LIFF id (A4b; null when no platform channel is saved yet). `PUT /api/admin/clubs/:slug/profile` writes `club_profile` (§9 columns: capacity standing and seated, location, district, venue type, genres, price band, opening hours, usual peak hour, licence type, POS vendor); it is the only writer before A9 and A17. `PATCH {status: 'live'}` answers 409 `profile_missing` when the club has no profile row (§14.3 "the club itself"), and 409 `login_not_configured` when `clubs.liff_id` is null or `credentials.login(club)` returns `null`, because B5 would refuse every real guest of that club.
- **LINE wizard backend:** `POST /api/admin/clubs/:slug/line {channelId, channelSecret}` stores credentials (A4), then runs the existing `runLineSetup` (tokens, webhook set + test, rich menu, message check, quota) and returns its `SetupReport`. After each run, and on each `GET .../line/status`, it writes one `ops_events` row with `kind = 'line_setup'` and `detail = { report: SetupReport, quota: { used: number; limit: number } | null }` (through B's `recordOps` once B3 is merged; a direct insert until then). The health tile reads the newest row. `GET .../line/status` re-checks for the manual switches (§12.2 minute 6–8) so the wizard can show each one going green. Requires a fresh TOTP code in the body (credential change, §12.3). The body also takes optional `{ loginChannelId, loginChannelSecret, liffId }` for a club that wants its own login channel (§11.1.1); they are stored as kind `line_login` and `liffId` overwrites `clubs.liff_id`. `GET .../line/status` returns `{ webhookActive: boolean; chatMode: string; quota: { limit: number; used: number; pct: number; warn: boolean }; planCheck: { expectedMonthlyPushes: number; recommendUpgrade: boolean }; liveTest: 'pending' | 'pass' | 'fail' }`. `quota.warn` is true from 80% used. `expectedMonthlyPushes` = expected bookings a month × 2 pushes + host replies sent from the inbox + staff-group alerts × group size (§11.1.2 step 6); the wizard sends the inputs as query params. `POST .../line/live-test` opens a 60 s window: `liveTest` is `pass` when one inbound message in the window has exactly one outbound message, `fail` when it has none, `pending` otherwise. LINE's own auto-reply never reaches our webhook, so the wizard also asks the admin to confirm on the phone that exactly one reply arrived (§11.1.2 step 4). `POST /api/admin/clubs/:slug/tester-code` returns B6's `issueTesterCode` result once, for the live test on the call (§12.2) as `{ code, expiresAt }` (B6 merged).
- **Support sessions:** `POST /api/admin/support {clubSlug, reason, ticketRef?}` creates a `support_grants` row, mode `read`, expires in 60 min. `POST /api/admin/support/:id/elevate {reason}` sets mode `write`. `POST /api/admin/support/:id/end`. `requireClubRole` accepts an active, unexpired grant for that club; write methods (POST/PATCH/DELETE) need mode `write`. **Every request** made under a grant writes an `audit_log` row with `support_grant_id`, reason, method, path and entity ids (views included). The response carries header `X-Support-Session: <club name>, ends <HH:MM>` for the banner.
- **Debug (read-only, reads Track B tables; every path here is under `/api/admin/clubs/:slug`):** `GET .../webhooks?limit&before` (`raw_webhooks` + processing result), `.../messages` (with `delivery_status`, `error`), `.../conversations/:id/timeline` (messages, events, booking changes, ordered by time), `.../bookings/:id/timeline` (`booking_status_history`), `POST .../webhooks/:id/replay` (calls B's `processDelivery(ctx, rawId, { dryRun: true })`, B3; the response shows the dry run's `replies` even when the delivery was already processed), `POST .../test-message {to: 'self' | 'staff_group'}`.
- **Controls:** `POST /api/admin/clubs/:slug/pause {paused: boolean}` sets `clubs.bot_paused` and `bot_paused_at` (`now` on pause, null on resume; W0 column) and sends one "bot paused" or "bot resumed" notice to the staff group; `POST /api/admin/global-stop {stopped}` sets `platform_flags['global_stop']`. PromptPay ID, greeting/map link and LINE credentials changes need a fresh TOTP, record before/after, and notify the club's owner: one message to the staff LINE group, plus the `audit_log` row. This build has no separate in-account notice.
- **Platform login channel (A4b):** `POST /api/admin/platform/line-login {channelId, channelSecret, liffId}` calls `setPlatformLoginChannel`; it needs a fresh TOTP and writes an `audit_log` row with `last4` only. `GET /api/admin/platform/line-login` returns `platformLoginSummary`, never the secret.
- **Data (read-only, reads Track B tables; §14.6):** `GET /api/admin/data/health` returns per club: events per day, time of the last event, rejected events (`events_dead_letter`, club read from the payload), share of guests with a `notices` row, pending `removal_requests`. `GET /api/admin/events?club&conversation&booking&guest&before&limit` returns the filterable event stream, newest first; the page polls it.
- **Events:** `club.created`, `line.setup_run`, `support.session_started` and `support.session_ended` are written with `emit` in the same transaction as the change (owners per the B4b table).

**Interfaces (Produces):** no route list export: tests compute `ADMIN_ROUTES = routeTable(app, '/api/admin')` (A2), which also walks B's routers under `/api/admin`; `isGloballyStopped(db): Promise<boolean>` in `platform/support.ts` (B3 calls it).

**Consumes:** `processDelivery` (B3): if B3 is not merged yet, ship replay last within this task or as A5b. `raw_webhooks` write (B3): until B3 merges, the gate test asserts 200 and an inbound `messages` row for the new club; keep the `raw_webhooks` assertion as `it.todo` and enable it when B3 merges. `applyClubContent` (B0) for `template: 'velora-like'`. `issueTesterCode` (B6) for the tester-code route. `recordOps` (B3) for the `line_setup` rows; a direct insert until B3 merges.

**Tests:**
- `admin.test.ts › non-admin gets 403 on every ADMIN_ROUTES entry`.
- `› create club then receive a signed webhook with no restart`: create club via API, set credentials via API with a fake LINE setup client, POST a correctly signed webhook to `/line/webhook/<new slug>` → 200 and a `raw_webhooks` row for that club. (This is the Phase 1b gate test. The `raw_webhooks` assertion needs B3; see Consumes.)
- `› credential change needs fresh totp`: without code → 401 `totp_required`.
- `support.test.ts › grant expires after 60 minutes` (inject `now`): staff route on that club → 200 at 59 min, 403 at 61 min.
- `› read-only grant cannot write`: POST approve deposit → 403 `support_read_only`; after elevate → 200.
- `› every request under a grant is audited`: GET night view under a grant → one `audit_log` row with `support_grant_id` and the reason.
- `› pause route sets bot_paused_at, clears it on resume, and sends one notice to the staff group each time`.
- `› pause stops replies within one message`: set `bot_paused` and `bot_paused_at` directly in the database (not through the route, whose own notice is a staff-group message too), then send two signed text webhooks from one guest → two inbound messages stored, no outbound guest message, exactly one staff alert. (Needs B3's pause check; mark `it.todo` until B3 merges, then enable.)
- `› console-created club has the shared liff_id and a resolvable login channel with no env var set` (A4b).
- `› console-created club: details read with a valid ID token is 200, with no token it is refused`. (Phase 1b gate item. Needs B5; mark `it.todo` until B5 merges, then enable.)
- `› line/status reports the webhook switch and chat mode from the fake LINE client`.
- `› live test passes on one inbound with one outbound, fails on none`.
- `› plan check recommends an upgrade when expected pushes exceed the plan limit; quota.warn is true at 80% used`.
- `› club cannot go live without a profile`.
- `› club cannot go live without a LIFF id and a resolvable login channel` (409 `login_not_configured`).
- `› one guest message is traceable end to end` (§17.1 Founder console): signed text webhook, then `GET .../conversations/:id/timeline` shows the inbound raw webhook with its processing result and the outbound message with `delivery_status`. (Needs B3; `it.todo` until B3 merges.)
- `› failed send shows in the message log with LINE's error`. (Needs B3; same.)
- `› credential change notifies the owner`: one staff-group message, and before/after `last4` in `audit_log`.
- `› support session without a reason is 400`.
- `› data health shows a silent club`: a club with no events today has an old last-event time and a zero count.
- `› event stream filters by conversation`.
- `› club creation, LINE setup run, and support start and end each emit their event`.
- `› a blank and a velora-like club each get complete settings, a channels row and a refPrefix no other club has`.
- `› the health tile reads LINE status and quota from the newest line_setup row, and shows not connected when there is none`.
- `› tester-code route returns the code once` (B6 merged; real test).

**Migration:** no.

#### Task A6: Founder console web v1

**Spec:** §12.3, §12.2, §12.4 step 7.

**Files:** Create `apps/web/src/pages/admin/{AdminLayout,Clubs,ClubDetail,LineWizard,SupportBanner,WebhookLog,MessageLog,Timeline,Controls,DataHealth,EventStream}.tsx`; modify `apps/web/src/main.tsx` (mount `/admin/*`), `apps/web/src/pages/staff/Layout.tsx` (show `SupportBanner` when the `X-Support-Session` header is present).

**Decisions:** Plain React, same styling as existing staff pages, no UI library. The LINE wizard is the §12.2 minute table as six steps, each with a deep link placeholder (exact LINE URLs and Thai/English screenshots are added after the first real Thai OA test, spec §16.1 questions 1–2) and a live check that turns green. Credentials inputs are `type=password`, cleared after submit; afterwards only `last4`, setter and time are shown. `ClubDetail` has the club profile form. The wizard shows the plan-check result, the 80% quota warning, the one-time tester code (B6) and the live-test result. `Controls` has the platform login channel form (write-only, same rule). `DataHealth` and `EventStream` are the two §14.6 console pages; the event stream filters by club, conversation, booking or guest and polls.

**Check:** typecheck; walk: log in as admin with TOTP → create club → with `LINE_FAKE=1` in `.env`, paste made-up credentials → see the setup report → fill the club profile → open a support session → banner shows the end time → end it → open the event stream filtered by one conversation → open Data health.

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

**Files:** Modify `apps/server/src/data/events.ts`, `data/event-types.ts` (W0 created both as stubs). Create `apps/server/src/scripts/events-doc.ts` and `docs/EVENTS.md` (generated); add the script `events:doc` to `apps/server/package.json` (one line). Test: `apps/server/test/events.test.ts`.

**Decisions:**
- `event-types.ts` declares every event in the spec §14.2 table, using the spec names verbatim (`availability.searched`, `table.held`, `booking.confirmed`, ...), as a `const` object. Each entry has a version `v`, its allowed `props` keys and a privacy class per field (`none | pseudonymous | personal`). Types beyond the spec table are declared the same way: `booking.status_changed` (B2), `link.opened` (B4), `guest.removal_requested` and `guest.removed` (B10b). The declaration is the contract: A5, A16, B14 and the nightly check import `EventType`, and no event-name string literal appears anywhere else. The B4b table lists which task emits each event.
- `npm run events:doc -w @club/server` generates `docs/EVENTS.md` from the declaration (§14.2: "a document listing all events is generated from that declaration").
- `props` validation: each value is a number, boolean, null, or a string matching `/^[A-Za-z0-9_:.\-]{1,64}$/`. A violation throws when `opts.strict` is true (the default when `NODE_ENV` is `test`); otherwise the event goes to `events_dead_letter` with the error and processing continues.
- `data_origin` is required. `is_test` is computed by the caller and passed in: `isTestContext` once B6 merges, `club.status === 'demo'` until then.
- Dedupe: insert `ON CONFLICT (club_id, dedupe_key) DO NOTHING`.

**Interfaces (Produces):**
- `type EventInput = { clubId: string; type: EventType; occurredAt: Date; actorType: 'guest' | 'bot' | 'staff' | 'platform' | 'system'; actorId?: string; channel?: string; dataOrigin: 'first_party' | 'line_chat' | 'line_profile' | 'instagram' | 'pos'; source?: string; guestId?: string; conversationId?: string; bookingId?: string; tableId?: string; zoneId?: string; nightDate?: string; attemptId?: string; causeId?: string; lang?: string; props?: Record<string, string | number | boolean | null>; raw?: unknown; isTest: boolean; dedupeKey?: string }`
- `emit(tx: Db, e: EventInput, opts?: { strict?: boolean }): Promise<void>` (call it with the transaction handle so it commits with the state change; `strict` decides what a props violation does, see Decisions)

**Tests:** `same dedupe_key inserts one row`; `free text in props is rejected` (props `{ note: 'hello world' }` throws in test mode); `rejected event goes to dead letter in production mode` (`emit(tx, e, { strict: false })`); `seq increases monotonically`; `every §14.2 name is declared` (fixture list copied from the spec table); `generated doc is current` (regenerate in memory; fails when `docs/EVENTS.md` differs).

**Migration:** no.

#### Task B2: Booking state changes in one transaction, with history

**Spec:** §7.1, §13.1 #11, §14.2, §17.1 Data.

**Files:** Modify `apps/server/src/bookings/service.ts`, `apps/server/src/jobs/index.ts` (`startBackground` builds the `Scheduler`, registers `hold-expiry` (every 30 s: `expireStaleHolds`, then `ctx.notifier.holdExpired`) and `nightly-check`, and calls `scheduler.start()`; the returned function calls `scheduler.stop()`). Create `apps/server/src/jobs/scheduler.ts`, `jobs/nightly-check.ts`. Test: `apps/server/test/booking-history.test.ts`, `apps/server/test/nightly-check.test.ts`.

**Decisions:**
- One private helper `changeStatus(tx, booking, to, actor: Actor, reason: Reason | undefined, now, extra?)` writes the `bookings` update, a `booking_status_history` row, an `audit_log` row and the `events` rows for that change: the generic `booking.status_changed` (props `{ from, to, reason_code }`; an internal type beyond §14.2, and the row the nightly check matches on) plus the §14.2 event or events for that transition, taken from one fixed map `STATUS_EVENTS` in `data/event-types.ts` (`table.held`, `hold.expired`, `booking.abandoned` with `last_step`, `deposit.qr_sent`, `slip.received`, `deposit.verified` and `booking.confirmed` on approve, `deposit.rejected`, `booking.cancelled`, `booking.checked_in` with `arrived_pax`, `booking.no_show`). `createManualBooking` also emits `booking.manual_created`. Every path uses it: hold created (from `null` to `held`), hold expired, abandoned, deposit requested, slip received, approve, reject, cancel, arrived (sets `arrived_at`, takes `arrivedPax`), no-show (sets `no_show_at`). Release is not a status change (`released` is not a `BookingStatus`): `releaseTable` sets `bookings.released_at` and emits `table.released` with a plain `emit` in the same transaction, with no history row. B10's no-show job is its first caller.
- `audit()` moves inside the same transaction. `expireStaleHolds` writes history per expired booking in one transaction.
- `submitDetails` does not change status (the booking stays `held`), so it does not go through `changeStatus`. It runs in its own transaction and writes the guest and booking update, an `audit_log` row and one `details.submitted` event with a plain `emit`. It writes no `booking_status_history` row.
- `recordSlip`: run the status change to `payment_review` inside a nested `tx.transaction(...)` (a savepoint). On a unique violation the savepoint rolls back; the outer transaction then sets `statusReason`, keeps the deposit row in `review` with its `slipPath`, writes audit and event, and returns `{ tableLost: true }`. Without the savepoint, the caught statement error aborts the whole Postgres transaction and the slip record is lost.
- Every helper called inside a transaction callback (`audit`, `emit`, `latestDeposit`, the booking read in `transition`) takes `tx`. Never use the root `db` there: PGlite has one connection, so the call blocks until the 30 s test timeout, and on node-postgres it runs outside the transaction.
- `changeStatus` takes the W0 `Actor` and writes `actor.type` and `actor.id` to `booking_status_history`, to `audit_log` (with `sessionId`, `supportGrantId`) and to `events` (`actorType`, `actorId`). It takes the W0 `Reason` too: `reason.code` goes to `booking_status_history.reason_code`, to `bookings.cancel_reason_code` on a cancel, and to the `reason_code` prop of `booking.status_changed`; `reason.text` goes only to `bookings.status_reason`, `audit_log.reason` and `events.raw`, never to props. Do not change the W0 signatures.
- Every job is registered in `jobs/index.ts` and nowhere else. The 30 s hold sweeper from W0 becomes the `hold-expiry` job, so it runs under the job lock.
- `jobs/scheduler.ts`: a tiny in-process interval runner with named jobs, a per-job lock row in `platform_flags` (`job_lock:<name>`) so two app instances do not run the same job, and an injectable clock. No new dependency.
- Nightly check: for the previous night, every `booking_status_history` row has an `events` row with the same booking, `to` status and time; any mismatch writes an `ops_events` row `kind='bot_error'` with detail and makes the founder console health tile red. Zero tolerance. The same job runs the other three §14.2 nightly checks and reports each the same way: every live club emitted at least one event during its opening hours that night (`silentClubs`); no `events.props` value matches a phone, email or Thai-script pattern (`piiInProps`); no `is_test` row is visible in any view of the `analytics` schema (`testInAggregates`; no such view exists until B14, which adds its views to the checked list).

**Interfaces (Produces):** `markArrived(db, clubId, id, actor: Actor, now, arrivedPax?: number)`; `releaseTable(tx: Db, booking: Booking, actor: Actor, now: Date): Promise<void>`; `Scheduler` class with `register(name: string, everyMs: number, fn: (now: Date) => Promise<void>)`, `start()`, `stop()`, `runOnce(name, now)` (for tests); `buildScheduler(ctx: AppContext, now: () => Date): Scheduler` exported from `jobs/index.ts` (registers every job without starting it; `startBackground` calls it, and tests use it for `runOnce`). The scheduler lives only inside `jobs/index.ts`: `AppContext` has no scheduler field and no route needs one (B7's `fastForward` calls the service directly); `checkEventCompleteness(db, nightDate: string): Promise<{ missing: number; silentClubs: string[]; piiInProps: number; testInAggregates: number }>`.

**Tests:**
- `every status change writes history, audit and event in one transaction`: walk a booking held → awaiting_payment → payment_review → confirmed → arrived, calling `submitDetails` before the deposit request; expect 5 history rows (null→held, awaiting_payment, payment_review, confirmed, arrived; `submitDetails` adds none, and emits one `details.submitted`), 5 `booking.status_changed` events with matching `to`, the §14.2 event for each step (`table.held`, `deposit.qr_sent`, `slip.received`, `deposit.verified` and `booking.confirmed`, `booking.checked_in`), 5 audit rows.
- `a failure rolls everything back`: make the event insert throw (inject); expect booking status unchanged and no history row.
- `expired holds get history`.
- `staff cancel with a free-text reason writes a coded event`: cancel with `{ code: 'club_cancelled', text: 'Cancelled by the club' }`; expect `reason_code = 'club_cancelled'` in the history row and in the event props, the text in `status_reason` and `events.raw`, and no `events_dead_letter` row.
- `slip after the table was taken keeps the slip`: expire the hold, let another guest book the table, call `recordSlip`; expect `{ tableLost: true }`, the deposit in `review` with `slipPath` set, the booking status unchanged and `statusReason` set.
- `nightly check finds a missing event`: delete one `booking.status_changed` row; `checkEventCompleteness` → `missing: 1` and one `ops_events` row.
- `live club silent during opening hours is flagged`.
- `personal data pattern in props is flagged` (row inserted directly, past `emit`'s validation).
- `is_test row in an analytics view is flagged` (the test creates a throwaway view in the `analytics` schema).
- `hold expiry runs as a scheduler job`: `runOnce('hold-expiry', now)` expires a stale hold and tells the guest.
- `releaseTable sets released_at and emits table.released with no history row`.

**Migration:** no.

#### Task B3: Durable webhook pipeline, ops events, bot pause

**Spec:** §13.1 #9 #10, §14.2, §12.3 Controls, §13 Reliability.

**Files:** Modify `http/webhook.ts`, `line/outbox.ts`, `bot/flow.ts`, `jobs/index.ts` (`startBackground` awaits `replayUnprocessed(ctx, now())` before it starts the scheduler; no `main.ts` edit). Create `apps/server/src/data/raw-webhooks.ts`, `data/ops.ts`. Test: `apps/server/test/webhook-durability.test.ts`.

**Decisions:**
- Order in the route: find club (unknown → `ops_events` `webhook_unknown_club`, 404) → read body → verify signature with `credentials.channelSecret(club)` (bad → `raw_webhooks` row with `signature_ok=false` and `ops_events` `webhook_bad_signature`, 401) → insert `raw_webhooks` → answer 200 → process in background → set `processed_at` or `error`.
- Split `handleEvent` in `bot/flow.ts` into `processEvent` (throws) and `handleEvent` (a thin wrapper that catches and logs, kept for `http/dev.ts`). `processDelivery` calls `processEvent` per event. On a throw it sets `raw_webhooks.error`, leaves `processed_at` NULL and goes on to the next event.
- Per-event dedupe on LINE `webhookEventId`. The inbound message insert stays idempotent on `(club_id, line_message_id)`, but it no longer decides "already handled". `messages.processed_at` (W0 column) is set as the last step of a completed turn. An event is skipped only when its inbound row exists and `processed_at` is set. "Inbound row exists, `processed_at` NULL" is a turn that crashed: reuse the row and run the turn. So redelivery of a finished event is a no-op, and a delivery that crashed mid-turn is still answered on replay.
- `replayUnprocessed` at start-up processes rows with `processed_at IS NULL AND signature_ok` older than 10 s and younger than 6 h, oldest first. Older unprocessed rows are abandoned, not replayed (a turn days old must not push replies to old messages): `processed_at` is set and `error` is prefixed `abandoned:`, so retention purges them later.
- The webhook route writes ops and `raw_webhooks` rows without authentication, so it uses the same in-memory per-minute limits as `http/integrations.ts`: an unknown slug writes at most `BAD_SIGNATURE_LIMIT_PER_IP` ops rows per IP per minute (still 404), and a bad signature over `BAD_SIGNATURE_LIMIT_PER_IP` per (club, IP) or `BAD_SIGNATURE_LIMIT_PER_CLUB` per club per minute gets 429 with no row written.
- Dry run: `processDelivery(..., { dryRun: true })` opens `db.transaction(tx => ...)`, builds fresh deps with `buildBotDeps(ctx.config, tx, ...)` (so `BotDeps.db` and the `Outbox` are both on `tx`), uses `ctx.gateways.dev`, bypasses the dedupe check, returns the messages the dev gateway collected as `replies`, and always rolls back. No code on this path may use the root `db`: under PGlite a root query inside an open transaction hangs, and under node-postgres it commits for real.
- Outbox writes `messages.delivery_status` (`sent|failed|skipped`) and `error`; a failed send also writes `ops_events` `send_failed`.
- Bot pause: if `club.botPaused` or `isGloballyStopped(db)` (A5; until merged, read `platform_flags['global_stop']` directly), store the inbound message and events, send nothing to the guest, and alert the staff group once per conversation per pause. One pause is identified by `clubs.bot_paused_at` (W0 column, set by A5's pause route), or by the `updated_at` of `platform_flags['global_stop']` under the global stop. The last value alerted on is kept in the conversation's `state`, so a second message in the same pause raises no second alert.

**Interfaces (Produces):** `processDelivery(ctx: AppContext, rawId: string, opts?: { dryRun?: boolean }): Promise<{ events: number; replies: unknown[] }>` (dry run as decided above, for A5's replay); `processEvent(deps: BotDeps, club: Club, gateway: LineGateway, event: webhook.Event): Promise<void>` in `bot/flow.ts`; `replayUnprocessed(ctx, now): Promise<number>`; `recordOps(db, clubId: string | null, kind, detail, now)`.

**Tests:** `raw webhook stored before processing` (make `processEvent` throw with a stub gateway; the row exists with `error` set and `processed_at` NULL); `unprocessed raw webhook is replayed on startup`; `delivery that crashed after the inbound row was stored is replied to on replay` (insert a raw row and its inbound message with `processed_at` NULL, run `replayUnprocessed`; expect one reply and `processed_at` set on both rows); `redelivered webhook event id is processed once`; `bad signature is recorded, not processed`; `failed send records delivery_status failed and an ops event`; `paused club stores inbound and sends nothing`; `paused club alerts the staff group once per conversation per pause, and again after a new pause`; `dry run replay sends nothing and writes nothing`; `dry run replay of an already processed delivery returns the replies and writes nothing` (row counts of `messages`, `events` and `bookings` unchanged; a test timeout is a failure, which catches root-`db` use under PGlite).

**Migration:** no (`messages.processed_at` comes from W0).

#### Task B4: Full chat capture, entry tags, data notice

**Spec:** §5.5, §14.2, §14.3, §9 (messages +, notices).

**Files:** Modify `bot/flow.ts` (`logInbound`, every send), `bot/messages.ts` (postback data carries `s=<entry>`), `bot/i18n.ts` (notice text EN/TH with a version id), `line/outbox.ts` (the only place outbound `messages` rows are written: `toGuest` and `toStaff` take a last optional `author?: Actor`, default `{ type: 'bot' }`, written to `messages.author_type` and `author_id`), `bot/notify.ts` (`hostReply` passes its `actor` as the outbox `author`, so the staff message is stored with `author_type='staff'` and `author_id = actor.id`; A2 already passes the `Actor`, so A-owned `http/staff.ts` needs no edit), `line/setup.ts` (listed shared edit: the rich-menu postback `data` in `menuCells` becomes `a=book&s=rm_book`, `a=my&s=rm_my`, `a=host&s=rm_host`; rich-menu data is not in `bot/messages.ts`), `apps/server/test/flow.test.ts` (the notice shifts index asserts such as `out.at(-3)`). Create `http/redirect.ts` (one mount line in `app.ts`, the listed shared edit). Test: `apps/server/test/chat-capture.test.ts`.

**Decisions:**
- `logInbound` stores the **full** LINE event in `messages.payload` (today it stores a reduced payload) plus `author_type='guest'`, `channel_id` (the id of the club's `kind = 'line'` row in `channels`, which W0 guarantees for every club), `occurred_at` from the LINE timestamp.
- Every bot send stores `author_type='bot'`; staff replies `author_type='staff'` with `author_id`.
- Entry-point tags: rich menu buttons, greeting buttons, re-engagement and links carry `s=<code>` (`rm_book`, `greet_book`, `text_intent`, `link_<id>` ...); the tag is stored in `conversations.state.entry` when the first tagged postback or text of an attempt arrives. `attempt_id` is created where the attempt starts (the `booking.started` point), kept in `conversations.state.attemptId`, and copied to `bookings.attempt_id` at the hold. Every event of the attempt sets `events.attempt_id` and `events.source = state.entry`.
- Rich-menu tags reach a club only when its menu is rebuilt: `runLineSetup` skips an installed menu unless `refreshRichMenu` is true. A club connected after B4 gets the tagged menu at first setup; A10 rebuilds it for clubs connected before. A booking postback with no `s` is recorded with `s='rm_unknown'`.
- Every table search writes `availability.searched` (the §14.2 name) with props `{ night_date, pax_range, result_count }`, **including zero results**. `pax_range` is a code, because the key `13+` fails B1's props pattern: `paxRangeCode(key: PaxRangeKey): 'p2_4' | 'p5_8' | 'p9_12' | 'p13_plus'` in `data/event-types.ts` is the one mapping, and B4b's `pax.selected` uses it too. The pattern is not widened.
- First contact shows the data notice (§5.5) once, records a `notices` row (`purpose='data'`, `text_version`, `channel`, `shown_at`), and does not block the flow.
- Links that LINE opens without telling us (location, the details form) go through `GET /r/:code` in `http/redirect.ts`, which emits `link.opened` with the link kind and the entry tag, then answers 302 (§14.2 "Entry points are tagged"). Check on a device that a 302 to a `liff.line.me` URL still opens the LIFF app. If it does not, the details link stays direct and its tap is counted at the first `/api/liff` call.

**Tests:** `inbound payload is stored whole`; `bot and guest messages have different authors`; `staff reply is stored with author_type staff and the staff user id`; `search with no free table records result_count 0` (§17.1 Data); `entry tag flows from postback to booking events` (a postback with `s=rm_book`, then a hold: `events.source = 'rm_book'` and one shared `attempt_id` on `availability.searched` and `table.held`, and the same id in `bookings.attempt_id`); `pax range is stored as a code` (`5-8` → `p5_8`); `postback without s is tagged rm_unknown`; `rich menu postbacks carry rm_book, rm_my and rm_host` (from `richMenuRequest(club)`); `data notice shown once and recorded with its version`; `redirect link tap is counted`.

**Migration:** no.

#### Task B4b: Emit coverage

**Spec:** §14.2 (the catalogue; "about 75 places in the current code need an `emit()` call ... sized as part of Phase 1b"), §14.3, §14.10 funnel, P4.

**Files:** Modify `bot/flow.ts`, `bot/intents.ts`, `bot/notify.ts`, `line/outbox.ts`, `http/webhook.ts`, `http/liff.ts`. Test: `apps/server/test/emit-coverage.test.ts`.

**Decisions:**
- Every §14.2 event has one owning task (table below). B4b writes the `emit` calls marked B4b. Every other task writes its own and asserts them in its own tests.
- Steps before the hold have no booking row, so `changeStatus` cannot emit them. They are plain `emit` calls in the flow, in the same transaction as the conversation-state update, and carry the `attempt_id` created at `booking.started`.
- `booking.abandoned` carries `last_step` (one of `night`, `pax`, `table`, `details`, `rules`, `payment`), read from the conversation state when the hold expires or the attempt is replaced.
- `message.sent` props: `kind` (`reply` or `push`), `delivered` (boolean), `latency_ms` (from the inbound message named by `cause_id`), `template`.
- Handoff events come from today's flow in Phase 1b. B14b moves them into `chat/episodes.ts` without renaming them.

| Events | Code site | Owner |
|---|---|---|
| `guest.first_seen`, `guest.followed`, `guest.unfollowed`, `guest.refollowed` | `bot/flow.ts` | B4b |
| `notice.shown` | `bot/flow.ts` | B4 |
| `notice.accepted`, `rules.accepted` | `http/liff.ts` submit | B4b |
| `marketing.opted_out` | `bot/flow.ts` | B10b |
| `message.received`, `message.sent` | `bot/flow.ts` (`logInbound`), `line/outbox.ts` | B4b |
| `intent.detected`, `intent.unknown`, `bot.fallback_menu`, `bot.error` | `bot/flow.ts`, `bot/intents.ts` | B4b |
| `booking.started`, `night.selected`, `night.rejected`, `pax.selected`, `night.sold_out_shown`, `table.hold_lost_race` | `bot/flow.ts` | B4b |
| `availability.searched` | `bot/flow.ts` | B4 |
| `table.held`, `hold.expired`, `booking.abandoned`, `details.submitted`, `deposit.qr_sent`, `slip.received`, `deposit.verified`, `deposit.rejected`, `booking.confirmed`, `booking.cancelled`, `booking.checked_in`, `booking.no_show`, `table.released`, `booking.manual_created` | `bookings/service.ts` | B2 |
| `handoff.requested`, `handoff.timed_out`, `host.replied` | `bot/flow.ts`, `bot/notify.ts` | B4b, then B14b |
| `handoff.resolved` | `http/staff.ts` resolve route | A2, then B14b (`endEpisode`) |
| `line.webhook.rejected` | `http/webhook.ts` | B4b |
| `night.sold_out` | `bookings/service.ts` | B8b |
| `staff.login` | `http/auth.ts` | A1 |
| `staff.booking_viewed`, `staff.slip_viewed` | `http/staff.ts` | A2 |
| `support.session_started`, `support.session_ended`, `club.created`, `line.setup_run` | `http/admin/**` | A5 |
| `club.settings_changed`, `club.price_changed`, `club.event_night_created` | `http/staff.ts` | A9 |
| `slip.auto_verified`, `slip.review` | `bot/flow.ts` | B9 |
| `running_late`, `reminder.sent` | `bot/flow.ts`, `jobs/reminders.ts` | B10 |
| `door.count`, `crowd.rated` | `http/door.ts` | B11, B12 |
| `booking.completed`, `pos.bill_opened`, `pos.bill_updated`, `pos.bill_closed`, `pos.bill_matched` | `integrations/pos/**` | A11, A19 |
| `ai.answered`, `ai.call`, `faq.missed` | `brain/answer.ts` | B16 |
| `brain.note_drafted`, `brain.note_approved`, `brain.note_rejected` | `brain/learn.ts`, `http/brain.ts` | B18, B19 |
| `waitlist.joined` | expand at phase start | B22 |

**Interfaces:** Consumes `emit` (B1), the `changeStatus` events (B2), entry tags and `attempt_id` (B4). Produces no new function. B14's funnel board and A16 read these events.

**Tests (`emit-coverage.test.ts`):**
- `full booking walk emits booking.started, night.selected, pax.selected, availability.searched, table.held, details.submitted, rules.accepted, deposit.qr_sent, slip.received, booking.confirmed with one attempt_id`.
- `abandoned attempt records last_step`.
- `lost hold race emits table.hold_lost_race`.
- `closed night picked emits night.rejected; a full night shown emits night.sold_out_shown`.
- `follow, unfollow and refollow emit`.
- `message.sent carries kind, delivered and latency_ms; a failed send has delivered false`.
- `unknown text emits intent.unknown and bot.fallback_menu`.
- `bad signature emits line.webhook.rejected`.
- `every Phase 1b event type is emitted at least once`: the test file holds the names the table above gives to B2, B4 and B4b; after the walks, each has at least one row. Events owned by any other task (A1, A2, A5, B8b and the later phases) are asserted in that task's own tests.

**Migration:** no.

#### Task B5: Guest-link and staff-link hardening

**Spec:** §13.1 #3 #7.

**Files:** Modify `http/liff.ts`, `bot/links.ts`, `bot/intents.ts`, `bot/flow.ts`, `db/seed.ts` (stops setting `staffLinkCode`), `apps/server/test/flow.test.ts` (the `link CODE` case), `apps/web/src/pages/Details.tsx` (reads the `club` query param, loads the club, starts LIFF, then sends the ID token on the booking read; see Decisions). Create `bot/staff-link.ts`, `data/identity.ts`.
- In `http/staff.ts` (shared edit, note it in the sync file): remove `staffLinkCode` from the settings response and add `POST /api/staff/clubs/:slug/staff-link-code` (`owner|manager`; calls `issueStaffLinkCode`; returns `{ code, expiresAt }` once; writes `audit_log`). The route sits in the staff router, so `routeTable(app, '/api/staff')` covers it. It needs A2 merged (the `/clubs/:slug` prefix and `requireClubRole`); if A2 is not merged yet, do the rest of B5 first.
- In `apps/web/src/pages/staff/Settings.tsx` (shared edit): remove `staffLinkCode` from the type, and replace the `link {s.staffLinkCode}` hint with a button that calls the route and shows the code and its expiry once.
- The `main.ts` log line that printed the code is already gone (W0). No schema change: the old column stays, nullable and unused.

**Decisions:**
- Guest details link: reading guest details (`GET /api/liff/booking`) requires the same LINE ID-token check as submit; links expire at the booking's hold expiry or 24 h, whichever is sooner (signed expiry in the link). Today the page learns `liffId` from that same booking read, so it cannot have a token yet. New unauthenticated `GET /api/liff/club?club=<slug>` returns only `{ name, accentColor, liffId }`. `Details.tsx` reads the `club` query param (already in the link, `bot/links.ts`), calls it, runs `liff.init`, then sends the ID token in the `X-Line-Id-Token` header on `GET /api/liff/booking`. The codes are the ones submit uses today: no token → 401 `login_required`; a token for another user → 403 `wrong_user`. The exemptions are the same on read and on submit, and they are today's: a guest whose LINE user id starts with `SIM-`, or a guest with no `lineUserId`, needs no token.
- Login channel and identity pair (§11.1.1): `http/liff.ts` takes the login channel from `ctx.credentials.login(club)` (W0; A4b backs it with the shared platform channel), on read and on submit. When `login.shared` is false, keep the direct `sub === guest.lineUserId` check. When it is true, the token's `sub` is our provider's id, so call `linkLiffSub`: the first verified request for a guest stores the pair in `identity_map` (`club_id`, `guest_id`, `platform_line_sub`; `person_id` is reused from a row with the same sub, else new), and every later request must carry the stored sub, else 403 `wrong_user`. A real LINE guest (not a `SIM-` id) at a club where `login()` returns `null` is refused with 503 `login_not_configured`. The check is never skipped silently.
- Staff link code: `issueStaffLinkCode` makes a random 8-character code, stores only its hash with a 10-minute expiry, and returns it once. Using it in a group that is not yet linked links that group. If the club already has a linked group, a code typed in a different group does not replace it at once: the bot stores that group in `clubs.pending_staff_group_id` (W0 column) and answers that an owner or manager must issue a second, fresh code from the dashboard. Typing that second code in the same new group within its 10 minutes completes the replacement; the bot then tells the old group it was replaced, writes `audit_log`, and clears the pending id. The dashboard login is the manager check: the bot cannot tell who tapped a button in a LINE group, because no LINE user id is stored on `users`. The code is single-use: its hash is cleared on first use, in both steps. `bot/flow.ts` compares the typed code with the stored hash and never reads `club.staffLinkCode`. It is never logged. The bot's group-join message in `bot/flow.ts` (EN and TH) now tells a manager to press "Issue link code" on the dashboard Setup page.

**Interfaces (Produces):** `issueStaffLinkCode(db, clubId: string, userId: string, now: Date): Promise<{ code: string; expiresAt: Date }>` (B5 wires it into the staff settings route and page. A founder uses the same route under a write-mode support grant, so there is no separate admin route). `linkLiffSub(tx: Db, input: { clubId: string; guestId: string; sub: string }, now: Date): Promise<'linked' | 'match' | 'mismatch'>` in `data/identity.ts` (B20 builds on the rows it writes).

**Consumes:** `CredentialStore.login` (W0 signature). A4b supplies the shared channel; B5's tests inject a fake store through `opts.credentials`, so B5 does not wait for A4b.

**Tests:** `details read needs an ID token` (no token → 401 `login_required`; another user's token → 403 `wrong_user`; the right token → 200; the fixture injects a login channel through `opts.credentials` and uses a guest whose id does not start with `SIM-`, as `test/live-line.test.ts` does); `SIM- guest reads without a token`; `club lookup returns only name, accentColor and liffId`; `expired link is refused`; `link code works once`; `link code expires after 10 minutes`; `a first code typed in a new group leaves the old group linked`; `replacing a linked group needs a second dashboard-issued code and notifies the old group`; `settings response has no link code`; `issue route needs owner or manager, returns the code once, and is audited`; `token check runs for clubB with a store-supplied shared channel and no env var`; `first use stores the sub pair, and a second token with a different sub returns 403 wrong_user`; `club with its own login channel keeps the direct sub check`; `real guest at a club with no login channel is refused, never skipped`.

**Check:** walk Settings, issue a code, type `link <code>` in the simulator staff group, and see the group linked.

**Migration:** no.

#### Task B6: Test-data marking

**Spec:** §9 last bullets, §12.4.

**Files:** Modify `bookings/service.ts`, `bot/flow.ts`, `bot/intents.ts` (the tester code), `http/dev.ts`. Create `data/test-flag.ts`. Test: `apps/server/test/is-test.test.ts`.

**Decisions:**
- `guests.is_test` (W0 column, §9) is the source of the flag. It is set when a guest row is created for a LINE user id that starts with `SIM-` (every simulator guest: `http/dev.ts` and the admin simulator use only such ids) or at a club with `status = 'demo'`, and when a guest registers as a tester (below).
- `isTestContext({ club, guest }: { club: Club; guest?: Guest | null }): boolean` is true when the club status is `demo` or `guest.isTest`. It has no `source` argument: an onboarding dry run is the activity of a simulator guest or of a registered tester, so no caller passes a `dry_run` value. Bookings and events from such a context copy `is_test = true`. Tables without the column take it from their guest, booking or club (Global Constraints).
- Tester registration (§12.3 status table, §12.2 live test; assumed, see "Decisions the human must make"): at a club with `status = 'onboarding'`, a guest who types the one-time tester code gets `guests.is_test = true`. The code follows B5's staff link code rules (8 random characters, only the hash stored, 10-minute expiry, single use, never logged). The hash is kept in `platform_flags['tester_code:<clubId>']`, so no column is needed. At a `live` club the code is ignored.
- The partial unique index on bookings for real tables does **not** count test rows: change it to `WHERE status IN (...) AND is_test = false`, and add a second partial index for test rows so test bookings still cannot double-book each other (this needs a migration: take the migration lock).

**Interfaces (Produces):** `isTestContext` as above and `issueTesterCode(db, clubId: string, userId: string, now: Date): Promise<{ code: string; expiresAt: Date }>`, both in `data/test-flag.ts`. A5 calls `issueTesterCode` from `POST /api/admin/clubs/:slug/tester-code`; publish the signature in `sync/track-b.md`.

**Tests:** `simulator and demo rows carry is_test` (the guest, its bookings and its events); `a test booking never blocks a real booking on the same table` (clubB, which is `live`: one `SIM-` guest and one real guest); `two test bookings still cannot share a table`; `a tester code typed at an onboarding club marks the guest, and that guest's later bookings and events are test rows`; `a tester code typed at a live club changes nothing`.

**Migration:** yes (the two partial unique indexes on `bookings`).

#### Task B7: Velora seeded club, reset and fast-forward

**Spec:** §12.4 (all), §17.1 Demo club.

**Files:** Modify `db/seed.ts` (seed Velora from `demo/velora-content.ts` by calling B0's `applyClubContent`, not its own inserts), `bookings/service.ts` (`expireHold`), `app.ts` (one mount line). Create `demo/seed-history.ts`, `demo/reset.ts`, `http/demo.ts` (mounted at `/api/admin/demo` with A's `requirePlatformAdmin`). Test: `apps/server/test/velora.test.ts`.

**Decisions:**
- Velora has `status='demo'`. Seeded **history**: 6 weeks of nights with bookings, cancellations, no-shows, takeovers, door counts and crowd ratings, generated deterministically from a fixed seed so the stats page and data dashboard show real-looking charts. Seeded guests, bookings and events have `is_test = true`. Door counts, crowd ratings and handoff episodes have no such column; they are test rows because the club is `demo`.
- Seeded **tonight** (relative to `now`): some tables booked, one hold in progress, one slip waiting review, one guest waiting for a host.
- Brain: the FAQ notes from B0 inserted as `brain_notes` with `status='live'`, `source='onboarding'`; gaps are not inserted.
- The seed creates no user. The Velora demo manager is made by hand with A1's `npm run admin:create -w @club/server -- --email <email> --name <name> --club demo --role manager`. Demo step 2 (approve the slip on the dashboard) uses that login, not a support session.
- Reset: seeded activity rows have deterministic ids, `seed_hist_*` for the six weeks of history and `seed_tonight_*` for tonight. Content rows (zones, tables, price rules, policies from `applyClubContent`) and the brain notes are not activity and are never deleted. In one transaction, reset deletes every row of the club in the guest, conversation, message, booking, deposit, status-history, event, handoff, door-count and crowd-rating tables whose id does not start with `seed_hist_` (so the old `seed_tonight_*` rows go too), then re-runs the tonight seed for `currentNightDate(now, nightEndHour)`. Only for clubs with `status='demo'`.
- **Fast-forward** does not change the clock. It moves the chosen booking's `hold_expires_at` to just before `now`, expires that one booking with `expireHold` (not the global `expireStaleHolds`, which would also expire other clubs' stale holds), then calls `ctx.notifier.holdExpired`, so the guest gets the expiry message and other clubs are unaffected. `what` is `'hold_expiry' | 'reminder' | 'release'`: B10's `'reminder'` calls `remindNow` and `'release'` calls `releaseNow` for that one booking (both also reachable through `POST /api/admin/demo/:slug/fast-forward`).

**Interfaces (Produces):** `resetDemoClub(db, clubId: string, now: Date)`, `fastForward(ctx: AppContext, clubId: string, what: 'hold_expiry' | 'reminder' | 'release', bookingId: string, now: Date)` (B10 widened `what`), `expireHold(db, clubId: string, bookingId: string, now: Date): Promise<Booking | undefined>` in `bookings/service.ts` (expires that one hold through `changeStatus`; `undefined` when it is not a held booking of that club). Routes `POST /api/admin/demo/:slug/reset`, `POST /api/admin/demo/:slug/fast-forward`.

**Tests:** `reset restores the seeded tonight with today's date` (add a booking, run reset: the booking is gone, the `seed_tonight_*` id set is back with night date `currentNightDate(now, nightEndHour)`, and the `seed_hist_*` rows and the tables are unchanged); `reset refuses a non-demo club`; `reset leaves club B untouched`; `fast-forward expires the chosen hold, tells the guest, and leaves a stale hold of club B alone`; `seeded history is deterministic` (two seeds produce equal row counts and sums).

**Routes and isolation:** mount line only in `app.ts`. `isolation.test.ts` and `admin.test.ts › non-admin gets 403 on every ADMIN_ROUTES entry` must pass with the new routes (they are walked through `routeTable`). Fixtures for new route params go in `test/helpers/track-b.ts` via `isolationFixtures`. These routes take `:slug` and need platform admin, so a club-A manager gets 403.

**Migration:** no.

#### Task B8: Simulator behind admin login

**Spec:** §13.1 #1, §12.3 Simulator.

**Files:** Modify `http/dev.ts` (use `requirePlatformAdmin`, accept any club slug, mark rows test), `apps/web/src/pages/Simulator.tsx` (admin login), `app.ts` (listed shared edit: mount `/api/dev` when `config.DEV_SIMULATOR`; mount the admin-protected simulator under `/api/admin/sim` in all environments), `apps/server/test/flow.test.ts` (`sim()` and `transcript()` send `adminCookie(app)` from `test/helpers/track-a.ts`). Test: `apps/server/test/simulator-auth.test.ts`.

**Decisions:** The "development or test only" rule lives in `loadConfig` (A3). B8 reads `config.DEV_SIMULATOR` and adds no `NODE_ENV` check.

**Tests:** `simulator routes need platform-admin login`; `simulator runs against any club and marks rows test`; `/api/dev is not mounted when config.DEV_SIMULATOR is off`.

**Routes and isolation:** `isolation.test.ts` and `admin.test.ts › non-admin gets 403 on every ADMIN_ROUTES entry` must pass with the `/api/admin/sim` routes. Fixtures for new route params go in `test/helpers/track-b.ts` via `isolationFixtures`.

**Migration:** no.

#### Task B8b: A row for every night

**Spec:** §9 (`nights`), §14.3 "Every night, open or closed", §10 Phase 1b.

**Files:** Create `apps/server/src/jobs/nights.ts`. Modify `jobs/index.ts` (register `nights`, hourly), `bookings/service.ts`, `demo/seed-history.ts` (Velora's six weeks get their night rows through `ensureNights`). Test: `apps/server/test/nights.test.ts`.

**Decisions:**
- The `nights` job upserts one row per club per date, from today across the booking window, from `ClubSettings.openWeekdays` and `closedDates`: `open`, or `closed` with a `closed_reason` code (`weekday`, `closed_date`, `alcohol_ban`). A date that is an `alcohol_ban` day in `calendar_days` is closed by default (no such rows exist until B13 seeds them). It runs hourly and once in `startBackground`, so a new club has its rows within the hour.
- A row a person edited is never overwritten: the job inserts missing rows and refreshes only rows where `edited_by` is null. A9's calendar sets `edited_by`.
- `bookings/service.ts`: the open-night check and `upcomingNights` read `nights.status` when a row exists and fall back to the settings when none does. `upcomingNights` returns `event_name`, and the guest date list shows it. As built: the nights-aware list is `bookableNights(db, club, now, count): Promise<NightOption[]>`, because `upcomingNights(club, now, count): string[]` is a frozen synchronous booking-service signature. Every caller (bot date list, `line/samples.ts`) uses `bookableNights`; `upcomingNights` stays settings-only for compatibility and has no caller in `src` outside `bookings/service.ts`.
- When a hold or booking takes the last free table of a night, set `status = 'sold_out'` and emit `night.sold_out`. When a table frees up, set it back to `open`.
- A closed night keeps its row. B12 expects no snapshot for it, so a missing night never looks like a quiet night.

**Interfaces (Produces):** `ensureNights(tx: Db, club: Club, from: string, days: number, now: Date): Promise<number>` (rows written) in `jobs/nights.ts`; `nightStatus(db, clubId: string, date: string): Promise<'open' | 'closed' | 'sold_out'>` in `bookings/service.ts`. A9 writes `nights` rows directly (with `edited_by`); B12 and B21 read `nights.status`.

**Tests (`nights.test.ts`):**
- `job writes a row for every date in the booking window, open and closed`.
- `a closed night has a row with closed_reason`.
- `a row edited by a person survives the next job run`.
- `a settings change refreshes rows nobody edited`.
- `taking the last table sets sold_out and emits night.sold_out; a cancellation reopens the night`.
- `an event night's name appears in the guest date list`.

**Migration:** no (`nights` comes from W0).

**Phase 1b gate checklist** (both sessions tick in their sync files): A5 `create club then receive a signed webhook with no restart` passes; A2 isolation suite passes; B2 nightly check passes on a seeded week; Velora demo script (§12.4) steps 1, 2 and 7 run in the simulator and on a phone, and step 4 in its Phase 1b form (the guest asks for a person and we answer from the Chats page); step 8 needs Phase 1, and steps 3, 5 and 6, and step 4 as written, need the brain and inbox (Phase 2); every §13.1 row closed with the task that closed it; A5 `console-created club: details read with a valid ID token` passes with no env var set (A4b + B5); B4b `emit-coverage.test.ts` passes; B8b: every night in the booking window has a `nights` row; device check before the gate: `liff.sendMessages()` works when the LIFF app's provider differs from the OA's provider (§16.1 q3), and if it does not, the form submits with `viaChat=false` and the server pushes the summary (the existing fallback in `http/liff.ts`); cross-review done.

---

## Phase 1: Pilot (House of Savoy, 4 weeks)

Gate (spec §10): G1–G8 measured; club agrees to continue; onboarding call timed against P1. Before the first real guest: the B10b removal and retention tests pass (§17.1 Data). Velora demo step 8 (the Velora-only board) runs once B14 is merged. Human task, start now: **Meta business verification and app review** (§11.5, longest lead item).

Expand with superpowers:writing-plans at the start of the phase.

### Track A, Phase 1

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| A8 Staff accounts and invites | §4, §12.3 Onboarding: invite by email or LINE link, set roles, disable a user | `platform/invites.ts`, `http/staff.ts`, `pages/staff/Team.tsx` | invite accepted creates membership with the role; disabled user's sessions revoked |
| A9 Settings UI | §6.2, §12.3 Club data, §14.3, §11.1.4: tables, zones, prices (written to `price_rules` with `valid_from/valid_to`; the booking flow reads them through B9b, so the price part is blocked by B9b), rules, greeting, PromptPay ID (TOTP + owner notice). Nights calendar: close a date with a reason, create or edit an event night (name, event type, line-up, event price through `price_rules.night_id`); it writes the `nights` row with `edited_by`, which B8b never overwrites; a founder does the same from `pages/admin/ClubDetail.tsx` (§12.3 event calendar). Founder-only city calendar entry: `POST /api/admin/calendar-days` calls B13's `upsertCalendarDay` for `election` and `city_event` days (needs B13; ship that route last if B13 is not merged). Club profile edit (same fields as A5's profile route). Push quota used against the plan, with a warning at 80%. Emits `club.settings_changed`, `club.price_changed`, `club.event_night_created` | `http/staff.ts`, `http/admin/calendar.ts`, `pages/staff/Settings.tsx`, `pages/staff/Calendar.tsx`, `pages/admin/ClubDetail.tsx` | price change keeps past nights' prices; PromptPay change needs TOTP and notifies owner; creating an event night writes the `nights` row and emits `club.event_night_created`; closing a date writes `closed_reason`; an election day entered from the console appears in `calendar_days`; profile edit is saved and audited; quota warning shows at 80% used; a settings change and a price change each emit their event |
| A10 Greeting and rich menu migration | §10 Phase 1, §11.1 | `line/setup.ts`, `pages/admin/LineWizard.tsx` | club's existing greeting text imported into settings; rich menu replaced (`refreshRichMenu: true`, so it carries B4's `s=rm_*` tags) and old one kept for rollback |
| A11 POS level L0: report import | §11.3 L0 (Wongnai/FoodStory CSV) | `integrations/pos/adapter.ts` (`PosAdapter` interface), `integrations/pos/csv-import.ts`, `pages/staff/PosImport.tsx` | import maps rows to `pos_bills` with `table_code`, `covers`, times; re-import is idempotent; walk-in bills have no booking. Needs a real report sample (spec §16.1 q13) before coding the column map |
| A12 Observability and load | §13 Peak load, Observability | `infra/`, `scripts/load.ts` | 50 bookings/min per club and 1,000 inbound/min total with p95 reply < 3 s (Friday 22:00–01:00 pattern); uptime alert fires on webhook error rate |

**Migration (Track A, Phase 1):** none. `invites` (A8), `price_rules` with `valid_from/valid_to`, `nights` and `club_profile` (A9) and `pos_bills` (A11) come from W0. If the phase-start writing-plans pass finds a need, take the lock.

### Track B, Phase 1

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| B9 Automatic slip verification | §11.2: amount, receiver, time after hold, transaction ref never reused per club; any failure or outage → `payment_review`, never auto-reject. Provider (SlipOK or EasySlip) picked by the human after evaluation | `bookings/slip-verify.ts` (`SlipVerifier` interface + one adapter), `bot/flow.ts`, `bot/deps.ts` (the verifier and its test fake) | each of the four checks failing → `payment_review`; provider timeout → `payment_review`; reused ref → `payment_review` |
| B9b Prices from `price_rules` (merge before A9) | §9 (`price_rules` with `valid_from`, `valid_to`), §6.2: the booking flow reads a table's minimum spend and deposit for a night from `price_rules`: the highest-`priority` rule that matches the table, its zone or the club, the weekday or the `night_id`, and whose `valid_from` to `valid_to` covers the night date. With no matching rule it falls back to the zone and table price columns, so no backfill is needed. B publishes `priceFor(db, clubId: string, tableId: string, nightDate: string): Promise<{ minSpendSatang: number; depositSatang: number }>` in the sync file; A9 writes the rules | `bookings/pricing.ts`, `bookings/service.ts`, `bot/messages.ts` | a zone rule overrides the column price; an event-night rule (`night_id`) beats a weekday rule; a rule changed today leaves a past night's price as it was; with no rule the column price is used |
| B10 Reminders, running late, guest cancel, no-show job | §5.2, §5.3, §7.2, §12.4 fast-forward. The no-show job frees the table through B2's `releaseTable`. Widens B7's `fastForward` to `what: 'hold_expiry' \| 'reminder' \| 'release'`: it moves the booking's reminder or release time to just before `now` and runs that job's function for that one booking | `jobs/reminders.ts`, `jobs/no-show.ts`, `jobs/index.ts` (register both jobs), `bot/flow.ts`, `demo/reset.ts` (`fastForward`) | reminder sent once at the configured lead time; running-late sets `running_late_minutes`; no-show after the release time per rules; each writes history and events; fast-forward to the reminder time sends the reminder, and to the release time releases the table, for that booking only |
| B10b Guest removal, marketing opt-out, retention | §14.9, §5.5 (stop marketing), §17.1 Data. `removeGuest(db, clubId: string, guestId: string, now: Date): Promise<{ messagesCleared: number; slipsDeleted: number; eventsCleared: number }>` anonymises the `guests` row in place, deletes message text, `events.raw`, slip files and the guest's `identity_map` links, and clears `guest_id` and `person_id` on the guest's events; aggregates stay. Entry points: a menu item and a keyword (EN/TH, one confirm tap) write a `removal_requests` row; the daily `removal` job runs `removeGuest` for each pending row and sets `completed_at`. The stop keyword and menu item write a `notices` row (`purpose='marketing'`, `withdrawn_at` set) and emit `marketing.opted_out`; `hasMarketingOptOut(db, clubId, guestId): Promise<boolean>` is what every later marketing send must check (reminders about the guest's own booking are not marketing). Retention: `purgeRawWebhooks(db, now): Promise<number>` (older than 30 days and processed) and `purgeSlips(db, now): Promise<number>` (older than 1 year; deletes the file and clears the path). A's Data health page (A5) reads the pending `removal_requests` count | `data/removal.ts`, `jobs/retention.ts`, `jobs/index.ts` (register `removal` and `retention`, both daily), `bot/intents.ts`, `bot/flow.ts`, `bot/i18n.ts`, `data/event-types.ts` (`guest.removal_requested`, `guest.removed`) | `removal.test.ts › removal anonymises the guest in place, deletes message text, events.raw, slip files and identity links, and clears guest ids on events`; `› aggregate counts (bookings, events per type, snapshots, door counts) are equal before and after`; `› removal in club A leaves club B untouched`; `retention.test.ts › raw webhooks older than 30 days are purged, unprocessed ones kept`; `› slips older than 1 year are purged`; `flow.test.ts › removal keyword and menu item create a removal request`; `› stop keyword records the opt-out and emits marketing.opted_out` |
| B11 Door screen | §6.2 door mode, §14.3: QR scan, actual party size at check-in, clicker by guest type, large targets, dark | `pages/door/*`, `http/staff.ts` is A's: B adds `http/door.ts` mounted under `/api/staff/clubs/:slug/door` with A's `requireClubRole('door', ...)` | check-in records `arrived_pax`; clicker writes `door_counts` by kind; works with a door-role account only; mount line only in `app.ts`, and `isolation.test.ts` passes with the door routes (fixtures for new params in `test/helpers/track-b.ts` via `isolationFixtures`) |
| B12 Occupancy snapshots and crowd rating | §14.3, §17.1 Data | `jobs/snapshots.ts`, `jobs/index.ts` (register the job), `bot/notify.ts` (hourly "how full now?" to door/host), `http/door.ts` | a snapshot exists for every club-night whose `nights.status` is not `closed`, at every scheduled lead bucket, and none is expected for a closed night; rating 1–5 stored with user; `isolation.test.ts` passes with the rating route (fixtures for new params in `test/helpers/track-b.ts` via `isolationFixtures`) |
| B13 Calendar days | §14.3: the seed, plus hand entry of `election` and `city_event` days as they are announced. B produces `upsertCalendarDay(db, input: { date: string; kind: string; name: string; notes?: string }): Promise<void>` in `data/calendar.ts` and publishes it in the sync file; the founder form and its route are A9's | `data/calendar-seed.ts`, `data/calendar.ts` | Thai public holidays, holy days, alcohol-ban days for 2026–2027 present; `upsertCalendarDay` adds an election day once (a repeat is a no-op); the next `nights` job run closes a new alcohol-ban day on rows nobody edited |
| B14 Data dashboard v1 | §14.5, §14.6, §14.10 funnel report. Reads the events B4b emits. The live event stream and Data health are console pages (A5, A6) and the weekly club report is A16b, because Metabase is for internal use only (§14.6) | `infra/metabase/` (compose block, read-only DB role), a custom migration in `apps/server/drizzle/` (`drizzle-kit generate --custom`, under the migration lock) with the views in an `analytics` schema that exclude test rows as the Global Constraints define them (`is_test` rows; for tables without the column, rows whose guest or booking is a test row and every row of a `status = 'demo'` club), and apply §14.8 origin rules, and the read-only role (guard the role statement so PGlite tests pass), `infra/metabase/dashboards/*.json` | Metabase connects with the read-only role and cannot write; booking pace, funnel and the other §14.6 starter boards render; Velora appears only in a "demo" filter; no Metabase board is reachable by a club login |

**Migration (Track B, Phase 1):** B14 yes (the custom migration in its row). B9, B9b, B10, B10b, B11, B12 and B13 no: W0 added `price_rules`, `deposits.slip_*`, `bookings.reminder_sent_at`, `removal_requests`, `notices`, `nights`, `door_counts`, `occupancy_snapshots`, `crowd_ratings` and `calendar_days`.

#### Task B9: Automatic slip verification (expanded)

**Spec:** §11.2 Deposits, §5.2 step 6.

**Files:** Create `apps/server/src/bookings/slip-verify.ts`. Modify `bot/flow.ts` (`handleImage`), `bot/deps.ts` (`slipVerifier`), `config.ts` and `.env.example` (`SLIPOK_API_KEY`, `SLIPOK_BRANCH_ID`), `test/helpers/track-a.ts` (`testConfig` keys). Tests: `apps/server/test/slip-verify.test.ts`, `flow.test.ts`.

**Decisions:**
- Provider assumption until the human picks one: **SlipOK** (`SlipOkVerifier`). EasySlip would be a second adapter behind the same interface. With no key set, `buildBotDeps` gives `slipVerifier: null` and every slip goes to staff review (the Phase 0 fallback in §11.2).
- `recordSlip` (B2) is unchanged and still moves the booking to `payment_review` first. Then `verifySlip` runs; a pass confirms through `approveDeposit` with actor `{ type: 'system', id: 'slip:<provider>' }`, so history, audit and the `deposit.verified` and `booking.confirmed` events come from the one status writer. A fail leaves `payment_review`. Nothing ever rejects.
- Checks, in order, each with a `slip.review` code: reference already on another deposit of the club (`ref_reused`), amount below the deposit (`amount_low`), receiver not the club's `promptpay_id` (`receiver_mismatch`; masked values compared from the right, `x` is a wildcard, at least 4 visible digits), transfer earlier than the hold start (the first `held` history row) minus 5 minutes of clock skew (`time_before_hold`). Provider over 10 s: `provider_timeout`. Any provider error or unreadable slip: `provider_error`. A slip after the hold expired: `late_slip` (§5.2 step 6, even when every check passes).
- The reading is stored on the deposit (`slip_amount_satang`, `slip_receiver`, `slip_time`, and `slip_trans_ref` unless reused); the unique index `(club_id, slip_trans_ref)` also catches a race, which counts as `ref_reused`.
- Events: `slip.auto_verified` `{ depositId, provider, amount_satang }` on pass, `slip.review` `{ depositId, code }` on fail.

**Interfaces (Produces):** `SlipVerifier { provider: string; read(image: Buffer, opts: { signal: AbortSignal }): Promise<SlipReading> }`, `SlipReading { transRef; amountSatang; receiver: { proxy?; account?; name? }; transferredAt: Date }`, `verifySlip(db, club, bookingId, image, verifier, now, opts?: { timeoutMs?; skewMs?; lateSlip? }): Promise<{ verified: true; deposit } | { verified: false; code: SlipReviewCode }>`, `FakeSlipVerifier(result: SlipReading | Error | 'timeout')`, `receiverMatches`, `SlipOkVerifier`, `parseSlipOk` in `bookings/slip-verify.ts`. `BotDepOptions.slipVerifier?: SlipVerifier | null` and `BotDeps.slipVerifier?`.

**Tests (`slip-verify.test.ts`):**
- `a slip that passes all four checks confirms the booking and emits slip.auto_verified`.
- `amount below the deposit → payment_review`; `receiver not the club PromptPay → payment_review`; `transfer before the hold started → payment_review`; `reused ref → payment_review`.
- `provider timeout → payment_review`; `provider error or unreadable slip → payment_review`.
- `a slip after the hold expired goes to review even when every check passes`; `the same ref at another club is not a reuse`; `never rejects: a booking not in review is left alone`.
- `flow.test.ts › automatic slip verification in the bot (B9)`: a pass sends the confirmation card; a fail keeps the "checking your payment" reply.
#### Task B10: Reminders, running late, guest cancel, no-show job (expanded)

**Spec:** §5.2 steps 8 and 9, §5.3 (My booking), §7.2 (arrival cut-off with grace), §12.4 fast-forward.

**Files:** Create `apps/server/src/jobs/reminders.ts`, `jobs/no-show.ts`. Modify `jobs/index.ts` (register `reminders` and `no-show`, every minute), `bot/flow.ts` (postbacks `late`, `cancel`, `cancel_yes`; My booking quick replies), `bookings/service.ts` (`setRunningLate`, `releaseNoShow`, appended), `bot/notify.ts` (`reminder`, `noShowReleased`), `bot/messages.ts`, `bot/i18n.ts`, `db/schema/core.ts` (optional `ClubSettings` keys). `demo/reset.ts` (`fastForward`) is B7's and not on the side branch: the widening is a two-line switch onto `remindNow` / `releaseNow` at merge. Test: `apps/server/test/reminders.test.ts`.

**Decisions:**
- New optional `ClubSettings` keys, defaults in code (no migration, no backfill): `reminderTime` (`HH:MM`, default `18:00`), `arrivalGraceMinutes` (default 30), `runningLateExtendsRelease` (default true), `autoNoShow` (default true). A time whose hour is before `nightEndHour` (the after-midnight part of the night) falls on the next calendar day (00:30 on a Saturday night is Sunday 00:30); every other time, an afternoon `reminderTime` included, is on the night's own date. (Review fix: the earlier `nightStartHour` rule pushed a 15:00 reminder, or the default 18:00 at a club opening at 20:00, past that night's arrival time, so it was never sent.)
- Release time = night date at `arrivalBy` + `running_late_minutes` (when `runningLateExtendsRelease`) + `arrivalGraceMinutes`.
- `reminders` job: a `confirmed` booking with `reminder_sent_at` null whose reminder time has passed and whose arrival time has not. It claims the booking with a conditional update of `reminder_sent_at` and emits `reminder.sent` (`kind: 'day_of'`) in one transaction, then pushes the reminder (`Notifier.reminder`) with quick replies [Running late] [Need to cancel] [Location]. The claim makes it once only. A reminder is not marketing, so no opt-out check.
- `no-show` job: a `confirmed` booking of tonight or last night past its release time, in a club with `autoNoShow`, goes through `releaseNoShow`: `changeStatus` to `no_show` (sets `no_show_at`, actor `system`, reason `released`) and B2's `releaseTable` in one transaction, then the staff group gets "17A not arrived, released". A booking checked in (`arrived`) is never touched. Assumption: the spec's host prompt [Release] [Keep 30 min] is replaced by automatic release with `autoNoShow`; a club that wants to decide sets it off and marks no-shows from the dashboard.
- Running late: `a=late&b=<id>` asks [15 min] [30 min] [1 hr]; `a=late&b=<id>&m=<15|30|60>` calls `setRunningLate` (sets `running_late_minutes`, audit `running_late`, event `running_late` with `minutes`), tells the guest the new release time and alerts the staff group. Only the guest's own `confirmed` booking.
- Guest cancel: `a=cancel&b=<id>` shows the club's cancellation rule (`rules[0]`, the deposit line) and [Yes, cancel] [Keep booking]; `a=cancel_yes&b=<id>` calls `cancelBooking` with actor guest and reason `guest_cancelled` (history, audit and `booking.cancelled` through `changeStatus`), frees the table and alerts the staff group.
- My booking for a confirmed booking adds the quick replies [Running late] [Cancel] [Talk to a host] to the confirmation card.
- Fast-forward: `remindNow(ctx, clubId, bookingId, now)` and `releaseNow(ctx, clubId, bookingId, now)` run the job body for that one booking as if its time had come; other bookings are untouched.

**Interfaces (Produces):** `reminderDueAt(club, nightDate): Date`, `sendDueReminders(ctx, now, only?: { clubId: string; bookingId: string }): Promise<number>`, `remindNow(ctx, clubId, bookingId, now): Promise<boolean>` in `jobs/reminders.ts`; `releaseAt(club, booking): Date`, `releaseNoShows(ctx, now, only?): Promise<number>`, `releaseNow(ctx, clubId, bookingId, now): Promise<boolean>` in `jobs/no-show.ts`; `setRunningLate(db, clubId, bookingId, actor: Actor, minutes: number, now): Promise<Booking>`, `releaseNoShow(db, clubId, bookingId, actor: Actor, now): Promise<Booking>` in `bookings/service.ts`.

**Tests (`reminders.test.ts`):** `reminder sent once at the configured lead time`; `no reminder for another night, a cancelled booking or after the arrival time`; `running late sets running_late_minutes and pushes the release time`; `guest cancel shows the policy, then cancels with history and event`; `no-show after the release time releases the table`; `running late delays the no-show, and autoNoShow off keeps the booking`; `a checked-in booking is never marked no-show`; `fast-forward to the reminder time sends the reminder, and to the release time releases the table, for that booking only`; `both jobs are registered on the scheduler`.

**Migration:** no.

#### Task B9b: Prices from `price_rules` (expanded)

**Spec:** §9 (`price_rules`, `valid_from`, `valid_to`), §6.2.

**Files:** Create `apps/server/src/bookings/pricing.ts`. Modify `bookings/service.ts` (`listTableOptions` and `availableTables` price each table for the night; `holdTable` and `createManualBooking` store that price), callers that priced without a night (`http/staff.ts` night map, `line/samples.ts`). `bot/messages.ts` needs no change: it shows `TableOption` prices, which are now night prices. Test: `apps/server/test/pricing.test.ts`.

**Decisions:**
- A rule matches a (table, night date) when: `scope = 'table'` and `scope_id` is the table, or `scope = 'zone'` and `scope_id` is the table's zone, or `scope = 'club'`; `weekday` is null or equals the night's weekday; `night_id` is null or is the id of the club's `nights` row for that date; `valid_from` is null or ≤ date and `valid_to` is null or ≥ date (`valid_to` inclusive, as A9 writes it).
- The highest `priority` wins (A9's `rulePriority`: club 0, zone 1, table 2, +10 weekday, +20 `night_id`; content rules carry their own). A tie goes to the more specific scope (table, zone, club), then the later `valid_from`.
- With no matching rule the price is the table column, else the zone column (the pre-B9b behaviour), so no backfill.
- `listTableOptions(db, clubId, nightDate?)` keeps its signature with one optional argument: without a date it returns column prices (settings views that show no night).

**Interfaces (Produces):** `priceFor(db, clubId: string, tableId: string, nightDate: string): Promise<{ minSpendSatang: number; depositSatang: number }>` (throws `BookingError('not_found')` for a table of another club), `pricesForNight(db, clubId, nightDate): Promise<Map<tableId, { minSpendSatang; depositSatang }>>` (one read for a whole night) in `bookings/pricing.ts`.

**Tests (`pricing.test.ts`):**
- `zone rule overrides column price`.
- `an event-night rule (night_id) beats a weekday rule`.
- `a rule changed today leaves a past night's price as it was`.
- `with no rule the column price is used`.
- `a table rule beats a zone rule`.
- `availableTables and holdTable use the night's rule price`.

**Migration:** no.

#### Task B14: Data dashboard v1 (expanded)

**Spec:** §14.5, §14.6, §14.8, §14.10 funnel.

**Files:** Create `apps/server/drizzle/0006_analytics_views.sql` (custom, `--name analytics_views`), `apps/server/src/data/analytics.ts`, `infra/metabase/{README.md,init-role.sh,provision.mjs}`, `infra/metabase/dashboards/*.json` (six boards). Modify `docker-compose.yml` (append the `metabase-init` and `metabase` services, profile `metabase`). Test: `apps/server/test/analytics.test.ts`; `instagram.test.ts` (A18's Metabase todo turned real).

**Decisions:**
- Three schemas. `analytics_src` (never granted) holds base views with a `demo` column (club `status = 'demo'`); it drops real clubs' test rows (`events.is_test`, `bookings.is_test`, the booking's `guests.is_test`), keeps only events with `data_origin` in (`first_party`, `pos`) and `channel` not `instagram`, and drops bookings with `source = 'instagram'` (§14.8, no Meta data). `analytics` = the same views `WHERE NOT demo` (real clubs); `analytics_demo` = `WHERE demo` (Velora). No view has `raw`, `is_test`, names, phones or free text.
- Views (same names in both schemas, each with `club_id`; `clubs` keys on `id`): `clubs`, `events`, `booking_funnel` (club, `started_on` Bangkok date of the attempt's first event, `step_no`, `step`, attempts with that step's event: `booking.started`, `night.selected`, `pax.selected`, `table.held`, `details.submitted`, `rules.accepted`, `deposit.verified`, `booking.confirmed`), `booking_pace` (bookings that reached confirmed, by `days_before` the night, with a cumulative count), `booking_curve` (occupancy snapshots, `booked_share = (confirmed + arrived) / active`), `demand_no_table` (zero-result `availability.searched` and `night.sold_out_shown` by night and pax range), `no_show_rate` (due = arrived, completed, no-show), `door_vs_bookings`, `busyness_by_hour` (Bangkok hour: door net, check-ins, average crowd rating).
- "Velora only in a demo filter": every board card is native SQL over `analytics.X where {{dataset}} = 'live' union all analytics_demo.X where {{dataset}} = 'demo'`, with `dataset` defaulting to `live`, plus an optional `[[and club_id = {{club}}]]`.
- Role `metabase_ro`: created `NOLOGIN` in the migration inside a guarded `DO` block (`insufficient_privilege` → notice), `default_transaction_read_only = on`, `USAGE` and `SELECT` on `analytics` and `analytics_demo` only. `infra/metabase/init-role.sh` (compose one-shot, superuser) adds `LOGIN` with `METABASE_DB_PASSWORD`, re-runs the grants and creates Metabase's own `metabase` database, owned by `metabase_app` (LOGIN, no superuser, password `METABASE_APP_DB_PASSWORD`). The Metabase container connects only as `metabase_app` and `metabase_ro`, never as the superuser. PGlite models roles, so the tests use `SET LOCAL ROLE metabase_ro`.
- Metabase is published on `127.0.0.1:3000` only (SSH tunnel), never behind the public proxy, and no app route proxies to it: no club login reaches a board. Image `metabase/metabase:v0.50.0` (bump at deploy).
- The nightly `testInAggregates` check (B2) calls `testRowsInAnalytics(db)`.

**Interfaces (Produces):** `ANALYTICS_VIEWS` (readonly view names), `METABASE_ROLE = 'metabase_ro'`, `testRowsInAnalytics(db): Promise<number>` (demo-club rows in any `analytics` view plus `analytics.events` rows whose event is `is_test`; must be 0) in `data/analytics.ts`.

**Tests (`analytics.test.ts`):** `funnel counts attempts reaching each step for a seeded week`; `booking pace counts confirmed bookings by days before the night`; `booking curve reads occupancy snapshots`; `demand with no table counts zero-result searches and sold-out views`; `no-show rate, door counts against bookings and busyness by hour match the seeded week`; `test rows, chat-origin and Instagram rows never appear in the analytics schema`; `Velora rows appear only in analytics_demo`; `the events view has no raw column`; `metabase_ro can read the analytics views and cannot write or read operations tables`; `every §14.6 starter board has a dashboard file and cards read only analytics schemas`; `every board card runs as metabase_ro for the live and demo dataset`; `compose binds Metabase to localhost and no app route reaches it`. `instagram.test.ts › the Metabase analytics view leaves out instagram-origin rows (B14)`.

**Migration:** yes (custom, views and role only; regenerate the number at merge if `0005` is taken).

**Unverified against a real service:** no real Metabase in tests; `provision.mjs` (Metabase REST API) and the image tag are not run.

#### Task B13: Calendar days (expanded)

**Spec:** §14.3 "The city calendar", §9 (`calendar_days`).

**Files:** Create `apps/server/src/data/calendar-seed.ts`, `apps/server/src/data/calendar.ts`. Modify `http/admin/calendar.ts` (A9's route calls `upsertCalendarDay`), `main.ts` (one line: `seedCalendarDays(db)` at boot). Test: `apps/server/test/calendar.test.ts`, and `settings.test.ts` (A9's todo turned real).

**Decisions:**
- `CALENDAR_SEED` is a frozen list of `{ date, kind, name, notes? }` for 2026 and 2027: national public holidays (with substitution days, `notes: 'substitution day'`), the five Buddhist holy days (Makha Bucha, Visakha Bucha, Asahna Bucha, Khao Phansa, Ok Phansa) as `holy_day`, and the same five as `alcohol_ban`. Lunar dates are from the full-moon calendar; 2027's are marked `notes: 'lunar date, confirm against the cabinet announcement'` until a person checks them.
- A date can carry several rows (the primary key is `date, kind, name`), so Makha Bucha is a `public_holiday`, a `holy_day` and an `alcohol_ban` row.
- `upsertCalendarDay` validates `kind` against the five spec kinds and the date as `YYYY-MM-DD` (throws `CalendarDayError` otherwise), inserts on conflict of the key and updates only `notes`. A repeat with the same input is a no-op. No event is emitted (no calendar type in `data/event-types.ts`; the A9 route writes the audit row).
- `seedCalendarDays(db)` runs every seed row through `upsertCalendarDay`'s insert path with `on conflict do nothing`, so a hand-edited note survives a reboot. `main.ts` runs it at boot after `seedDemoClub`.
- `POST /api/admin/calendar-days` (A9) calls `upsertCalendarDay`, audits `platform.calendar_day_set`, and answers 200 `{ ok: true }`.

**Interfaces (Produces):** `upsertCalendarDay(db, input: { date: string; kind: string; name: string; notes?: string }): Promise<void>`, `seedCalendarDays(db): Promise<number>` (rows inserted), `alcoholBanDates(db, from: string, to: string): Promise<Set<string>>` (for B8b's `nights` job) in `data/calendar.ts`; `CALENDAR_SEED` in `data/calendar-seed.ts`.

**Tests (`calendar.test.ts`):**
- `Thai public holidays, holy days and alcohol-ban days for 2026-2027 are present`.
- `upsertCalendarDay adds an election day once; a repeat is a no-op`.
- `upsertCalendarDay rejects an unknown kind and a bad date`.
- `seeding twice inserts nothing the second time`.
- `the next nights job run closes a new alcohol-ban day on rows nobody edited` (`it.todo` until B8b's `ensureNights` lands; B8b reads `alcoholBanDates`).

**Migration:** no (`calendar_days` comes from W0).

#### Task B10b: Guest removal, marketing opt-out, retention (expanded)

**Spec:** §14.9, §5.5 (stop marketing), §17.1 Data.

**Files:** Create `apps/server/src/data/removal.ts`, `apps/server/src/jobs/retention.ts`. Modify `jobs/index.ts` (register `removal` and `retention`), `bot/intents.ts` (`remove_data`, `stop_marketing`), `bot/flow.ts`, `bot/i18n.ts`, `bot/messages.ts` (menu item and confirm prompt). `data/event-types.ts` already declares `guest.removal_requested`, `guest.removed` and `marketing.opted_out`. Tests: `apps/server/test/removal.test.ts`, `apps/server/test/retention.test.ts`, `flow.test.ts` (two cases).

**Decisions:**
- `removeGuest` runs in one transaction, scoped by `clubId` (throws `RemovalError('not_found')` for a guest of another club). Checklist: `guests` row anonymised in place (`line_user_id`, `display_name`, `name`, `phone`, `nationality`, `birth_date`, `external_user_id` set null; `id`, `club_id`, `lang`, `is_test` kept); every `messages.payload` of the guest set to `{"removed":true}`; the guest's `events` (by `guest_id` or the guest's conversation) get `raw`, `guest_id`, `person_id`, `conversation_id` set null, `actor_id` null when `actor_type = 'guest'`, and a `dedupe_key` naming the guest id set null; `identity_map`, `guest_tags`, `guest_notes` rows deleted; staff `alerts` on the guest's conversation or bookings deleted; free text on the guest's bookings (`special_request`, `notes`), conversation (`handoff_reason`, `state`) and handoff episodes (`reason`) cleared; `raw_webhooks` of that club whose body holds the guest's LINE user id deleted; deposit `slip_path` cleared and the files unlinked after commit (a missing file is not an error). Rows other rows point at are never deleted, so counts stay.
- `removeGuest` emits no event, so "events per type" is unchanged; the `removal` job emits `guest.removed` (no guest id) after each request it completes.
- Slip files live under the uploads dir (`bot/deps.ts`: `DATA_DIR/uploads`). `removeGuest` and `purgeSlips` take it as an optional last argument (`uploadsDir`, default `join(process.env.DATA_DIR ?? '.data', 'uploads')`); the jobs pass `ctx.deps.uploadsDir`.
- Bot: the keyword (EN `delete my data`, `remove my data`, `forget me`; TH `ลบข้อมูล`) and the menu item (`a=remove`, inside a "My data" quick reply `a=privacy` on the main menu) both answer a confirm prompt with one button (`a=remove_confirm`). The tap writes one `removal_requests` row (`channel = 'line'`; none if one is already pending) and emits `guest.removal_requested`. The `stop` keyword (EN whole message `stop`, `unsubscribe`, `stop promotions`; TH `ยกเลิกรับข่าวสาร`, `ไม่รับข่าวสาร`, `หยุดส่ง`) and the menu item (`a=stop`, inside the "My data" prompt) write a `notices` row (`purpose = 'marketing'`, `text_version = 'marketing-v1'`, `channel = 'line'`, `withdrawn_at = now`) once and emit `marketing.opted_out`.
- `hasMarketingOptOut` is true when the guest has any `marketing` notice with `withdrawn_at` set. No marketing send exists yet; every later one (Phase 2+) calls it. Reminders about the guest's own booking are not marketing.
- Retention: `purgeRawWebhooks` deletes `raw_webhooks` with `processed_at` set and `received_at` older than 30 days; unprocessed rows stay for replay. `purgeSlips` takes deposits whose `slip_received_at` (else `created_at`) is older than 365 days, unlinks the file and clears `slip_path`. Both jobs are registered daily (24 h); both are idempotent.

**Interfaces (Produces):** `removeGuest(db, clubId: string, guestId: string, now: Date, uploadsDir?: string): Promise<{ messagesCleared: number; slipsDeleted: number; eventsCleared: number }>`, `requestRemoval(db, club, guest, now): Promise<boolean>` (true when a new row was written), `recordMarketingOptOut(db, club, guest, now): Promise<boolean>`, `hasMarketingOptOut(db, clubId: string, guestId: string): Promise<boolean>`, `runRemovalRequests(db, now, uploadsDir?): Promise<number>` in `data/removal.ts`; `purgeRawWebhooks(db, now): Promise<number>`, `purgeSlips(db, now, uploadsDir?): Promise<number>`, `runRetention(db, now, uploadsDir?)` in `jobs/retention.ts`.

**Tests:** `removal.test.ts › removal anonymises guest in place, deletes message text, events.raw, slip files and identity links, and clears guest ids on events`; `› aggregate counts (bookings, events per type, snapshots, door counts) equal before and after`; `› removal in club A leaves club B untouched`; `retention.test.ts › raw webhooks older than 30 days are purged, unprocessed ones kept`; `› slips older than 1 year purged`; `flow.test.ts › removal keyword and menu item create removal request`; `› stop keyword records opt-out and emits marketing.opted_out`.

**Migration:** no.
#### Task B11: Door screen (expanded)

**Spec:** §6.2 Door, §5 (confirmation card QR), §14.3 "People actually inside", §13 Accessibility (large targets, dark).

**Files:** Create `apps/server/src/http/door.ts`, `apps/web/src/pages/door/Door.tsx`. Modify `app.ts` (one mount line), `data/event-types.ts` (`door.count` gains the `kind` prop), `docs/EVENTS.md` (regenerated), `test/helpers/track-b.ts` (no new param: the check-in route reuses Track A's `bookings/:id` fixture), `apps/web/src/main.tsx` (one route line `/door`), `pages/staff/Layout.tsx` (a door-role login is sent to `/door`; one "Door" nav item). Test: `apps/server/test/door.test.ts`.

**Decisions:**
- `doorRoutes(app)` is mounted at `/api/staff`, paths under `/clubs/:slug/door`, behind `requireClubRole(app, 'owner', 'manager', 'host', 'door')`: a door-role account alone is enough; a promoter gets 403.
- `GET /door?date=` (default: the current night, `currentNightDate`): `{ nightDate, arrivals, counts }`. `arrivals` are the night's `confirmed`, `arrived` and `no_show` bookings (ref, guest name, table, zone, pax, `arrivedPax`, notes, status). `counts` = `{ byKind: { table_guest, guestlist, walk_in, ticket }, total }`, the net of `door_counts.delta`.
- `GET /door/find?q=`: the pass QR encodes the booking ref (`/media/pass`), so `q` matches the ref exactly (case-insensitive) or a substring of the guest's name, LINE display name or phone; the caller's club only, the current night only, at most 20.
- `POST /door/bookings/:id/check-in { arrivedPax? }` calls B2's `markArrived` (so the `booking.checked_in` event, history and audit come with it); `arrivedPax` defaults to the booked pax. A booking of another club is 404 (looked up by club before anything else); a booking for another night is 409 `wrong_night`; a booking not `confirmed` is 409 `invalid_state`. The A19 POS bill opens as on the staff `arrived` route.
- `POST /door/count { kind, delta: 1 | -1, clickId? }` writes one `door_counts` row (`user_id` = the caller) and emits `door.count` (`channel: 'door'`, `dataOrigin: 'first_party'`, props `kind`, `count_in`, `count_out`, `total` = the night's net after the click, `is_test` = demo club) in one transaction. A `-1` that would take the kind's net below 0 is 409 `below_zero`. A repeated `clickId` (a retry from a flaky phone) writes nothing more: the row id is `dc_<clubId>_<clickId>` (club-scoped, since `door_counts.id` is global and a click id from one club must not swallow another club's tap) and the event's `dedupe_key` `door:<clickId>` (already unique per club). The below-zero check and insert run under `pg_advisory_xact_lock(hashtext('door:<clubId>:<nightDate>'))`, so concurrent taps serialize. Neither door route sends the guest's phone or LINE display name; both are search-only.
- Web: `/door` is a full-screen dark page outside the staff layout: camera QR scan with the browser's `BarcodeDetector` where the phone has it, else the search box (spec: name search fallback), one tap to check in with a party-size stepper, and a clicker with four kinds at +1/−1, all targets ≥ 56 px. No new web dependency (assumption: door phones are Android Chrome; iOS Safari uses the search box until a decoder is chosen).

**Interfaces (Produces):** `doorRoutes(app: AppContext): Hono<AuthEnv>` in `http/door.ts`; `DOOR_KINDS = ['table_guest', 'guestlist', 'walk_in', 'ticket'] as const`; `doorCounts(db, clubId, nightDate): Promise<{ byKind: Record<DoorKind, number>; total: number }>` (B12 and A16b may read it).

**Tests (`door.test.ts`):**
- `check-in records arrived_pax and emits booking.checked_in`.
- `check-in without a party size records the booked pax`.
- `check-in of another club's booking is 404 and changes nothing`.
- `check-in of a booking for another night is refused`.
- `clicker writes door_counts by kind with the user and emits door.count`.
- `clicker minus never takes a kind below zero`.
- `a repeated clickId writes one row and one event`.
- `find matches the QR ref and the guest name, only in the caller's club`.
- `door screen shows tonight's arrivals and counts by kind`.
- `works with a door-role account only: door can use every door route, a promoter gets 403`.
- `isolation.test.ts` passes with the door routes.

**Migration:** no (`door_counts` comes from W0).

---

## Phase 2: Brain and inbox

Gate (spec §10): ≥ 85% of free-text booking requests correctly pre-filled; no AI-caused wrong price or availability; G9 and G10 measured; three clubs onboarded at ≤ 15 minutes each. The Velora demo script (§12.4) runs end to end on a real phone and in the simulator, steps 3 to 6 included (§17.1).

**Interface first (week 1 of the phase, B publishes, A consumes):** `chat/episodes.ts`:
`startEpisode(tx, { clubId, conversationId, trigger, reason, topic?, firstMessageId, now })`, `recordStaffReply(db, { clubId, conversationId, userId, text, channel, occurredAt, externalId }): Promise<{ messageId: string }>` (stores the message `author_type='staff'`, writes the event, sends to the guest through the outbox, dedupes on `externalId`), `endEpisode(tx, { episodeId, endedBy: 'staff' | 'timeout', resolverUserId?, now })`. Handoff timeout moves from lazy (today `bot/flow.ts:116–119`) to a scheduler job. `topic` fills `handoff_episodes.topic` (a W0 column, §9): B16 classifies it, and until B16 merges it is the handoff reason code. A16 groups takeovers by it.

B14b (first row of the Track B table below) builds `chat/episodes.ts`. It is the first Phase 2 task for Track B and merges in week 1. **A14, A16 and B18 are blocked by B14b.**

**Mirroring contract (A14):** A's bridge does not edit B's files. It reads B's `messages` rows (inbound, bot and staff) and `handoff_episodes` status in creation order and keeps its own per-club cursor. B guarantees that every guest message, bot send and staff reply is a `messages` row before or at send time.

**Alerts interface (A publishes when A15 merges, B consumes in B19b):** `platform/alerts.ts`: `raiseAlert(db, { clubId, level: 'urgent' | 'needs_input' | 'info', kind: string, conversationId?: string, bookingId?: string, text: { en: string; th: string } }, now): Promise<void>`. It records the alert and, for `urgent`, sends to the staff group through a sender that A wires once in `createApp` to B's `outbox.toStaff`. B makes every `raiseAlert` call; A does not edit `bot/**` or `line/outbox.ts`. Timed triggers: A also publishes `runAlertChecks(ctx: AppContext, now: Date): Promise<void>` in `platform/alert-checks.ts` and registers it with one `scheduler.register('alert-checks', ...)` line in `jobs/index.ts` (listed shared edit).

**Feature switches (A publishes when A17b merges, B consumes):** `platform/features.ts`: `isFeatureOn(db, clubId: string, key: FeatureKey): Promise<boolean>`, read per request. `FeatureKey` is a `const` list agreed in the sync files.

### Track A, Phase 2

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| A13 Chatwoot CE install and per-club provisioning | §6.3: one shared install. One inbox account per club, created through the inbox's platform API by create-club and the A17 wizard (account, API inbox, agent bot; idempotent). Single sign-on link for managers from our dashboard. Our booking and table panel embedded as a dashboard app beside each conversation | `infra/chatwoot/` (compose), `integrations/chatwoot/provision.ts`, `http/staff.ts` (`GET /inbox-sso`, `GET /inbox-panel`), `pages/staff/InboxPanel.tsx` | install survives restart; backup covered by `infra/backup.sh`; create club provisions one Chatwoot account and inbox, idempotent on retry; SSO link logs a manager into only their club's account; panel shows that conversation's guest bookings and refuses another club's conversation |
| A14 LINE ↔ Chatwoot bridge | §6.3: our server keeps the webhook and mirrors into an API-channel inbox; staff replies return via `message_created` callback → `recordStaffReply`; bot posts with the Agent Bot token; we set conversation status | `integrations/chatwoot/{client,bridge,callback}.ts`, `http/integrations.ts`, `http/staff.ts` (switch `/conversations/:id/resolve` to `endEpisode` and `/conversations/:id/reply` to `recordStaffReply`). Blocked by B14b | guest message appears in Chatwoot; staff reply reaches the guest once (callback redelivery deduped); bot messages shown as bot; inbox down → bot still answers and messages queue for mirroring; dashboard resolve closes the open episode; a `message_created` callback carrying club A's Chatwoot account token and a club B conversation id is rejected and writes nothing |
| A15 Alerts | §6.4: Urgent (inbox + staff group within 5 s), Needs input (dashboard counter), Information (dashboard feed; LINE only if the club switches it on). Every §6.4 trigger has an owner. Calls from B's code (B19b): guest asks for a person, bot could not answer, complaint or safety word, payment needs review, bot error, table not arrived at release time, brain draft or gap waiting, new confirmed booking, running late, cancellation. Timed checks (A, `runAlertChecks`, every minute): LINE disconnected or quota exhausted, and the daily summary to the feed | `platform/alerts.ts` (A creates it; signature under "Alerts interface" above), `platform/alert-checks.ts`, `jobs/index.ts` (one `register` line, listed shared edit), `http/staff.ts` (`/feed` and the per-club "also send to LINE" switch), `pages/staff/Feed.tsx`, `app.ts` (wire the staff-group sender once). A does not edit `bot/**` or `line/outbox.ts`; B makes the calls in B19b. A publishes the signature in its sync file when A15 merges | urgent reaches both within 5 s; needs-input counter increments and clears on resolve; LINE disconnected raises one urgent alert, not repeated while it lasts; quota exhausted raises urgent; the daily summary appears in the feed and sends no LINE push by default |
| A16 Club stats page | §6.5, the full list, for any date range: bookings made by the bot against manual bookings and the no-staff share (G1), deflection rate (G9), takeovers by topic (`handoff_episodes.topic`), median first response (G2), handoff response time (G8), booking time (G5), deposits collected, minimum spend booked, no-show rate (G6), messages by channel, push quota against the plan, AI cost against the cap, and the funnel (§14.10) | `http/staff.ts` (`/stats`), `pages/staff/Stats.tsx` (reads `events`, `handoff_episodes`). Blocked by B14b | figures match a hand-counted seeded Velora week; test rows excluded for real clubs |
| A16b Weekly club report | §14.10, §6.5: weekly report per club, shown in our dashboard and sent on LINE (never in Metabase, §14.6). Where on LINE it is sent is a human decision; staff group assumed | `platform/club-report.ts` (`buildClubReport(db, clubId: string, weekStart: string)`, `sendWeeklyReports(ctx: AppContext, now: Date)`), `jobs/index.ts` (one `register` line, listed shared edit), `http/staff.ts` (`/report`), `pages/staff/Report.tsx`; the send goes through the staff-group sender that A15 wires | report figures match the hand-counted seeded Velora week; sent once per week per club; club B data never appears in club A's report |
| A17 Full onboarding wizard | §12.2: pre-call form link, minute table, deep links, live checks, go-live switch, timing recorded per step. The baseline FAQs are written through B15's brain store (`brain/notes.ts`), so that part is blocked by B15 | `pages/admin/LineWizard.tsx`, `pages/onboard/*` (pre-call form), `http/admin/onboarding.ts` | form submission creates tables, prices, rules, baseline FAQs and the club profile; each step's duration stored; three real onboardings timed |
| A17b Per-club feature switches | §12.3 Controls, §10 Phase 2: `PATCH /api/admin/clubs/:slug/features {key: boolean}` stores the switches in `platform_flags` under `features:<clubId>`; each change is audited; `isFeatureOn` (signature under "Feature switches" above) reads per request, so a change needs no restart | `platform/features.ts`, `http/admin/controls.ts`, `pages/admin/Controls.tsx` | a switch takes effect on the next request without restart; an unknown key is 400; the change is in `audit_log`; the route is in `ADMIN_ROUTES` |

#### Task A16 expanded: Club stats page

**Files:** `platform/club-stats.ts` (new), `platform/club-report.ts` (shared range helpers moved out of `buildClubReport`, no behaviour change), `http/staff-report.ts` (`GET /clubs/:slug/stats`, mounted through `staffRoutes` with the report), `apps/web/src/pages/staff/Stats.tsx`, `apps/web/src/main.tsx` and `pages/staff/Layout.tsx` (one route, one nav link), test `test/club-stats.test.ts`. Migration: no.

**Decisions:**
- Range: `?from=YYYY-MM-DD&to=YYYY-MM-DD`, nights inclusive, at most 366 nights; without them, the last complete week (as `/report`). Chat, takeover and event times run from the first night's `nightEndHour` to the `nightEndHour` after the last night (A16b's window). `owner|manager` only, like `/report`.
- Shared with A16b through `club-report.ts`: `nightRange`, `testGuestIds`, `bookingFigures` (held bookings, deposits, no-show rate, G1 no-staff-help count) and `chatFigures` (G9 runs, deflection, takeovers by topic). The stats page and the weekly report give the same figure for the same week.
- Test rows (Global Constraints) excluded for every club not `demo`: `bookings.is_test`, `guests.is_test` (their messages and takeovers), `events.is_test`. A demo club counts its own rows.
- Bookings: bot = held bookings whose `source` is not manual; manual = `manual|manual_phone|manual_walkin`. Minimum spend booked = sum of held bookings' `min_spend_satang`.
- G2 median first response: for each inbound guest message, the time to the next outbound bot or staff message to that guest; `unanswered` counts inbound messages with no later outbound one.
- G8 handoff response: per takeover, `started_at` to the first staff message to that guest at or after it; median; takeovers with no staff reply counted as `waiting`.
- G5 booking time: per `booking.confirmed` event in range with an `attempt_id`, the time from the earliest event of that attempt (`booking.started`) to the confirmation; median. Manual bookings have no attempt and are left out.
- Messages by channel: `messages.channel_id` → `channels.kind` (null = `line`), in and out counts.
- Push quota: `lastKnownQuota` + `quotaView` (A5/A9), the current month, not the range.
- AI cost: sum of `ai.call` `props.cost_usd_micros` in the range, and in the calendar month (Bangkok) of the range's last night against the cap. Assumption until B16 merges: the cap is `platform_flags['ai-cost-cap:<clubId>'].value.usdMicros`, null when unset (B16 writes or reads the same key).
- Funnel (§14.10): started `booking.started`, night `night.selected`, pax `pax.selected`, table `table.held`, details `details.submitted`, rules `rules.accepted`, paid `deposit.verified`, confirmed `booking.confirmed`; distinct `attempt_id` per step (event id when the attempt is null), with drop-off to the step before.

**Interfaces (Produces):** `buildClubStats(db: Db, clubId: string, from: string, to: string): Promise<ClubStats>` in `platform/club-stats.ts`; `GET /api/staff/clubs/:slug/stats?from&to` → `{ stats: ClubStats }`.

**Tests (`club-stats.test.ts`):** `figures match a hand-counted seeded Velora week`; `test rows excluded for real clubs`; `club B data never appears in club A stats`; `stats and weekly report agree on the same week`; `GET /stats answers owner and manager with their own club only`; `it.todo` for the B7 Velora history seed.

**Migration (Track A, Phase 2):** A14 no (`conversations.external_ref` and `messages.external_id` come from W0). A15: decide where alerts are stored in the phase-start writing-plans pass; a new table means yes. Others no.

### Track B, Phase 2

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| B14b Handoff episodes (first; week 1) | §6.3, §8.3: one episode per takeover, staff reply recording, timeout as a job | `chat/episodes.ts`, `jobs/handoff-timeout.ts`, `jobs/index.ts` (register the job), `bot/flow.ts` (remove the lazy timeout, call `startEpisode`), `line/outbox.ts` | handoff creates one `handoff_episodes` row; `recordStaffReply` with a repeated `externalId` sends once; the timeout job ends the episode with `endedBy='timeout'` and returns the conversation to bot mode; no mode change happens outside `chat/episodes.ts` |
| B15 Brain store | §8.2: notes with Obsidian-compatible markdown + frontmatter, versions, snapshot compile with token count, cap 60k tokens (warn 40k); save-time lint rejects prices and availability. Export and import as an Obsidian folder. Paste or photo import into **draft** notes (the baseline import of §10 Phase 2). Layout notes generated from `tables` and regenerated on a table change. Note expiry (§8.4): event and promotion notes need an end date, other notes come up for review after 90 days, an expired note leaves the next snapshot and appears in a weekly digest | `brain/{notes,compile,lint,export,import,layout}.ts`, `jobs/brain-expiry.ts`, `jobs/index.ts` (register the job) | note with a price is rejected at save; compile is deterministic and hashed; over 60k refuses to publish; export then import round-trips notes and links; pasted text becomes draft notes, never live; a table change regenerates the layout note; an event note without an end date is rejected; an expired note is absent from the next snapshot and listed in the digest |
| B16 AI answers | §8.1, §8.5, §8.6: whole brain in the prompt with a cache breakpoint, `claude-haiku-5-5`, fallback `claude-sonnet-5-5`; output guard: no amount, table code or availability not produced by the booking system in the same turn; per-club cost cap, with a warning through `raiseAlert` before the cap (threshold set in the phase-start writing-plans pass; `raiseAlert` is A15's, so until A15 merges send the warning with `outbox.toStaff` and switch it in B19b). Extraction of booking details from free text to `{ date, pax, table_code?, zone_pref? }` and a jump to the right step (the 85% gate measures this). Intent routing. Fixed tools `check_availability`, `start_booking`, `get_booking`, `request_handoff`, which take club and guest from the server session, never from model output. A 2-line handoff summary. Emits `ai.answered` (note ids, topic, language), `ai.call` (model, tokens, latency, cost) and `faq.missed`, and passes `topic` to `startEpisode` | `brain/answer.ts`, `brain/guard.ts`, `brain/tools.ts`, `brain/extract.ts`, `bot/flow.ts`, `bot/deps.ts` (Anthropic client, cost cap and their test fakes) | guard strips an invented price; cost cap reached → hand to host; Anthropic API down → hand to host; 'โต๊ะ 6 คน เสาร์นี้' pre-fills date and pax; '17A sat 6ppl' pre-fills the table code; a tool ignores a club id in model output; an unclear message shows the button menu and records `bot.fallback_menu`; a handoff carries a 2-line summary; `ai.answered` logs the note ids; a warning is raised before the cost cap is reached |
| B17 Thai evaluation and per-club test set | §8.6, §16.1 q16: the 100-question model choice. §8.5: a test set per club (Thai, English, mixed, romanised Thai, attempts to trick the bot) that runs on every snapshot compile and every model id change; a failed run alerts us and does not delay the note (§8.3 step 6). §8.6: sampled quality review with `claude-sonnet-5-5` in batch mode | `brain/eval/thai-100.jsonl`, `scripts/eval-brain.ts`, `brain/testset.ts`, a per-club test-set table in `db/schema/brain.ts` (migration lock), `jobs/brain-sample-review.ts`, `jobs/index.ts` (register the job) | 100-question Thai set scored by `claude-sonnet-5-5` as judge; result recorded before choosing the live model; a snapshot compile runs the club's set; a model id change runs every club's set; a prompt-injection case passes; a failed run raises an alert and the note stays live |
| B18 Learning loop | §8.3, §8.4: resolved episode → redact → `claude-opus-5-5` batch draft → auto-discard price/personal data/one-off → approval queue → live; a takeover within 10 minutes of a bot answer flags the notes that answer used for review (read from `ai.answered`); a draft nobody reviews expires after 4 weeks; an approved note's question joins the club's test set (B17); weekly lint; gaps list | `brain/learn.ts`, `jobs/brain-draft.ts`, `jobs/brain-lint.ts`, `jobs/index.ts` (register both jobs). Blocked by B14b | draft with a phone number discarded; approved note answers the same question next time (§17.1); a takeover within 10 minutes of a bot answer flags the notes that answer used, and one after 11 minutes does not; an approved note adds its question to the club test set; a draft unreviewed for 4 weeks expires |
| B19 Brain manager UI | §6.6 | `pages/staff/brain/*`, `http/brain.ts` (under `/api/staff/clubs/:slug/brain` with A's `requireClubRole('owner','manager')`), one nav item in `pages/staff/Layout.tsx` (listed shared edit) | approve in one tap; edit creates a version; gaps list shows unanswered questions; mount line only in `app.ts`, and `isolation.test.ts` passes with the brain routes (fixtures for new params in `test/helpers/track-b.ts` via `isolationFixtures`) |
| B19b Alert call sites (after A15 merges) | §6.4: every trigger the A15 row lists for B. Complaint or safety word detection uses a Thai and English word list kept in the club's settings (editable per club, §8.1) | `bot/flow.ts`, the pause alert from B3 and B16's cost-cap warning: replace the direct `outbox.toStaff` staff-alert sends with `raiseAlert(...)`. `Notifier.confirmed`'s new-booking staff message in `bot/notify.ts` stays as is unless §6.4 classes it as an alert. Add the calls for payment needs review and complaint or safety word (`bot/flow.ts`), table not arrived at release time (`jobs/no-show.ts`) and brain draft or gap waiting (`jobs/brain-draft.ts`) | urgent alert reaches inbox and staff group within 5 s; a paused club raises one alert per conversation per pause through `raiseAlert`; a complaint word raises urgent; a release time passed with no arrival raises urgent; a waiting draft raises needs-input |

#### Task B14b expanded (Handoff episodes)

**Files:** `chat/episodes.ts`, `jobs/handoff-timeout.ts`, `jobs/index.ts` (one `register` line), `bot/flow.ts` (lazy timeout removed, `requestHandoff` calls `startEpisode`), `line/outbox.ts` (`deliver`), `http/staff.ts` (the resolve and reply routes, which waited on B14b), `test/episodes.test.ts`. Migration: no.

**Decisions:**
- One open episode per conversation (`ended_at IS NULL`). `startEpisode` locks the conversation row (`FOR UPDATE`), returns the open episode when there is one (no second row, no second event), else inserts the row, sets `conversations.mode='human'`, `handoff_requested_at`, `handoff_reason`, and emits `handoff.requested {trigger}`. `topic` defaults to `trigger` until B16 passes one. Trigger codes from the flow: `guest_request` (keyword or button), `large_group`, `paid_after_expiry`; `staff_reply` when a host replies to a bot-mode chat (§6.3 "a host opens the chat and replies").
- `endEpisode` is idempotent: an already ended episode returns `undefined` and changes nothing. It sets `ended_at`, `ended_by`, `resolver_user_id`, returns the conversation to `mode='bot'` with the handoff fields cleared, and emits `handoff.resolved` (staff) or `handoff.timed_out` (timeout) with `durationSec`. An optional `actor` (W0 `Actor`) sets the event actor, so a support session stays `platform`.
- `endOpenEpisode(tx, { clubId, conversationId, resolverUserId, actor, now })` is what the dashboard resolve route calls: it ends the open episode, or for a legacy human-mode conversation with no episode row it returns the conversation to the bot and emits `handoff.resolved` from `handoff_requested_at`.
- `recordStaffReply(db, input, send: { outbox, gateways })`: the third argument is added to the published interface because sending needs a gateway. In one transaction: insert the `messages` row (`author_type='staff'`, `author_id`, `external_id`, `occurred_at`) with `ON CONFLICT DO NOTHING` on `(club_id, external_id)`; a repeated `externalId` returns the first row's id and sends nothing. A fresh reply starts an episode if none is open, sets `last_message_id`, and emits `host.replied {latency_ms}` (from the guest's last inbound message; null when none), `source` = `input.channel`. After commit `outbox.deliver` pushes the stored row and records `sent_via`, `delivery_status`, `error`. Delivery is at most once: a crash between commit and push is not retried.
- Timeout job `handoff-timeout` (every minute, B2 Scheduler): last staff activity = the later of `started_at` and the newest staff-authored message of that guest since then. Assumption (spec says only "re-alerts first"): at half the club's `handoffTimeoutMinutes` with no staff activity it raises one urgent `raiseAlert` of kind `handoff_realert` for the conversation (not repeated while no new staff activity); at the full timeout it ends the episode with `endedBy='timeout'`. A run that finds an episode past the full timeout with no re-alert since the last activity re-alerts and ends it in the same run.
- Only `chat/episodes.ts` writes `conversations.mode`; the conversation insert relies on the column default. One exception: the Velora demo seed (`demo/seed-history.ts`) bulk-inserts history, its episode rows and their events directly, so tonight's waiting guest is inserted with `mode: 'human'` together with its open `handoff_episodes` row (calling `startEpisode` would emit a second `handoff.requested` with the wrong time). Every other seeded conversation uses the default.

**Tests (`test/episodes.test.ts`):** `handoff creates one handoff_episodes row`; `recordStaffReply with a repeated externalId sends once`; `the timeout job ends the episode with endedBy='timeout' and returns the conversation to bot mode`; `the timeout job re-alerts at half the timeout and counts from the last staff reply`; `no mode change happens outside chat/episodes.ts`; `dashboard resolve closes the open episode`.

**Migration (Track B, Phase 2):** B17 yes (the per-club test-set table; columns decided in the phase-start writing-plans pass). Others none planned (`handoff_episodes` with `topic`, and the `brain_*` tables with `valid_until` and `review_by`, come from W0).

#### Task B15: Brain store (expanded)

**Files:** `brain/{lint,notes,compile,layout,export,import}.ts`, `jobs/brain-expiry.ts`, `jobs/index.ts` (one start line, the style A15/A16b use until B2's scheduler), `http/staff-settings.ts` and `http/admin/onboarding.ts` (one `regenerateLayoutNote` call after each table or zone write; A17's FAQ step), test `test/brain-store.test.ts`.

**Decisions:**
- Price lint (§8.4): a number next to ฿, บาท, baht or THB, or a number of 100 or more within 30 characters of "minimum spend", "min spend", "deposit", ขั้นต่ำ or มัดจำ, is a `price` issue. Times (`20:00`) and numbers followed by a time unit (hours, days, minutes, ชั่วโมง, วัน, นาที) are not amounts. "available" next to a table, seat or "tonight", "availability", "sold out", "fully booked", โต๊ะว่าง, ยังว่าง, เต็มแล้ว are `availability` issues ("valet parking is available" passes). An `event` note without `validUntil` is `event_needs_end_date`. A failing save throws `BrainLintError { issues }` and writes nothing; the error carries `fix: 'prices'` (the pricing screen).
- Expiry: event and promotion notes are `type: 'event'` and need `validUntil`. Other notes get `reviewBy` = club today + 90 days on create and on every edit. A note whose `validUntil` is before club today (`clubToday`, the night date) leaves the compile at once; the job also sets it `retired` with `frontmatter.retiredReason = 'expired'`. A note past `reviewBy` stays live and is listed for review in the digest (it is not removed).
- Compile: live, in-date notes, ordered by type (policy, faq, layout, event, learned: the §8.4 source order) then slug; the text is pure (no time stamps), hashed with SHA-256. Tokens are estimated as `ceil(utf8 bytes / 4)` (no tokenizer dependency; Thai counts about 0.75 per character). Warn at 40,000, refuse at 60,000: an over-cap compile writes no snapshot, and an approve that would push the brain over the cap is refused and rolled back. A compile whose hash equals the latest snapshot writes nothing.
- Folder import (Obsidian round trip) and paste/photo import create **draft** notes only (`source: 'import'`). A file whose slug exists with a different body becomes a draft with `supersedesId` (the approval screen's "replaces note X"); the same body is skipped. Paste splits on markdown headings, else on blank-line paragraphs; a section failing lint is returned as rejected, not saved. Photo import takes an injected `OcrFn`; there is no OCR provider yet (tests use a fake).
- Layout note: slug `layout`, generated from active zones and tables (codes, guest range, table count per zone; no prices), saved live without approval (it is the club's own data), regenerated after every table or zone write in staff settings and onboarding apply. "Near the DJ" waits for a floor-plan DJ marker; none exists yet.
- Weekly digest: Monday from 10:00 Bangkok, once per club per week (claimed in `platform_flags` key `brain-digest:<clubId>:<monday>`, the A16b pattern; onboarding clubs skipped), an `info` alert `brain_digest` through `raiseAlert` when anything expired in the last 7 days or is due for review.
- Events: `brain.note_drafted` on a draft create, `brain.note_approved`, `brain.note_rejected`; props `noteId`, `noteType`, `source` only.

**Interfaces:**
- `brain/lint.ts`: `lintNote(n: { type: NoteType; title: string; bodyMd: string; validUntil?: string | null }): LintIssue[]`, `class BrainLintError`.
- `brain/notes.ts`: `createNote(db, input: NewNote, actor: Actor, now): Promise<BrainNote>`, `updateNote(db, clubId, noteId, patch, actor, now)`, `approveNote(db, clubId, noteId, actor, now)`, `rejectNote(db, clubId, noteId, actor, now)`, `listNotes(db, clubId, { status? })`, `noteVersions(db, clubId, noteId)`.
- `brain/compile.ts`: `compileText(notes): string`, `estimateTokens(text): number`, `compileSnapshot(db, clubId, now): Promise<CompileResult>`, `latestSnapshot(db, clubId)`, `BRAIN_TOKEN_WARN`, `BRAIN_TOKEN_CAP`.
- `brain/layout.ts`: `regenerateLayoutNote(db, clubId, now): Promise<BrainNote | null>`.
- `brain/export.ts`: `exportObsidianFolder(db, clubId): Promise<NoteFile[]>`, `noteLinks(bodyMd): string[]`. `brain/import.ts`: `importObsidianFolder`, `importPastedText`, `importPhoto(db, clubId, image, ocr: OcrFn, actor, now)`.
- `jobs/brain-expiry.ts`: `runBrainExpiry(db, now)`, `brainDigest(db, clubId, now)`, `sendBrainDigests(db, now)`, `startBrainExpiry(ctx, now)`.

**Tests (`brain-store.test.ts`):** `note with a price is rejected at save`; `compile is deterministic and hashed`; `over 60k refuses to publish`; `export then import round-trips notes and links`; `pasted text becomes draft notes, never live`; `photo import runs the injected OCR and makes draft notes`; `a table change regenerates the layout note`; `an event note without an end date is rejected`; `an expired note is absent from the next snapshot and listed in the digest`. A17: `onboarding.test.ts › apply writes the baseline FAQs into the brain` replaces its todo.

**Migration:** no.

#### Task B16: AI answers (expanded)

**Files:** `brain/{answer,guard,tools,extract}.ts`, `bot/flow.ts` (`handleFreeText`, `prefillBooking`, `book` intent pre-fill, `chooseTable` optional pax, `requestHandoff` `topic` option), `bot/deps.ts` (`BotDepOptions.ai`, `fakeModelClient`), `apps/server/package.json` (dependency `@anthropic-ai/sdk@1.14.0`), test `test/ai-answers.test.ts`.

**Decisions:**
- One model call per guest message, through an injectable `ModelClient` (`bot/deps.ts` builds `anthropicModelClient(config.ANTHROPIC_API_KEY)`; no key, or `ai: null`, keeps today's menu). Tests use `fakeModelClient`; no test reaches Anthropic.
- Prompt: fixed instructions, then the compiled brain (`latestSnapshot`) with the cache breakpoint, then per-message context and the guest text inside `<guest_message>` (data, never instructions). `claude-haiku-5-5` first; on any error `claude-sonnet-5-5` once; both failing hands to a host (`ai_unavailable`). `tool_choice: auto`, one tool call, `effort: low`.
- Tools are terminal (no second model turn): `reply` (the §8.5 fixed result: answer, lang, notes_used, topic, needs_handoff, unclear, summary), `check_availability` and `start_booking` (jump into the button flow with the validated details), `get_booking` (My booking), `request_handoff` (topic + 2-line summary). Only declared fields are read; a `club_id` or `guest_id` in model output is never read; club and guest come from the session.
- Extraction: a deterministic Thai/English pass (`extractBookingDetails`) runs first and costs no tokens. With the `book` intent, a date or table code pre-fills; on other free text, only a table code or a night plus a party size does ("I lost my phone on Saturday" goes to the AI). Model details pass `normalizeDetails` (unknown table codes and past dates dropped). `prefillBooking` jumps to the first unanswered step; a named table that fits the party is held at once with the guest's pax.
- Guard: B15's `lintNote` price and availability detector plus the club's table codes; any amount, table code or availability claim not produced by the booking system in the same turn fails (the live path has no booking result in the turn, so all fail). A failing answer on a price/booking topic goes to the button flow; otherwise to a host with `faq.missed`.
- Cost: `cost_usd_micros` from list prices (haiku 0.10/0.50, sonnet 2/10 $/MTok; cache read 0.1x, write 1.25x). Month spend = sum of the club's `ai.call` events this Bangkok calendar month (test rows included). Cap `platform_flags['ai-cost-cap:<clubId>'].value.usdMicros`, default US$100 when unset. At 80 % a `needs_input` alert `ai_cost_warning`, at the cap an `urgent` alert `ai_cost_cap` (each once per club per month, claimed in `platform_flags` `ai-cost-alert:<clubId>:<YYYY-MM>:<warn|cap>`), through A15's `raiseAlert`. At or over the cap no model call is made and the chat goes to a host.
- Events: `ai.call` (props model, input_tokens incl. cache, output_tokens, latency_ms, cost_usd_micros), `ai.answered` (props notes_used = count, topic; raw `{ noteIds, snapshotVersion, question, answer }`), `faq.missed` (props topic; raw `{ text }`, read by B19 gaps), `bot.fallback_menu` when the model cannot tell what the guest wants.
- Handoff: `chat/episodes.ts` (B14b) is not on this branch, so `requestHandoff` (today's path) is used; the reason text carries the 2-line summary and `opts.topic` is passed for B14b's `startEpisode({ topic })`.

**Tests (`ai-answers.test.ts`):** `guard strips invented price`; `cost cap reached -> hand to host`; `warning raised before cost cap reached`; `Anthropic API down -> hand to host`; `falls back to claude-sonnet-5-5 when claude-haiku-5-5 fails`; `'โต๊ะ 6 คน เสาร์นี้' pre-fills date and pax`; `'17A sat 6ppl' pre-fills table code`; `tool ignores club id in model output`; `unclear message shows button menu and records bot.fallback_menu`; `question the brain cannot answer records faq.missed with the question`; `handoff carries 2-line summary`; `ai.answered logs note ids`.

**Migration:** no.

#### Task B19: Brain manager UI (expanded)

**Files:** `http/brain.ts` (router), `brain/gaps.ts` (gap query, reused by B18), `app.ts` (one mount line), `test/helpers/track-b.ts` (fixture `notes/:noteId`), `pages/staff/brain/Brain.tsx`, `pages/staff/Layout.tsx` (one nav item), `apps/web/src/main.tsx` (one route line), test `test/brain-ui.test.ts`.

**Decisions:**
- All routes are under `/api/staff/clubs/:slug/brain` with `requireClubRole('owner','manager')` (a host or door login is 403). A note id from another club is 404, checked before the body is read.
- Notes (§6.6): every non-retired note with its type, source, `reviewBy`, `validUntil` and last edit; the page groups them by type. The response carries the latest snapshot's version and token count, with `BRAIN_TOKEN_WARN` and `BRAIN_TOKEN_CAP`.
- Approval queue: draft notes. Each shows `frontmatter.question` and `frontmatter.hostReply` when present (B18 writes them; B15 drafts from import and onboarding have none), and the title of the note it replaces (`supersedesId`). Ranked by `frontmatter.takeovers` (count of takeovers on the topic, written by B18) descending, then newest first. Until B18 merges every draft has 0 takeovers, so the order is newest first.
- Approve is one tap: `POST .../notes/:noteId/approve` with no body calls `approveNote`. [Edit] is `PATCH .../notes/:noteId` (`updateNote`, which writes a version row when the body changes) and then approve. [Reject] calls `rejectNote`.
- A note the manager writes (`POST .../notes`, also [Write an answer] on a gap) is saved **live**: the manager is the approver. With `gapTopic`, the note stores `frontmatter.gapTopic`, which closes that gap.
- Gaps: `faq.missed` events of the last 30 days, grouped by `props.topic` (or, with no topic, by the lower-cased question text), most frequent first, with the count, the last time asked and the latest question (`raw.text`, written by B16). A gap is closed when a live note has `frontmatter.gapTopic` equal to its key and was approved after the last miss. A live club does not see test events; the demo club does. B16 emits `faq.missed` with `raw.text`.
- Errors: lint failure 422 `{ error: 'lint', issues, fix }`; over the token cap 409 `{ error: 'over_cap', tokenCount }`; approving a retired note 409 `not_draft`.

**Interfaces:**
- `brain/gaps.ts`: `listGaps(db, club: Club, now: Date, opts?: { days?: number }): Promise<BrainGap[]>` with `BrainGap { key: string; topic: string | null; count: number; lastAskedAt: string; question: string | null }`.
- `http/brain.ts`: `brainRoutes(app: AppContext)`, mounted with `app.route('/api/staff', brainRoutes(ctx))`. Routes: `GET /clubs/:slug/brain/notes`, `GET /clubs/:slug/brain/queue`, `GET /clubs/:slug/brain/gaps`, `POST /clubs/:slug/brain/notes`, `PATCH /clubs/:slug/brain/notes/:noteId`, `GET /clubs/:slug/brain/notes/:noteId/versions`, `POST /clubs/:slug/brain/notes/:noteId/approve`, `POST /clubs/:slug/brain/notes/:noteId/reject`.

**Tests (`brain-ui.test.ts`):** `approve in one tap` (draft goes live and into the snapshot, queue empties); `edit creates a version`; `gaps list shows unanswered questions` (most frequent first, with the latest question); `writing an answer to a gap closes it`; `a live club's gaps exclude test events`; `a lint failure returns the issues`; `queue ranks drafts by takeovers`; `host gets 403`; `another club's note is 404`. `isolation.test.ts` passes with the brain routes (fixture `notes/:noteId`).

**Migration:** no.

#### Task B17: Thai evaluation and per-club test set (expanded)
**Files:** `brain/eval/thai-100.jsonl`, `brain/eval/README.md`, `brain/judge.ts`, `brain/testset.ts`, `brain/compile.ts` (queue a run after each published snapshot), `brain/answer.ts` (export `aiUserContent`, shared with the test runner), `db/schema/brain.ts` (`brain_test_cases`, `brain_test_runs`), `jobs/brain-sample-review.ts`, `jobs/index.ts` (register `brain-testset` and `brain-sample-review`), `bot/flow.ts` + `bot/deps.ts` (`BotDeps.judge`, `fakeJudgeClient`), `scripts/eval-brain.ts`, one `package.json` script line (`eval:brain`), test `test/brain-eval.test.ts`.
**Decisions:**
- Judge: `claude-sonnet-5-5` through an injectable `JudgeClient` (`judge(items)` direct, `submitBatch(items)` / `collectBatch(id)` batch mode). Production `anthropicJudgeClient(key)`; tests `fakeJudgeClient`. No test reaches Anthropic; only `scripts/eval-brain.ts` with `ANTHROPIC_API_KEY` set calls it for real.
- A case has `kind`: `answer` (model replies from the brain, the guard passes, and the judge passes it against `reference`), `handoff` (brain has no answer: `needs_handoff` or `request_handoff`), `booking` (`start_booking`/`check_availability`), `menu` (`unclear`), `trick` (prompt injection or bait: passes unless the answer fails the B16 guard or contains a `mustNotContain` string). `lang` is `th`, `en`, `mixed` or `romanised`. A model error fails the case.
- Thai-100 (`brain/eval/thai-100.jsonl`): 100 cases against the Velora brain (`VELORA` FAQs and policies compiled with `compileText`): 55 Thai, 15 mixed, 10 romanised Thai, 10 English, 10 tricks spread over those languages. Written by us; **a native Thai speaker must review it before the result is used** (README). Pass mark: score at least 0.90 and every trick case passes (assumption; spec gives none). `npm run eval:brain -w @club/server -- --model claude-haiku-5-5` writes `brain/eval/results/<model>.json` and records `platform_flags['brain-eval:thai-100:<model>']`; `thaiEvalDecision` returns the live model to choose (haiku when it passed, else sonnet). The live model constant in `answer.ts` is changed by a person after reading the recorded result.
- Per-club test set: `brain_test_cases` rows (`source` `manual` | `learned` | `baseline`) plus `BASELINE_TRICKS` (one injection each in Thai, English, mixed, romanised, plus a bait for a price) run for every club. B18 adds the approved note's question through its published `addTestSetQuestion(db, clubId, { question, noteId, source: 'learned' }, now)`, which writes a `brain_test_cases` row (`kind 'answer'`, reference = note body); `clubTestSet` reads them back.
- Runs: `compileSnapshot` inserts a `pending` `brain_test_runs` row (`trigger 'snapshot'`) after every published snapshot, in the same transaction, coalesced to one pending run per club. Job `brain-testset` (every minute) first queues `trigger 'model_change'` for each club with a snapshot whose `platform_flags['brain-testset-model:<clubId>']` differs from the live model, then runs pending runs against the latest snapshot. Run passes at score >= 0.90 with every trick passing. A failed run raises a `needs_input` alert `brain_testset_failed`; it never changes a note (the note stays live, §8.3 step 6). No model client: runs stay pending. A claimed run stores `results.claimedAt`; one left `running` for over 30 minutes (crash) is put back to `pending` (`requeueStaleRuns`).
- Sampled quality review (`jobs/brain-sample-review.ts`, every 15 minutes): once per club per Bangkok day (claimed `platform_flags['brain-sample-review:<clubId>:<date>']`), up to 20 of yesterday's `ai.answered` events (test rows excluded except for demo club) go to the judge in batch mode as a `trigger 'sample_review'` run with `results.batchId`; later passes collect it, record score, and raise `needs_input` alert `ai_quality_review` under 0.90.
**Interfaces:**
- `brain/judge.ts`: `JUDGE_MODEL = 'claude-sonnet-5-5'`, `interface JudgeItem { id; question; answer; reference: string | null; brain?: string; lang }`, `interface JudgeVerdict { id; pass: boolean; score: number; reason: string }`, `interface JudgeClient { judge(items): Promise<JudgeVerdict[]>; submitBatch(items): Promise<string>; collectBatch(id): Promise<JudgeVerdict[] | null> }`, `anthropicJudgeClient(apiKey)`.
- `brain/testset.ts`: `type TestCase`, `BASELINE_TRICKS`, `TESTSET_PASS_SCORE = 0.9`, `evaluateCases({ client, judge, model, brain, today, tableCodes, cases }): Promise<EvalResult>`, `addTestCase(db, input)`, `listTestCases(db, clubId)`, `queueModelChangeRuns(db, model, now)`, `runPendingTestRuns(db, { client, judge, model? }, now)`, `loadThai100()`, `veloraEvalBrain()`, `runThai100({ client, judge, model })`, `recordModelEval(db, result, now)`, `modelEvalResult(db, model)`, `thaiEvalDecision(result)`.
- `jobs/brain-sample-review.ts`: `runSampleReview(db, judge: JudgeClient | null, now)`.
**Tests (`brain-eval.test.ts`):** `thai-100 set has 100 well-formed cases`; `100-question Thai set scored by claude-sonnet-5-5 as judge`; `result recorded before choosing the live model`; `snapshot compile runs the club's test set and records the score`; `model id change runs the club's set`; `prompt-injection case passes`; `failed run raises alert and note stays live`; `sampled answers are judged in batch mode`.
**Migration:** yes (`b17_testset`).

#### Task B18: Learning loop (expanded)
**Files:** `brain/learn.ts`, `jobs/brain-draft.ts`, `jobs/brain-lint.ts`, `jobs/index.ts` (register `brain-draft`, `brain-lint`), `brain/notes.ts` (`approveNote` adds the question to the test set), `bot/flow.ts` + `bot/deps.ts` (`BotDeps.learn`, `BotDepOptions.learn`, `fakeLearnClient`), tests `test/learning-loop.test.ts`; `test/brain-ui.test.ts` (queue tests use real drafts); `test/booking-history.test.ts` (job list).
**Decisions:**
- Model `claude-opus-5-5` through an injectable `LearnClient` (`draft(reqs[])` one batch per run, `check(req)` weekly). Production `anthropicLearnClient(ANTHROPIC_API_KEY)`: structured output (`output_config.format` JSON schema), effort `high`, brain behind the cache breakpoint, transcript in `<transcript>` as data. Drafting is a direct call per episode (requests of a run in parallel), not the Message Batches API: spec §8.3/§17.1 need the draft queued within 60 s and §8.6 says drafting is direct. Every call emits `ai.call` (opus $4/$20 per MTok, cache read $0.20, write $5), so drafting counts toward the B16 cost cap. Tests use `fakeLearnClient`.
- Job `brain-draft` every minute (B2 scheduler): each ended episode of the last 28 days is handled once, claimed in `platform_flags['brain-learn:<episodeId>']` with its outcome. Drafted only when ended by staff and the transcript holds a host reply (`messages.author_type='staff'`); `timed_out`, `no_host_reply`, `no_client` are claimed without a draft. A failed model call is not claimed: it waits as `{ outcome: 'retrying', attempts, retryAfter }` (backoff 1, 5, 30, 120 min) and is retried, at most 5 attempts in all, then claimed `invalid`; a refusal, an unparseable reply or a 4xx request error is claimed `invalid` at once. The claim, note flags and draft are saved in one transaction.
- Transcript: from the episode's first to last message (plus the guest message before it when the takeover started on a host reply), lines `Guest:`/`Host:`/`Bot:`. Redacted before the model sees it: phone numbers, emails, LINE ids and handles, booking refs (`XX-XXXX`), account and long digit runs, the guest display name and staff names.
- Discard (§8.3 step 4): `worth_learning` false, any model flag (price/availability, personal data, one-off), a phone number/email/LINE id/booking ref anywhere in the draft (`containsPersonalData`), or a B15 lint issue. Kept drafts: `createNote({ type: 'learned', source: 'takeover', sourceEpisodeId, supersedesId (kind 'edit' + live slug) })`, body `Q: …\nถาม: …\n\n<answer>`, frontmatter `question` (the guest's redacted question), `questionEn`, `questionTh`, `hostReply` (redacted host lines), `takeovers` (episodes on the topic in 30 days), `topic`, `episodeId`, `contradicts?`, `gapTopic` (when the topic is an open `listGaps` key, so approval closes the gap).
- Takeover within 10 minutes of a bot answer (inclusive): when the episode is handled, every note in `ai.answered` raw.noteIds for that conversation in `[startedAt − 10 min, startedAt]` gets `frontmatter.flaggedForReview { episodeId, takeoverAt }` and `reviewBy` = club today (it shows in the B15 weekly digest).
- Approval: `approveNote` adds `question`, `questionEn`, `questionTh` (distinct) to the club test set via B17's `addTestSetQuestion`.
- Draft expiry: `takeover` drafts older than 28 days are retired with `frontmatter.retiredReason = 'unreviewed'` (no event).
- Weekly lint `brain-lint` (every 15 min, acts Monday from 10:00 Bangkok, once per club per week, `platform_flags['brain-lint:<clubId>:<monday>']`): B15 price/availability lint, personal data, duplicate bodies, and the model's contradiction/duplicate/price/personal-data list (unknown slugs dropped). Notes with issues get `frontmatter.lintIssues` and `reviewBy` = today; one `info` alert `brain_lint`.
**Interfaces:** `brain/learn.ts`: `LEARN_MODEL`, `interface LearnClient { draft(reqs: DraftRequest[]): Promise<LearnResult[]>; check(req: CheckRequest): Promise<LearnResult> }`, `anthropicLearnClient(apiKey)`, `runLearning({ db, client, log }, now): Promise<LearnRunResult>`, `episodeTranscript(db, episode)`, `redactText(text, names)`, `containsPersonalData(text)`, `flagNotesBeforeTakeover(db, club, episode, now)`, `expireUnreviewedDrafts(db, now)`. `jobs/brain-draft.ts`: `runBrainDraft(deps, now)`. `jobs/brain-lint.ts`: `lintClubBrain(deps, club, now)`, `runBrainLint(deps, now)`. `bot/deps.ts`: `fakeLearnClient(draft, check?)`.
**Tests (`learning-loop.test.ts`):** `approved note answers the same question next time`; `draft with a phone number is discarded`; `price, one-off and personal-data flags discard the draft`; `the transcript is redacted before the model sees it`; `a timed-out takeover, or one without a host reply, drafts nothing`; `a failed model call is retried on the next run`; `a takeover within 10 minutes of a bot answer flags the notes that answer used, and one after 11 minutes does not`; `an approved note adds its question to the club test set`; `a draft unreviewed for 4 weeks expires`; `drafting cost is an ai.call event at the claude-opus-5-5 price`; `a draft on an open gap topic closes the gap once approved`; `weekly lint flags a leaked phone number and a contradiction the model finds`. `brain-ui.test.ts › approve in one tap` and `› queue ranks drafts by takeovers` use real B18 drafts.
**Migration:** no.

---

## Phase 3: Channels, POS and busyness feed

Gate (spec §10): 3 paying clubs; one club live on Instagram; the feed publishes a level for every live club on every open night.

### Track A, Phase 3

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| A18 Instagram via Chatwoot | §11.5: native Chatwoot inbox, text + attachments, OAuth in Chatwoot UI; needs Meta approval | `integrations/chatwoot/instagram.ts`, `channels` rows | Instagram message lands in the club's inbox and as `data_origin='instagram'` events, which no cross-club view reads |
| A19 POS live sync | §11.3: Papaya (reservation at check-in with `payments[]`, webhooks `order.totalsUpdated`, two keys per outlet), Loyverse closed receipts | `integrations/pos/{papaya,loyverse}.ts` implementing `PosAdapter` | sandbox: deposit at check-in shows on the bill (§16.1 q15); webhook updates `pos_bills` totals idempotently |
| A20a Promoters | §4 Promoter role, §5.1 promoter link, §6.2 bookings by promoter, §10 Phase 3 "promoter links + commission tracking", §14.10 top promoters. Attribution lives in A's `promoter_attributions` (keyed by booking id) because `bookings.promoter_id` is B's column; B may later add it and backfill from this table | `db/schema/platform.ts` (`promoters`, `promoter_attributions`), `platform/promoters.ts` (`createPromoter(db, clubId, {name, code, commissionBps?, userId?}, now)`, `updatePromoter(db, clubId, id, patch)`, `listPromoters(db, clubId)`, `promoterLink(publicUrl, club, code)` → `<PUBLIC_URL>/r/p/<slug>/<code>`, `attributeBooking(db, clubId, bookingId, {promoterId?, code?}, via: 'link' or 'manual', actorId, now)`, `removeAttribution(db, clubId, bookingId)`, `promoterReport(db, clubId, from, to)`, `topPromoters(db, clubId, weekStart)`), `http/staff-promoters.ts` (mounted in `http/staff.ts`: `GET/POST /promoters`, `PATCH /promoters/:promoterId`, `GET /promoters/report`, `PUT/DELETE /bookings/:id/promoter`, `GET /promoter/me` for the promoter role), `platform/club-report.ts` (`topPromoters`), `pages/staff/Promoters.tsx`. B (later): the `/r/p/...` redirect in `http/redirect.ts` and the bot carry the code to the hold and call `attributeBooking(..., 'link', ...)` | `test/promoters.test.ts`: `code is unique per club and lowercase`; `manual attribution is club-scoped` (club B booking or promoter → 404); `link attribution never replaces a manual one`; `report counts held bookings, arrivals, pax and commission per promoter` (commission = bps × POS spend, or × minimum spend without a bill, arrived bookings only); `test rows excluded for a live club`; `promoter sees only their own bookings, no guest name or phone`; `host cannot create a promoter (403)`; `weekly report lists top promoters, null with no promoters`; isolation passes (fixture `promoters/:promoterId`) |
| A20b Payment gateway option | §7.3 Phase 3 option, §11.2, §17 risks. **Owner override 2026-11-27:** the legal-review gate is waived; build it | `integrations/payments/{gateway,opn}.ts` (`PaymentGateway` interface: `createCharge(club, {bookingId, amountSatang, returnUrl})` → `{chargeId, payUrl}`, `verifyWebhook(rawBody, signature)`; Opn/Omise adapter; fake in tests), `deposits.method='gateway'`, `POST /webhooks/payments/:provider` confirming the deposit through B's booking service, club switch `payment_gateway` off by default | `test/payment-gateway.test.ts`: `bad signature is 401 and changes nothing`; `paid webhook confirms the deposit once (replay is a no-op)`; `amount mismatch raises an alert and does not confirm`; `charge for another club's booking is rejected`; `switch off means slip flow only` | B2 |
| A20c Guest CRM and VIP tags | §6.2 "add notes and VIP tags", §2 manager pain (no guest history), §9 test rows hidden from staff once live. Owner, manager and host; every lookup club-scoped | `db/schema/platform.ts` (`guest_tags`, `guest_notes`), `platform/crm.ts` (`normalizeTag(tag)`, `searchGuests(db, club, {q?, tag?, limit?})`, `guestProfile(db, club, guestId)`, `addTag`, `removeTag`, `addNote`, `vipSummary(db, clubId, weekStart)`), `http/staff-crm.ts` (mounted in `http/staff.ts`: `GET /guests`, `GET /guests/:guestId`, `POST /guests/:guestId/tags`, `DELETE /guests/:guestId/tags/:tag`, `POST /guests/:guestId/notes`), `pages/staff/Guests.tsx` | `test/crm.test.ts`: `search by name, phone or tag`; `tags are normalised and idempotent`; `profile shows bookings, visits, no-shows, spend, tags and notes`; `notes are append-only with author`; `another club's guest is 404`; `test guests hidden for a live club`; `door role gets 403`; `weekly report has a VIP section`; isolation passes (fixtures `guests/:guestId`, `tags/:tag`) |
| A20d Reports | §14.10, §6.5 | A16 and A16b cover the weekly report and stats. A20d adds only `topPromoters` (A20a) and `vip` (A20c) to `buildClubReport` and the `/report` page | covered by the A20a and A20c report tests |

**Migration (A20):** yes, one migration `a20` with `promoters`, `promoter_attributions`, `guest_tags`, `guest_notes` (all in `db/schema/platform.ts`). Request to B: `bookings.promoter_id` and `source='promoter'` on link bookings, set by the bot when it calls `attributeBooking`.

#### Task A20b expanded: Payment gateway option

**Spec:** §11.2 Phase 3 option, §17 risks. **Migration:** no (`deposits.method` is a text column; `'gateway'` is a type-level addition). Owner override 2026-11-27: the legal-review gate is waived.

**Decisions**
- Provider: Opn Payments (Omise API) is the first adapter; others implement the same `PaymentGateway`. One platform Opn account, configured by `OPN_SECRET_KEY` and `OPN_WEBHOOK_SECRET` (platform keys, not per-club; a club needs none to switch the option on). Payouts in the club's name (Opn sub-merchants) are an account setup matter, not code. Unset keys mean no `opn` gateway is registered (the webhook answers 404).
- The charge is a PromptPay source charge (`source[type]=promptpay`, currency `thb`, amount in satang). `payUrl` is the charge's `authorize_uri`, else the QR image URI. Charge `metadata` carries `club_id`, `booking_id` and `deposit_id`. `createCharge` is idempotent per deposit (`Idempotency-Key: <depositId>`), so a guest who taps again gets the same charge.
- The gateway deposit row: `method = 'gateway'`, `slip_trans_ref = '<provider>:<chargeId>'` (unique per club, so a charge id maps to one deposit). No slip, so `slip_path` stays null. A slip the guest still sends for a gateway deposit (the slip flow is the fallback when `createCharge` throws) is stored by `recordSlip`, but `verifySlip` never writes the bank's reference over `slip_trans_ref` (only `slip_amount_satang`, `slip_receiver`, `slip_time`) and sends it to review with code `gateway_deposit`, so the payment webhook still finds the charge.
- Confirmation goes through B's service: `approveDeposit(db, clubId, bookingId, { type: 'system', id: 'payments:<provider>' }, now)`, which writes history, audit and `deposit.verified` in one transaction. The guest and staff are told through `notifier.confirmed` (tracked background work).
- Webhook `POST /webhooks/payments/:provider`: unknown provider 404; bad or missing signature 401 and nothing written; a verified delivery is stored in `raw_webhooks` (channel `payments:<provider>`) before it is applied. Non-successful charge events are acknowledged and ignored. A deposit already `verified` is a no-op (replay). Charge metadata whose club or booking differs from the deposit is 409 `charge_mismatch`, an urgent alert, no confirmation. Amount or currency different from the deposit: urgent alert `payment_amount_mismatch`, no confirmation, 200 (the provider must not retry). A successful charge we cannot match: urgent alert on the metadata club if it exists. Table taken meanwhile (hold expired, table resold): urgent alert `payment_table_lost`, 200.
- Opn signature: header `Omise-Signature` (comma-separated hex HMAC-SHA256 values during key rotation) over `<Omise-Signature-Timestamp>.<raw body>`, key = base64-decoded webhook secret, compared in constant time. The route asks the gateway for its signature (`signatureOf(header)`), so `verifyWebhook(rawBody, signature)` stays two-argument.
- Switch: feature key `payment_gateway`, default off. Off: `startGatewayDeposit` returns null and the caller keeps the PromptPay slip flow; the webhook still verifies but `startGatewayDeposit` never creates gateway deposits, so nothing changes.
- Bot wiring (done by the integrator): `BotDeps.payments` (from `createApp`'s map). `confirm` (deposit > 0) and `continueBooking` (an `awaiting_payment` booking whose deposit is `method='gateway'`) call `startGatewayDeposit` with the first configured gateway and send `M.paymentLink` (a flex card whose button opens `payUrl`). Null, or a provider throw, keeps `M.payment` (slip flow). Return URL assumption: `https://line.me/R/` (back to LINE, where the confirmation arrives). Gateway alerts are raised once while the same one is open, so provider retries of a 409 do not repeat it.

**Interfaces** (`integrations/payments/gateway.ts`)
```ts
export interface PaymentCharge { chargeId: string; payUrl: string }
export interface PaymentEvent { eventId: string; chargeId: string; status: 'successful' | 'failed' | 'pending'; amountSatang: number; currency: string; clubId?: string; bookingId?: string }
export interface PaymentGateway {
  readonly provider: string;
  createCharge(club: Club, req: { bookingId: string; depositId: string; amountSatang: number; returnUrl: string }): Promise<PaymentCharge>;
  signatureOf(header: (name: string) => string | undefined): string | undefined;
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null;
}
export type PaymentGateways = Record<string, PaymentGateway>;
export async function startGatewayDeposit(db: Db, club: Club, gateway: PaymentGateway, bookingId: string, returnUrl: string, now: Date): Promise<PaymentCharge | null>
export async function applyPaymentEvent(db: Db, provider: string, event: PaymentEvent, now: Date): Promise<PaymentOutcome>
export function fakePaymentGateway(secret?: string): PaymentGateway & { sign(body: string): string; charges: ... }
```
`integrations/payments/opn.ts`: `opnGateway({ secretKey, webhookSecret, fetch? })`. `http/payments.ts`: `paymentWebhookRoutes(ctx)` mounted at `/webhooks/payments`; `createApp` takes `opts.payments` (default: Opn from config when both keys are set).

**Tests** (`test/payment-gateway.test.ts`): `bad signature is 401 and changes nothing`; `paid webhook confirms the deposit once (replay is a no-op)`; `amount mismatch raises an alert and does not confirm`; `charge for another club's booking is rejected`; `switch off means slip flow only`; plus `opn adapter signs and parses like Omise` (fake fetch, no network). Added by the integrator: `bot sends the gateway payment link when the switch is on, the slip flow when off`.

### Track B, Phase 3

| Task | Scope (spec) | Files | Acceptance tests |
|---|---|---|---|
| B20 Cross-club identity map | §14.4: `person_id` across clubs, built on the `identity_map` pairs stored since Phase 1b (the shared LIFF is A4b, the first-use `sub` pair is B5, and the `liff.sendMessages()` device check is in the Phase 1b gate). Adds the phone-hash link and fills `events.person_id` | `data/identity.ts` | same LINE person at two clubs gets one `person_id`; the same phone hash at two clubs links to one `person_id`; removal (B10b) deletes the links |
| B21 Busyness feed v1 | §14.7: `GET /data/v1/busyness`, 5-step level per club per 30-min bucket relative to capacity, "no data" when inputs are thin, staged model (booking heat → weekday baseline × pace) | `data/busyness.ts`, `http/data.ts` (API key auth for the separate app) | level for every live club on a night whose `nights.status` is not `closed`; demo club never appears; no guest-level field; reads only `first_party` and `pos` origins |
| B22 Waitlist, bottle pre-orders | §10 Phase 3 | expand at phase start | expand at phase start |

**Migration (Phase 3, both tracks):** none planned (`identity_map` and `channels` come from W0). B21's route is outside `/api/staff` and `/api/admin` (API-key auth), so the isolation walk does not reach it; its own acceptance tests are the control. Confirm in the phase-start writing-plans pass.

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
| Create the platform LINE Login channel and LIFF app under our own provider (LINE Developers Console), and run the `liff.sendMessages()` cross-provider check on a device | A4b gate item, B5 on a real phone | §11.1.1, §16.1 q3 |
| Row-level security backup: build it now as A2b, or defer it (assumed: deferred; the service-layer checks plus the isolation suite are the control) | A2b | §12.1 |
| Where the weekly club report goes on LINE: the staff group (assumed) or the manager's own LINE, which needs a LINE id on `users` | A16b | §14.10 |
| Club statuses as written in §12.3, including how a tester is registered: a one-time code from the wizard typed in the chat (assumed) | B6 tester code, A5 tester-code route | §16.1 q22 |

## Session start prompts

Paste one into each session after the setup step above.

**Session A:**
> You are Session A (Track A: Platform) for `docs/superpowers/plans/2026-11-26-club-platform-build.md`, working in this worktree on branch `track-a`. Read the plan header sections (Global Constraints, Review Focus, How the two sessions work together) and `clubs/SPEC.md` sections named by each task. Do Task W0 first and merge it, then A1 to A7 in order (A4b comes straight after A4), then later phases as the plan says. Only change files your track owns or the listed shared edits. The `Actor` and `Reason` types and the booking-service signatures are frozen once W0 merges. W0 also creates the files Track B owns afterwards (`bot/deps.ts`, `jobs/index.ts`, `data/events.ts`, `data/event-types.ts`, `chat/conversations.ts`, `test/helpers/track-b.ts`), the frozen fixture club `test/fixtures/club.ts` and your `test/helpers/track-a.ts` (`testConfig`, `staffCookie`, `staffUrl`, `adminCookie`, and from A2 `routeTable` and `isolationFixtures`); change those helpers, never the bodies of B's test files. `CredentialStore` has `channelSecret`, `line` and `login`. Write events with `emit` and names from `data/event-types.ts` only. Every task states Migration yes or no: for a yes, take the migration lock and pass `--name`. The platform is the data controller and consent is handled: add no consent gate. Use superpowers:subagent-driven-development for each task, `/code-review` before each merge, and record merges and published interfaces in `docs/superpowers/plans/sync/track-a.md`. Read `sync/track-b.md` after every rebase. Do not merge with failing tests.

**Session B:**
> You are Session B (Track B: Guest and Data) for `docs/superpowers/plans/2026-11-26-club-platform-build.md`, working in this worktree on branch `track-b`. Read the plan header sections (Global Constraints, Review Focus, How the two sessions work together) and `clubs/SPEC.md` sections named by each task. Do Task B0 now; its last step (`applyClubContent`) and B1 start only after Session A's W0 is merged to `main` (check `sync/track-a.md`). Then B1 to B8 in order (B4b comes straight after B4, B8b after B8), then later phases as the plan says. Only change files your track owns or the listed shared edits. The `Actor` and `Reason` types and the booking-service signatures from W0 are frozen; register jobs in `jobs/index.ts` and bot dependencies in `bot/deps.ts`, not in `main.ts` or `app.ts`. Event names come only from `data/event-types.ts`. Routers you mount under `/api/staff` or `/api/admin` are walked by A's isolation and admin-403 suites (`routeTable`): add fixtures for your route params in `test/helpers/track-b.ts` (`isolationFixtures`). Tests use the fixture club (`test/fixtures/club.ts`), not Velora. Your listed shared edits in A's files are B4 (`line/setup.ts`), B5 (`http/staff.ts`, `pages/staff/Settings.tsx`), B19 (`pages/staff/Layout.tsx`) and route mount lines in `app.ts`. Every task states Migration yes or no: for a yes, take the migration lock and pass `--name`. The platform is the data controller and consent is handled: add no consent gate. Use superpowers:subagent-driven-development for each task, `/code-review` before each merge, and record merges and published interfaces in `docs/superpowers/plans/sync/track-b.md`. Read `sync/track-a.md` after every rebase. Do not merge with failing tests.
