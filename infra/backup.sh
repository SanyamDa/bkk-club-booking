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
#
# Cron (host crontab, 03:30 Asia/Bangkok, after the club night closes):
#   30 3 * * * cd /srv/club && BACKUP_DEST=s3://club-backups/prod infra/backup.sh >> /var/log/club-backup.log 2>&1
#
# Output: one custom-format dump per run, named club-YYYYMMDDTHHMMSSZ.dump (restore with pg_restore).
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

log "dump start"
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --no-owner --no-privileges --file="$out" "$DATABASE_URL"
else
  docker compose --project-directory "$compose_dir" exec -T db \
    pg_dump --format=custom --no-owner --no-privileges \
    -U "${POSTGRES_USER:-club}" -d "${POSTGRES_DB:-club}" > "$out"
fi

# A dump that pg_restore cannot list is not a backup.
size="$(wc -c < "$out" | tr -d ' ')"
if [[ "$size" -lt 1024 ]]; then
  log "dump too small (${size} bytes), refusing to upload"
  exit 1
fi
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$out" > /dev/null
elif [[ -z "${DATABASE_URL:-}" ]]; then
  docker compose --project-directory "$compose_dir" exec -T db pg_restore --list < "$out" > /dev/null
fi
log "dump ok (${size} bytes)"

case "$BACKUP_DEST" in
  s3://*)
    endpoint=()
    [[ -n "${S3_ENDPOINT_URL:-}" ]] && endpoint=(--endpoint-url "$S3_ENDPOINT_URL")
    aws ${endpoint[@]+"${endpoint[@]}"} s3 cp --only-show-errors "$out" "${BACKUP_DEST%/}/$name"
    # Retention for s3:// is a bucket lifecycle rule (e.g. expire after 35 days), not this script.
    ;;
  file://*)
    dir="${BACKUP_DEST#file://}"
    mkdir -p "$dir"
    cp "$out" "$dir/$name"
    find "$dir" -name 'club-*.dump' -type f -mtime +"${KEEP_LOCAL_DAYS:-30}" -delete
    ;;
  *)
    log "unsupported BACKUP_DEST: $BACKUP_DEST"
    exit 1
    ;;
esac

log "uploaded ${BACKUP_DEST%/}/$name"
