#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
BACKEND_LOG="$ROOT_DIR/backend-nightly-sync.log"

PORT="${PORT:-3001}"
SYNC_TIMEZONE="${SYNC_TIMEZONE:-Europe/Rome}"
EXPECTED_LOCAL_HOUR="${EXPECTED_LOCAL_HOUR:-01}"
RUN_ODDS_SYNC="${RUN_ODDS_SYNC:-false}"
CI_SKIP_ODDS_SYNC="${CI_SKIP_ODDS_SYNC:-true}"
ODDS_SYNC_COMPETITIONS="${ODDS_SYNC_COMPETITIONS:-Serie A|Premier League|La Liga|Bundesliga|Ligue 1}"
ODDS_SYNC_MARKETS="${ODDS_SYNC_MARKETS:-h2h,totals,spreads}"
UNDERSTAT_SYNC_TIMEOUT_SECONDS="${UNDERSTAT_SYNC_TIMEOUT_SECONDS:-4200}"
LEARNING_SYNC_TIMEOUT_SECONDS="${LEARNING_SYNC_TIMEOUT_SECONDS:-1800}"
ODDS_SYNC_TIMEOUT_SECONDS="${ODDS_SYNC_TIMEOUT_SECONDS:-1800}"
FINAL_STATUS_TIMEOUT_SECONDS="${FINAL_STATUS_TIMEOUT_SECONDS:-120}"

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
  if ! curl --silent --show-error --fail --max-time "$timeout_seconds" \
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
  if ! curl --silent --show-error --fail --max-time "$timeout_seconds" "$url"; then
    echo "Request failed: $url"
    print_backend_log_tail
    return 1
  fi
  echo
}

if [[ "${GITHUB_EVENT_NAME:-}" == "schedule" ]]; then
  CURRENT_LOCAL_HOUR="$(TZ="$SYNC_TIMEZONE" date +%H)"
  if [[ "$CURRENT_LOCAL_HOUR" != "$EXPECTED_LOCAL_HOUR" ]]; then
    echo "Skip scheduled run: local hour in $SYNC_TIMEZONE is $CURRENT_LOCAL_HOUR, expected $EXPECTED_LOCAL_HOUR."
    exit 0
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
  '{"mode":"top5","yearsBack":1,"importPlayers":true,"includeMatchDetails":true,"forceRefresh":false}' \
  "$UNDERSTAT_SYNC_TIMEOUT_SECONDS"

if [[ "$CI_SKIP_ODDS_SYNC" == "true" ]]; then
  echo "Skipping odds sync in CI. Eurobet automation is not reliable on GitHub-hosted runners."
elif [[ "$RUN_ODDS_SYNC" == "true" && -n "${ODDS_API_KEY:-}" ]]; then
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

echo "Running learning review sync..."
post_json \
  "http://127.0.0.1:$PORT/api/learning/reviews/sync" \
  '{"limit":50,"forceRefresh":false}' \
  "$LEARNING_SYNC_TIMEOUT_SECONDS"

echo "Fetching final scheduler status snapshot..."
get_json "http://127.0.0.1:$PORT/api/scraper/status" "$FINAL_STATUS_TIMEOUT_SECONDS"

echo "Nightly sync workflow completed."
