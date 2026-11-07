-- Explicit, source-backed kickoff corrections are protected separately from results.
CREATE TABLE IF NOT EXISTS match_kickoff_observations (
  match_id TEXT PRIMARY KEY NOT NULL,
  kickoff_at TEXT NOT NULL CHECK(length(kickoff_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ', kickoff_at) IS kickoff_at),
  source TEXT NOT NULL CHECK(length(trim(source)) > 0),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS match_kickoff_observations_check_insert BEFORE INSERT ON match_kickoff_observations
WHEN EXISTS (SELECT 1 FROM match_kickoff_observations WHERE match_id=NEW.match_id)
  OR NOT EXISTS (SELECT 1 FROM matches WHERE match_id=NEW.match_id AND date=NEW.kickoff_at)
BEGIN
  SELECT RAISE(ABORT, 'match_kickoff_observation_value_changed');
END;
CREATE TRIGGER IF NOT EXISTS match_kickoff_observations_no_update BEFORE UPDATE ON match_kickoff_observations BEGIN
  SELECT RAISE(ABORT, 'match_kickoff_observation_immutable');
END;
CREATE TRIGGER IF NOT EXISTS match_kickoff_observations_no_delete BEFORE DELETE ON match_kickoff_observations BEGIN
  SELECT RAISE(ABORT, 'match_kickoff_observation_immutable');
END;
CREATE TRIGGER IF NOT EXISTS match_kickoff_observations_protect_match BEFORE UPDATE ON matches
WHEN EXISTS (SELECT 1 FROM match_kickoff_observations WHERE match_id=OLD.match_id)
  AND (NEW.match_id IS NOT OLD.match_id OR NEW.date IS NOT OLD.date)
BEGIN
  SELECT RAISE(ABORT, 'match_kickoff_observation_locked');
END;
CREATE TRIGGER IF NOT EXISTS match_kickoff_observations_protect_delete BEFORE DELETE ON matches
WHEN EXISTS (SELECT 1 FROM match_kickoff_observations WHERE match_id=OLD.match_id)
BEGIN
  SELECT RAISE(ABORT, 'match_kickoff_observation_locked');
END;
