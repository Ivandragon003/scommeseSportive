CREATE TABLE IF NOT EXISTS player_lineup_status (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('predicted_starter', 'predicted_bench', 'confirmed_starter', 'confirmed_bench', 'unavailable')),
  probability REAL,
  source TEXT NOT NULL,
  provider_fixture_id TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  kickoff_at TEXT,
  raw_json TEXT,
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_player_lineup_status_match
  ON player_lineup_status(match_id, team_id, status);

CREATE INDEX IF NOT EXISTS idx_player_lineup_status_player
  ON player_lineup_status(player_id, fetched_at);
