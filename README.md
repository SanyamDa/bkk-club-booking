# Bkk Party · LINE booking automation for clubs

Automates table bookings inside a club's **own LINE Official Account**: night → party size → table → guest details → house rules → PromptPay deposit → confirmation with a door QR. Staff get a live dashboard and LINE group alerts. Product spec: **[clubs/SPEC.md](clubs/SPEC.md)**.

**Status:** Phase 0 (demo) and Phase 1a (live on LINE) are built, running on a fictional club, *Velora (Demo)*. Phase 1a has not been run against a real LINE account yet. First pilot client: House of Savoy.

## Quick start (no LINE account needed)

Requires Node 20+.

```bash
npm install
```

```bash
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env`: set `APP_SECRET` to a long random string. Then create your own staff account for the demo club (it prints a password once; run it while the app is stopped, because the embedded database allows one process at a time):

```bash
npm run admin:create -w @club/server -- --email you@example.com --name "You" --club demo --role owner
npm run dev
```

Leave out `--club` and `--role` to create a platform admin instead: it also prints a TOTP `otpauth://` link (and QR) for your authenticator app, and sign-in asks for the 6-digit code.

| Open | What it is |
|---|---|
| http://localhost:5173/dev/simulator | Chat with the bot as a guest. Uses the real bot code; nothing is sent to LINE |
| http://localhost:5173/staff | Staff dashboard (sign in with the email and password from `npm run admin:create`) |

The database is an embedded Postgres (PGlite) stored in `apps/server/.data/`. Delete that folder to start fresh.

To use a real LINE account on your phone: do the one-time setup in **[docs/LINE-SETUP.md](docs/LINE-SETUP.md)**, then run `npm run live`.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | API server (port 8787) + web app (port 5173, proxies to the API) |
| `npm test` | Booking engine + full LINE flow tests (in-memory database) |
| `npm run typecheck` | TypeScript checks for both apps |
| `npm run admin:create -w @club/server -- --email … --name …` | Create a platform admin (password + TOTP link, shown once); add `--club <slug> --role <role>` for a club member |
| `npm run build` then `npm start` | Production build; the server also serves the web app |
| `npm run db:generate` | Create a migration after changing `apps/server/src/db/schema.ts` |
| `npm run live` | Go live on a real LINE account: tunnel + webhook + rich menu + LIFF + message check, then prints an add-friend QR ([docs/LINE-SETUP.md](docs/LINE-SETUP.md)) |

## Layout

```
apps/server/                 API + LINE bot (TypeScript, Hono, Drizzle, Postgres)
  src/bookings/service.ts    Booking engine: nights, availability, holds, deposits, staff actions
  src/bot/flow.ts            The LINE conversation: every message/button → next step
  src/bot/messages.ts        LINE message builders (cards, quick replies), Thai + English via i18n.ts
  src/bot/intents.ts         Keyword rules (EN/TH). Phase 2 adds AI on top
  src/line/                  LINE gateway (real / dev) and the outbox that logs + sends every message
  src/http/                  Routes: webhook, guest form API, staff API, signed media, simulator
  src/db/                    Schema, migrations, demo club seed
  test/                      Vitest suites
apps/web/                    React (Vite): guest details form (LIFF), staff dashboard, chat simulator
clubs/SPEC.md                Product spec for the club booking product
docs/LINE-SETUP.md           Connecting a real LINE Official Account
docs/archive/                Earlier marketplace plan (Book + Pulse), on hold
```

## Rules worth knowing before you change things

- **No double bookings:** a partial unique index allows one active booking per table per night. Don't work around it in code.
- **Money is integer satang.** Format only at the edges (`formatBaht`).
- **Every outgoing message goes through `Outbox`**, so it's logged and uses a free reply token when there is one. Pushes cost the club LINE quota.
- **LINE secrets never go in the database.** The club row stores the *names* of environment variables.
- **Deposits go straight to the club's PromptPay.** We never hold guest money.
- **Each club is data, not code.** Tables, prices, rules and texts live in the club's settings.

## Phase 0 limits (planned for Phase 1)

- One shared staff password. Per-person accounts, roles and 2FA come next.
- Tables, prices and rules are edited in `apps/server/src/db/seed.ts`, not yet in the dashboard.
- Slips are approved by staff. Automatic slip verification is not built yet.
- Not built yet: day-of reminders, the camera door scanner, running late / cancel from LINE, and AI understanding of free text.
