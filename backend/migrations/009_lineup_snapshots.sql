CREATE TABLE IF NOT EXISTS player_lineup_snapshot_batches (
  batch_order INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL UNIQUE,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_lineup_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('predicted_starter', 'predicted_bench', 'confirmed_starter', 'confirmed_bench', 'unavailable')),
  probability REAL,
  source TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES player_lineup_snapshot_batches(batch_id),
  is_official INTEGER NOT NULL DEFAULT 0 CHECK (is_official IN (0, 1)),
  formation TEXT,
  position_code TEXT,
  history_matches_used INTEGER,
  provider_fixture_id TEXT,
  kickoff_at TEXT,
  raw_json TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lineup_snapshots_match
  ON player_lineup_snapshots(match_id, team_id, is_official, batch_id, captured_at);

CREATE INDEX IF NOT EXISTS idx_lineup_snapshots_team_history
  ON player_lineup_snapshots(team_id, kickoff_at, is_official, status);
