-- Authorized withdrawal preserves the exact original bet and stake movement.
CREATE TABLE IF NOT EXISTS research_bet_cancellations (
  bet_id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK(policy_version='virtual-recommendation-v1'),
  run_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  cancelled_at TEXT NOT NULL,
  bet_json TEXT NOT NULL,
  stake_ledger_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL
);
