# Track B sync (Session B: Guest and Data)

Append-only. Newest entry last. Track A: read after every rebase.

---

## 2026-11-27 · B0 (part 1 of 2): baseline + Velora content

**Base:** `track-b` cut from `origin/spec-v2` (f5c2891). `spec-v2` is not merged to `main` yet; rebase onto `main` once it is.

**Baseline on a clean checkout:** `npm install` ok (0 vulnerabilities), `npm test` 33/33 green, `npm run typecheck` clean. Nothing needed fixing.

**Merged / ready:** `apps/server/src/demo/velora-content.ts` (pure data, no imports) + `apps/server/test/velora-content.test.ts` (10 tests). Suite now 43/43.

**Interface published (B0):**
```ts
// apps/server/src/demo/velora-content.ts
export const VELORA: {
  zones: VeloraZone[];          // code, kind (vip|booth|high|standing), name_en, name_th, sort, minSpendSatang, depositSatang (base = Wednesday)
  tables: VeloraTable[];        // code, zone (zone code), minPax, maxPax, floorX, floorY (0–100 grid), shape, sort, minSpendSatang|null, depositSatang|null
  priceRules: VeloraPriceRule[];// scope (club|zone|table), target (code|null), weekday (0–6|null), minSpendSatang, depositSatang, priority, label
  policies: { en: string; th: string }[];
  faqs: { slug: string; question_en: string; question_th: string; answer_en: string; answer_th: string }[];
  gaps: { question_en: string; question_th: string; answer_en: string; answer_th: string }[];
  profile: VeloraProfile;       // club_profile fields (camelCase) + openWeekdays, openingHours, arrivalCutoff, eventNight
};
```
Content: 4 zones, 22 tables, 12 price rules (Fri/Sat weekend priority 10, Thursday event night priority 20), 9 policies, 25 FAQs, 3 gaps (private room hire, wheelchair access, re-entry), profile.

**Notes for whoever writes Velora into the database (B0 part 2, B7, A5):**
- Price rules use `weekday` for the weekly event night (Thursday). `night_id` is unused because there is no nights table yet.
- Table-level prices are all `null` (zone prices apply). The zone base price is the Wednesday price; `applyClubContent` should copy it into the existing zone price columns, which the booking flow still reads.
- FAQ answers and policies contain no amounts and no table codes (a test enforces it), so they pass the B15 save-time price lint.
- Thai text needs a native-speaker read before the demo.

**Requests for Track A** (found running the bot against a real LINE account; files are A-owned, so not changed here):
1. `line/setup.ts`: `richMenuRequest().chatBarText` must be **≤ 14 characters**. LINE rejected `"Book a table · จองโต๊ะ"` with `400 chatBarText: must not be longer than 14 characters`. `"Book a table"` works.
2. `npm run live` on macOS: Vite listened on IPv6 `::1` while the script health-checked `127.0.0.1`, so start-up failed after 60 s. Fix used locally: pin Vite `server.host: '127.0.0.1'`, proxy target `http://127.0.0.1:8787`, and point ngrok/cloudflared at `127.0.0.1:5173`. (`apps/web/vite.config.ts` and `apps/server/src/scripts/live.ts` are not in the ownership table; owner to decide.)

**Blocked:** B0 part 2 (`demo/apply-content.ts` + `apply-content.test.ts`) waits for W0 to merge to `main` (needs `price_rules` and `setupTwoClubs`).

---

## 2026-11-27 · B0 (part 2 of 2): applyClubContent, built by Session A on track-a

**Done on `track-a`** (one session builds both tracks). Migration: none.

**Interface published (B0):**
```ts
// apps/server/src/demo/apply-content.ts
export async function applyClubContent(tx: Db, clubId: string, content: typeof VELORA): Promise<void>;
```
- Inserts zones (`name` = `name_en`, base Wednesday price in `zones.min_spend_satang` / `deposit_satang`), tables (codes, pax, floor x/y, shape, sort; table prices copied as given, all null for Velora), and one `price_rules` row per content rule (`scope_id` = the new zone/table id, `weekday` kept, `night_id` null, `valid_from` null). The base price is not also written as a `price_rules` row.
- Policies become `clubs.settings.rules = { en: [...], th: [...] }` (other settings kept; `rulesVersion` unchanged).
- No history, no brain notes, no FAQ rows, no profile, no status change. Throws on an unknown zone/table code or missing club, so the caller's transaction rolls back. For a club with no tables yet (table codes are unique per club).
- Call with the transaction handle.

**A5 fallback removed:** `POST /api/admin/clubs {template:'velora-like'}` now creates the club and calls `applyClubContent` in the club-insert transaction (201). `admin.test.ts` 501 test replaced by the former `it.todo` "a velora-like club gets complete settings, a channels row, a refPrefix no other club has, and Velora tables and prices".

**Assumptions / unverified:** none needs a human decision or an external service. **Browser walk:** creating a velora-like club from the console is still to be walked by a human.

**Tests:** `apply-content.test.ts` › `applyClubContent writes tables and prices for a new club id`, › `rejects a table whose zone is not in the content`. Deviation: `setupTwoClubs().clubB` already has tables V1/V2/S1/S2 (Velora reuses those codes, unique per club), so the test inserts a fresh club next to clubA/clubB and checks clubB is untouched.

---

## 2026-11-27 · B13: Calendar days, built by Session A on track-a

**Done on `track-a`** (one session builds both tracks). Migration: none (`calendar_days` from W0).

**Interface published (B13):**
```ts
// apps/server/src/data/calendar.ts
export async function upsertCalendarDay(db: Db, input: { date: string; kind: string; name: string; notes?: string }): Promise<void>;
export async function seedCalendarDays(db: Db): Promise<number>; // rows inserted; existing rows kept
export async function alcoholBanDates(db: Db, from: string, to: string): Promise<Set<string>>; // inclusive, YYYY-MM-DD
export class CalendarDayError extends Error { code: 'bad_kind' | 'bad_date' | 'bad_name' }
// apps/server/src/data/calendar-seed.ts
export const CALENDAR_SEED: readonly CalendarSeedRow[];
```
- Key is `(date, kind, name)`. A repeat is a no-op; a repeat with `notes` updates only `notes`. `kind` must be one of `public_holiday | holy_day | alcohol_ban | election | city_event`; the date must be a real `YYYY-MM-DD` day. No event emitted.
- Seed: 2026 and 2027 national public holidays (substitution days carry `notes: 'substitution day'`), the five Buddhist days as both `holy_day` and `alcohol_ban`. 2027 lunar dates carry `notes: 'lunar date, confirm against the cabinet announcement'`: a person must check them against the official announcement. `main.ts` runs `seedCalendarDays(db)` at boot after `seedDemoClub`.

**A9 fallback removed:** `POST /api/admin/calendar-days` now calls `upsertCalendarDay`, audits `platform.calendar_day_set` (club_id null, entity `calendar_days`, entityId `date:kind:name`) and answers 200 `{ ok: true }`. The 503 test in `settings.test.ts` is replaced by the former todo "an election day entered from the console appears in calendar_days". The console Club page has a City calendar day form (`adminApi.saveCalendarDay`).

**For B8b:** the `nights` job closes a date in `alcoholBanDates(db, from, to)` with `closed_reason = 'alcohol_ban'` on rows with `edited_by` null. `calendar.test.ts` › `the next nights job run closes a new alcohol-ban day on rows nobody edited` is a real test since B8b.

**Tests:** `calendar.test.ts` (4 pass, 1 todo); `settings.test.ts` (16 pass).

**Assumptions in place of a human decision:** the 2026 and 2027 holiday list and the lunar dates were written from the published full-moon calendar, not from a checked government source; the 2027 lunar rows carry the confirm note.

**Unverified against a real source:** the seed dates (no cabinet announcement was read). **Browser walk:** the console City calendar day form on the Club page is still to be walked by a human (typecheck and `npm run build -w @club/web` green).

## 2026-11-27 · B1: Event log core, built by Session A on track-a

Migration: none (`events_dead_letter` from W0).

**Published (`src/data/event-types.ts`):** `EVENT_DECLARATIONS` (one entry per type: `v`, `area`, `description`, `props: { key: 'none' | 'pseudonymous' | 'personal' }`, optional `raw` class), `EventType = keyof typeof EVENT_DECLARATIONS`, `EVENT_TYPES` (same names, declaration order; still exported), `eventDeclaration(type)`, `PrivacyClass`, `paxRangeCode(key: PaxRangeKey): 'p2_4' | 'p5_8' | 'p9_12' | 'p13_plus'`. Declared: every §14.2 name plus `booking.status_changed`, `link.opened`, `guest.removal_requested`, `guest.removed`, `staff.invited`, `staff.invite_accepted`, `staff.role_changed`, `staff.disabled`. `STATUS_EVENTS` is left to B2 (its shape follows `changeStatus`).

**Published (`src/data/events.ts`):** `emit(tx, e, opts?)` signature unchanged. It now validates against the declaration: unknown type, an undeclared props key, or a props value that is not a number, boolean, null or a string matching `PROPS_VALUE_PATTERN` (`/^[A-Za-z0-9_:.\-]{1,64}$/`). Strict (throws `EventValidationError`) when `opts.strict` is true, default `NODE_ENV === 'test'`; otherwise the event goes to `events_dead_letter` in the same transaction and the caller continues. Row `v` comes from the declaration. Also exported: `eventProblems(e)`.

**Rule for every task that emits:** a new props key needs a line in `EVENT_DECLARATIONS` and `npm run events:doc -w @club/server` (regenerates `docs/EVENTS.md`; `events.test.ts › generated doc is current` fails otherwise). Props keys missing from an event are allowed (keys are optional). Tasks that later emit a declared event may add props keys; renaming or removing one bumps `v`.

