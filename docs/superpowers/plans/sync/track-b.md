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
