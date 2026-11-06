#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
BACKEND_LOG="$ROOT_DIR/backend-nightly-sync.log"

PORT="${PORT:-3001}"
SYNC_TIMEZONE="${SYNC_TIMEZONE:-Europe/Rome}"
SCHEDULE_CRON="${SCHEDULE_CRON:-}"
RUN_ODDS_SYNC="${RUN_ODDS_SYNC:-false}"
API_FOOTBALL_ENABLED="${API_FOOTBALL_ENABLED:-false}"
PLAYER_AVAILABILITY_ENABLED="${PLAYER_AVAILABILITY_ENABLED:-false}"
IMPORT_PLAYERS=false
if [[ "${PLAYER_DATA_ENABLED:-false}" == "true" ]]; then IMPORT_PLAYERS=true; fi
ODDS_SYNC_COMPETITIONS="${ODDS_SYNC_COMPETITIONS:-Serie A|Premier League|La Liga|Bundesliga|Ligue 1}"
ODDS_SYNC_MARKETS="${ODDS_SYNC_MARKETS:-h2h,totals,spreads}"
# SofaScore RIMOSSO: falli/corner/tiri/cartellini/arbitro ora da football-data.co.uk
# (fonte HTTP/CSV stabile, vedi step piu' sotto).
UNDERSTAT_SYNC_TIMEOUT_SECONDS="${UNDERSTAT_SYNC_TIMEOUT_SECONDS:-3600}"
FOOTBALL_DATA_TIMEOUT_SECONDS="${FOOTBALL_DATA_TIMEOUT_SECONDS:-2400}"
TRANSITION_REFERENCE_TIMEOUT_SECONDS="${TRANSITION_REFERENCE_TIMEOUT_SECONDS:-600}"
API_FOOTBALL_TIMEOUT_SECONDS="${API_FOOTBALL_TIMEOUT_SECONDS:-120}"
PREDICTIONS_SETTLEMENT_TIMEOUT_SECONDS="${PREDICTIONS_SETTLEMENT_TIMEOUT_SECONDS:-180}"
ODDS_SYNC_TIMEOUT_SECONDS="${ODDS_SYNC_TIMEOUT_SECONDS:-300}"
LEARNING_SYNC_TIMEOUT_SECONDS="${LEARNING_SYNC_TIMEOUT_SECONDS:-600}"
FINAL_STATUS_TIMEOUT_SECONDS="${FINAL_STATUS_TIMEOUT_SECONDS:-120}"
RUN_TRANSITION_REFERENCE_SYNC="${RUN_TRANSITION_REFERENCE_SYNC:-false}"
RESEARCH_NIGHTLY_ENABLED="${RESEARCH_NIGHTLY_ENABLED:-false}"
RESEARCH_NIGHTLY_TIMEOUT_SECONDS="${RESEARCH_NIGHTLY_TIMEOUT_SECONDS:-1200}"
UPCOMING_KICKOFFS_TIMEOUT_SECONDS="${UPCOMING_KICKOFFS_TIMEOUT_SECONDS:-180}"
NIGHTLY_SOURCE_MODE="${NIGHTLY_SOURCE_MODE:-primary}"
NIGHTLY_SOURCE_MANIFEST_FILE="${NIGHTLY_SOURCE_MANIFEST_FILE:-${RUNNER_TEMP:-$ROOT_DIR/artifacts}/nightly-source-manifest.json}"
NIGHTLY_SOURCE_MAPPING_FILE="${NIGHTLY_SOURCE_MAPPING_FILE:-${RUNNER_TEMP:-$ROOT_DIR/artifacts}/nightly-source-mapping.json}"
export NIGHTLY_SOURCE_MODE NIGHTLY_SOURCE_MANIFEST_FILE NIGHTLY_SOURCE_MAPPING_FILE
if [[ "$NIGHTLY_SOURCE_MODE" != "primary" && "$NIGHTLY_SOURCE_MODE" != "verified-alternatives" ]]; then
  echo "Invalid NIGHTLY_SOURCE_MODE."
  exit 1
