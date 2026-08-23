-- Metadata-only foundation for promoted/relegated team adjustments.
-- No model weight is applied from these tables yet.
CREATE TABLE IF NOT EXISTS secondary_competitions (
  competition_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  tier INTEGER NOT NULL,
  cluster_key TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(country, name)
);

CREATE TABLE IF NOT EXISTS source_season_reference (
  source_competition_id TEXT NOT NULL REFERENCES secondary_competitions(competition_id),
  source_season TEXT NOT NULL,
  teams_count INTEGER NOT NULL,
  mean_ppg REAL,
  stdev_ppg REAL,
  mean_goal_difference_per_match REAL,
  stdev_goal_difference_per_match REAL,
  matches_per_team REAL,
  coverage_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (coverage_status IN ('complete', 'partial', 'unknown')),
  source_provider TEXT,
  source_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_competition_id, source_season)
);

CREATE TABLE IF NOT EXISTS team_competition_transitions (
  transition_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(team_id),
  source_competition_id TEXT REFERENCES secondary_competitions(competition_id),
  source_season TEXT,
  destination_competition_id TEXT NOT NULL,
  destination_season TEXT NOT NULL,
  transition_type TEXT NOT NULL
    CHECK (transition_type IN ('promoted', 'relegated')),
  source_rank INTEGER,
  source_points REAL,
  source_matches INTEGER,
  source_ppg REAL,
  source_goal_difference REAL,
  source_goal_difference_per_match REAL,
  transition_mode TEXT NOT NULL DEFAULT 'unknown'
    CHECK (transition_mode IN ('direct_1', 'direct_2', 'direct_3', 'playoff', 'playout', 'direct_relegation', 'unknown')),
  coverage_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (coverage_status IN ('complete', 'partial', 'unknown')),
  source_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (source_quality IN ('confirmed', 'estimated', 'unknown')),
  source_provider TEXT,
  source_reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, destination_season)
);

CREATE INDEX IF NOT EXISTS idx_source_season_reference_status
  ON source_season_reference(coverage_status, source_competition_id, source_season);
CREATE INDEX IF NOT EXISTS idx_team_transitions_destination
  ON team_competition_transitions(destination_competition_id, destination_season, transition_type);
CREATE INDEX IF NOT EXISTS idx_team_transitions_quality
  ON team_competition_transitions(coverage_status, source_quality);
