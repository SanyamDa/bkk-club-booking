# Architecture (INTERNAL, do not publish)

Status: proposal v1 · Owner: engineering · Decisions here get recorded as ADRs in `docs/adr/` once accepted.

---

## 1. System at a glance

```
                ┌──────────────────────── PUBLIC: "Book" brand ────────────────────────┐
  Consumers ──▶ │ book-web (Next.js)      book-mobile (Expo, phase 2)                  │
  Venues    ──▶ │ venue-dashboard (Next.js)   door-app (PWA: QR check-in)              │
                │                    │                                                 │
                │              book-api (TypeScript service)                           │
                │                    │                                                 │
                │              Postgres: BOOK DB  ◀── payments provider webhooks       │
                │                    ▲                                                 │
                └────────────────────┼─────────────────────────────────────────────────┘
                                     │  signals.* tables only (venue-level aggregates,
                                     │  no user ids, k-anonymity floor)
                       ┌─────────────┴─────────────┐
                       │ signals-pipeline (jobs)   │   ◀── INTERNAL ONLY
                       │ aggregate → forecast      │
                       └─────────────┬─────────────┘
                                     │ reads pulse.reports
                ┌────────────────────┼─────────────── PUBLIC: "Pulse" brand ──────────┐
  Consumers ──▶ │ pulse-mobile (Expo)   pulse-web (Next.js, read-only venue pages)     │
                │              pulse-api (TypeScript service)                          │
                │              Postgres: PULSE DB                                      │
                └──────────────────────────────────────────────────────────────────────┘

  Internal: admin (Next.js, staff-only, SSO), catalog sync, analytics warehouse
```

### Why two databases, not one with two schemas

- **Real separation of identities.** Pulse users and Book users are different accounts in different auth systems. The Book database physically cannot leak a Pulse user's location history, because it never has it.
- **Blast radius.** A bug or breach in one app doesn't expose the other.
- **Brand independence is enforced by architecture, not by discipline.** Engineers can't accidentally join a Pulse user to a Book booking.
- **Cost:** one more managed Postgres and a sync job. Worth it.

### The data boundary (the most important rule in this repo)

| May flow Pulse → Book | Must never flow |
|---|---|
| `venue_id, hour_bucket, energy_avg, crowd_avg, wait_bucket, n_reports, confidence` | Pulse user ids, device ids, raw coordinates, free-text, photos with faces |
| Forecasts: `venue_id, date, hour, predicted_energy, p10, p90` | Anything about an individual |

Rules:
- An aggregate is published only if it rests on **≥ 5 distinct reporters** (k-anonymity floor). Below that, publish "insufficient data".
- The pipeline is the **only** component with read access to both DBs. It runs under its own service account with read-only credentials to Pulse and write access **only** to `book.signals.*`.
- Flow is one way. Pulse never reads booking data, so Pulse ratings can't be influenced by who pays us.

### Legal note (Thailand PDPA)

"Nobody outside knows the apps are linked" is a marketing position, not a legal one. Both privacy policies must name the same legal entity as data controller and say that **anonymised, aggregated venue-level statistics** may be used across the company's services. Aggregated, non-personal data is low-risk under PDPA. Personal data crossing between apps without disclosure and a lawful basis is not. Get a Thai privacy lawyer to review both policies before launch.

---

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One hiring pool, shared types between client and server |
| Monorepo | **Turborepo + pnpm workspaces** | Industry standard, fast cached CI, easy for new engineers |
| Web apps | **Next.js (App Router)** on Vercel | SSR/SEO for the storefront, same framework for dashboards |
| Mobile | **Expo (React Native) + Expo Router**, EAS Build/Update | One codebase for iOS and Android, OTA fixes, native location/camera/push |
| API services | **Hono** or **NestJS** on Node, containerised (Fly.io / Cloud Run / ECS) | Business logic lives in a service we own, not in client-side DB calls. Pick NestJS if the team prefers more structure, Hono if lighter |
| Contracts | **zod** schemas in `packages/contracts` → generated OpenAPI → typed clients | Clients and server can't drift apart |
| Database | **Postgres** (managed: Supabase or Neon/RDS) | Pick Supabase for speed: Auth, Storage and Realtime included |
| ORM / migrations | **Drizzle** (SQL-first, migrations in git) | Readable SQL, no magic |
| Auth | Supabase Auth (one project per brand) or Clerk. **LINE Login**, Apple, Google, phone OTP | LINE is the default identity in Thailand |
| Jobs / queues | **pg-boss** (Postgres-backed) at first, then a managed queue later if needed | No extra infrastructure on day one |
| Realtime | Supabase Realtime / websockets for live Pulse meters and the door app | |
| Search | Postgres full-text + `pg_trgm` + PostGIS, then Typesense/Meilisearch later | Postgres is enough until roughly 10k venues |
| Maps | Mapbox or Google Maps (Thai labels) | |
| Media | Object storage + image CDN; strip EXIF on upload | |
| Observability | **Sentry** (errors), **OpenTelemetry** to Grafana/Datadog, structured logs | |
| Product analytics | **PostHog**, with a separate project per brand | Keeps the brands' analytics apart too |
| Feature flags | PostHog flags or GrowthBook | |
| Email / SMS | Resend / Postmark; LINE Messaging API for notifications | |