**Caller fixes (props failed the pattern):** `club.settings_changed` `fields` is now joined with `:` (was `,`; `settings.test.ts` updated); `club.event_night_created` moved `eventName` to `raw`.

**A8 fallback removed:** `http/team.ts` now emits `staff.invited` (`inviteId, role, via`), `staff.invite_accepted` (`inviteId, role`), `staff.role_changed` (`from, to`), `staff.disabled` (`role, sessionsRevoked, accountDisabled`) beside the audit rows. Test: `invites.test.ts › team changes emit staff.invited, staff.invite_accepted, staff.role_changed and staff.disabled`.

**Assumptions / unverified:** privacy classes per props key were chosen by this session from spec §14 (no human review yet); no external service involved. No web change.

**Tests:** `events.test.ts` (8 pass); `invites.test.ts` (+1); full suite green with B15.

## 2026-11-27 · B15: Brain store, built by Session A on track-a

Migration: none (`brain_*` tables from W0).

**Published:**
```ts
// brain/lint.ts
export const NOTE_TYPES: readonly ['faq', 'policy', 'layout', 'event', 'learned']; export type NoteType;
export function lintNote(n: { type; title: string; bodyMd: string; validUntil?: string | null }): LintIssue[]; // code: 'price' | 'availability' | 'event_needs_end_date'
export class BrainLintError extends Error { issues: LintIssue[]; fix: 'prices' }
// brain/notes.ts
export async function createNote(db, input: NewNote, actor: Actor, now: Date): Promise<BrainNote>; // draft by default; lint first; version row; emits brain.note_drafted
export async function updateNote(db, clubId, noteId, patch: NotePatch, actor, now): Promise<BrainNote>; // new version on body change; a live note recompiles
export async function approveNote(db, clubId, noteId, actor, now): Promise<BrainNote>; // retires supersedesId; recompiles; throws BrainCapError over 60k (rolled back)
export async function rejectNote(db, clubId, noteId, actor, now): Promise<BrainNote>;
export async function listNotes(db, clubId, opts?: { status? }): Promise<BrainNote[]>;
export async function noteVersions(db, clubId, noteId);
export function slugify(title: string): string;
// brain/compile.ts
export const BRAIN_TOKEN_WARN = 40_000, BRAIN_TOKEN_CAP = 60_000;
export function compileText(notes): string; export function estimateTokens(text: string): number; // ceil(utf8 bytes / 4)
export async function compileSnapshot(db, clubId, now): Promise<{ status: 'published' | 'unchanged'; snapshot; warn } | { status: 'over_cap'; tokenCount }>;
export async function latestSnapshot(db, clubId): Promise<BrainSnapshot | undefined>; // B16 reads compiledText from here
export async function liveNotesFor(db, clubId, today): Promise<BrainNote[]>;
// brain/layout.ts
export async function regenerateLayoutNote(db, clubId, now): Promise<BrainNote | null>;
// brain/export.ts, brain/import.ts
export async function exportObsidianFolder(db, clubId): Promise<{ path; content }[]>; export function noteLinks(bodyMd): string[];
export async function importObsidianFolder(db, clubId, files, actor, now): Promise<{ created; superseding; unchanged; skipped; rejected }>;
export async function importPastedText(db, clubId, text, actor, now): Promise<{ created: BrainNote[]; rejected }>;
export type OcrFn = (image: { bytes: Uint8Array; mimeType: string }) => Promise<string>;
export async function importPhoto(db, clubId, image, ocr: OcrFn, actor, now);
// jobs/brain-expiry.ts
export async function runBrainExpiry(db, now): Promise<{ expired: number }>;
export async function brainDigest(db, clubId, now): Promise<{ expired: BrainNote[]; dueForReview: BrainNote[] }>;
export async function sendBrainDigests(db, now): Promise<void>; export function startBrainExpiry(ctx, now): () => void;
```
- Every import is a draft. A folder file whose slug exists with a different body becomes a draft with `supersedesId`.
- Expiry: a live note past `validUntil` (club night date) is out of the compile and retired by the job (`frontmatter.retiredReason = 'expired'`). A note past `reviewBy` (default today + 90 days, reset on edit) stays live and is listed in the digest. The digest is an `info` alert `brain_digest`, once per club per week from Monday 10:00 Bangkok (`platform_flags['brain-digest:<clubId>:<monday>']`).
- Events: `brain.note_drafted|approved|rejected` props are now `noteId, noteType, source` (declarations and `docs/EVENTS.md` updated).
- `jobs/index.ts`: a `startBrainExpiry` line, to become `scheduler.register('brain-expiry', ...)` with B2's scheduler.
- The layout note (slug `layout`, live, no prices) is regenerated after every zone and table write in `http/staff-settings.ts` and in onboarding apply.

**Assumptions to match:** no real OCR provider (inject an `OcrFn`); the token count is an estimate, not the provider's tokenizer; "near the DJ" is not in the layout note until the floor plan has a DJ marker. B16 answers from `latestSnapshot(...).compiledText`; B18 creates learned notes with `createNote({ type: 'learned', source: 'takeover', sourceEpisodeId })`; B19 routes call `approveNote` / `rejectNote` / `updateNote` and show `BrainLintError.issues`.

**A17 fallback removed:** onboarding apply writes each FAQ that has an answer as a draft note (`source: 'onboarding'`, title = question, body = EN then TH answer); an existing slug is skipped, a FAQ that fails the price lint is counted in `detail`. The step is `done` with the written count. `onboarding.test.ts › apply writes the baseline FAQs into the brain` replaces the todo.

**Unverified against a real service:** photo import runs only against a fake `OcrFn` (no OCR provider chosen); the token estimate is not checked against the AI provider's tokenizer. No web change; the B19 approval screen is not built.

**Tests:** `brain-store.test.ts` (9 pass); `onboarding.test.ts` (10 pass).

## Integration: B0 part 2, B1, B13, B15 (2026-11-27, branch track-a)

One session now builds both tracks on `track-a`. After the four tasks: `npm test` 35 files, 326 passed, 15 todo; `npm run typecheck` and `npm run build -w @club/web` green.

