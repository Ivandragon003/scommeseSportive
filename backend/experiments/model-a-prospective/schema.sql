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
