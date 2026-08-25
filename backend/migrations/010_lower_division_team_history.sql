-- Match-level history for known top-five teams while they played in tier two.
-- This evidence is shadow-only: prediction weights remain disabled until a
-- temporal backtest validates a promotion calibration.
CREATE TABLE IF NOT EXISTS lower_division_team_seasons (
  team_id TEXT NOT NULL REFERENCES teams(team_id),
  source_competition_id TEXT NOT NULL REFERENCES secondary_competitions(competition_id),
  source_season TEXT NOT NULL,
  final_rank INTEGER,
  matches_played INTEGER NOT NULL,
  points REAL NOT NULL,
  ppg REAL NOT NULL,
  goal_difference REAL NOT NULL,
  goal_difference_per_match REAL NOT NULL,
  source_provider TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('complete', 'partial')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, source_competition_id, source_season)
);

CREATE TABLE IF NOT EXISTS lower_division_team_matches (
  history_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(team_id),
  source_competition_id TEXT NOT NULL REFERENCES secondary_competitions(competition_id),
  source_season TEXT NOT NULL,
  played_at TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('home', 'away')),
  opponent_name TEXT NOT NULL,
  goals_for INTEGER,
  goals_against INTEGER,
  shots_for INTEGER,
  shots_against INTEGER,
  shots_on_target_for INTEGER,
  shots_on_target_against INTEGER,
  fouls_for INTEGER,
  fouls_against INTEGER,
  corners_for INTEGER,
  corners_against INTEGER,
  yellow_cards_for INTEGER,
  yellow_cards_against INTEGER,
  red_cards_for INTEGER,
  red_cards_against INTEGER,
  referee TEXT,
  source_provider TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  raw_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, source_competition_id, source_season, played_at, venue, opponent_name)
);

CREATE INDEX IF NOT EXISTS idx_lower_team_seasons_window
  ON lower_division_team_seasons(team_id, source_season DESC);

CREATE INDEX IF NOT EXISTS idx_lower_team_matches_window
  ON lower_division_team_matches(team_id, source_season DESC, played_at DESC);
