# Hosting (24/7)

One Docker host runs two containers from `docker-compose.yml`:

| Service | Image | Data | Restart |
|---|---|---|---|
| `app` | built from `Dockerfile` (API, LINE webhook, built web app) | volume `appdata` at `/data` (uploaded slips and media) | `unless-stopped`, healthcheck on `GET /health` |
| `db` | `postgres:16` | volume `pgdata` | `unless-stopped`, healthcheck `pg_isready` |

The app uses real Postgres in this setup: compose sets `DATABASE_URL`, and `db/client.ts` then uses node-postgres instead of PGlite. Migrations in `apps/server/drizzle` run on every start-up. The app is ready when `GET /health` returns `{"ok":true}`.

The files are host-neutral. The hosting region is still open (spec §16.1 question 5; a Thailand region is preferred). Any VM with Docker Engine and the Compose plugin works.

## 1. Deploy

1. Provision a VM (2 vCPU, 2 GB RAM is enough to start). Install Docker Engine and the Compose plugin.
2. Put a TLS reverse proxy in front of port 8787 (Caddy, nginx or the host's load balancer). LINE requires an `https` webhook URL.
3. Clone the repo to `/srv/club` and create `/srv/club/.env` (gitignored; compose reads it):

   ```sh
   POSTGRES_PASSWORD=<hex, see below>      # hex only: it is placed inside DATABASE_URL
   APP_SECRET=<hex, see below>             # at least 32 characters; the example value is refused
   CREDENTIALS_KEY=<base64, see below>     # base64 of exactly 32 bytes; required in production
   PUBLIC_URL=https://book.example.com     # the public https URL behind the proxy
   # optional
   ANTHROPIC_API_KEY=
   APP_PORT=8787
   ```

   Generate the secrets:

   ```sh
   openssl rand -hex 24      # POSTGRES_PASSWORD
   openssl rand -hex 32      # APP_SECRET
   openssl rand -base64 32   # CREDENTIALS_KEY
   ```

   Store `CREDENTIALS_KEY` in a password manager as well. Without it, a restored database cannot decrypt club LINE credentials.

4. Start:

   ```sh
   cd /srv/club
   docker compose up -d --build
   docker compose ps                      # both services "healthy"
   curl -fsS http://localhost:8787/health # {"ok":true}
   ```

5. Update to a new version:

   ```sh
   git pull && docker compose up -d --build app
   ```

   Migrations run when the new container starts. Take a backup first (section 2) when the release has a migration.

`DEV_SIMULATOR` is forced to `0`. The app refuses `DEV_SIMULATOR` and `LINE_FAKE` outside `development` and `test`.

Logs are structured: one JSON object per line on stdout (`time`, `level`, `msg`, plus fields; errors under `err`), written by `lib/log.ts`. Docker's `json-file` driver keeps them (5 x 20 MB). Read them with `docker compose logs -f app`. Ship them to a log service through the host's log agent when one is chosen.

## 2. Backup

`infra/backup.sh` writes one `pg_dump` custom-format file per run and uploads it. It checks the dump with `pg_restore --list` before upload and exits non-zero on any failure.

Destinations:

- `s3://bucket/prefix`: any S3-compatible store through the `aws` CLI. Set `S3_ENDPOINT_URL` for non-AWS stores (Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO). Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_DEFAULT_REGION`. Use a key that can only write to that bucket. Keep 35 days with a bucket lifecycle rule.
- `file:///absolute/dir`: a local directory, for restore drills. Dumps older than `KEEP_LOCAL_DAYS` (default 30) are deleted.

Source: with `DATABASE_URL` set, the script runs `pg_dump` on the host (version 16 or newer). Without it, the script runs `pg_dump` inside the compose `db` container, so the versions always match.

Nightly cron on the host (03:30 Bangkok time, after club nights close):

```sh
# crontab -e   (host clock in Asia/Bangkok, or adjust the hour)
30 3 * * * cd /srv/club && BACKUP_DEST=s3://club-backups/prod S3_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com infra/backup.sh >> /var/log/club-backup.log 2>&1
```

Also back up the `appdata` volume (uploaded slips) the same night, for example `docker run --rm -v club_appdata:/data -v "$PWD":/out alpine tar czf /out/appdata.tgz -C /data .` and upload that file. The volume name is `<project>_appdata`; check it with `docker volume ls`.

Alert when a backup fails: the cron line exits non-zero, and the log line `"msg":"uploaded ..."` is missing. Use a heartbeat monitor (section 5): append `&& curl -fsS <heartbeat-url>` to the cron line.

## 3. Restore

Restore into a fresh database, then start the app. The app needs the same `CREDENTIALS_KEY` that was in use when the dump was taken.

```sh
cd /srv/club
docker compose stop app
# fetch the dump (or use a file:// copy)
aws ${S3_ENDPOINT_URL:+--endpoint-url "$S3_ENDPOINT_URL"} s3 cp s3://club-backups/prod/club-YYYYMMDDTHHMMSSZ.dump ./restore.dump

docker compose exec -T db dropdb   -U club --if-exists club
docker compose exec -T db createdb -U club club
docker compose exec -T db pg_restore --no-owner --no-privileges -U club -d club < ./restore.dump

docker compose start app
curl -fsS http://localhost:8787/health   # {"ok":true}
```

The dump includes the `drizzle` schema (applied-migration journal). On start, the app applies only migrations newer than the dump.

### Restore drill (do this before go-live, then every quarter)

1. `BACKUP_DEST=file:///tmp/drill infra/backup.sh`
2. Follow the restore steps above with `/tmp/drill/club-*.dump`.
3. Check `/health`, sign in to the staff dashboard, and open one recent booking.
4. Write the date and the result in the ops log.

Drill run on 2026-11-27 against a local Postgres 16: dump (80 KB), drop, `pg_restore`, app restart. `/health` returned `{"ok":true}`, the demo club row was intact, and no migration was re-applied.

## 4. Rotate `CREDENTIALS_KEY`

`CREDENTIALS_KEY` encrypts secrets in two places (AES-256-GCM, `v1:iv:tag:data`, `key_ref = 'env:CREDENTIALS_KEY:v1'`):

- each club secret, in `club_credentials.ciphertext`;
- the platform LINE Login channel shared by every club's booking form (A4b), in `platform_flags` row `key = 'line_login'`, field `value->>'ciphertext'`.

The app reads one key only. A rotation re-encrypts both stores with the new key in one transaction and then swaps the key. Neither store needs to change `key_ref`. Missing the platform login channel would break the shared booking form for every club that has no login channel of its own.

Rotate when someone with access to the key leaves, or when the key may have leaked.

1. Take a backup (section 2). Keep the old key until step 6 is done.
2. Generate the new key: `openssl rand -base64 32`.
3. Re-encrypt both stores in one transaction, inside the running app container:

   ```sh
   docker compose exec -T -e OLD_KEY="<old base64>" -e NEW_KEY="<new base64>" app node --input-type=module -e '
     import pg from "pg";
     import { decryptSecret, encryptSecret } from "./dist/platform/crypto.js";
     const oldKey = Buffer.from(process.env.OLD_KEY, "base64");
     const newKey = Buffer.from(process.env.NEW_KEY, "base64");
     if (oldKey.length !== 32 || newKey.length !== 32) throw new Error("keys must be 32 bytes");
     const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
     await c.connect();
     await c.query("BEGIN");
     const { rows } = await c.query("SELECT id, ciphertext FROM club_credentials FOR UPDATE");
     for (const r of rows) {
       const next = encryptSecret(decryptSecret(r.ciphertext, oldKey), newKey);
       await c.query("UPDATE club_credentials SET ciphertext = $1 WHERE id = $2", [next, r.id]);
     }
     const flag = await c.query("SELECT value FROM platform_flags WHERE key = $1 FOR UPDATE", ["line_login"]);
     let platformLogin = 0;
     if (flag.rows[0]?.value?.ciphertext) {
       const next = encryptSecret(decryptSecret(flag.rows[0].value.ciphertext, oldKey), newKey);
       await c.query("UPDATE platform_flags SET value = jsonb_set(value, $1, to_jsonb($2::text)) WHERE key = $3", ["{ciphertext}", next, "line_login"]);
       platformLogin = 1;
     }
     await c.query("COMMIT");
     console.log(JSON.stringify({ rotated: rows.length, platformLogin }));
     await c.end();
   '
   ```

   A row that fails to decrypt aborts the script before `COMMIT`, so nothing changes. `platformLogin` is 1 when the platform login channel was re-encrypted, 0 when none is saved yet.
4. Set `CREDENTIALS_KEY=<new>` in `/srv/club/.env`, then `docker compose up -d app`.
5. Check: `/health` is ok, one club's LINE bot answers a test message (the app decrypts its channel secret on each webhook), and the booking form opens inside LINE for a club on the shared login channel (the app decrypts the platform login channel for it).
6. Delete the old key from the password manager. Backups taken before the rotation still need the old key: keep it with those backups until they expire (35 days), then destroy it.

Between steps 3 and 4 the running app still holds the old key, so webhook signature checks fail for a few seconds. Do the rotation outside club hours.

## 5. Monitoring

Uptime monitor (any provider: UptimeRobot, Better Stack, Healthchecks.io, a cloud provider's check):

- `GET https://<PUBLIC_URL>/health` every 1 minute. Alert when the status is not 200 or the body is not `{"ok":true}`, for 2 checks in a row. Target: 99.9% monthly (spec §13).
- Backup heartbeat: one ping a night from the backup cron line; alert when it is missing for 26 hours.

Webhook error rate from `ops_events`. Run this every 5 minutes from the host (cron plus a heartbeat or alert URL), or as a Metabase alert once Metabase exists (B14):

```sql
-- Webhook and send errors in the last 15 minutes, per club.
SELECT club_id, kind, count(*) AS n
FROM ops_events
WHERE at > now() - interval '15 minutes'
  AND kind IN ('webhook_bad_signature', 'webhook_unknown_club', 'bot_error', 'send_failed')
GROUP BY club_id, kind
ORDER BY n DESC;
```

Alert when any club has 5 or more rows in 15 minutes. A burst of `webhook_bad_signature` for one club after a console change usually means a wrong channel secret.

`infra/check-webhook-errors.sh` runs this check. It alerts when a club has `THRESHOLD` (default 5) or more errors in `WINDOW_MIN` (default 15) minutes, or when errors exceed `MAX_RATE_PCT` (default 5%) of that club's inbound messages in the window (only when the club had at least `MIN_INBOUND`, default 20, inbound messages). It reads the compose database through `docker compose exec`, or `DATABASE_URL` when set. Exit code 0 is ok, 1 is an alert, 2 means the check could not run (that alerts too). It calls `ALERT_URL` on an alert and `OK_URL` on success, so a heartbeat monitor also catches a check that stopped running:

```sh
*/5 * * * * cd /srv/club && ALERT_URL=https://hc-ping.com/<uuid>/fail OK_URL=https://hc-ping.com/<uuid> infra/check-webhook-errors.sh >> /var/log/club-webhook-check.log 2>&1
```

Until B3 adds `raw_webhooks`, the denominator is inbound rows in `messages`. A signature failure writes no message, so the absolute threshold is what catches a wrong channel secret.

### Peak-load test (spec §13 Peak load)

Run before the pilot, and again after any change to the bot turn or the database. Target: 50 bookings/min per club and 1,000 inbound messages/min in total, Friday 22:00-01:00 pattern (ramp up, peak 23:30-00:30, taper), with p95 reply latency under 3 s and under 1% errors. The script exits 1 when the target is missed.

```sh
# local: server with DEV_SIMULATOR=1 (npm run dev), full rate, 3 hours compressed into 5 minutes
npm run load -w @club/server -- --mode sim --clubs demo --duration 300
# quick smoke run at 10% of the rate
npm run load -w @club/server -- --duration 30 --scale 0.1
# staging, signed like LINE (measures the webhook ack, not the reply; the club's access token must not be real)
LOAD_CHANNEL_SECRET=<channel secret> npm run load -w @club/server -- --mode webhook --base https://staging.example.com --clubs demo
```

`--mode sim` posts to `/api/dev/:slug/event`, which runs the whole bot turn before it answers, so the response time is the reply latency. `--mode webhook` signs each body with the channel secret, as LINE does; that route answers before the turn runs. A booking is two events from one guest (the `a=book` postback, then the night pick); the rest of the 1,000/min is free text from distinct guests. Set `LOAD_COOKIE` once the simulator needs a platform-admin login (B8).

## 6. Still open

- Production host and region (spec §16.1 question 5). Decide before go-live.
- Error tracking service (spec §13) is not chosen.
