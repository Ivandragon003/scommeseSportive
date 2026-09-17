-- Additive indexes: latest-snapshot seeks and bounded scheduler queries.
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_latest
ON odds_snapshots(match_id, datetime(captured_at) DESC, snapshot_id DESC);

CREATE INDEX IF NOT EXISTS idx_matches_completed_scope
ON matches(competition, season, date)
WHERE home_goals IS NOT NULL AND away_goals IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matches_upcoming_date
ON matches(date)
WHERE home_goals IS NULL AND away_goals IS NULL;
