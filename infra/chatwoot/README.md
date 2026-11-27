# Chatwoot CE: the shared inbox

One self-hosted Chatwoot Community Edition install serves every club (spec §6.3). Our server
creates one Chatwoot **account** per club through Chatwoot's platform API, with an API-channel
inbox (LINE is mirrored into it), an agent bot (the booking bot) and our booking panel as a
dashboard app. Managers never sign in to Chatwoot themselves: the staff dashboard gives them a
single sign-on link into their own club's account only.

The files here:

| File | What it is |
|---|---|
| `docker-compose.yml` | Chatwoot web (`rails`), background worker (`sidekiq`), Postgres with pgvector, Redis. Named volumes, `restart: unless-stopped` |
| `.env.example` | Chatwoot settings; copy to `.env` |

## First setup

1. Copy the settings and fill in every empty value:

   ```sh
   cd infra/chatwoot
   cp .env.example .env
   # SECRET_KEY_BASE: openssl rand -hex 64
   # POSTGRES_PASSWORD, REDIS_PASSWORD: openssl rand -hex 24
   # FRONTEND_URL: the public https address of the inbox
   ```

2. Prepare the database, then start everything:

   ```sh
   docker compose run --rm rails bundle exec rails db:chatwoot_prepare
   docker compose up -d
   ```

3. Put a TLS reverse proxy in front of `127.0.0.1:3000` at `FRONTEND_URL`. The proxy must pass
   websockets (`/cable`).

4. Open `FRONTEND_URL`. The first visit asks for the first user: this is the **super admin** of the
   install, for the platform team only. Turn on its second factor.

5. In the super admin console (`FRONTEND_URL/super_admin`), open **Platform Apps**, create one
   named `club-platform`, and copy its access token.

6. In our server's `apps/server/.env`:

   ```sh
   CHATWOOT_URL=https://inbox.example.com
   CHATWOOT_PLATFORM_TOKEN=<the platform app token>
   ```

   Restart our server. From then on, **creating a club** in the admin console also creates its
   Chatwoot account, API inbox, agent bot and booking panel. With these two values empty, clubs are
   created without an inbox and the staff "Open inbox" link answers 503.

   **CHATWOOT_URL must be on the same registrable domain as our `PUBLIC_URL`** (for example
   `inbox.example.com` beside `app.example.com`, both under `example.com`). Chatwoot shows our
   booking panel (`PUBLIC_URL/inbox-panel`) in an iframe, and the panel signs in with our staff
   session cookie, which is `SameSite=Lax`. On a different registrable domain the iframe's request
   is cross-site, the browser does not send the cookie, and the panel always answers 401.

7. Clubs that existed before step 6, or whose provisioning failed (the create-club response says
   `inbox.status: "failed"`), are provisioned with
   `POST /api/admin/clubs/<slug>/inbox/provision`. It is safe to repeat: every completed step is
   stored in `platform_flags['chatwoot:<clubId>']` and skipped next time.

## Restart and upgrade

- Restart: `docker compose restart` (or `docker compose down && docker compose up -d`). Data lives
  in the named volumes `chatwoot_postgres`, `chatwoot_redis` and `chatwoot_storage`, so restarts,
  `down` and host reboots keep every account, conversation and attachment. Never run
  `docker compose down -v`: it deletes the volumes.
- Check it came back: `docker compose ps` shows all four services `running` (Postgres and Redis
  `healthy`), and a manager's SSO link from the staff dashboard opens their inbox.
- Upgrade: take a backup first (below), change the image tag in `docker-compose.yml`, then
  `docker compose pull && docker compose run --rm rails bundle exec rails db:chatwoot_prepare && docker compose up -d`.

## Backup

`infra/backup.sh` dumps the Chatwoot database next to ours on every run:

- It writes `chatwoot-YYYYMMDDTHHMMSSZ.dump` (custom format, restore with `pg_restore`) to the same
  `BACKUP_DEST` as `club-*.dump`.
- Source: `CHATWOOT_DATABASE_URL` when set, otherwise `docker compose exec postgres pg_dump` in this
  directory (`CHATWOOT_COMPOSE_DIR`, default `infra/chatwoot`).
- `CHATWOOT_BACKUP=auto` (default) skips the Chatwoot dump when this compose project is not running
  and no `CHATWOOT_DATABASE_URL` is set; `on` makes a missing Chatwoot an error; `off` skips it.
- Attachments live in the `chatwoot_storage` volume. Every message is also stored in our own
  database, so losing attachments loses no chat text; back the volume up with the host's volume
  snapshots if attachments matter.

Restore drill:

```sh
docker compose stop rails sidekiq
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner \
  -U chatwoot -d chatwoot < chatwoot-YYYYMMDDTHHMMSSZ.dump
docker compose start rails sidekiq
```

## What our server stores

`platform_flags['chatwoot:<clubId>']` holds the club's Chatwoot account, inbox, agent bot and
dashboard app ids, and the encrypted tokens of the club's platform-owned admin user and agent bot.
`platform_flags['chatwoot:<clubId>:user:<userId>']` maps one of our staff users to their Chatwoot
user for that club. Each staff user gets a separate Chatwoot user per club, a member of that
club's account only, so the SSO link can never reach another club's inbox.
