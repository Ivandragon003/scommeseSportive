-- Links new budget bets to the immutable prediction that produced them.
-- Existing bets remain valid and intentionally keep a NULL link.
ALTER TABLE bets ADD COLUMN prediction_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bets_prediction_id ON bets(prediction_id);
