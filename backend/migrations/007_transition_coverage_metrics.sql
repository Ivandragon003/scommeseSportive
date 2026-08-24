-- Separates source competition completeness from team identity matching.
ALTER TABLE source_season_reference ADD COLUMN matches_observed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_season_reference ADD COLUMN matches_expected INTEGER;
ALTER TABLE source_season_reference ADD COLUMN coverage_percent REAL;
ALTER TABLE source_season_reference ADD COLUMN identity_coverage_percent REAL;

ALTER TABLE team_competition_transitions ADD COLUMN transition_sequence INTEGER;
ALTER TABLE team_competition_transitions ADD COLUMN source_identity_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (source_identity_status IN ('matched', 'unresolved', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_transition_team_history
  ON team_competition_transitions(team_id, destination_season, transition_type);