fi
if [[ "$NIGHTLY_SOURCE_MODE" == "verified-alternatives" ]]; then
  # A malformed target/mapping must fail before a backend can access its DB.
  node "$BACKEND_DIR/scripts/prepare-nightly-source-config.js"
fi

BACKEND_PID=""
REQUIRED_SYNC_FAILURES=()

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
    -H "Origin: http://127.0.0.1:$PORT" \
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

# GitHub admission is checked before npm/build using read-only workflow metadata.
# Refuse an unguarded scheduled call rather than falling back to the retired UTC gate.
if [[ "${GITHUB_EVENT_NAME:-}" == "schedule" || "${NIGHTLY_GUARD_PASSED:-}" == "true" ]]; then
  if [[ "${NIGHTLY_GUARD_PASSED:-}" != "true" || "${NIGHTLY_GUARD_DAY:-}" != "$(TZ="$SYNC_TIMEZONE" date +%F)" ]]; then
    echo "Nightly requires admission for the current Rome day."
    exit 1
  fi
fi
if [[ "${GITHUB_EVENT_NAME:-}" == "schedule" ]]; then
  case "$SCHEDULE_CRON" in
    "7 3 * * *"|"17 4 * * *"|"27 5 * * *") ;;
    *) echo "Unsupported nightly trigger; no maintenance started."; exit 1 ;;
  esac
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
NIGHTLY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Starting backend for CI sync..."
NODE_ENV=ci \
SHARED_ADMIN_AUTH_ENABLED=false \
CORS_ORIGIN="http://127.0.0.1:$PORT" \
PORT="$PORT" \
AUTO_SYNC_ON_BOOT=false \
WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED=false \
NIGHTLY_ORCHESTRATOR=github_actions \
UNDERSTAT_SCHEDULER_ENABLED=false \
ODDS_SNAPSHOT_SCHEDULER_ENABLED=false \
LEARNING_REVIEW_SCHEDULER_ENABLED=false \
LINEUP_REFRESH_SCHEDULER_ENABLED=false \
RESEARCH_T15_SCHEDULER_ENABLED=false \
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

if [[ "$NIGHTLY_SOURCE_MODE" == "primary" ]]; then
echo "Running Understat sync..."
if ! post_json \
  "http://127.0.0.1:$PORT/api/scraper/understat" \
  "{\"mode\":\"top5\",\"yearsBack\":5,\"importPlayers\":$IMPORT_PLAYERS,\"includeMatchDetails\":true,\"forceRefresh\":false,\"_schedulerRun\":{\"enabled\":true,\"schedulerName\":\"understat\",\"trigger\":\"github_actions\",\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" \
  "$UNDERSTAT_SYNC_TIMEOUT_SECONDS"; then
  REQUIRED_SYNC_FAILURES+=("understat")
  echo "Required gate failed: Understat. Continuing with independent data gates."
fi
else
  echo "Using verified alternative sources; retained Understat xG are preserved."
fi

if [[ "$NIGHTLY_SOURCE_MODE" == "verified-alternatives" ]]; then
  echo "Collecting and importing independently verified source subsets..."
  if timeout "$FOOTBALL_DATA_TIMEOUT_SECONDS" node scripts/nightly-alternative-sources.js --execute \
    --target-sha256 "$NIGHTLY_SOURCE_TARGET_SHA256" --season "$NIGHTLY_SOURCE_SEASON" \
    --mapping "$NIGHTLY_SOURCE_MAPPING_FILE" --collect-fdo --collect-csv > "$NIGHTLY_SOURCE_MANIFEST_FILE"; then
    node scripts/nightly-source-context.js --recompute-imported-teams || \
      REQUIRED_SYNC_FAILURES+=("source-derived-statistics")
  else
    echo "Alternative maintenance unavailable; fixture admission will fail closed. Settlement continues."
  fi
