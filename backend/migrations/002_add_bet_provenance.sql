-- Additive provenance metadata for the internal bet ledger.
-- Existing rows are deliberately classified as pre-fix/unknown: their origin
-- cannot be reconstructed reliably from the legacy schema.
CREATE TABLE IF NOT EXISTS bets (
  bet_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  match_id TEXT NOT NULL,
  home_team_name TEXT,
  away_team_name TEXT,
  competition TEXT,
  match_date TEXT,
  market_name TEXT NOT NULL,
  selection TEXT NOT NULL,
  odds REAL NOT NULL,
  stake REAL NOT NULL,
  our_probability REAL NOT NULL,
  expected_value REAL NOT NULL,
  status TEXT DEFAULT 'PENDING',
  return_amount REAL,
  profit REAL,
  placed_at TEXT NOT NULL,
  settled_at TEXT,
  notes TEXT
);

ALTER TABLE bets ADD COLUMN data_quality TEXT NOT NULL DEFAULT 'pre_fix';
ALTER TABLE bets ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown';

UPDATE bets
SET data_quality = 'pre_fix'
WHERE data_quality IS NULL OR trim(data_quality) = '';

UPDATE bets
SET source = 'unknown'
WHERE source IS NULL OR trim(source) = '';
