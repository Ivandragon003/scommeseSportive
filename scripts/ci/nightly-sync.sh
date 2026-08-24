#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
BACKEND_LOG="$ROOT_DIR/backend-nightly-sync.log"

PORT="${PORT:-3001}"
SYNC_TIMEZONE="${SYNC_TIMEZONE:-Europe/Rome}"
EXPECTED_LOCAL_HOUR="${EXPECTED_LOCAL_HOUR:-03}"
SCHEDULE_CRON="${SCHEDULE_CRON:-}"
RUN_ODDS_SYNC="${RUN_ODDS_SYNC:-false}"
API_FOOTBALL_ENABLED="${API_FOOTBALL_ENABLED:-false}"
ODDS_SYNC_COMPETITIONS="${ODDS_SYNC_COMPETITIONS:-Serie A|Premier League|La Liga|Bundesliga|Ligue 1}"
ODDS_SYNC_MARKETS="${ODDS_SYNC_MARKETS:-h2h,totals,spreads}"
# SofaScore RIMOSSO: falli/corner/tiri/cartellini/arbitro ora da football-data.co.uk
# (fonte HTTP/CSV stabile, vedi step piu' sotto).
FOOTBALL_DATA_KEEP_SEASONS="${FOOTBALL_DATA_KEEP_SEASONS:-4}"
FOOTBALL_DATA_TIMEOUT_SECONDS="${FOOTBALL_DATA_TIMEOUT_SECONDS:-900}"
UNDERSTAT_SYNC_TIMEOUT_SECONDS="${UNDERSTAT_SYNC_TIMEOUT_SECONDS:-4200}"
LEARNING_SYNC_TIMEOUT_SECONDS="${LEARNING_SYNC_TIMEOUT_SECONDS:-1800}"
ODDS_SYNC_TIMEOUT_SECONDS="${ODDS_SYNC_TIMEOUT_SECONDS:-1800}"
FINAL_STATUS_TIMEOUT_SECONDS="${FINAL_STATUS_TIMEOUT_SECONDS:-120}"
RUN_TRANSITION_REFERENCE_SYNC="${RUN_TRANSITION_REFERENCE_SYNC:-true}"

BACKEND_PID=""

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

print_backend_log_tail() {
  if [[ -f "$BACKEND_LOG" ]]; then
    echo "----- backend log tail -----"
    tail -n 120 "$BACKEND_LOG" || true
    echo "----------------------------"
  fi
}

post_json() {
  local url="$1"
  local body="$2"
  local timeout_seconds="$3"
  if ! curl --silent --show-error --fail-with-body --max-time "$timeout_seconds" \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    --data "$body"; then
    echo "Request failed: $url"
    print_backend_log_tail
    return 1
  fi
  echo
}

get_json() {
  local url="$1"
  local timeout_seconds="$2"
  if ! curl --silent --show-error --fail-with-body --max-time "$timeout_seconds" "$url"; then
    echo "Request failed: $url"
    print_backend_log_tail
    return 1
  fi
  echo
}

if [[ "${GITHUB_EVENT_NAME:-}" == "schedule" ]]; then
  # GitHub Actions puo avviare il cron con ritardo. Controllare solo l'ora
  # locale farebbe saltare il run valido; usare invece il cron originale,
  # che resta disponibile in github.event.schedule anche dopo il ritardo.
  if [[ -n "$SCHEDULE_CRON" ]]; then
    CURRENT_OFFSET="$(TZ="$SYNC_TIMEZONE" date +%z)"
    case "$CURRENT_OFFSET" in
      +0200) EXPECTED_SCHEDULE_CRON="0 1 * * *" ;;
      +0100) EXPECTED_SCHEDULE_CRON="0 2 * * *" ;;
      *)
        echo "Skip scheduled run: unsupported $SYNC_TIMEZONE UTC offset '$CURRENT_OFFSET'."
        exit 0
        ;;
    esac

    if [[ "$SCHEDULE_CRON" != "$EXPECTED_SCHEDULE_CRON" ]]; then
      echo "Skip scheduled run: cron '$SCHEDULE_CRON' is not the active $SYNC_TIMEZONE cron '$EXPECTED_SCHEDULE_CRON' (offset $CURRENT_OFFSET)."
      exit 0
    fi
  else
    # Fallback per esecuzioni esterne che non espongono github.event.schedule.
    CURRENT_LOCAL_HOUR="$(TZ="$SYNC_TIMEZONE" date +%H)"
    if [[ "$CURRENT_LOCAL_HOUR" != "$EXPECTED_LOCAL_HOUR" ]]; then
      echo "Skip scheduled run: local hour in $SYNC_TIMEZONE is $CURRENT_LOCAL_HOUR, expected $EXPECTED_LOCAL_HOUR."
      exit 0
    fi
  fi
fi

required_envs=(
  TURSO_DATABASE_URL
  TURSO_AUTH_TOKEN
)

for name in "${required_envs[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name"
    exit 1
  fi
done

cd "$BACKEND_DIR"

