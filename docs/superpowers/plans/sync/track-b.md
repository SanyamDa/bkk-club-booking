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

**For B8b:** the `nights` job closes a date in `alcoholBanDates(db, from, to)` with `closed_reason = 'alcohol_ban'` on rows with `edited_by` null. `calendar.test.ts` › `the next nights job run closes a new alcohol-ban day on rows nobody edited` stays `it.todo` until B8b lands; B8b turns it real.

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
