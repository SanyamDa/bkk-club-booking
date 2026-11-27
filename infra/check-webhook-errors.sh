#!/usr/bin/env bash
# Webhook error-rate alert from ops_events (spec §13 Observability, plan A12).
#
# Counts webhook and send errors per club in the last WINDOW_MIN minutes and alerts when any
# club reaches THRESHOLD, or when errors are more than MAX_RATE_PCT of that club's LINE webhook
# deliveries (raw_webhooks) in the window (only when the club had at least MIN_INBOUND deliveries).
#
# Usage:
#   infra/check-webhook-errors.sh                 # compose db (docker compose exec -T db psql)
#   DATABASE_URL=postgres://... infra/check-webhook-errors.sh
#
# Environment (all optional):
#   WINDOW_MIN=15  THRESHOLD=5  MAX_RATE_PCT=5  MIN_INBOUND=20
#   ALERT_URL      called with curl (GET, ?msg=...) when the check fails (Healthchecks.io /fail,
#                  Better Stack heartbeat, a Slack/LINE Notify relay)
#   OK_URL         called on success (heartbeat: alert when the check itself stops running)
#   COMPOSE_FILE_DIR / POSTGRES_USER / POSTGRES_DB   compose mode only (default: repo root / club / club)
#
# Cron (every 5 minutes):
#   */5 * * * * cd /srv/club && ALERT_URL=https://hc-ping.com/<uuid>/fail OK_URL=https://hc-ping.com/<uuid> infra/check-webhook-errors.sh >> /var/log/club-webhook-check.log 2>&1
#
# Exit code: 0 ok, 1 alert, 2 the check could not run (also alerts).
set -uo pipefail

WINDOW_MIN="${WINDOW_MIN:-15}"
THRESHOLD="${THRESHOLD:-5}"
MAX_RATE_PCT="${MAX_RATE_PCT:-5}"
MIN_INBOUND="${MIN_INBOUND:-20}"
for v in WINDOW_MIN THRESHOLD MAX_RATE_PCT MIN_INBOUND; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { echo "$v must be a whole number" >&2; exit 2; }
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_dir="${COMPOSE_FILE_DIR:-$(dirname "$script_dir")}"

log() { printf '{"at":"%s","job":"webhook-check","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# One row per club with errors: club_id|errors|inbound|rate_pct|kinds
read -r -d '' SQL <<SQL
WITH err AS (
  SELECT coalesce(club_id, '-') AS club_id, count(*) AS n,
         string_agg(DISTINCT kind, ',') AS kinds
  FROM ops_events
  WHERE at > now() - interval '${WINDOW_MIN} minutes'
    AND kind IN ('webhook_bad_signature', 'webhook_unknown_club', 'bot_error', 'send_failed')
  GROUP BY 1
), inb AS (
  SELECT club_id, count(*) AS n
  FROM raw_webhooks
  WHERE channel = 'line' AND received_at > now() - interval '${WINDOW_MIN} minutes'
  GROUP BY 1
)
SELECT err.club_id, err.n, coalesce(inb.n, 0),
       CASE WHEN coalesce(inb.n, 0) = 0 THEN 0 ELSE round(100.0 * err.n / inb.n, 1) END,
       err.kinds
FROM err LEFT JOIN inb ON inb.club_id = err.club_id
ORDER BY err.n DESC;
SQL

if [[ -n "${DATABASE_URL:-}" ]]; then
  out="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -AtF '|' -c "$SQL" 2>&1)"
else
  out="$(docker compose --project-directory "$compose_dir" exec -T db \
    psql -U "${POSTGRES_USER:-club}" -d "${POSTGRES_DB:-club}" -v ON_ERROR_STOP=1 -AtF '|' -c "$SQL" 2>&1)"
fi
status=$?

alert() {
  log "ALERT $1"
  if [[ -n "${ALERT_URL:-}" ]]; then
    curl -fsS -m 10 -G --data-urlencode "msg=$1" "$ALERT_URL" > /dev/null || log "alert url failed"
  fi
}

if [[ $status -ne 0 ]]; then
  alert "check failed: $(printf '%s' "$out" | head -1)"
  exit 2
fi

failed=0
while IFS='|' read -r club n inbound rate kinds; do
  [[ -z "$club" ]] && continue
  if (( n >= THRESHOLD )); then
    alert "club $club: $n webhook/send errors in ${WINDOW_MIN} min ($kinds)"
    failed=1
  elif (( inbound >= MIN_INBOUND )) && awk -v r="$rate" -v m="$MAX_RATE_PCT" 'BEGIN { exit !(r > m) }'; then
    alert "club $club: error rate ${rate}% of $inbound inbound in ${WINDOW_MIN} min ($kinds)"
    failed=1
  fi
done <<< "$out"

if (( failed )); then exit 1; fi
log "ok"
if [[ -n "${OK_URL:-}" ]]; then curl -fsS -m 10 "$OK_URL" > /dev/null || log "ok url failed"; fi
exit 0
