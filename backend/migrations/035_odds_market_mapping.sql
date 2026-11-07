-- Original provider payloads stay unchanged; normalized prices identify their mapper.
ALTER TABLE odds_snapshots ADD COLUMN market_mapping_version TEXT NOT NULL DEFAULT 'legacy-unverified-v1';