elif [[ -n "${NIGHTLY_SOURCE_TARGET_SHA256:-}" && -n "${NIGHTLY_SOURCE_SEASON:-}" ]]; then
  # Even the primary route must use the shared CSV budget across CI runners.
  if timeout "$FOOTBALL_DATA_TIMEOUT_SECONDS" node scripts/nightly-alternative-sources.js --execute --csv-only \
    --target-sha256 "$NIGHTLY_SOURCE_TARGET_SHA256" --season "$NIGHTLY_SOURCE_SEASON" --collect-csv > "$NIGHTLY_SOURCE_MANIFEST_FILE"; then
    node scripts/nightly-source-context.js --recompute-imported-teams || \
      REQUIRED_SYNC_FAILURES+=("source-derived-statistics")
  else
    echo "Supplement unavailable; retaining existing observed statistics without an unbudgeted download."
  fi
else
  echo "CSV collection not configured; no direct or unbudgeted supplemental download."
fi

if [[ "$PLAYER_AVAILABILITY_ENABLED" == "true" ]]; then
  echo "Saving local last-five lineup predictions; API-Football enrichment is optional..."
  post_json \
    "http://127.0.0.1:$PORT/api/player-availability/sync-upcoming" \
    '{"windowHours":24}' \
    "$API_FOOTBALL_TIMEOUT_SECONDS" || \
    echo "Warning: lineup sync failed; the on-demand local fallback remains available."
else
  echo "Skipping lineup sync. PLAYER_AVAILABILITY_ENABLED=false."
fi

if [[ "$RUN_TRANSITION_REFERENCE_SYNC" == "true" && "$NIGHTLY_SOURCE_MODE" == "primary" ]]; then
  echo "Syncing second-division seasonal references (idempotent)..."
  if ! post_json \
    "http://127.0.0.1:$PORT/api/competition-transitions/sync-references" \
    "{}" \
    "$TRANSITION_REFERENCE_TIMEOUT_SECONDS"; then
    REQUIRED_SYNC_FAILURES+=("second-division-references")
    echo "Required gate failed: second-division references. Continuing with independent data gates."
  fi
else
  echo "Skipping transition reference sync. RUN_TRANSITION_REFERENCE_SYNC=false."
fi

# Chiude le giocate operative dopo l'import delle statistiche supplementari.
# In precedenza la nightly aggiornava solo le prediction archiviate: le bet nel
# budget restavano PENDING fino a una navigazione manuale nell'interfaccia.
echo "Settling pending budget bets for completed matches..."
if ! post_json \
  "http://127.0.0.1:$PORT/api/bets/sync" \
  "{}" \
  "$PREDICTIONS_SETTLEMENT_TIMEOUT_SECONDS"; then
  echo "Warning: budget bet settlement batch timed out/failed; continuing with the remaining nightly jobs."
fi

# Existing virtual A/C bets settle even when new nightly registrations are disabled.
echo "Settling pending virtual A/C bets..."
if ! post_json "http://127.0.0.1:$PORT/api/research/settle" "{}" "$PREDICTIONS_SETTLEMENT_TIMEOUT_SECONDS"; then
  REQUIRED_SYNC_FAILURES+=("virtual-settlement")
fi

# The Understat route already settles the small user-facing opportunity archive.
# Keep the complete raw prediction settlement as a separate maintenance step:
# it can be slower and remains useful for calibration/backtest history.
echo "Settling the complete technical prediction audit for completed matches..."
if ! post_json \
  "http://127.0.0.1:$PORT/api/predictions/settle-completed" \
  "{\"limit\":${PREDICTIONS_SETTLEMENT_MATCH_LIMIT:-25}}" \
  "$PREDICTIONS_SETTLEMENT_TIMEOUT_SECONDS"; then
  echo "Warning: prediction settlement batch timed out/failed; continuing with the remaining nightly jobs."
fi

