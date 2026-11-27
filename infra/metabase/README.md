# Data dashboard (Metabase), internal only

Spec §14.5, §14.6. Task B14. Metabase (open-source edition) reads the analytics area through a read-only role.
It is for the platform team only: the free edition has no per-club row security, so clubs see their own
figures in our dashboard (A16, A16b), never here.

## What it can read

Migration `apps/server/drizzle/0005_analytics_views.sql` creates three schemas:

| Schema | Holds | Granted to `metabase_ro` |
|---|---|---|
| `analytics_src` | base views with a `demo` flag | no |
| `analytics` | real clubs only: no `is_test` row, no row of a demo club, no test guest's booking | yes (SELECT) |
| `analytics_demo` | Velora (demo clubs) only | yes (SELECT) |

Both granted schemas have the same views: `clubs`, `events` (no `raw` column), `booking_funnel`, `booking_pace`,
`booking_curve`, `demand_no_table`, `no_show_rate`, `door_vs_bookings`, `busyness_by_hour`.
Origin rules (§14.8): events only with `data_origin` in (`first_party`, `pos`) and not on the `instagram`
channel; bookings whose `source` is `instagram` are left out. No Meta data reaches Metabase.

`metabase_ro` has no other grant, and `default_transaction_read_only = on`: an INSERT fails even on a
view. `apps/server/test/analytics.test.ts` checks this with `SET ROLE metabase_ro` on PGlite.

## Boards

`dashboards/*.json` holds the six starter boards (booking funnel, booking curve and pace, demand that found
no table, no-show rate, door counts against bookings, busyness by club and hour). Every card is native SQL
with a **Dataset** filter: `live` (default) reads `analytics`, `demo` reads `analytics_demo`. Velora is
visible only with `Dataset = demo`. Chat-based figures (handoff, deflection, takeovers) are not here (§14.6).

## Run it

1. Add to `/srv/club/.env`: `METABASE_DB_PASSWORD=$(openssl rand -hex 24)` and
   `METABASE_APP_DB_PASSWORD=$(openssl rand -hex 24)` (hex only). The first is for `metabase_ro` (reads the
   analytics views); the second is for `metabase_app`, a non-superuser that owns only Metabase's settings database.
2. `docker compose --profile metabase up -d` starts `metabase-init` (sets the roles' passwords, creates the `metabase`
   settings database owned by `metabase_app`) and then Metabase.
3. Metabase listens on `127.0.0.1:3000` only. It is not behind the public proxy, so no club login and no
   public URL reaches it. Open it through an SSH tunnel: `ssh -L 3000:127.0.0.1:3000 <host>`.
4. Create the first admin in the browser, then load the boards:
   `MB_USER=... MB_PASSWORD=... METABASE_DB_PASSWORD=... node infra/metabase/provision.mjs`.

**Unverified:** `provision.mjs` and the image tag have not been run against a real Metabase; tests only run
the board SQL on PGlite as `metabase_ro`.
