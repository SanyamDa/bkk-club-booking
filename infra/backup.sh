#!/usr/bin/env bash
# Nightly Postgres backup to object storage. Host-neutral: works with any S3-compatible store
# (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO) or a local directory.
#
# Usage:
#   infra/backup.sh                      # dump + upload
#   BACKUP_DEST=file:///var/backups/club infra/backup.sh   # local directory (restore drills)
#
# Where the dump comes from (first match wins):
#   1. DATABASE_URL set            -> pg_dump "$DATABASE_URL" on this machine (pg_dump 16+ needed)
#   2. otherwise                   -> `docker compose exec -T db pg_dump` against the compose db
#                                     (pg_dump version always matches the server)
#
# Environment:
#   BACKUP_DEST        required. s3://bucket/prefix  or  file:///absolute/dir
#   S3_ENDPOINT_URL    optional. Endpoint for non-AWS S3-compatible stores (R2, B2, Spaces, MinIO)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION   for s3:// (aws CLI)
#   COMPOSE_FILE_DIR   optional. Directory holding docker-compose.yml (default: repo root)
#   POSTGRES_USER / POSTGRES_DB      optional, compose mode only (default: club / club)
#   KEEP_LOCAL_DAYS    optional, file:// only: delete local dumps older than N days (default 30)
#   CHATWOOT_BACKUP    optional. auto (default) | on | off. The shared Chatwoot inbox database
#                      (infra/chatwoot) is dumped too, as chatwoot-<stamp>.dump. auto skips it when
#                      neither CHATWOOT_DATABASE_URL is set nor the infra/chatwoot compose project runs;
#                      on makes that an error.
#   CHATWOOT_DATABASE_URL   optional. pg_dump this URL instead of the compose `postgres` service
#   CHATWOOT_COMPOSE_DIR    optional. Directory of the Chatwoot compose file (default: infra/chatwoot)
#   CHATWOOT_POSTGRES_USER / CHATWOOT_POSTGRES_DB   optional, compose mode (default: chatwoot / chatwoot)
#
# Cron (host crontab, 03:30 Asia/Bangkok, after the club night closes):
#   30 3 * * * cd /srv/club && BACKUP_DEST=s3://club-backups/prod infra/backup.sh >> /var/log/club-backup.log 2>&1
#
# Output: one custom-format dump per run, named club-YYYYMMDDTHHMMSSZ.dump (restore with pg_restore),
# plus chatwoot-YYYYMMDDTHHMMSSZ.dump for the inbox (infra/chatwoot/README.md).
# Exit code is non-zero on any failure, so cron mail / the uptime monitor can alert on it.
set -euo pipefail

: "${BACKUP_DEST:?set BACKUP_DEST to s3://bucket/prefix or file:///dir}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_dir="${COMPOSE_FILE_DIR:-$(dirname "$script_dir")}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="club-${stamp}.dump"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/$name"

log() { printf '{"at":"%s","job":"backup","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# check_dump <file> <compose dir> <service>: a dump that pg_restore cannot list is not a backup.
check_dump() {
  local file="$1" dir="$2" service="$3" size
  size="$(wc -c < "$file" | tr -d ' ')"
  if [[ "$size" -lt 1024 ]]; then
    log "$(basename "$file") too small (${size} bytes), refusing to upload"
    exit 1
  fi
  if command -v pg_restore >/dev/null 2>&1; then
    pg_restore --list "$file" > /dev/null
  elif [[ -n "$dir" ]]; then
    docker compose --project-directory "$dir" exec -T "$service" pg_restore --list < "$file" > /dev/null
  fi
  log "$(basename "$file") ok (${size} bytes)"
}

upload() {
  local file="$1" base
  base="$(basename "$file")"
  case "$BACKUP_DEST" in
    s3://*)
      endpoint=()
      [[ -n "${S3_ENDPOINT_URL:-}" ]] && endpoint=(--endpoint-url "$S3_ENDPOINT_URL")
      aws ${endpoint[@]+"${endpoint[@]}"} s3 cp --only-show-errors "$file" "${BACKUP_DEST%/}/$base"
      # Retention for s3:// is a bucket lifecycle rule (e.g. expire after 35 days), not this script.
      ;;
    file://*)
      dir="${BACKUP_DEST#file://}"
      mkdir -p "$dir"
      cp "$file" "$dir/$base"
      find "$dir" \( -name 'club-*.dump' -o -name 'chatwoot-*.dump' \) -type f -mtime +"${KEEP_LOCAL_DAYS:-30}" -delete
      ;;
    *)
      log "unsupported BACKUP_DEST: $BACKUP_DEST"
      exit 1
      ;;
  esac
  log "uploaded ${BACKUP_DEST%/}/$base"
}

case "$BACKUP_DEST" in
  s3://* | file://*) ;;
  *) log "unsupported BACKUP_DEST: $BACKUP_DEST"; exit 1 ;;
esac

log "dump start"
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --no-owner --no-privileges --file="$out" "$DATABASE_URL"
  check_dump "$out" "" db
else
  docker compose --project-directory "$compose_dir" exec -T db \
    pg_dump --format=custom --no-owner --no-privileges \
    -U "${POSTGRES_USER:-club}" -d "${POSTGRES_DB:-club}" > "$out"
  check_dump "$out" "$compose_dir" db
fi

# The shared Chatwoot inbox (spec §6.3, infra/chatwoot).
cw_mode="${CHATWOOT_BACKUP:-auto}"
cw_dir="${CHATWOOT_COMPOSE_DIR:-$script_dir/chatwoot}"
cw_out="$tmp/chatwoot-${stamp}.dump"
cw_done=0
if [[ "$cw_mode" != "off" ]]; then
  if [[ -n "${CHATWOOT_DATABASE_URL:-}" ]]; then
    log "chatwoot dump start"
    pg_dump --format=custom --no-owner --no-privileges --file="$cw_out" "$CHATWOOT_DATABASE_URL"
    check_dump "$cw_out" "" postgres
    cw_done=1
  elif [[ -f "$cw_dir/docker-compose.yml" ]] && docker compose --project-directory "$cw_dir" ps --status running --services 2>/dev/null | grep -qx postgres; then
    log "chatwoot dump start"
    docker compose --project-directory "$cw_dir" exec -T postgres \
      pg_dump --format=custom --no-owner --no-privileges \
      -U "${CHATWOOT_POSTGRES_USER:-chatwoot}" -d "${CHATWOOT_POSTGRES_DB:-chatwoot}" > "$cw_out"
    check_dump "$cw_out" "$cw_dir" postgres
    cw_done=1
  elif [[ "$cw_mode" == "on" ]]; then
    log "CHATWOOT_BACKUP=on but no CHATWOOT_DATABASE_URL and the compose project in $cw_dir is not running"
    exit 1
  else
    log "chatwoot not running here, skipped (set CHATWOOT_BACKUP=on to require it)"
  fi
fi

upload "$out"
[[ "$cw_done" -eq 1 ]] && upload "$cw_out"
log "backup done"
