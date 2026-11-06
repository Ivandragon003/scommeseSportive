-- Flat-unit paper execution is separate from funded wallets and frozen research evidence.
CREATE TABLE IF NOT EXISTS paper_model_bets (
  id TEXT PRIMARY KEY,
  execution_decision_id TEXT NOT NULL REFERENCES research_execution_decisions(id),
  origin_decision_id TEXT NOT NULL REFERENCES research_decisions(id),
  input_id TEXT NOT NULL REFERENCES research_execution_inputs(id),
  policy_hash TEXT NOT NULL REFERENCES research_execution_policies(hash),
  family TEXT NOT NULL CHECK(family IN ('A','C')),
  match_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  selection_key TEXT NOT NULL,
  odds REAL NOT NULL CHECK(odds>1),
  stake_cents INTEGER NOT NULL CHECK(stake_cents=100),
  snapshot_json TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  UNIQUE(family,match_id,selection_key)
);
CREATE INDEX IF NOT EXISTS paper_model_bets_placed ON paper_model_bets(placed_at,id);
CREATE INDEX IF NOT EXISTS paper_model_bets_execution ON paper_model_bets(execution_decision_id);
CREATE TABLE IF NOT EXISTS paper_model_settlements (
  bet_id TEXT PRIMARY KEY REFERENCES paper_model_bets(id),
  multiplier REAL NOT NULL CHECK(multiplier>=0),
  return_cents INTEGER NOT NULL CHECK(return_cents>=0),
  evidence_json TEXT NOT NULL,
  settled_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS paper_model_bets_immutable_update BEFORE UPDATE ON paper_model_bets
BEGIN SELECT RAISE(ABORT,'paper evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS paper_model_bets_immutable_delete BEFORE DELETE ON paper_model_bets
BEGIN SELECT RAISE(ABORT,'paper evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS paper_model_settlements_immutable_update BEFORE UPDATE ON paper_model_settlements
BEGIN SELECT RAISE(ABORT,'paper evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS paper_model_settlements_immutable_delete BEFORE DELETE ON paper_model_settlements
BEGIN SELECT RAISE(ABORT,'paper evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS paper_model_bet_authorization BEFORE INSERT ON paper_model_bets BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id
    JOIN research_execution_jobs j ON j.id=i.job_id JOIN research_execution_policies p ON p.hash=j.policy_hash,
    json_each(d.snapshot_json,'$.selections') selection
    WHERE d.id=NEW.execution_decision_id AND d.origin_decision_id=NEW.origin_decision_id AND d.input_id=NEW.input_id
      AND d.family=NEW.family AND d.model_version=NEW.model_version AND d.action='BET'
      AND j.match_id=NEW.match_id AND j.policy_hash=NEW.policy_hash AND p.version='paper-fixed-unit-v1'
      AND json_extract(d.snapshot_json,'$.stakeMode')='PAPER_FIXED_UNIT'
      AND json_extract(selection.value,'$.selectionKey')=NEW.selection_key
      AND json_extract(selection.value,'$.market')=NEW.market AND json_extract(selection.value,'$.selection')=NEW.selection
      AND json_extract(selection.value,'$.quote.odds')=NEW.odds
      AND json_extract(selection.value,'$.quote')=json_extract(NEW.snapshot_json,'$.quote')
      AND json_extract(NEW.snapshot_json,'$.stakeMode')='PAPER_FIXED_UNIT'
      AND json_extract(NEW.snapshot_json,'$.stakeCents')=100
      AND json_extract(NEW.snapshot_json,'$.effectiveExecutionDecisionId')=d.id
  ) THEN RAISE(ABORT,'paper bet authorization mismatch') END;
END;
