-- Manual, additive proposal. Never invoked by application startup or this experiment.
CREATE TABLE IF NOT EXISTS model_a_prospective_forecasts (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  forecast_at TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  CHECK (julianday(forecast_at) < julianday(kickoff_at))
);
CREATE INDEX IF NOT EXISTS idx_model_a_prospective_match ON model_a_prospective_forecasts(match_id, forecast_at);
CREATE TRIGGER IF NOT EXISTS model_a_prospective_no_update BEFORE UPDATE ON model_a_prospective_forecasts
BEGIN SELECT RAISE(ABORT, 'model A prospective forecasts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS model_a_prospective_no_delete BEFORE DELETE ON model_a_prospective_forecasts
BEGIN SELECT RAISE(ABORT, 'model A prospective forecasts are append-only'); END;

-- Result observations are separate from the immutable prediction and linked by match_id.
CREATE TABLE IF NOT EXISTS model_a_prospective_results (
  evidence_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  home_goals INTEGER NOT NULL CHECK(home_goals >= 0),
  away_goals INTEGER NOT NULL CHECK(away_goals >= 0),
  evidence_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_a_prospective_results_match ON model_a_prospective_results(match_id, observed_at);
CREATE TRIGGER IF NOT EXISTS model_a_prospective_results_no_update BEFORE UPDATE ON model_a_prospective_results
BEGIN SELECT RAISE(ABORT, 'model A prospective results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS model_a_prospective_results_no_delete BEFORE DELETE ON model_a_prospective_results
BEGIN SELECT RAISE(ABORT, 'model A prospective results are append-only'); END;

-- Independent collector: explicit manual installation only. A protocol ID freezes its scope.
CREATE TABLE IF NOT EXISTS model_a_collection_protocols (
  protocol_id TEXT PRIMARY KEY,
  scope_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS model_a_collection_protocols_no_update BEFORE UPDATE ON model_a_collection_protocols
BEGIN SELECT RAISE(ABORT, 'collection protocol is immutable'); END;
CREATE TRIGGER IF NOT EXISTS model_a_collection_protocols_no_delete BEFORE DELETE ON model_a_collection_protocols
BEGIN SELECT RAISE(ABORT, 'collection protocol is immutable'); END;
CREATE TABLE IF NOT EXISTS model_a_collection_ledger (
  protocol_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  competition TEXT NOT NULL,
  season TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  claim_at TEXT,
  claim_id TEXT,
  forecast_id TEXT,
  recorder_status TEXT,
  recorder_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (protocol_id, match_id, kickoff_at),
  FOREIGN KEY (protocol_id) REFERENCES model_a_collection_protocols(protocol_id)
);
CREATE INDEX IF NOT EXISTS idx_model_a_collection_state ON model_a_collection_ledger(protocol_id, state, kickoff_at);
CREATE TABLE IF NOT EXISTS model_a_collection_runs (
  run_id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  examined INTEGER,
  claimed INTEGER,
  invalid_kickoff_count INTEGER,
  performance_json TEXT,
  FOREIGN KEY (protocol_id) REFERENCES model_a_collection_protocols(protocol_id)
);
CREATE INDEX IF NOT EXISTS idx_model_a_collection_runs_protocol ON model_a_collection_runs(protocol_id, started_at);

-- Research-only provider lifecycle observations; no operational match is changed.
CREATE TABLE IF NOT EXISTS model_a_prospective_result_observations (
  evidence_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('final','postponed','canceled','not_final','missing','conflict','unverified','provider_error')),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_a_result_observations_match ON model_a_prospective_result_observations(match_id,kickoff_at,observed_at);
CREATE TRIGGER IF NOT EXISTS model_a_result_observations_no_update BEFORE UPDATE ON model_a_prospective_result_observations
BEGIN SELECT RAISE(ABORT, 'model A prospective result observations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS model_a_result_observations_no_delete BEFORE DELETE ON model_a_prospective_result_observations
BEGIN SELECT RAISE(ABORT, 'model A prospective result observations are append-only'); END;

-- Restart-safe pagination and lease/liveness metadata, separate from immutable evidence.
CREATE TABLE IF NOT EXISTS model_a_prospective_result_refresh_state (
  refresh_id TEXT PRIMARY KEY,
  after_match_id TEXT,
  after_kickoff_at TEXT,
  pending_after_evidence_id TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_success_at TEXT,
  last_status TEXT NOT NULL,
  last_error_code TEXT,
  last_summary_json TEXT,
  lease_owner TEXT,
  lease_until TEXT
);