**Don't:** let clients write directly to tables for anything involving money, inventory or ratings. Postgres Row Level Security is a second layer of defence, not the business logic.

---

## 3. Repository layout

```
/
├─ apps/
│  ├─ book-web/            # Consumer storefront (Next.js)
│  ├─ venue-dashboard/     # B2B dashboard (Next.js)
│  ├─ door-app/            # Staff check-in PWA (Next.js, installable)
│  ├─ book-mobile/         # Phase 2 (Expo)
│  ├─ book-api/            # Booking, inventory, payments, ledger
│  ├─ pulse-mobile/        # Pulse consumer app (Expo)
│  ├─ pulse-web/           # Public read-only venue pages for SEO + sharing
│  ├─ pulse-api/           # Reports, trust scoring, live aggregates
│  ├─ signals-pipeline/    # INTERNAL: Pulse aggregates → Book signals + forecasts
│  └─ admin/               # INTERNAL: ops, moderation, venue onboarding
├─ packages/
│  ├─ contracts/           # zod schemas + OpenAPI generation (per domain)
│  ├─ db-book/             # Drizzle schema + migrations for BOOK DB
│  ├─ db-pulse/            # Drizzle schema + migrations for PULSE DB
│  ├─ catalog/             # Venue catalog types + sync logic (shared domain)
│  ├─ tokens-book/         # Book design tokens (DESIGN.md → code)
│  ├─ tokens-pulse/        # Pulse design tokens
│  ├─ ui-book/             # Book component library (web + native variants)
│  ├─ ui-pulse/            # Pulse component library
│  ├─ i18n/                # th/en message catalogs, formatters (THB, dates)
│  ├─ money/               # Integer-satang money type, VAT/service calc
│  └─ config/              # eslint, tsconfig, prettier, vitest presets
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ adr/                 # Architecture Decision Records, numbered
│  └─ runbooks/            # Incident + on-call procedures
└─ .github/                # CI workflows, CODEOWNERS, PR template
```

**Boundary enforcement in CI** (eslint `boundaries` plugin or Nx-style tags):
- `pulse-*` may not import `db-book`, `ui-book`, `tokens-book`, or anything `book-*`. The reverse holds too.
- Only `signals-pipeline` may import both `db-pulse` and `db-book`.
- `ui-*` packages may not import from `apps/*`.

### Code organisation inside an API

Organise by **domain module**, not by technical layer:

```
book-api/src/modules/
  venues/   inventory/   bookings/   payments/   ledger/   payouts/   promoters/   events/   signals/
    ├─ routes.ts        # HTTP layer, validates with contracts
    ├─ service.ts       # business rules, no HTTP or SQL details
    ├─ repo.ts          # SQL via Drizzle
    ├─ events.ts        # domain events emitted (BookingConfirmed, PayoutScheduled…)
    └─ *.test.ts
```

Modules talk to each other through service interfaces or domain events, never through each other's tables. That keeps a module extractable into its own service later if it ever needs to be.

---

## 4. Core data model (Book DB, abridged)

