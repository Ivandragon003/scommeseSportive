-- Only source-backed, explicitly recorded observations are protected.
CREATE TABLE IF NOT EXISTS final_observations (
  match_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK(field IN ('home_goals','away_goals','home_xg','away_xg','home_shots','away_shots','home_shots_on_target','away_shots_on_target','home_fouls','away_fouls','home_corners','away_corners','home_yellow_cards','away_yellow_cards','home_red_cards','away_red_cards','referee')),
  value NOT NULL,
  source TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(match_id, field)
);
CREATE TABLE IF NOT EXISTS final_observation_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  field TEXT NOT NULL,
  existing_value NOT NULL,
  attempted_value NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS final_observation_sources (
  sha256 TEXT PRIMARY KEY,
  csv TEXT NOT NULL,
  source TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS final_observation_sources_no_update BEFORE UPDATE ON final_observation_sources BEGIN
  SELECT RAISE(ABORT, 'final_observation_source_immutable');
END;
CREATE TRIGGER IF NOT EXISTS final_observation_sources_no_delete BEFORE DELETE ON final_observation_sources BEGIN
  SELECT RAISE(ABORT, 'final_observation_source_immutable');
END;
CREATE TRIGGER IF NOT EXISTS final_observations_no_update BEFORE UPDATE ON final_observations BEGIN
  SELECT RAISE(ABORT, 'final_observation_immutable');
END;
CREATE TRIGGER IF NOT EXISTS final_observations_no_delete BEFORE DELETE ON final_observations BEGIN
  SELECT RAISE(ABORT, 'final_observation_immutable');
END;
CREATE TRIGGER IF NOT EXISTS final_observations_check_insert BEFORE INSERT ON final_observations
WHEN NOT EXISTS (SELECT 1 FROM matches WHERE match_id=NEW.match_id AND (
  (NEW.field='home_goals' AND home_goals IS NOT NULL AND home_goals=NEW.value) OR
  (NEW.field='away_goals' AND away_goals IS NOT NULL AND away_goals=NEW.value) OR
  (NEW.field='home_xg' AND home_xg IS NOT NULL AND home_xg=NEW.value) OR
  (NEW.field='away_xg' AND away_xg IS NOT NULL AND away_xg=NEW.value) OR
  (NEW.field='home_shots' AND home_shots IS NOT NULL AND home_shots=NEW.value) OR
  (NEW.field='away_shots' AND away_shots IS NOT NULL AND away_shots=NEW.value) OR
  (NEW.field='home_shots_on_target' AND home_shots_on_target IS NOT NULL AND home_shots_on_target=NEW.value) OR
  (NEW.field='away_shots_on_target' AND away_shots_on_target IS NOT NULL AND away_shots_on_target=NEW.value) OR
  (NEW.field='home_fouls' AND home_fouls IS NOT NULL AND home_fouls=NEW.value) OR
  (NEW.field='away_fouls' AND away_fouls IS NOT NULL AND away_fouls=NEW.value) OR
  (NEW.field='home_corners' AND home_corners IS NOT NULL AND home_corners=NEW.value) OR
  (NEW.field='away_corners' AND away_corners IS NOT NULL AND away_corners=NEW.value) OR
  (NEW.field='home_yellow_cards' AND home_yellow_cards IS NOT NULL AND home_yellow_cards=NEW.value) OR
  (NEW.field='away_yellow_cards' AND away_yellow_cards IS NOT NULL AND away_yellow_cards=NEW.value) OR
  (NEW.field='home_red_cards' AND home_red_cards IS NOT NULL AND home_red_cards=NEW.value) OR
  (NEW.field='away_red_cards' AND away_red_cards IS NOT NULL AND away_red_cards=NEW.value) OR
  (NEW.field='referee' AND referee IS NOT NULL AND referee=NEW.value))) BEGIN
  SELECT RAISE(ABORT, 'final_observation_value_changed');
END;
CREATE TRIGGER IF NOT EXISTS final_observations_protect_match BEFORE UPDATE ON matches
WHEN EXISTS (SELECT 1 FROM final_observations WHERE match_id=OLD.match_id AND (NEW.match_id IS NOT OLD.match_id OR
  (field='home_goals' AND NEW.home_goals IS NOT OLD.home_goals) OR
  (field='away_goals' AND NEW.away_goals IS NOT OLD.away_goals) OR
  (field='home_xg' AND NEW.home_xg IS NOT OLD.home_xg) OR
  (field='away_xg' AND NEW.away_xg IS NOT OLD.away_xg) OR
  (field='home_shots' AND NEW.home_shots IS NOT OLD.home_shots) OR
  (field='away_shots' AND NEW.away_shots IS NOT OLD.away_shots) OR
  (field='home_shots_on_target' AND NEW.home_shots_on_target IS NOT OLD.home_shots_on_target) OR
  (field='away_shots_on_target' AND NEW.away_shots_on_target IS NOT OLD.away_shots_on_target) OR
  (field='home_fouls' AND NEW.home_fouls IS NOT OLD.home_fouls) OR
  (field='away_fouls' AND NEW.away_fouls IS NOT OLD.away_fouls) OR
  (field='home_corners' AND NEW.home_corners IS NOT OLD.home_corners) OR
  (field='away_corners' AND NEW.away_corners IS NOT OLD.away_corners) OR
  (field='home_yellow_cards' AND NEW.home_yellow_cards IS NOT OLD.home_yellow_cards) OR
  (field='away_yellow_cards' AND NEW.away_yellow_cards IS NOT OLD.away_yellow_cards) OR
  (field='home_red_cards' AND NEW.home_red_cards IS NOT OLD.home_red_cards) OR
  (field='away_red_cards' AND NEW.away_red_cards IS NOT OLD.away_red_cards) OR
  (field='referee' AND NEW.referee IS NOT OLD.referee))) BEGIN
  SELECT RAISE(ABORT, 'final_observation_locked');
END;
CREATE TRIGGER IF NOT EXISTS final_observations_protect_delete BEFORE DELETE ON matches
WHEN EXISTS (SELECT 1 FROM final_observations WHERE match_id=OLD.match_id) BEGIN
  SELECT RAISE(ABORT, 'final_observation_locked');
END;
