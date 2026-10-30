-- Additive execution policy revisions preserve all original research evidence.
CREATE TABLE IF NOT EXISTS research_execution_policies (
  hash TEXT PRIMARY KEY, version TEXT NOT NULL, descriptor_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_execution_jobs (
  id TEXT PRIMARY KEY, match_id TEXT NOT NULL, policy_hash TEXT NOT NULL REFERENCES research_execution_policies(hash),
  run_id TEXT NOT NULL, kickoff_at TEXT NOT NULL, window_start_at TEXT NOT NULL, window_end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('CLAIMED','COMPLETED','SKIPPED','ERROR')),
  lease_token TEXT, lease_expires_at TEXT, reason TEXT, claimed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(match_id,policy_hash)
);
CREATE INDEX IF NOT EXISTS research_execution_job_run ON research_execution_jobs(run_id,policy_hash,status);
CREATE TABLE IF NOT EXISTS research_execution_inputs (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES research_execution_jobs(id),
  origin_input_id TEXT NOT NULL REFERENCES research_inputs(id), input_hash TEXT NOT NULL, decisions_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, captured_at TEXT NOT NULL, kickoff_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_execution_decisions (
  id TEXT PRIMARY KEY, input_id TEXT NOT NULL REFERENCES research_execution_inputs(id),
  origin_decision_id TEXT NOT NULL REFERENCES research_decisions(id), family TEXT NOT NULL CHECK(family IN ('A','C')),
  model_version TEXT NOT NULL, portfolio_id TEXT NOT NULL REFERENCES research_portfolios(id),
  action TEXT NOT NULL CHECK(action IN ('BET','ABSTAIN')), market TEXT NOT NULL, selection TEXT, reason TEXT,
  snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(input_id,family,portfolio_id)
);
ALTER TABLE research_bets ADD COLUMN execution_decision_id TEXT REFERENCES research_execution_decisions(id);
CREATE UNIQUE INDEX IF NOT EXISTS research_bet_execution_decision ON research_bets(execution_decision_id) WHERE execution_decision_id IS NOT NULL;