```
organizations(id, name, tax_id, payout_account_ref, commission_bps, status)
venues(id, org_id, slug, type[club|bar|restaurant|rooftop], name_en, name_th,
       geo(point), district, hours jsonb, dress_code, min_age, vat_inclusive bool,
       service_charge_bps, is_partner bool, status)
venue_members(venue_id, user_id, role[owner|manager|host|door|promoter])

inventory_items(id, venue_id, kind[table|ticket|guestlist|package|slot],
                name, capacity, min_spend_satang, price_satang, floor_plan_ref, active)
availability(id, item_id, starts_at, ends_at, quantity, held, sold)  -- per night/slot

bookings(id, venue_id, customer_id, status[held|pending_payment|confirmed|
         checked_in|no_show|cancelled|refunded], party_size, starts_at,
         promoter_id NULL, source[web|app|widget|promoter_link], idempotency_key)
booking_lines(booking_id, item_id, qty, unit_price_satang)
payments(id, booking_id, provider, provider_ref, amount_satang, status)

ledger_accounts(id, owner_type, owner_id, kind[platform_revenue|venue_payable|
                promoter_payable|provider_clearing|refunds])
ledger_entries(id, txn_id, account_id, amount_satang, direction[debit|credit], created_at)
payouts(id, org_id, amount_satang, status, provider_ref, period)

signals.venue_hourly(venue_id, hour_bucket, energy_avg, crowd_avg, wait_bucket,
                     n_reports, confidence)       -- written ONLY by signals-pipeline
signals.forecast(venue_id, for_date, hour, predicted_energy, p10, p90, model_version)
```

Rules:
- **Money is an integer in satang** (1 THB = 100 satang). Never use floats. VAT (7%) and service charge (10%) are computed in `packages/money`, with the rounding rule written down.
- **Inventory holds** use a Postgres row lock or `UPDATE … WHERE sold + held < quantity` with a 10-minute TTL hold. No double-selling a table.
- **Idempotency key** on every booking and payment mutation.
- Timestamps in `timestamptz`, displayed in `Asia/Bangkok`. A "night" runs 18:00 → 06:00 and belongs to the date it started, so 2am Saturday counts as Friday night.

## 5. Pulse data model (abridged)

```
users(id, auth_id, handle, trust_score, created_at)       -- no real name required
venues_replica(id, type, name_en, name_th, geo, district) -- synced from catalog
reports(id, user_id, venue_id, created_at, energy 1-5, crowd 1-5, wait_bucket,
        door_strictness, music_tag, extra jsonb, verified_on_site bool,
        distance_bucket, weight)                           -- NO raw lat/lng stored
media(id, report_id, storage_key, moderation_status, expires_at)
live_venue_state(venue_id, computed_at, energy, crowd, wait, n_recent, confidence)
```

Location privacy by design: the client sends coordinates, the server checks the geofence and stores only `verified_on_site` and a coarse `distance_bucket`, then drops the coordinates. We cannot leak a location trail we never kept.

---

## 6. Payments and commission

Flow for "table at 10,000 THB, we take 5%":

1. Customer pays 10,000 via the provider's hosted checkout (card, PromptPay, TrueMoney, Rabbit LINE Pay).
2. Provider webhook arrives. Verify the signature, look up the payment by idempotency key, mark it `confirmed`.
3. Ledger transaction (must balance to zero):
   - Debit `provider_clearing` 10,000
   - Credit `venue_payable[venue]` 9,500
   - Credit `platform_revenue` 500
   - (If a promoter is attached: split from the venue's side according to the venue's promoter terms, e.g. credit `promoter_payable` X, debit venue share)
4. Payout job (daily or weekly per venue contract) sends `venue_payable` balances through the provider's marketplace transfer API.
5. Monthly: issue a Thai tax invoice to each venue for the commission (e-Tax Invoice).

Provider options to evaluate:
- **Opn Payments (Omise):** Thai company, strong PromptPay and local methods, supports transfers to recipients.
- **Stripe Connect:** best developer experience. Confirm current Thailand support for Connect payouts to Thai venues.
- **2C2P:** enterprise-leaning and common with Thai hospitality.

Before going live, confirm with a Thai payments lawyer whether our flow puts us under Bank of Thailand e-payment licensing, and structure the flow so the licensed provider holds the funds.

Card data never touches our servers. Use hosted fields or redirect only, so we stay at PCI SAQ-A.

---

## 7. Security baseline

Target **OWASP ASVS Level 2** for the APIs and dashboards.

