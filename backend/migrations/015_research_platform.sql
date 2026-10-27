-- Isolated research records share libSQL infrastructure, never the legacy bankroll.
CREATE TABLE IF NOT EXISTS research_models (
  family TEXT NOT NULL CHECK (family IN ('A','C')),
  version TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (family, version)
);
CREATE TABLE IF NOT EXISTS research_benchmarks (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('A','C','PAIR')),
  model_version TEXT,
  report_json TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  validated INTEGER NOT NULL CHECK (validated IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_champions (
  family TEXT PRIMARY KEY CHECK (family IN ('A','C')),
  version TEXT NOT NULL,
  benchmark_id TEXT NOT NULL REFERENCES research_benchmarks(id),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (family, version) REFERENCES research_models(family, version)
);
CREATE TABLE IF NOT EXISTS research_model_events (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('A','C')),
  version TEXT NOT NULL,
  previous_version TEXT,
  action TEXT NOT NULL CHECK (action IN ('PROMOTE','ROLLBACK')),
  benchmark_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_markets (
  family TEXT NOT NULL CHECK (family IN ('A','C')),
  model_version TEXT NOT NULL,
  market TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('EXPERIMENTAL','SHADOW','ACTIVE','SUSPENDED')),
  evidence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (family, model_version, market),
  FOREIGN KEY (family, model_version) REFERENCES research_models(family, version)
);
CREATE TABLE IF NOT EXISTS research_market_events (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('A','C')),
  model_version TEXT NOT NULL,
  market TEXT NOT NULL,
  previous_state TEXT,
  state TEXT NOT NULL CHECK (state IN ('EXPERIMENTAL','SHADOW','ACTIVE','SUSPENDED')),
  evidence_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_portfolios (
  id TEXT PRIMARY KEY CHECK (id IN ('shadow_A','shadow_C','main')),
  family TEXT CHECK (family IN ('A','C')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_jobs (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL UNIQUE,
  kickoff_at TEXT NOT NULL,
  target_at TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('PENDING','CLAIMED','COMPLETED','MISSED','SKIPPED','ERROR','CANCELLED')),
  lease_token TEXT,
  lease_expires_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_jobs_due ON research_jobs(status, target_at);
CREATE TABLE IF NOT EXISTS research_inputs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES research_jobs(id),
  input_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  kickoff_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_decisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES research_jobs(id),
  input_id TEXT NOT NULL REFERENCES research_inputs(id),
  family TEXT NOT NULL CHECK (family IN ('A','C')),
  model_version TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT,
  portfolio_id TEXT NOT NULL REFERENCES research_portfolios(id),
  action TEXT NOT NULL CHECK (action IN ('BET','ABSTAIN')),
  reason TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, family, portfolio_id)
);
CREATE TABLE IF NOT EXISTS research_bets (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES research_decisions(id),
  portfolio_id TEXT NOT NULL REFERENCES research_portfolios(id),
  match_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('A','C')),
  model_version TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  odds REAL NOT NULL CHECK (odds > 1),
  stake_cents INTEGER NOT NULL CHECK (stake_cents > 0),
  snapshot_json TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  UNIQUE (portfolio_id, match_id)
);
CREATE TABLE IF NOT EXISTS research_settlements (
  bet_id TEXT PRIMARY KEY REFERENCES research_bets(id),
  multiplier REAL NOT NULL CHECK (multiplier >= 0),
  return_cents INTEGER NOT NULL CHECK (return_cents >= 0),
  evidence_json TEXT NOT NULL,
  settled_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_ledger (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES research_portfolios(id),
  bet_id TEXT REFERENCES research_bets(id),
  event TEXT NOT NULL CHECK (event IN ('OPEN','STAKE','SETTLE')),
  available_delta_cents INTEGER NOT NULL,
  committed_delta_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (portfolio_id, event, bet_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS research_single_open ON research_ledger(portfolio_id) WHERE event = 'OPEN';
