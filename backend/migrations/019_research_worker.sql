-- One shared owner for the T-15 loop. Per-job tokens and unique ledger keys
-- remain the final transactional fence for decisions and virtual stakes.
CREATE TABLE IF NOT EXISTS research_worker_state (
  scheduler TEXT PRIMARY KEY,
  owner_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  last_tick_at TEXT,
  last_tick_json TEXT,
  last_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
