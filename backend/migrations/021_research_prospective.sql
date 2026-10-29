-- Prospective, pre-outcome observations are distinct from bets and historical benchmarks.
CREATE TABLE IF NOT EXISTS research_prospective_observations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES research_jobs(id),
  input_id TEXT NOT NULL REFERENCES research_inputs(id),
  match_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('A','C')),
  model_version TEXT NOT NULL,
  model_artifact_hash TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  market TEXT NOT NULL,
  bucket INTEGER NOT NULL CHECK (bucket BETWEEN 0 AND 4),
  partition TEXT NOT NULL CHECK (partition IN ('CALIBRATION','FUTURE_TEST')),
  protocol TEXT NOT NULL CHECK (protocol='prospective-residual-v1'),
  probability REAL NOT NULL CHECK (probability>0 AND probability<1),
  expected_value REAL NOT NULL,
  odds REAL NOT NULL CHECK (odds>1),
  observed_at TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  FOREIGN KEY (family,model_version) REFERENCES research_models(family,version),
  UNIQUE (match_id,family,model_version,configuration_hash,market,bucket)
);
CREATE INDEX IF NOT EXISTS research_prospective_calibration ON research_prospective_observations
  (family,model_version,configuration_hash,partition,market,bucket);
CREATE TABLE IF NOT EXISTS research_prospective_results (
  observation_id TEXT PRIMARY KEY REFERENCES research_prospective_observations(id),
  return_multiplier REAL NOT NULL CHECK (return_multiplier>=0),
  evidence_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  available_at TEXT NOT NULL
);
-- Corrections quarantine an earlier label. They never rewrite or replace it.
CREATE TABLE IF NOT EXISTS research_prospective_invalidations (
  observation_id TEXT PRIMARY KEY REFERENCES research_prospective_observations(id),
  detected_at TEXT NOT NULL,
  reason TEXT NOT NULL
);
