#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
BACKEND_LOG="$ROOT_DIR/backend-nightly-sync.log"

PORT="${PORT:-3001}"
SYNC_TIMEZONE="${SYNC_TIMEZONE:-Europe/Rome}"
EXPECTED_LOCAL_HOUR="${EXPECTED_LOCAL_HOUR:-01}"
RUN_ODDS_SYNC="${RUN_ODDS_SYNC:-false}"
ODDS_SYNC_COMPETITIONS="${ODDS_SYNC_COMPETITIONS:-Serie A|Premier League|La Liga|Bundesliga|Ligue 1}"
ODDS_SYNC_MARKETS="${ODDS_SYNC_MARKETS:-h2h,totals,spreads}"

BACKEND_PID=""

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

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
curl --silent --show-error --fail \
  -X POST "http://127.0.0.1:$PORT/api/scraper/understat" \
  -H "Content-Type: application/json" \
  --data '{"mode":"top5","yearsBack":1,"importPlayers":true,"includeMatchDetails":true,"forceRefresh":false}'
echo

if [[ "$RUN_ODDS_SYNC" == "true" && -n "${ODDS_API_KEY:-}" ]]; then
  IFS='|' read -r -a competitions <<< "$ODDS_SYNC_COMPETITIONS"
  for competition in "${competitions[@]}"; do
    if [[ -z "$competition" ]]; then
      continue
    fi
    echo "Running odds snapshot sync for: $competition"
    curl --silent --show-error --fail \
      -X POST "http://127.0.0.1:$PORT/api/scraper/odds" \
      -H "Content-Type: application/json" \
      --data "{\"competition\":\"$competition\",\"markets\":[\"h2h\",\"totals\",\"spreads\"]}"
    echo
  done
else
  echo "Skipping odds sync. RUN_ODDS_SYNC=false or ODDS_API_KEY missing."
fi

echo "Running learning review sync..."
curl --silent --show-error --fail \
  -X POST "http://127.0.0.1:$PORT/api/learning/reviews/sync" \
  -H "Content-Type: application/json" \
  --data '{"limit":50,"forceRefresh":false}'
echo

echo "Fetching final scheduler status snapshot..."
curl --silent --show-error --fail "http://127.0.0.1:$PORT/api/scraper/status"
echo

echo "Nightly sync workflow completed."
