-- The operational budget has always used the deterministic A algorithm.
-- Preserve the original bets and ledger; make that identity explicit in storage.
ALTER TABLE bets ADD COLUMN model_family TEXT NOT NULL DEFAULT 'A' CHECK (model_family = 'A');
