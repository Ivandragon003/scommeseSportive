CREATE TABLE IF NOT EXISTS player_injury_refresh_batches (
  refresh_order INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES player_lineup_snapshot_batches(batch_id),
  match_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  provider_fixture_id TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE (batch_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_injury_refresh_match_team
  ON player_injury_refresh_batches(match_id, team_id, batch_id, captured_at);

INSERT OR IGNORE INTO player_injury_refresh_batches
  (batch_id, match_id, team_id, provider_fixture_id, captured_at)
SELECT snapshot.batch_id, snapshot.match_id, snapshot.team_id,
       MAX(snapshot.provider_fixture_id), MAX(snapshot.captured_at)
FROM player_lineup_snapshots snapshot
WHERE snapshot.status = 'unavailable'
GROUP BY snapshot.batch_id, snapshot.match_id, snapshot.team_id;