- **AuthN:** short-lived access tokens and rotating refresh tokens. **Mandatory 2FA** for venue owners and managers (they control payouts). Staff admin uses Google Workspace SSO only.
- **AuthZ:** RBAC per venue membership (`owner, manager, host, door, promoter`), checked in the service layer, with RLS as backup. Every query in a venue context is scoped by `venue_id`.
- **Payout bank details:** stored only at the payments provider, never in our DB. Changing them needs 2FA re-auth plus email and LINE notification to all owners, followed by a 48-hour cooldown.
- **Input:** every request is validated against zod contracts. Parameterised SQL only (Drizzle). Uploads are size- and type-checked, re-encoded, EXIF-stripped, and moderated before going public.
- **Abuse:** rate limiting per IP, account and device (Redis/Upstash), bot protection on signup and checkout (Turnstile), and anti-fraud signals from the payments provider.
- **Secrets:** a secret manager (Doppler / 1Password / cloud KMS). No `.env` in git. Separate keys per environment.
- **Audit log:** append-only `audit_events` for every venue-staff and admin action (who, what, before/after).
- **Supply chain:** Renovate, `pnpm audit`/OSV in CI, lockfile enforced, CodeQL.
- **Data:** encryption at rest (provider default), TLS everywhere, PII minimised, retention policies (Pulse media expires after 24h unless featured; raw reports anonymised after 180 days).
- **Mobile:** certificate pinning is optional. Use secure storage for tokens and App Attest / Play Integrity on report submission, which raises the cost of fake-report farms.

---

## 8. Signals and forecasting

**Live (Pulse, realtime):**
`live_score = Σ(wᵢ · scoreᵢ) / Σwᵢ` over reports from the last 90 minutes, where
`wᵢ = trust(user) × verified_on_site × exp(-age_minutes / 30)`.
Show the result only when `n_recent ≥ 3`. Otherwise show "No recent reports" plus the forecast.

**Forecast (Book, "will it be lit tonight?"):**

- *v0 (ship first):* for each venue × weekday × hour, an exponentially weighted mean over the last 8 matching nights with a half-life of 3 weeks. P10–P90 band from the empirical spread.
- *v1 adjustments* (multiplicative, each tested on held-out nights):
  - Headliner DJ or event booked (from Book's events table)
  - Thai calendar: payday (25th to end of month), long weekends, **alcohol-ban days** (Buddhist holidays, election days: predict closed), Songkran, Loy Krathong, NYE
  - Weather: heavy rain (rooftops, open-air)
  - Book's own signal: tables sold or held for tonight (a strong same-day predictor)
- *v2:* gradient-boosted model (LightGBM) when there are over 6 months of data, evaluated by MAE against realised live scores, with a model card and version stored on each forecast row.

Display rule: **always show confidence.** "Likely packed after 00:30 · based on 7 recent Fridays." If confidence is low, say so rather than inventing certainty.

---

## 9. Team workflow (so many people can work on it for years)

- **Trunk-based development.** Short-lived branches, PRs into `main`, squash merge, Conventional Commits.
- **CODEOWNERS** per app and package. A change to `ledger/`, `payments/` or the data boundary needs two approvals.
- **CI on every PR:** typecheck, lint (including boundary rules), unit tests (Vitest), API integration tests against a throwaway Postgres (Testcontainers), Playwright e2e on web, Maestro on mobile, and build. Preview deploys per PR (Vercel; EAS preview channels).
- **Environments:** `local` (docker compose + seed data), `staging` (prod-like, seeded with fake venues), `production`. Migrations run automatically, forward-only, reviewed like code.
- **ADRs:** any decision that's hard to reverse gets a one-page ADR in `docs/adr/NNNN-title.md`.
- **Definition of done:** tests, i18n strings in both th and en, analytics event named per the tracking plan, accessibility check, Sentry clean on staging.
- **Docs live next to the code.** Each app's `SPECIFICATION.md` and `DESIGN.md` is the source of truth and changes in the same PR as the feature.

## 10. Phasing

| Phase | Weeks | Ship |
|---|---|---|
| 0 | 1–2 | Monorepo, CI, auth, catalog of ~150 Bangkok venues (all types, partner or not), design tokens for both brands |
| 1 | 3–10 | **Pulse MVP** (report, live map, venue page), plus street-team seeding in Thonglor, Ekkamai, Sukhumvit and Silom. Data starts accumulating from day one, and it's the slowest thing to build |
| 1 (parallel) | 3–12 | **Book MVP:** venue dashboard (inventory, bookings, door check-in), storefront, payments + ledger, 5–10 pilot venues |
| 2 | 12–20 | Signals pipeline + v0 forecast in Book, promoter tooling, LINE OA notifications, embeddable widget |
| 3 | 20+ | Book native app, v1/v2 forecasting, venue insights product |

Start Pulse **first or in parallel**, not after Book. The forecast is only as good as the weeks of history behind it.