- **Closed requests from `sync/track-a.md`:** B0 `applyClubContent` (velora-like no longer answers 501; the A5 todo is a real test); B13 `upsertCalendarDay` (A9's 503 and todo gone); B15 `brain/notes.ts` (A17 `faqs` step is `done`, the onboarding todo is a real test). B1 removed A8's audit-only fallback in `http/team.ts`.
- **Cross-task fix kept:** B1's props pattern rejects `,`, so `club.settings_changed.fields` is joined with `:`; the `settings.test.ts` assertion follows. Free-text `eventName` of `club.event_night_created` moved to `raw`.
- **Todos left, each waiting on an unbuilt task:** `calendar.test.ts` nights-job close (B8b), plus the B3, B4, B5, B6, B7 todos listed in `sync/track-a.md`.
- **Deviations:** `applyClubContent` test runs on a fresh club, not `setupTwoClubs().clubB` (clubB already has V1, V2, S1, S2). `main.ts` gained `seedCalendarDays(db)` (outside B13's Files list). `brain-expiry` uses its own `setInterval` until B2's scheduler. `STATUS_EVENTS` is left to B2. No promoter or guest-tag event names yet (A20a request 5): not in spec §14.2.

## 2026-11-27 · B8: Simulator behind admin login, built by Session A on track-a

- **Routes:** `devRoutes(ctx)` (`http/dev.ts`) now runs `requirePlatformAdmin` on every route (401 signed out, 403 for any non-admin, club owners included). `app.ts` mounts it at `/api/admin/sim` in every environment and also at `/api/dev` only when `config.DEV_SIMULATOR` is on (no `NODE_ENV` check; `loadConfig` holds that rule). Paths: `POST /:slug/event`, `GET /:slug/transcript?userId=`; any club slug, unknown slug 404. Only `:slug` params, so no new `isolationFixtures`.
- **Test rows:** the event route upserts the `SIM-<userId>` guest with `is_test = true` before the bot runs. Bookings and events copying the flag is B6 (`isTestContext`); B8 marks only the guest.
- **Callers must send an admin cookie:** `flow.test.ts` `sim()`/`transcript()` use `adminCookie(app)` (one per test); `scripts/load.ts` sim mode needs `LOAD_COOKIE` = an admin `sid=...`. The web simulator (`/dev/simulator`) calls `/api/admin/sim`, sends signed-out users to `/staff/login?next=/dev/simulator`, has a club picker (`?club=<slug>`, from `GET /api/admin/clubs`).
- **Tests:** `simulator-auth.test.ts` 3 pass; `flow`, `isolation`, `admin` green.
- **Assumptions in place of a human decision:** none beyond the plan; the simulator stays reachable in production behind platform-admin login.
- **Unverified against a real service:** none (the simulator sends nothing to LINE).
- **Browser walk still to be done by a human:** `/dev/simulator` signed out (redirect to login), signed in as admin, club picker, one booking chat.

## 2026-11-27 · B9b: Prices from `price_rules`, built by Session A on track-a

Plan section: "Task B9b: Prices from `price_rules` (expanded)".

```ts
// apps/server/src/bookings/pricing.ts
export interface Price { minSpendSatang: number; depositSatang: number }
export async function priceFor(db: Db, clubId: string, tableId: string, nightDate: string): Promise<Price>; // BookingError('not_found') for another club's table
export async function pricesForNight(db: Db, clubId: string, nightDate: string): Promise<Map<string, Price>>; // every table of the club, one read
export async function priceTables(db, clubId, nightDate, rows: { table; zone }[]): Promise<Map<string, Price>>;
// apps/server/src/bookings/service.ts (one optional argument added; old calls unchanged)
export async function listTableOptions(db: Db, clubId: string, nightDate?: string): Promise<TableOption[]>;
```
- Match: table rule for the table, zone rule for its zone, or club rule; `weekday` null or the night's weekday; `night_id` null or the club's `nights` row for that date; `valid_from` ≤ date ≤ `valid_to` (both inclusive, null open). Highest `priority` wins; tie goes to table > zone > club, then the later `valid_from`. No rule: table column, else zone column.
- Wired: `availableTables`, `holdTable`, `createManualBooking` (stored booking price), staff night map `GET /clubs/:slug/night` (a malformed `date` query shows column prices), `line/samples.ts`. `bot/messages.ts` unchanged (it prints `TableOption` prices). A9 fallback text removed from `pages/staff/Settings.tsx`, `pages/staff/Calendar.tsx` and the `http/staff-settings.ts` comment.
- **Assumption others must match:** priorities come from A9's `rulePriority` (club 0, zone 1, table 2, +10 weekday, +20 `night_id`), so an event-night club rule (20) beats any weekday rule (≤ 12). Content rules (Velora) carry their own priority (weekend 10, event 20). `listTableOptions` without a date still returns column prices: callers that show a night must pass it.
- **Tests:** `pricing.test.ts` 7 pass; `bookings`, `flow`, `settings`, `line-migration`, `admin`, `isolation` green.
- **Unverified against a real service:** none (pure database logic).
- **Browser walk still to be done by a human:** staff Settings price rules and Calendar night map show rule prices for a weekend and an event night.

## 2026-11-27 · B6: Test-data marking, built by Session A on track-a

- **Published (`data/test-flag.ts`):** `isTestContext({ club, guest }: { club: Club; guest?: Guest | null }): boolean` (demo club or `guest.isTest`); `isTestGuestAtCreate(club, lineUserId)` (demo club or `SIM-` id); `issueTesterCode(db, clubId: string, userId: string, now: Date): Promise<{ code: string; expiresAt: Date }>`; `redeemTesterCode(db, club, guest, code, now): Promise<Guest | undefined>`; `testerCodeKey(clubId)` = `tester_code:<clubId>`; `TESTER_CODE_TTL_MS` = 10 min.
- **Tester code:** 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; `platform_flags['tester_code:<clubId>'].value = { hash, expiresAt }` (sha256 of `tester:<clubId>:<CODE>`), `updated_by` = issuer. A new code replaces the old one. Single use: redeem deletes the flag row. Only at `status = 'onboarding'`; elsewhere the text goes on to normal intents. Typed text matches `testerCodeIn` in `bot/intents.ts`: 8 letters/digits, optional `tester ` prefix, case-insensitive. On success the guest gets `is_test = true`, a bilingual "Tester registered" reply, and one `guest.tester_registered` event (new Internal type; `docs/EVENTS.md` regenerated).
- **Route:** `POST /api/admin/clubs/:slug/tester-code` returns `{ code, expiresAt }` (200, any club status) and writes audit `line.tester_code_issued` (no code in it). The 503 `not_ready` and its test are gone; `LineWizard.tsx` no longer special-cases 503.
- **Migration `0005_b6_test_rows`:** `bookings_one_active_per_table_night` now has `AND is_test = false`; new `bookings_one_active_test_per_table_night` with `AND is_test = true`.
- **Bookings:** `holdTable` copies `isTestContext` of the guest into `bookings.is_test`; `createManualBooking` marks guest and booking test at a demo club. `availableTables(..., now, opts?: { isTest?: boolean })`: given, only bookings on the same side count as taken; omitted, every active booking counts (old behaviour). The bot passes the guest's flag. Callers that book for a guest must pass it too.
- **Bot:** `upsertGuest` sets `is_test` via `isTestGuestAtCreate` and emits `guest.first_seen` (dedupe key `guest.first_seen:<guestId>`) in the same transaction. **B4b must not emit `guest.first_seen` a second time.** `http/dev.ts` lets `upsertGuest` create the `SIM-` guest (see the integration entry below).
- **Assumptions others must match:** every emit with a guest in context passes `isTest: isTestContext({ club, guest })` (Track A emits without a guest keep `club.status === 'demo'`, which equals `isTestContext({ club })`). Reports and views that hide test data filter `is_test = false` on guests, bookings and events.
- **Tests:** `is-test.test.ts` 5 pass (plan names); `admin.test.ts › tester-code route returns the code once` passes; `bookings`, `flow`, `events` green.
- **Assumptions in place of a human decision:** tester code is 8 characters, 10-minute TTL, single use, accepted only while the club is `onboarding`.
- **Unverified against a real service:** a tester typing the code in a real LINE OA chat (tested through the bot with the fake gateway only).
- **Browser walk still to be done by a human:** founder console LINE wizard "tester code" button shows the code once.

## 2026-11-27 · B2: Booking state changes in one transaction, scheduler, nightly check, built by Session A on track-a

- **Published (`bookings/service.ts`, W0 signatures unchanged):** `markArrived(db, clubId, id, actor: Actor, now, arrivedPax?: number)` (sets `arrived_at`, and `arrived_pax` when given); `releaseTable(tx: Db, booking: Booking, actor: Actor, now: Date): Promise<void>` (sets `released_at`, emits `table.released`, no history row); new `abandonUnfinished(db, clubId: string, guestId: string, now): Promise<Booking[]>` (the bot's "start over", replaces the direct update in `bot/flow.ts`). `recordSlip` now returns `Promise<{ tableLost: boolean }>` (savepoint; the slip is kept when the table is gone).
- **Published (`data/event-types.ts`):** `STATUS_EVENTS: Partial<Record<BookingStatus, readonly EventType[]>>` (held → `table.held`, expired → `hold.expired`, abandoned → `booking.abandoned`, awaiting_payment → `deposit.qr_sent`, payment_review → `slip.received`, confirmed → `deposit.verified` + `booking.confirmed`, rejected → `deposit.rejected`, cancelled → `booking.cancelled`, arrived → `booking.checked_in`, no_show → `booking.no_show`). `deposit.*` entries are written only when the change concerns a deposit. `completed` has no entry.
- **Published (`jobs/scheduler.ts`):** `class Scheduler { constructor(db: Db, now: () => Date, log?); register(name, everyMs, fn: (now: Date) => Promise<void>); names(): string[]; start(): void; stop(): Promise<void>; runOnce(name, now): Promise<boolean> }`; lock row `platform_flags['job_lock:<name>'] = { owner, until }`, TTL `max(2 × everyMs, 60 s)`, a stale lock is taken over, a job error is logged and never stops the timer. `jobLockKey(name)`.
- **Published (`jobs/index.ts`):** `buildScheduler(ctx: AppContext, now: () => Date): Scheduler` registers `hold-expiry` (30 s), `nightly-check` (15 min), `alert-checks` (1 min, A15), `chatwoot-grant-sweep` (1 min, A13, its own line now), `club-report` (15 min, A16b), `brain-expiry` (15 min, B15). `startBackground` builds it, starts it and returns `scheduler.stop`. The stand-ins `startAlertChecks`, `startClubReports`, `startBrainExpiry` are deleted. **A new job is one `s.register(...)` line in `buildScheduler`.**
- **Published (`jobs/nightly-check.ts`):** `checkEventCompleteness(db, nightDate: string, now?: Date): Promise<{ missing; silentClubs; piiInProps; testInAggregates }>`; `runNightlyCheck(db, now)` (from 07:00 Bangkok, checks the previous night once, claimed with `platform_flags['nightly_check:<date>']`). Each finding writes `ops_events` `kind = 'bot_error'` with `detail.check` in `event_completeness | silent_club | pii_in_props | test_in_aggregates` (per club where there is one), which counts in the health tile's `failures24h`.
- **Every status path goes through the private `changeStatus`:** hold created, hold expired (sweeper and the stale holds a new hold or manual booking clears), abandoned (other hold, start over), deposit requested, no-deposit confirm, slip, approve, reject, cancel, arrived, no-show, manual booking (null → confirmed, plus `booking.manual_created`). Audit action is `status:<to>` for each (the old `deposit_requested`, `confirmed_no_deposit`, `manual_booking` audit actions are gone); `details_submitted` and the table-lost `slip_received` stay. `audit_log.reason` = `reason.text`, `before`/`after` = `{ status }`. `booking.status_changed` carries `raw: { reason_text }` when there is text. Events take `is_test` from `bookings.is_test` (B6).
- **Assumptions others must match:** "that night" for the completeness and props checks is 06:00 Bangkok on the date to 06:00 the next day; the silent-club window is the club's `nightStartHour` to `nightEndHour`, and a club is open by its `nights` row if one exists, else `openWeekdays` / `closedDates`. Phone pattern `^(\+?66|0)[0-9]{8,9}$`, email, or any Thai character in a props string value. `testInAggregates` checks every view in schema `analytics` that has an `is_test` column (B14 needs no list edit). `markArrived` without `arrivedPax` stores `arrived_pax = null` and the event prop `arrived_pax: null`.
- **Not done (outside B2's Files):** no job for `syncClosedBills` (A19 request 3; it needs a per-club loop and the credentials key); the staff `arrived` route `arrivedPax` body field was added at integration.
- **Tests:** `booking-history.test.ts` 9 pass, `nightly-check.test.ts` 6 pass; full server suite 41 files green.
- **Unverified against a real service:** the scheduler lock under two real server processes (tested with a lock row written as another owner on one PGlite).
- **Browser walk:** none needed (no web change in B2).

## 2026-11-27 · B5: Guest-link and staff-link hardening, built by Session A on track-a

- **Published (`data/identity.ts`):** `linkLiffSub(tx: Db, input: { clubId; guestId; sub }, now): Promise<'linked' | 'match' | 'mismatch'>`. One `identity_map` row per (club, guest); `person_id` reused from any row with the same `platform_line_sub`, else new. A row without a sub (B20 phone link) gets the sub filled on first use.
- **Published (`bot/staff-link.ts`):** `issueStaffLinkCode(db, clubId, userId, now): Promise<{ code; expiresAt }>` (8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, `clubs.staff_link_code_hash` = sha256 of `staff-link:<CODE>`, 10-minute expiry, a new code replaces the old); `hashStaffLinkCode(code)`; `handleStaffLink(db, club, gateway, { groupId, code, replyToken? }, now): Promise<'ignored' | 'linked' | 'pending' | 'replaced'>`. `bot/flow.ts` calls it for group `link <code>` (intent regex now 8 characters). The function does not audit issuing; the route does.
- **Routes:** `GET /api/liff/club?club=<slug>` returns `{ name, accentColor, liffId }` (404 unknown). `GET /api/liff/booking` reads the token from the `X-Line-Id-Token` header; submit takes body `idToken` or the header; `POST /booking/review` now runs the same check. Codes: 401 `login_required`, 403 `wrong_user` (bad token, other sub, or stored-pair mismatch), 503 `login_not_configured` (real guest, `login()` null), 410 `link_expired`. `POST /api/staff/clubs/:slug/staff-link-code` (`owner|manager`) returns `{ code, expiresAt }` and writes audit `staff_link_code.issued` (no code in it). Settings response: `staffLinkCode` removed, `staffGroupPending: boolean` added.
- **Details link token:** `t` = `<expiry unix seconds, base36>.<sign('details', ref:expiry)>`; expiry = min(hold expiry, now + 24 h). `Links.details(club, booking, now)` and `Links.detailsToken(booking, now)` now take `now` (every caller updated: `bot/flow.ts`, `line/samples.ts`). Old unsigned-expiry tokens answer 404.
- **Group replacement:** a code in a new group while another is linked sets `pending_staff_group_id` and replies that a second dashboard code is needed; a second fresh code typed in that same group links it, pushes a notice to the old group, clears pending, and audits `staff_group.replaced` (`actor_type = 'bot'`, data `{ from, to }`). A first link audits `staff_group.linked`. A wrong or expired code is ignored silently.
- **Assumptions others must match:** a real (non-`SIM-`) guest at a club whose `login()` is null can no longer read or submit details (503); dev with a real LINE account needs the demo login env vars or a stored login channel. `db/seed.ts` no longer sets `staff_link_code`; `newLinkCode` is deleted. No new isolation fixtures (no new route params).
- **Tests:** `guest-staff-link.test.ts` 14 pass (plan names); `admin.test.ts › console-created club: details read with a valid ID token is 200, with no token it is refused` is a real test; `flow.test.ts` intents row updated; full server suite green (41 files).
- **Not done:** the plan's manual Check (simulator staff group) needs a group mode in the simulator, which does not exist; covered by `handleEvent` group tests instead.
- **Unverified against a real service:** LINE Login ID-token verification and the `shared: true` provider `sub` pairing run only against the test fake of `credentials.login`; no real LIFF login or real LINE group link was tried.
- **Browser walk still to be done by a human:** LIFF details page (`Details.tsx`) with a real LINE login, and staff Settings "staff link code" button and `staffGroupPending` notice.

## 2026-11-27 · Integration of B2, B5, B6, B8, B9b on track-a

- **B6 / B8 simulator `guest.first_seen`:** `http/dev.ts` no longer inserts the `SIM-` guest itself. A new simulator guest is created by the bot's `upsertGuest` (marked test by `isTestGuestAtCreate`, emits `guest.first_seen` as a test row); the route only flips `is_test` to true on a pre-existing `SIM-` guest row. The B6 note above ("simulator guests get no `first_seen`") no longer holds. `simulator-auth.test.ts` asserts the event.
- **B1 / B6 `isTestContext`:** `integrations/chatwoot/instagram.ts` (the one Track A emit with a guest in context) now passes `isTest: isTestContext({ club, guest })` on its events. Other Track A emits have no guest and keep `club.status === 'demo'`.
- **B2 `arrivedPax`:** the staff route `POST /api/staff/clubs/:slug/bookings/:id/arrived` takes an optional body `arrivedPax` (integer 0–200) and passes it to `markArrived`. Test: `staff-events.test.ts › the arrived route stores the party size at the door`.
- **Still open:** no scheduled job for `syncClosedBills` (A19 request 3); it is an A19 follow-up, one `s.register(...)` line in `buildScheduler` once its per-club night loop is decided.

## 2026-11-27 · B8b: A row for every night, built by Session A on track-a

- **Published (`jobs/nights.ts`):** `ensureNights(tx: Db, club: Club, from: string, days: number, now: Date): Promise<number>` (rows inserted or changed); `runNightsJob(db, now): Promise<number>` (every club, from `currentNightDate` across `bookingWindowDays + 1` dates); `defaultNight(club, date, banDates)`; `type NightClosedReason = 'weekday' | 'closed_date' | 'alcohol_ban'` (checked in that order). Rows with `edited_by` set are never touched; others are refreshed only when status or reason differ. A `sold_out` row the settings call open stays `sold_out`.
- **Published (`jobs/index.ts`):** job `nights`, every 60 min, and one `runOnce('nights')` right after `scheduler.start()` in `startBackground`.
- **Published (`bookings/service.ts`):** `nightStatus(db, clubId, date): Promise<'open' | 'closed' | 'sold_out'>` (row first, else settings); `isNightOpen(db, club, date, now): Promise<boolean>` (window + same-night cutoff + status not `closed`; a `sold_out` night is still open to try); `bookableNights(db, club, now, count): Promise<NightOption[]>` with `NightOption = { date; status: 'open' | 'sold_out'; eventName: string | null }` (closed rows left out, sold-out nights listed). `holdTable` checks `isNightOpen`; `bot/flow.ts` uses `bookableNights` / `isNightOpen`. `line/samples.ts` uses `bookableNights` too. The frozen sync `isNightBookable` and `upcomingNights` are unchanged (settings only) and have no caller left in `src` outside `bookings/service.ts`; `bookableNights` is the plan's nights-aware `upcomingNights`.
- **Sold out:** every `changeStatus` call runs `syncSoldOut`: when every active table of the club has an occupying booking that night, the row goes `open → sold_out` (or a `sold_out` row is inserted when none exists) and `night.sold_out` is emitted once (actor of the change, `bookingId`, `tableId`, `nightDate`, `props: {}`); when a table frees up, `sold_out → open`. A `closed` row is never changed. Only the club's own side counts: real bookings at a real club, test bookings at a demo club, so a simulator hold never sells out a real night.
- **Guest date list:** `M.askNight` accepts `string | { date; eventName? }` entries; an event night's chip label is `<day> · <event name>` (cut to 20 characters) and the message text lists each event night in full.
- **Tests:** `nights.test.ts` 6 pass (plan names); `calendar.test.ts` todo converted (5 pass).
- **Done (integrator):** `seedHistory` calls `ensureNights(tx, club, tonight − 42, 42, now)`. **Not done:** `releaseTable` does not reopen a sold-out night, because `availableTables` does not treat `released_at` as free either.


## 2026-11-27 · B9: Automatic slip verification, built by Session A on track-a

- **Published (`bookings/slip-verify.ts`):** `SlipVerifier`, `SlipReading`, `SlipReviewCode`, `verifySlip(db, club, bookingId, image: Buffer, verifier, now, opts?: { timeoutMs?; skewMs?; lateSlip? }): Promise<SlipOutcome>`, `FakeSlipVerifier` (test fake: a reading, an `Error`, or `'timeout'`), `SlipOkVerifier({ apiKey, branchId, fetch? })`, `parseSlipOk`, `receiverMatches(promptpayId, receiver)`.
- **Published (`bot/deps.ts`):** `BotDepOptions.slipVerifier?: SlipVerifier | null`; `BotDeps.slipVerifier?` (optional, so other `BotDeps` builders compile). Default: SlipOK when `SLIPOK_API_KEY` and `SLIPOK_BRANCH_ID` are set, else `null` (all slips to staff review). `Config` gains both keys; `testConfig` sets them `undefined`.
- **Flow:** `handleImage` runs `recordSlip` (unchanged), then `verifySlip` unless the table was lost. Pass: the guest gets the confirmation card and staff get the "confirmed" alert (no "checking your payment" reply). Fail or error: today's reply and review alert.
- **Assumptions others must match:** auto approval is `approveDeposit` with actor `{ type: 'system', id: 'slip:<provider>' }`, so `deposits.verified_by = 'slip:slipok'`. Receiver is checked against `clubs.promptpay_id` only (a bank-account receiver is not configured anywhere yet). Hold start = first `booking_status_history` row with `to_status = 'held'`. A late slip (booking `expired` when it arrived) always goes to review.
- **Unverified against a real service:** SlipOK request and response shape are from its public docs; no real call was made.

## 2026-11-27 · B10b: Guest removal, marketing opt-out, retention, built by Session A on track-a

- **Published (`data/removal.ts`):** `removeGuest(db, clubId, guestId, now, uploadsDir?): Promise<{ messagesCleared; slipsDeleted; eventsCleared }>` (throws `RemovalError('not_found')` for another club's guest; idempotent; emits no event), `requestRemoval(db, club, guest, now, channel = 'line'): Promise<boolean>`, `recordMarketingOptOut(db, club, guest, now, channel = 'line'): Promise<boolean>`, `hasMarketingOptOut(db, clubId, guestId): Promise<boolean>`, `runRemovalRequests(db, now, uploadsDir?, log?): Promise<number>`, `unlinkUnder(root, relPaths)`, `defaultUploadsDir()`, `MARKETING_NOTICE_VERSION = 'marketing-v1'`.
- **Published (`jobs/retention.ts`):** `purgeRawWebhooks(db, now): Promise<number>` (processed and older than 30 days; unprocessed kept), `purgeSlips(db, now, uploadsDir?): Promise<number>` (by `slip_received_at`, else `created_at`, older than 365 days), `runRetention(db, now, uploadsDir?)`.
- **Published (`jobs/index.ts`):** jobs `removal` and `retention`, every 24 h, and each run once right after `scheduler.start()`.
- **What removal clears:** guest row anonymised in place (LINE id, names, phone, nationality, birth date, external id); `messages.payload` → `{"removed":true}`; on the guest's events (by `guest_id` or the guest's conversation) `raw`, `guest_id`, `person_id`, `conversation_id`, guest `actor_id` and a guest-id `dedupe_key`; `identity_map`, `guest_tags`, `guest_notes` deleted (A20c request 4 closed); `alerts` on the guest's conversation or bookings deleted; bookings `special_request`/`notes`, conversation `handoff_reason`/`state`, handoff episode `reason` cleared; that club's `raw_webhooks` holding the guest's LINE user id deleted; slip files unlinked after commit, `slip_path` cleared. Counts stay.
- **Bot:** keyword (`delete/remove my data`, `forget me`, `ลบข้อมูล`) or menu `a=privacy` → `a=remove` answers a confirm prompt; `a=remove_confirm` writes the request. `stop` / `unsubscribe` (whole message), `ยกเลิกรับข่าวสาร`, `ไม่รับข่าวสาร`, `หยุดส่ง`, or menu `a=stop` records the opt-out. Main menu quick replies gain a last "My data" item.
- **Assumptions others must match:** every later marketing send calls `hasMarketingOptOut` (no marketing send exists yet); booking reminders do not. `guest.removed` carries no guest id. B20 deletes nothing extra: removal already deletes `identity_map` rows. A5's Data health count of pending `removal_requests` is fed by this flow.
- **Tests:** `removal.test.ts` 4 pass (3 plan names + job), `retention.test.ts` 2 pass, `flow.test.ts` +2 plan names and 5 intent cases, `booking-history.test.ts` scheduler list updated.
- **Done (integrator):** in human handoff a typed `stop` is recorded at once with no bot reply, and taps on `a=stop` / `a=remove_confirm` still run (a typed removal keyword still waits for the handoff to end, since it needs the confirm tap). **Not done:** Chatwoot copies of the guest's conversation (A13) are not deleted. `audit_log` rows are not scrubbed.

## 2026-11-27 · B14b: Handoff episodes, built by Session A on track-a

- **Exact signatures (`chat/episodes.ts`):** `openEpisode(db: Db, clubId: string, conversationId: string): Promise<HandoffEpisode | undefined>`; `startEpisode(tx: Db, input: StartEpisodeInput): Promise<HandoffEpisode>`; `endEpisode(tx: Db, input: EndEpisodeInput): Promise<HandoffEpisode | undefined>`; `endOpenEpisode(tx: Db, input: { clubId; conversationId; resolverUserId; actor?: Actor; now }): Promise<void>`; `recordStaffReply(db: Db, input: StaffReplyInput, send: StaffReplySend): Promise<{ messageId: string }>`; `type HandoffTrigger = 'guest_request' | 'large_group' | 'paid_after_expiry' | 'staff_reply' | (string & {})`; `HANDOFF_REALERT_KIND = 'handoff_realert'`; `class EpisodeError { code: 'not_found' }`. `jobs/handoff-timeout.ts`: `runHandoffTimeouts(db: Db, now: Date): Promise<{ realerted: string[]; ended: string[] }>`.
- **Unverified against a real service:** staff replies go out through the LINE push path of the outbox; no real LINE push was made (tests use the dev gateway). No web page changed; a browser walk of take over, reply, resolve and timeout from the dashboard is still to be done by a human.

- **`chat/episodes.ts`:** `startEpisode(tx, { clubId, conversationId, trigger, reason, topic?, firstMessageId, now })` returns the open episode if one exists, else inserts it, sets `mode='human'`, emits `handoff.requested {trigger}`; `topic` defaults to `trigger`. `endEpisode(tx, { episodeId, endedBy: 'staff'|'timeout', resolverUserId?, now, actor? })` returns `undefined` when already ended; emits `handoff.resolved` / `handoff.timed_out {durationSec}`. `endOpenEpisode(tx, { clubId, conversationId, resolverUserId, actor?, now })` for [Mark resolved] (also handles a legacy human-mode conversation with no episode). `recordStaffReply(db, { clubId, conversationId, userId, text, channel, occurredAt, externalId }, { outbox, gateways })` returns `{ messageId }`; **third argument added** (sending needs a gateway): A14 passes `{ outbox: ctx.deps.outbox, gateways: ctx.gateways }`. Throws `EpisodeError('not_found')` for another club's conversation. `openEpisode(db, clubId, conversationId)` reads the open one.
- **Outbox:** `outbox.deliver(gateway, club, guest, messageId, msgs)` pushes an already stored row and sets `sent_via` / `delivery_status`.
- **Job:** `handoff-timeout` every minute (`jobs/handoff-timeout.ts`, `runHandoffTimeouts(db, now)`). Counts from the last staff activity (start or newest staff-authored message). Assumption: one urgent `raiseAlert` kind `handoff_realert` at half of `handoffTimeoutMinutes`, end with `endedBy='timeout'` at the full timeout. The lazy timeout in `bot/flow.ts` is gone.
- **Routes:** `POST /conversations/:id/resolve` now calls `endOpenEpisode`; `POST /conversations/:id/reply` now calls `recordStaffReply` (`channel: 'dashboard'`, `externalId: null`). A14 only adds the Chatwoot callback path.
- **Flow triggers:** `guest_request`, `large_group`, `paid_after_expiry`; `staff_reply` when a host replies to a bot-mode chat.
- **Assumptions others must match:** only `chat/episodes.ts` writes `conversations.mode` (`test/episodes.test.ts` scans `src`). Seeds that insert a human-mode conversation should also insert its open `handoff_episodes` row, or the timeout job never closes it (`demo/seed-history.ts` inserts one without an episode today).
- **Re-alerts:** ending an episode (staff or timeout) resolves that conversation's open `handoff_realert` alerts in the same transaction (integrator). `HANDOFF_REALERT_KIND` now lives in `chat/episodes.ts`, re-exported from `jobs/handoff-timeout.ts`.
- **Tests:** `test/episodes.test.ts` 6 pass.

## 2026-11-27 · B7: Velora seeded club, reset and fast-forward, built by Session A on track-a

**Migration:** none.

**Interfaces published:**
```ts
// apps/server/src/db/seed.ts
export async function seedDemoClub(db: Db, env?: NodeJS.ProcessEnv, now?: Date): Promise<void>; // third arg new (default new Date())
// apps/server/src/demo/seed-history.ts
export const SEED_HIST = 'seed_hist_'; export const SEED_TONIGHT = 'seed_tonight_'; export const HISTORY_WEEKS = 6;
export async function seedHistory(tx: Db, club: Club, now: Date): Promise<void>;
export async function seedTonight(tx: Db, club: Club, now: Date): Promise<string>; // the night date seeded
export function historyNights(club: Club, tonight: string): string[];
// apps/server/src/demo/reset.ts
export class DemoError extends Error { code: 'not_found' | 'not_demo' }
export async function resetDemoClub(db: Db, clubId: string, now: Date): Promise<{ nightDate: string }>;
export async function fastForward(ctx: AppContext, clubId: string, what: 'hold_expiry', bookingId: string, now: Date): Promise<Booking | undefined>;
// apps/server/src/bookings/service.ts
export async function expireHold(db: Db, clubId: string, bookingId: string, now: Date): Promise<Booking | undefined>;
```
Routes (`http/demo.ts`, mounted at `/api/admin/demo`, `requirePlatformAdmin`): `POST /:slug/reset` → 200 `{ nightDate }`; `POST /:slug/fast-forward` `{ what: 'hold_expiry', bookingId }` → 200 `{ booking: { id, status, refCode } }`. 404 unknown club, 409 `not_demo`, 400 bad body, 404 `not_held`. Each success writes an `audit_log` row (`demo.reset`, `demo.fast_forward`).

**What a new Velora database holds** (`seedDemoClub`, one transaction, only when `club_demo` does not exist yet):
- Content through `applyClubContent` (zones, 22 tables, price rules, policies as `settings.rules`). The old inline zones/tables (`zone_demo_*`, `table_demo_*`) are gone; Velora table ids are random, look tables up by code.
- `club_profile` from `VELORA.profile` (`usual_peak_hour` 1; `opening_hours` jsonb also carries `openWeekdays`, `arrivalCutoff`, `eventNight`).
- 25 FAQ `brain_notes` (`id = note_velora_<slug>`, `slug` = FAQ slug, `type='faq'`, `status='live'`, `source='onboarding'`, body EN + TH, linted with `assertLint`), one version row each, one compiled snapshot. The three gaps are not inserted.
- History: the open nights (Wed–Sat) of the 6 weeks before tonight, from a fixed PRNG seed: bookings (completed with POS bill, no-show, cancelled, expired; ~10% `manual_phone`), deposits, status-history rows and the events `changeStatus` writes at each step (`booking.status_changed` + `STATUS_EVENTS`), `booking.completed`, chats (`message.received`), 1–2 takeovers a night (`handoff.requested`, `host.replied`, `handoff.resolved`; topics include the three gaps), door counts (`door.count`) and crowd ratings (`crowd.rated`). 80 seeded guests.
- Tonight: 6 confirmed (V1, V3, B2, B5, H1, H4), one `held` on B1 (expires `holdMinutes` after seeding), one `payment_review` on V2 (deposit `review`, `slip_path` null), one guest waiting for a host (`seed_tonight_conv_waiting`, `mode='human'`, open `handoff_episodes` row, topic `private_room`).

**Assumptions others must match:**
- Every seeded guest, booking and event is `is_test = true`. Seeded guests' `line_user_id` is `SIM-<row id>`, so a push to them (e.g. the fast-forward expiry message) goes to the simulator gateway, never to a real LINE user.
- Events are written with `emit` (strict) and then renamed to `seed_hist_ev_<seq>` / `seed_tonight_ev_<seq>` in the same transaction, so reset can tell them apart. Event ids are not stable across databases; row counts and sums are.
- Reset deletes, for the club, every guest, conversation, message, booking, deposit, status-history, event, handoff, door-count and crowd-rating row whose id does not start with `seed_hist_`, plus the rows that hang off a deleted guest or booking (POS bills, promoter attributions, guest tags/notes, notices, identity links, removal requests). It keeps content, brain notes, profile, `audit_log` and `occupancy_snapshots`. A change a user made to a `seed_hist_*` row is not undone.
- `expireHold` does not check the hold time; `fastForward` moves `hold_expires_at` to `now − 1 s` first. Only `demo` clubs (fast-forward also refuses a non-demo club).
- Tonight is `currentNightDate(now, nightEndHour)` even on a closed weekday.
- Nights rows: `seedHistory` writes the 42 past `nights` rows through B8b's `ensureNights`.
- Brain notes are inserted directly (not through `createNote`) to compile once instead of 25 times.

**Answer to Track A's request (A16b):** the hand-counted Velora week is the week of **Mon 16 Nov 2026** (nights Wed 18–Sat 21) for a seed at `2026-11-25T13:00:00Z`. `club-report.test.ts › report figures match the hand-counted B7-seeded Velora week` replaces the `it.todo` (44 bookings, 2 cancelled, 42 deposits ฿220,000, door 897 against 237 booked pax, peak hour 00).

**Tests:** `velora.test.ts` 7 pass (the 5 plan names, plus a seed-content test with the nightly completeness check, and a route test: admin 200, live club 409, unknown 404, bad `what` 400, manager 403). `club-report.test.ts` 6 pass. `admin.test.ts`, `isolation.test.ts`, `episodes.test.ts` pass with the new routes. `isolationFixtures` needs no new fixture (the routes take only `:slug`; the booking id is in the body).

**Not done:** no console button for reset / fast-forward (no web page in B7's Files); the browser walk of demo steps 1, 2 and 7 is still to be done by a human. Thai text still needs a native-speaker read.

## 2026-11-27 · B3: Durable webhook pipeline, ops events, bot pause, built by Session A on track-a

- **Published (`http/webhook.ts`):** `processDelivery(ctx: AppContext, rawId: string, opts?: { dryRun?: boolean }): Promise<{ events: number; replies: unknown[] }>`; `replayUnprocessed(ctx: AppContext, now: Date): Promise<number>` (signed `channel = 'line'` rows with `processed_at IS NULL` older than 10 s, oldest first). Route order: unknown slug → ops `webhook_unknown_club` (club null, `detail.slug`), 404 → bad signature → `raw_webhooks` row `signature_ok=false` with body `{ rejected: 'bad_signature', bytes }` (an unsigned body is never stored) and ops `webhook_bad_signature`, 401 → bad JSON → row with `error='bad_json'`, 400 → raw row → 200 → `processDelivery` in the background. A per-event throw writes ops `bot_error` `{ rawWebhookId, webhookEventId, error }`, sets `raw_webhooks.error`, leaves `processed_at` NULL and runs the next event. Missing access token: `error` set, nothing processed (the dev gateway is never used).
- **Published (`bot/flow.ts`):** `processEvent(deps, club, gateway, event, opts?: { ignoreDedupe?: boolean })` (throws); `handleEvent` is a catching wrapper (kept for `http/dev.ts`). `logInbound` uses `ON CONFLICT DO NOTHING` and returns the row; a turn is skipped only when that row's `processed_at` is set; `processed_at` is set as the last step of every completed guest turn (follow, unfollow, paused and human-mode turns too). Group events are not deduped.
- **Published (`data/raw-webhooks.ts`):** `recordRawWebhook(db, { clubId, channel, body, signatureOk, receivedAt, processedAt?, error? }): Promise<string>`, `markRawProcessed(db, id, at)`, `markRawError(db, id, error)`, `rawBody(text): { body; parsed }`, `errorText(err)`. Chatwoot Instagram and Papaya POS routes use it (direct inserts removed).
- **Published (`data/ops.ts`):** `recordOps(db, clubId: string | null, kind: OpsKind, detail, now)`, the one `ops_events` writer (`line-probe.ts` `recordLineSetup` and `jobs/nightly-check.ts` switched).
- **Outbox:** every outbound row ends with `delivery_status` `sent` (`sent_via` `reply`/`push`), `skipped` (`sent_via='none'`: no LINE id, unfollowed with no reply token, no staff group, staff messages past the first 5) or `failed` (`sent_via='push'`, `error` = `describeLineError`, plus one ops `send_failed` `{ target: 'guest' | 'staff', messageIds, error }`). `Outbox` takes an optional third constructor arg `now`.
- **Bot pause:** `clubs.bot_paused` or `isGloballyStopped(db)`: inbound stored, nothing to the guest, one staff-group message per conversation per pause, through `raiseAlert` (urgent `bot_paused`, since B19b). Pause identity `club:<bot_paused_at ISO>` or `global:<platform_flags.global_stop.updated_at ISO>`, kept in `conversations.state.pauseAlertedFor` (new optional `ConversationState` field, no migration).
- **Dry run:** one `db.transaction`, fresh `buildBotDeps(config, tx, { now, log, slipVerifier: null, payments: {} }) (no slip provider and no payment gateway is called)`, the dev gateway wrapped to collect `{ via, to|replyToken, messages }` into `replies`, no dedupe, always rolled back. `POST /api/admin/clubs/:slug/webhooks/:id/replay` returns `{ dryRun: true, events, replies }`, 409 `not_replayable` for an unsigned or non-LINE row, 500 `replay_failed` on a throw, and writes a `debug.view` audit row.
- **Start-up:** `startBackground` awaits `replayUnprocessed(ctx, now())` before the scheduler starts. Tested by `webhook-durability.test.ts › startBackground replays unprocessed deliveries before it returns` (integrator).
- **Alert script:** `infra/check-webhook-errors.sh` denominator is now LINE rows in `raw_webhooks`.
- **Tests:** `webhook-durability.test.ts` 10 pass (plan names); `admin.test.ts` gate `raw_webhooks` assertion, `pause stops replies within one message`, `one guest message is traceable end to end`, `failed send shows in the message log with LINE's error` are real tests; `admin-support.test.ts` replay dry run, end-to-end trace, failed send are real tests; `instagram.test.ts` raw-writer test is real.
- **Not done:** no event for webhook rejection (`line.webhook.rejected` is B4b's).
- **Assumptions in place of a human decision:** start-up replay waits 10 s past receipt so a delivery still in flight is not processed twice; the pause notice goes to the staff group once per conversation per pause.
- **Unverified against a real service:** signatures and redeliveries are tested with locally signed bodies; no delivery from the real LINE platform was received. No web page changed.

## 2026-11-27 · B8b, B9, B10b, B7: what is unverified, built by Session A on track-a

- **B8b:** no external service. No web page changed.
- **B9:** SlipOK sits behind `SlipVerifier`; tests use `FakeSlipVerifier` only. Assumption (plan default): with no `SLIPOK_*` keys every slip goes to host review. No web page changed.
- **B10b:** no external service; the confirm prompt and opt-out replies are tested against the dev gateway, not real LINE. Thai keywords and replies still need a native-speaker read. No web page changed.
- **B7:** no external service; seeded guests have `SIM-` LINE ids, so no real push happens. The browser walk of demo steps 1, 2 and 7 is still to be done by a human.

## 2026-11-27 · B20: Cross-club identity map, built by Session A on track-a

- **Published (`data/identity.ts`):** `normalizePhone(phone): string | null` (E.164, Thai default); `phoneHashKey(credentialsKey: Buffer): Buffer` (HKDF-SHA256, info `identity_map.phone_hash`); `hashPhone(key, phone): string | null` (base64url HMAC-SHA256); `linkPhone(tx, { clubId, guestId, phone }, key, now): Promise<{ personId } | null>`; `personIdOf(db, clubId, guestId): Promise<string | null>`. `linkLiffSub` unchanged in signature and results.
- **Behaviour:** both links on (owner decision). Same sub or same phone hash at any club means one `person_id`; when two persons meet, the one with the earliest `first_linked_at` keeps its id and every `identity_map` and `events` row of the other is repointed. `emit` now fills `events.person_id` from the guest's `identity_map` row (sub-select) unless `dataOrigin = 'instagram'`; a new link backfills the guest's earlier non-Instagram events in that club.
- **Wiring:** `POST /api/liff/booking/details` calls `linkPhone` after `submitDetails`, skipped for `guests.is_test`. Staff-entered phones are not linked.
- **Removal:** B10b already deletes the guest's `identity_map` row and clears `events.person_id`; nothing extra added. The other club's link stays.
- **Assumptions others must match:** cross-club readers (B21 feed, Metabase views) group guests by `events.person_id` / `identity_map.person_id` and never by `guest_id`; Instagram events have `person_id` null by design. Rotating `CREDENTIALS_KEY` changes every phone hash (re-link needed).
- **Unverified:** no external service. Phone normalisation is tested on Thai and E.164 samples only; foreign formats other than `+<cc>` are not linked.

## 2026-11-27 · B12: Occupancy snapshots and crowd rating, built by Session A on track-a

- **Published (`jobs/snapshots.ts`):** `leadBuckets(club, nightDate): { bucket; at }[]`, `dueBucket(club, nightDate, now): string | null`, `takeSnapshot(db, club, nightDate, bucket, now): Promise<boolean>`, `runSnapshots(db, now): Promise<number>`, `recordCrowdRating(db, club, { level; userId; actorType? }, now): Promise<CrowdRating>` (throws `CrowdRatingError('bad_level')`), `crowdPromptHours(club)`, `runCrowdPrompts(db, now, send)`. `Notifier.crowdPrompt(club, nightDate)` in `bot/notify.ts`.
- **Bucket codes** (`occupancy_snapshots.lead_bucket`): `d14`, `d7`, `d3`, `d1` (12:00 that many days before), `d0_1200`, `d0_1800`, then `live_HHMM` every 30 min from `nightStartHour` to `nightEndHour` inclusive. B21's feed and B14's views read these codes.
- **Route:** `POST /api/staff/clubs/:slug/door/crowd-rating` `{ level }` (owner|manager|host|door), 201 `{ rating: { id, nightDate, level, at } }`, 400 on a bad level. It lives in `http/door.ts` as `crowdRatingRoutes(ctx)`, mounted at `/api/staff` by one line in `app.ts`. **B11 (track-c) also creates `http/door.ts`:** on merge keep both route sets in that file.
- **Jobs:** `snapshots` and `crowd-prompt`, every 5 min, registered in `jobs/index.ts`.
- **Assumptions others must match:** doors and close are `settings.nightStartHour` / `nightEndHour` (no doors setting yet); a missed bucket window (next bucket or 2 h, whichever first) is not caught up; a closed night has no snapshots; a real club counts only `is_test = false` bookings, a demo club counts its own; prompt hours default 22, 23, 0, 1 and an optional `settings.crowdPromptHours` overrides (not in the `ClubSettings` type yet; A9 adds it when the settings UI sets it); the prompt goes to the staff group (no per-person push), once per club and hour via `platform_flags` `crowd_prompt:<clubId>`.
- **Unverified:** no external service; the prompt is tested against the dev gateway. Thai prompt text needs a native-speaker read. No web page for the rating (B11's door screen calls the route).

## 2026-11-27 · B19b: Alert call sites, built by Session A on track-a

Landed on `track-a` (one session builds both tracks). Tests: `test/alert-calls.test.ts` (9). Migration: none (`ClubSettings.urgentWords?` is a JSON field). `it.todo`: none.

- **Published (`bot/alerts.ts`):** `DEFAULT_URGENT_WORDS`, `urgentWordIn(club, text): string | null`, `handoffAlertKind(trigger)`, and the B-side `raiseAlert` helpers: `alertBookingConfirmed(db, view, now)` (info), `alertPaymentReview(db, view, now, { conversationId?, extra? })` (urgent), `alertNoArrival(db, view, now)` (urgent), `alertRunningLate(db, view, now, conversationId?)` (info), `alertCancellation(db, view, now)` (info), `alertBrainWaiting(db, { clubId, kind: 'brain_draft_waiting' | 'gap_waiting', count }, now)` (needs input, one open per kind per club), `alertCostCap(db, clubId, spentSatang, capSatang, now)` (urgent `ai_cost_cap`), `alertBotError(db, clubId, now)` (urgent, one open per club).
- **Switched to `raiseAlert`:** bot pause (`bot_paused`), every handoff in `requestHandoff` (`guest_wants_human` for `guest_request`/`large_group`, `complaint`, `payment_review` for `paid_after_expiry`, `bot_unanswered` for any other trigger), slip waiting for review (`payment_review`; a lost table raises one alert, not two), confirmed booking in `flow.ts` and `Notifier.confirmed` (`booking_confirmed`, info: no group push unless the club switched info to LINE), club cancellation in `Notifier.cancelled` (`cancellation`, info), bot error in `processDelivery` (`bot_error`; the `ops_events` row stays). `bot/flow.ts` has no `outbox.toStaff` call left.
- **Complaint or safety word:** checked before intent detection (not while the chat is with a host); case-insensitive substring of `club.settings.urgentWords` when non-empty, else `DEFAULT_URGENT_WORDS`. A hit starts a handoff with trigger `complaint`. Editable through `PATCH /api/staff/clubs/:slug/settings` `{ urgentWords: string[] }` (field code `words`; the settings route's joined field codes are now exactly 64 characters, so a new settings key needs a shorter scheme). No web editor yet.
- **For `track-c` (B10, B16) and B18, which must match:** B10's no-show job calls `alertNoArrival`, running late calls `alertRunningLate`, guest cancel calls `alertCancellation`; B16's cost-cap warning calls `alertCostCap` instead of `outbox.toStaff`, and a "could not answer" handoff passes any trigger other than `guest_request`/`large_group`/`complaint`/`paid_after_expiry` (it becomes `bot_unanswered`); B18 calls `alertBrainWaiting` when a draft or gap is queued. None of these call `outbox.toStaff` for an alert.
- **`alerts_line` (A17b):** `raiseAlert` (A15) reads it per call. Off = the alert is still written to the feed, but nothing goes to the staff LINE group (`sent_line_at` stays null). Test: `alerts_line switched off keeps the alert in the feed and sends nothing to the staff group`.
- **B12 settings key:** `ClubSettings.crowdPromptHours?: number[]` is now in the type (JSON, no migration); no settings route or UI sets it yet.
- **Unverified:** no external service; staff-group pushes are tested against the dev gateway only. The default urgent-word list (EN/TH) needs a native-speaker and owner read. No web editor for `urgentWords`.

## 2026-11-27 · B4: Full chat capture, entry tags, data notice, counted redirects, built by Session A on track-a

Landed on `track-a` (one session builds both tracks). Tests: `test/chat-capture.test.ts` (14). Migration: none (`ConversationState` gains JSON fields). `it.todo`: the A10 todo in `line-migration.test.ts` ("the replaced rich menu carries B4 s=rm_* tags") is now a real test.

- **Published (`line/outbox.ts`):** `toGuest(gateway, club, guest, msgs, replyToken?, author?: Actor)` and `toStaff(gateway, club, msgs, author?: Actor)`; default `{ type: 'bot' }`. Every outbound row gets `author_type` (a `platform` actor is stored as `staff`), `author_id`, `channel_id` (the club's `kind = 'line'` row) and `occurred_at`. `Notifier.hostReply` passes its `actor`.
- **Inbound rows:** `messages.payload` is the whole LINE webhook event (text at `payload.message.text`, postback at `payload.postback.data|params`), `author_type = 'guest'`, `author_id = guest.id`, `channel_id`, `occurred_at` = LINE timestamp. Readers updated: `chatwoot/bridge.ts mirrorContent`, web `MessageThread.describe`, admin `MessageLog` and `Timeline`. Any new reader of inbound text must read `payload.message.text` (and may fall back to `payload.text` for seeded/Instagram rows).
- **Entry tags (`s=`):** rich menu `rm_book`, `rm_my`, `rm_host` (`line/setup.ts menuCells`); menu quick replies `qr_book|qr_my|qr_host`; greeting `greet_*`; hold-expired "try again" `retry_book`; "Start over" `restart`; typed booking `text_intent`; promoter link `link_promoter`; map link from the location reply `text_location`. A booking postback with no `s` is `rm_unknown`. In-flow buttons `other_night` ("Another night") and `change` keep the running attempt.
- **Attempts:** `conversations.state.{ entry, attemptId, promoterCode }` (`ConversationState` in `db/schema/core.ts`). `attemptId` is made in `startBooking` where it goes on to ask the night (B4b's `booking.started` point; B4b emits that event there, reading `turn.conv.state.attemptId`). `holdTable` input gains optional `attemptId`, `entry` and `source: BookingSource` (frozen fields unchanged): `bookings.attempt_id` is set and the hold's events carry `events.source = entry` (`changeStatus` extra `eventSource`). Later booking events get `attempt_id` from the booking row; `events.source` is set only on the hold's events and on bot-side events (B4b sets `source: turn.conv.state.entry` on its own emits).
- **`availability.searched`:** every table search in `sendTables`, zero results included; props `{ night_date, pax_range: paxRangeCode(key), result_count, tables_shown }`, `dataOrigin 'first_party'`.
- **Data notice (§5.5):** `DATA_NOTICE_VERSION = 'data-v1'` (`bot/i18n.ts`, key `dataNotice`, EN/TH, club name inserted, link `<PUBLIC_URL>/privacy`). The first `send` of a turn to a guest with no `notices` row (`purpose 'data'`, this version, channel `line`) prepends the notice line, writes the row with `shown_at` and emits `notice.shown` (dedupe `notice.shown:<guestId>:data:<version>:line`). Does not block the flow. Tests counting a turn's outbound rows must leave that line out (see `webhook-durability.test.ts`, `payment-gateway.test.ts`). `GET /privacy` serves the notice page (plain HTML, `http/redirect.ts privacyRoutes`). B4b's `notice.accepted` should update this same row (`accepted_at`) when the LIFF form is submitted.
- **Redirects (`http/redirect.ts`, mounted at `/r`):** `GET /r/:code`, code `<kind>.<slug>.<entry>.<sig>` from `Links.tracked(club, kind, entry)` (`kind` in `map | drinks`, signed with `APP_SECRET`, target from the club's settings, never from the link), emits `link.opened` `{ kind }` with `source = entry`, 302; forged code 404. `GET /r/p/:slug/:code` (A20a request): enabled promoter + the club's `channels.external_id` (OA basic id) → emits `link.opened { kind: 'promoter' }`, 302 to `https://line.me/R/oaMessage/<basicId>/?Book a table · promo <code>`. The bot reads only that exact text (`/^Book a table · promo <code>$/i`) and only for an enabled promoter (`activePromoterByCode`, `platform/promoters.ts`); otherwise the text is handled as ordinary text. It starts an attempt `link_promoter`, holds with `source = 'promoter'` only while the promoter is still enabled, and calls `attributeBooking(..., 'link', null, now)` (a promoter disabled between check and hold: `source` reset to `line`, no attribution). No basic id (setup never ran) → 404.
- **Assumptions others must match:** the details-form link stays direct (plan: a 302 to `liff.line.me` is unverified on a device; its tap is counted at the first `/api/liff` call). Every map and drinks link goes through `/r/`: the typed location reply (`text_location`), menu and greeting quick replies (`qr_location`, `qr_drinks`, `greet_location`, `greet_drinks`), the confirmation card (`confirm_location`) and the rich-menu Location cell (`rm_location`; `runLineSetup` takes `links`). `menuQuickReplies`, `menu`, `greeting`, `confirmation` and `alreadyBooked` in `bot/messages.ts` take a `TrackedLinks` argument. The details link stays direct and `GET /api/liff/booking` emits `link.opened { kind: 'details' }` once per booking (dedupe `link.opened:details:<bookingId>`), with the booking and attempt. Every booking event with an `attempt_id` and no explicit `source` takes the attempt's entry tag from the booking's tagged hold event (`emit`, `data/events.ts`). `notices` has a unique index `notices_once` (club, guest, purpose, text_version, channel; migration `0007_b4_notices_once`), so a raced first contact shows the data notice once. `link.opened` carries no guest id (the tap is anonymous). A10 must rebuild menus of clubs connected before B4 (`refreshRichMenu: true`).
- **Unverified on a device:** that `line.me/R/oaMessage/<basicId>/?<text>` pre-fills the text in the club chat on iOS and Android; that a 302 to `liff.line.me` opens the LIFF app.
- **Web:** `MessageThread`, admin `MessageLog` and `Timeline` read the new payload shape; the browser walk of these pages is still to be done by a human. Thai data-notice text needs a native-speaker read.

## 2026-11-27 · B22: Waitlist and bottle pre-orders, built by Session A on track-a

Landed on `track-a` (one session builds both tracks). Tests: `test/waitlist.test.ts` (10), `test/preorders.test.ts` (8). Migration: yes, `0006_b22_waitlist_preorders` (`menu_items`, `booking_preorders`, `waitlist_entries` in `db/schema/core.ts`). Plan section "Task B22: Waitlist and bottle pre-orders (expanded)".

- **Published (`bookings/waitlist.ts`):** `WAITLIST_OFFER_MINUTES = 15`; `joinWaitlist(db, club, { guestId, nightDate, paxRange: PaxRangeKey }, now): Promise<{ entry, created }>` (one open entry per guest and night; `waitlist.joined` only when created); `leaveWaitlist(db, clubId, entryId, actor, now)`; `getWaitlistEntry(db, clubId, id)`; `listWaitlist(db, club, nightDate)` (test guests hidden for a live club); `runWaitlist(db, now): Promise<WaitlistOffer[]>` (the `waitlist` job, every minute); `WaitlistError` codes `bad_range | night_not_bookable | not_found`.
- **Published (`bookings/preorders.ts`):** `listMenu(db, clubId, { activeOnly? })`, `createMenuItem`, `updateMenuItem`, `setPreorder(db, club, bookingId, [{ menuItemId, qty }], actor, now)`, `addPreorderItem(db, club, bookingId, menuItemId, qty, actor, now)`, `getPreorder(db, clubId, bookingId)`, `preordersForNight(db, club, nightDate)`; `PreorderError` codes `not_found | invalid_state | bad_item | too_many`. Each change writes one `audit_log` row (`preorder_set`) and `preorder.placed { item_count, total_satang }` in one transaction.
- **Events added:** `waitlist.offered { pax_range }`, `preorder.placed { item_count, total_satang }` (`docs/EVENTS.md` regenerated).
- **Staff routes (`http/staff-extras.ts`):** `GET/POST /clubs/:slug/menu`, `PATCH /clubs/:slug/menu/:itemId` (owner, manager), `GET /clubs/:slug/preorders?date=`, `GET/PUT /clubs/:slug/bookings/:id/preorder`, `GET /clubs/:slug/waitlist?date=`, `DELETE /clubs/:slug/waitlist/:entryId` (owner, manager, host). Isolation fixtures `menu/:itemId`, `waitlist/:entryId` in `test/helpers/track-b.ts`. Web page `/staff/extras` ("Bottles").
- **Bot postbacks:** `a=waitlist&d&r`, `a=waitlist_book&w`, `a=waitlist_leave&w`, `a=bottles&b`, `a=bottle_add&b&i`, `a=bottle_clear&b`, `a=bottle_done&b` (all through `handleExtras` in `bot/flow.ts`). `M.noTables` takes an optional range key and then shows [Join waitlist] first. A sold-out night prepends `nightSoldOut` before the party-size question. Confirmations (bot `confirm`, auto-verified slip, `Notifier.confirmed`, "My booking") append `M.preorderPrompt` only when the club has an active bottle menu. [Done] sends the staff group `M.staffPreorder` ("Pre-order · table · night · lines · total", or "Cleared") through `outbox.toStaff` on every Done, as the plan says; it is a bar note, not a §6.4 alert, so no alert row. `PATCH /menu/:itemId` with an empty patch is 400.
- **Assumptions others must match:** an offer is a message, not a hold; open offers per night and side never exceed free tables. Any active booking of the guest that night marks the entry `booked` (times are not compared). Pre-orders are not charged and not counted toward minimum spend or the deposit; a line keeps the price it was first ordered at. Demo reset deletes all of the club's pre-orders and waitlist entries. Velora has no bottle menu seeded yet (add items to `demo/velora-content.ts` if the demo should show [Pre-order bottles]).
- **Unverified:** no external service (no POS or payment for pre-orders); bot flow tested against the dev gateway only.
- **Web:** `/staff/extras` ("Bottles": menu editor, pre-orders, waitlist) builds and typechecks; the browser walk is still to be done by a human.

## 2026-11-27 · B21: Busyness feed v1, built by Session A on track-a

Landed on `track-a` (one session builds both tracks). Tests: `test/busyness.test.ts` (14), plus `instagram.test.ts › the busyness feed leaves out instagram-origin rows` (the todo is split: the Metabase half stays a todo for B14 on track-c). Migration: none (keys live in `platform_flags`). Plan section "Task B21: Busyness feed v1 (expanded)".

- **Published (`data/busyness.ts`):** `BUSYNESS_RATE_LIMIT_PER_MINUTE = 60`, `MIN_BOOKED_GUESTS = 10`, `BASELINE_MIN_NIGHTS = 4`; `levelOf(fraction: number): BusynessLevel` (`1|2|3|4|5`); `busynessFeed(db: Db, opts: { kind: 'production' | 'sandbox'; date?: string; now: Date }): Promise<BusynessFeed>`; `issueBusynessKey(db: Db, input: { label: string; kind: BusynessKeyKind }, by: string, now: Date, ip?: string | null): Promise<{ key: BusynessKeyInfo; token: string }>`; `rotateBusynessKey(db: Db, id: string, by: string, now: Date, ip?: string | null): Promise<{ key: BusynessKeyInfo; token: string } | null>`; `revokeBusynessKey(db: Db, id: string, by: string, now: Date, ip?: string | null): Promise<BusynessKeyInfo | null>`; `listBusynessKeys(db: Db): Promise<BusynessKeyInfo[]>`; `verifyBusynessKey(db: Db, token: string): Promise<BusynessKeyInfo | null>`; `logBusynessRead(db: Db, key: BusynessKeyInfo, now: Date, data: { clubs: number; date: string | null }, ip?: string | null)`; `busynessRateLimiter(limit = BUSYNESS_RATE_LIMIT_PER_MINUTE): (keyId: string, now: Date) => { ok: true } | { ok: false; retryAfterSeconds: number }`. Types `BusynessFeed`, `BusynessClub`, `BusynessBucket`, `BusynessInput`, `BusynessKeyKind`, `BusynessKeyInfo`. `http/data.ts`: `busynessFeedRoutes(app: AppContext)`, `busynessKeyAdminRoutes(app: AppContext)`.
- **Routes (`http/data.ts`):** `GET /data/v1/busyness?date=` with `Authorization: Bearer bk_<id>_<secret>` (401 `invalid_key`, 429 `rate_limited` + `Retry-After`, 400 `bad_date`); mounted by one line in `app.ts`. Admin (platform admin only, under `/api/admin`): `GET/POST /busyness-keys`, `POST /busyness-keys/:id/rotate`, `DELETE /busyness-keys/:id`; mounted by one line in `http/admin/index.ts`. No web page yet for keys.
- **Response:** `{ version: 'v1', generatedAt, sandbox, clubs: [{ slug, name, nightDate, night: open|sold_out|closed, method: booking_heat|baseline_pace|null, test, buckets: [{ start, label, level: 1-5|null, noData, confidence: low|medium|high|null, inputs: (bookings|baseline|door_count|crowd_rating|searches)[] }] }] }`. Buckets every 30 min from doors to close (exclusive). No counts, spend, guest or user ids.
- **Model:** forecast = booking heat of the latest snapshot at or before the bucket (or now); `baseline_pace` (mean final heat of the last up-to-8 same-weekday nights × pace at the same lead bucket) once 4 such nights have snapshots. A started bucket takes a crowd rating from the last 60 min (level = rating, `high`), else the cumulative door count ÷ `club_profile.capacity_standing` (`medium`). `noData` when the snapshot has < 10 booked guests, or a bucket has started on a night with neither a door count nor a rating.
- **Assumptions others must match:** production key = `status 'live'` clubs only; sandbox key = `status 'demo'` clubs only, marked `test`. Search demand reads only `events.data_origin in ('first_party','pos')` (and `is_test = false` in production). Booking-derived inputs come from B12 snapshots; booking events are `first_party` whatever channel (if LINE's q12 answer is no, B12 must split snapshots by `bookings.source`). The forecast is flat across the night's buckets. Rate limit is per process in memory (a multi-instance deploy needs a shared store). Access log = one `audit_log` row per accepted read (`action 'busyness_read'`, `entity 'busyness_key'`); refused reads write nothing. Rotation stops the old token at once (no grace period). §16.1 q9 q10 (what "busy" means, the feed shape the app needs) are still open; the bucket size and levels above are the plan's assumption.
- **Unverified:** no external service; the separate app has not called it. LINE's written answer to q12 is still needed before the feed goes to the app (spec §10, owner waived the gate for building).
