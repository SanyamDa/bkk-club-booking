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