echo "Starting backend for CI sync..."
NODE_ENV=production \
PORT="$PORT" \
AUTO_SYNC_ON_BOOT=false \
UNDERSTAT_SCHEDULER_ENABLED=false \
ODDS_SNAPSHOT_SCHEDULER_ENABLED=false \
LEARNING_REVIEW_SCHEDULER_ENABLED=false \
nohup node dist/index.js >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "Waiting for backend health..."
for attempt in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:$PORT/api/health" >/dev/null; then
    echo "Backend is healthy."
    break
  fi
  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "Backend exited unexpectedly."
    cat "$BACKEND_LOG" || true
    exit 1
  fi
  sleep 2
  if [[ "$attempt" == "60" ]]; then
    echo "Backend healthcheck timeout."
    cat "$BACKEND_LOG" || true
    exit 1
  fi
done

echo "Running Understat sync..."
post_json \
  "http://127.0.0.1:$PORT/api/scraper/understat" \
  "{\"mode\":\"top5\",\"yearsBack\":1,\"importPlayers\":true,\"includeMatchDetails\":true,\"forceRefresh\":false,\"_schedulerRun\":{\"enabled\":true,\"schedulerName\":\"understat\",\"trigger\":\"github_actions\",\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" \
  "$UNDERSTAT_SYNC_TIMEOUT_SECONDS"

echo "Running football-data.co.uk supplemental sync (fouls/corners/shots/cards/referee) + season retention..."
if ! post_json \
  "http://127.0.0.1:$PORT/api/scraper/football-data" \
  "{\"keepSeasons\":$FOOTBALL_DATA_KEEP_SEASONS,\"recomputeAverages\":true}" \
  "$FOOTBALL_DATA_TIMEOUT_SECONDS"; then
  echo "Warning: supplemental football-data sync failed; continuing with the primary Understat data."
fi

if [[ "$API_FOOTBALL_ENABLED" == "true" && -n "${API_FOOTBALL_KEY:-}" ]]; then
  echo "Checking API-Football confirmed lineups and availability before slow maintenance jobs..."
  post_json \
    "http://127.0.0.1:$PORT/api/player-availability/sync-upcoming" \
    '{"windowHours":24}' \
    "${API_FOOTBALL_TIMEOUT_SECONDS:-120}" || \
    echo "Warning: API-Football lineup sync failed; internal lineup predictor remains active."
else
  echo "Skipping API-Football lineup sync. API_FOOTBALL_ENABLED=false or API_FOOTBALL_KEY missing."
fi

if [[ "$RUN_TRANSITION_REFERENCE_SYNC" == "true" ]]; then
  echo "Syncing second-division seasonal references (idempotent)..."
  if ! post_json \
    "http://127.0.0.1:$PORT/api/competition-transitions/sync-references" \
    "{}" \
    "$FOOTBALL_DATA_TIMEOUT_SECONDS"; then
    echo "Warning: transition reference sync failed; continuing with the normal nightly flow."
  fi
else
  echo "Skipping transition reference sync. RUN_TRANSITION_REFERENCE_SYNC=false."
fi

# The Understat route already settles the small user-facing opportunity archive.
# Keep the complete raw prediction settlement as a separate maintenance step:
# it can be slower and remains useful for calibration/backtest history.
echo "Settling the complete technical prediction audit for completed matches..."
if ! post_json \
  "http://127.0.0.1:$PORT/api/predictions/settle-completed" \
  "{\"limit\":${PREDICTIONS_SETTLEMENT_MATCH_LIMIT:-25}}" \
  "${PREDICTIONS_SETTLEMENT_TIMEOUT_SECONDS:-180}"; then
  echo "Warning: prediction settlement batch timed out/failed; continuing with the remaining nightly jobs."
fi

if [[ "$RUN_ODDS_SYNC" == "true" && -n "${ODDS_API_KEY:-}" ]]; then
  IFS='|' read -r -a competitions <<< "$ODDS_SYNC_COMPETITIONS"
  for competition in "${competitions[@]}"; do
    if [[ -z "$competition" ]]; then
      continue
    fi
    echo "Running odds snapshot sync for: $competition"
    post_json \
      "http://127.0.0.1:$PORT/api/scraper/odds" \
      "{\"competition\":\"$competition\",\"markets\":[\"h2h\",\"totals\",\"spreads\"]}" \
      "$ODDS_SYNC_TIMEOUT_SECONDS"
  done
else
  echo "Skipping odds sync. RUN_ODDS_SYNC=false or ODDS_API_KEY missing."
fi

echo "Creating valid internal bets for matches in the next ${AUTO_BET_WINDOW_HOURS:-24} hours..."
post_json \
  "http://127.0.0.1:$PORT/api/automation/place-valid-bets" \
  "{\"userId\":\"${AUTO_BET_USER_ID:-user1}\",\"windowHours\":${AUTO_BET_WINDOW_HOURS:-24},\"maxMatches\":${AUTO_BET_MAX_MATCHES:-100}}" \
  "${AUTO_BET_TIMEOUT_SECONDS:-3600}"

echo "Running learning review sync..."
post_json \
  "http://127.0.0.1:$PORT/api/learning/reviews/sync" \
  "{\"limit\":50,\"forceRefresh\":false,\"_schedulerRun\":{\"enabled\":true,\"schedulerName\":\"learning\",\"trigger\":\"github_actions\",\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" \
  "$LEARNING_SYNC_TIMEOUT_SECONDS"

echo "Fetching final scheduler status snapshot..."
get_json "http://127.0.0.1:$PORT/api/scraper/status" "$FINAL_STATUS_TIMEOUT_SECONDS"

echo "Nightly sync workflow completed."
