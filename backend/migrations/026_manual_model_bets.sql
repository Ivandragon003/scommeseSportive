-- Manual actions retain their own provenance, outside the paired Nightly experiment.
CREATE TABLE IF NOT EXISTS manual_model_bets (
 id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL REFERENCES research_portfolios(id),
 match_id TEXT NOT NULL, family TEXT NOT NULL CHECK(family IN ('A','C')),
 model_version TEXT NOT NULL, market TEXT NOT NULL, selection TEXT NOT NULL,
 odds REAL NOT NULL CHECK(odds>1), stake_cents INTEGER NOT NULL CHECK(stake_cents>0),
 snapshot_json TEXT NOT NULL, placed_at TEXT NOT NULL, UNIQUE(portfolio_id,match_id)
);
CREATE TABLE IF NOT EXISTS manual_model_settlements (
 bet_id TEXT PRIMARY KEY REFERENCES manual_model_bets(id), multiplier REAL NOT NULL CHECK(multiplier>=0),
 return_cents INTEGER NOT NULL CHECK(return_cents>=0), evidence_json TEXT NOT NULL, settled_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_model_archives (
 id TEXT PRIMARY KEY, match_id TEXT NOT NULL, family TEXT NOT NULL CHECK(family IN ('A','C')),
 selection TEXT NOT NULL, classification TEXT NOT NULL CHECK(classification IN ('LOW','SPECULATIVE')),
 snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(match_id,family,selection)
);
