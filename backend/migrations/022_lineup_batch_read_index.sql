-- Orphan-batch retention probes snapshots by batch_id, independently of match/team.
CREATE INDEX IF NOT EXISTS idx_lineup_snapshots_batch
  ON player_lineup_snapshots(batch_id);
