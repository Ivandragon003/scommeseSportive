-- Diagnostic experiments are metadata, never deployable model candidates.
CREATE TABLE IF NOT EXISTS research_experiments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('development','diagnostic_audit')),
  dataset_hash TEXT NOT NULL,
  original_report_hash TEXT NOT NULL,
  report_json TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_experiments_run ON research_experiments(run_id,created_at);
