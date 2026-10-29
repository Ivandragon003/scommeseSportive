-- Additive metadata reuses existing jobs, decisions and the two virtual wallets.
-- Old jobs have no mapping and retain their original T15 semantics.
CREATE TABLE IF NOT EXISTS research_nightly_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','ERROR')),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  quote_max_age_ms INTEGER NOT NULL,
  min_ev REAL NOT NULL,
  min_prudential_ev REAL NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  ended_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_nightly_run_active ON research_nightly_runs(status,lease_expires_at);
CREATE TABLE IF NOT EXISTS research_nightly_jobs (
  job_id TEXT PRIMARY KEY REFERENCES research_jobs(id),
  run_id TEXT NOT NULL REFERENCES research_nightly_runs(id),
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_nightly_job_run ON research_nightly_jobs(run_id);
