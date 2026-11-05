-- Manual upgrade ONLY from the previously proposed schema at 9c98e0ba.
-- Inspect pragma_table_info first: all three columns below must be absent.
-- Back up the named database and obtain authorization before execution.
-- Do not run against a fresh schema, an unknown schema, or from app startup.
BEGIN;
ALTER TABLE model_a_collection_runs ADD COLUMN performance_json TEXT;
ALTER TABLE model_a_collection_ledger ADD COLUMN recorder_status TEXT;
ALTER TABLE model_a_collection_ledger ADD COLUMN recorder_reason TEXT;
COMMIT;
