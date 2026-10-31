-- Candidate evaluation and adoption belong only to C, outside both betting ledgers.
CREATE TABLE IF NOT EXISTS challenger_candidates (
  id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  reference_version TEXT NOT NULL,
  dossier_json TEXT NOT NULL,
  dossier_hash TEXT NOT NULL,
  registered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenger_paired_forecasts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES challenger_candidates(id),
  match_id TEXT NOT NULL,
  competition TEXT NOT NULL,
  forecast_at TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  partition TEXT NOT NULL CHECK (partition IN ('CALIBRATION','FUTURE_TEST')),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  UNIQUE(candidate_id,match_id)
);
CREATE INDEX IF NOT EXISTS challenger_forecasts_candidate ON challenger_paired_forecasts(candidate_id,partition,kickoff_at);
CREATE TABLE IF NOT EXISTS challenger_candidate_reviews (
  candidate_id TEXT PRIMARY KEY REFERENCES challenger_candidates(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('ADOPT','REJECT')),
  report_json TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  assessed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenger_forecast_results (
  forecast_id TEXT PRIMARY KEY REFERENCES challenger_paired_forecasts(id),
  home_goals INTEGER NOT NULL CHECK(home_goals>=0),
  away_goals INTEGER NOT NULL CHECK(away_goals>=0),
  source TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  available_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenger_adoption_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK(action IN ('ADOPT','ROLLBACK','SUSPEND')),
  candidate_id TEXT REFERENCES challenger_candidates(id),
  deployment_json TEXT NOT NULL,
  previous_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS challenger_candidates_no_update BEFORE UPDATE ON challenger_candidates BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_candidates_no_delete BEFORE DELETE ON challenger_candidates BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_forecasts_no_update BEFORE UPDATE ON challenger_paired_forecasts BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_forecasts_no_delete BEFORE DELETE ON challenger_paired_forecasts BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_results_no_update BEFORE UPDATE ON challenger_forecast_results BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_results_no_delete BEFORE DELETE ON challenger_forecast_results BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_adoption_no_update BEFORE UPDATE ON challenger_adoption_events BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_adoption_no_delete BEFORE DELETE ON challenger_adoption_events BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_reviews_no_update BEFORE UPDATE ON challenger_candidate_reviews BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS challenger_reviews_no_delete BEFORE DELETE ON challenger_candidate_reviews BEGIN SELECT RAISE(ABORT,'challenger evidence is immutable'); END;