if [[ "$RUN_ODDS_SYNC" == "true" && -n "${ODDS_API_KEY:-}" ]]; then
  IFS='|' read -r -a competitions <<< "$ODDS_SYNC_COMPETITIONS"
  for competition in "${competitions[@]}"; do
    if [[ -z "$competition" ]]; then
      continue
    fi
    echo "Running odds snapshot sync for: $competition"
    if ! post_json \
      "http://127.0.0.1:$PORT/api/scraper/odds" \
      "{\"competition\":\"$competition\",\"markets\":[\"h2h\",\"totals\",\"spreads\"],\"requestOrigin\":\"nightly\"}" \
      "$ODDS_SYNC_TIMEOUT_SECONDS"; then
      REQUIRED_SYNC_FAILURES+=("odds:$competition")
      echo "Required gate failed: odds for $competition. Continuing with the remaining competitions."
    fi
  done
else
  echo "Skipping odds sync. RUN_ODDS_SYNC=false or ODDS_API_KEY missing."
fi

# Import is not permission to recalibrate. The explicit operational command
# prepares compatible profiles separately; recommendation inference is cache-only.
echo "Calibration rebuild disabled in automatic maintenance; requiring exact existing profiles."

if [[ "$RESEARCH_NIGHTLY_ENABLED" == "true" ]]; then
  if [[ "$NIGHTLY_SOURCE_MODE" == "primary" ]]; then
  echo "Refreshing upcoming Top 5 kickoff times from the free event calendar..."
  if ! post_json \
    "http://127.0.0.1:$PORT/api/system/sync-upcoming-kickoffs" \
    '{"mode":"top5","limit":160}' \
    "$UPCOMING_KICKOFFS_TIMEOUT_SECONDS"; then
    REQUIRED_SYNC_FAILURES+=("upcoming-kickoffs")
    echo "Required gate failed: upcoming kickoff calendar. New virtual decisions are blocked."
  fi
  fi
  RESEARCH_NIGHTLY_DATA_GATES_PASSED=true
  if (( ${#REQUIRED_SYNC_FAILURES[@]} > 0 )); then RESEARCH_NIGHTLY_DATA_GATES_PASSED=false; fi
  echo "Running explicit Nightly Pre-Match Virtual Betting A/C..."
  if ! RESEARCH_NIGHTLY_ENABLED=true RESEARCH_T15_SCHEDULER_ENABLED=false \
    RESEARCH_NIGHTLY_DATA_GATES_PASSED="$RESEARCH_NIGHTLY_DATA_GATES_PASSED" \
    timeout "$RESEARCH_NIGHTLY_TIMEOUT_SECONDS" node scripts/research-nightly.js; then
    REQUIRED_SYNC_FAILURES+=("virtual-nightly")
  fi
else
  echo "New virtual A/C registrations disabled. RESEARCH_NIGHTLY_ENABLED=false."
fi

if (( ${#REQUIRED_SYNC_FAILURES[@]} == 0 )) && [[ "$NIGHTLY_SOURCE_MODE" == "primary" ]]; then
  echo "Running learning review sync..."
  post_json \
    "http://127.0.0.1:$PORT/api/learning/reviews/sync" \
    "{\"limit\":50,\"forceRefresh\":false,\"_schedulerRun\":{\"enabled\":true,\"schedulerName\":\"learning\",\"trigger\":\"github_actions\",\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" \
    "$LEARNING_SYNC_TIMEOUT_SECONDS"
else
  echo "Skipping learning review sync in alternative mode or after failed required gates: ${REQUIRED_SYNC_FAILURES[*]}."
fi

echo "Fetching final scheduler status snapshot..."
get_json "http://127.0.0.1:$PORT/api/scraper/status" "$FINAL_STATUS_TIMEOUT_SECONDS"

if (( ${#REQUIRED_SYNC_FAILURES[@]} > 0 )); then
  echo "Nightly sync completed with required data-gate failures: ${REQUIRED_SYNC_FAILURES[*]}."
  exit 1
fi

if ! post_json \
  "http://127.0.0.1:$PORT/api/research/nightly-complete" \
  "{\"startedAt\":\"$NIGHTLY_STARTED_AT\"}" \
  "$FINAL_STATUS_TIMEOUT_SECONDS"; then
  # Transitional compatibility: the emergency two-file nightly patch can run
  # against the old backend before the full, authorized deployment.
  echo "Warning: nightly completion marker unavailable; data maintenance completed."
fi

echo "Nightly sync workflow completed."
