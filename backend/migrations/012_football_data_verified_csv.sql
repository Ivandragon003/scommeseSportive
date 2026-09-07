-- Verified historical source copies. Never used to bypass DB coverage checks.
CREATE TABLE IF NOT EXISTS football_data_verified_csv (
  league_code TEXT NOT NULL,
  season_start INTEGER NOT NULL,
  csv TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (league_code, season_start)
);
