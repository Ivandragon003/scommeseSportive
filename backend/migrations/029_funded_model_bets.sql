-- Preserve paper evidence while allowing explicit cancellation from operational totals.
CREATE TABLE IF NOT EXISTS paper_model_bet_cancellations (
  bet_id TEXT PRIMARY KEY REFERENCES paper_model_bets(id),
  cancelled_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason))>0)
);
CREATE TABLE IF NOT EXISTS funded_model_bets (
  id TEXT PRIMARY KEY,
  execution_decision_id TEXT NOT NULL REFERENCES research_execution_decisions(id),
  origin_decision_id TEXT NOT NULL REFERENCES research_decisions(id),
  input_id TEXT NOT NULL REFERENCES research_execution_inputs(id),
  policy_hash TEXT NOT NULL REFERENCES research_execution_policies(hash),
  portfolio_id TEXT NOT NULL REFERENCES research_portfolios(id),
  family TEXT NOT NULL CHECK(family IN ('A','C')),
  match_id TEXT NOT NULL, model_version TEXT NOT NULL, market TEXT NOT NULL,
  selection TEXT NOT NULL, selection_key TEXT NOT NULL,
  odds REAL NOT NULL CHECK(odds>1), stake_cents INTEGER NOT NULL CHECK(stake_cents>0),
  stake_percent INTEGER NOT NULL CHECK(stake_percent IN (1,3,5)),
  base_available_cents INTEGER NOT NULL CHECK(base_available_cents>0),
  confidence TEXT NOT NULL CHECK(confidence IN ('LOW','MEDIUM','HIGH')),
  snapshot_json TEXT NOT NULL, placed_at TEXT NOT NULL,
  UNIQUE(family,match_id,selection_key),
  CHECK(portfolio_id='shadow_'||family),
  CHECK(stake_percent=CASE confidence WHEN 'LOW' THEN 1 WHEN 'MEDIUM' THEN 3 ELSE 5 END),
  CHECK(stake_cents=CAST(base_available_cents*stake_percent/100 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS funded_model_bets_placed ON funded_model_bets(placed_at,id);
CREATE INDEX IF NOT EXISTS funded_model_bets_execution ON funded_model_bets(execution_decision_id);
CREATE TABLE IF NOT EXISTS funded_model_settlements (
  bet_id TEXT PRIMARY KEY REFERENCES funded_model_bets(id), multiplier REAL NOT NULL CHECK(multiplier>=0),
  return_cents INTEGER NOT NULL CHECK(return_cents>=0), evidence_json TEXT NOT NULL, settled_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS funded_model_bets_immutable_update BEFORE UPDATE ON funded_model_bets BEGIN SELECT RAISE(ABORT,'funded evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS funded_model_bets_immutable_delete BEFORE DELETE ON funded_model_bets BEGIN SELECT RAISE(ABORT,'funded evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS funded_model_settlements_immutable_update BEFORE UPDATE ON funded_model_settlements BEGIN SELECT RAISE(ABORT,'funded evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS funded_model_settlements_immutable_delete BEFORE DELETE ON funded_model_settlements BEGIN SELECT RAISE(ABORT,'funded evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS paper_model_cancellations_immutable_update BEFORE UPDATE ON paper_model_bet_cancellations BEGIN SELECT RAISE(ABORT,'paper cancellation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS paper_model_cancellations_immutable_delete BEFORE DELETE ON paper_model_bet_cancellations BEGIN SELECT RAISE(ABORT,'paper cancellation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS funded_model_bet_authorization BEFORE INSERT ON funded_model_bets BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id
  JOIN research_execution_jobs j ON j.id=i.job_id JOIN research_execution_policies p ON p.hash=j.policy_hash,
  json_each(d.snapshot_json,'$.selections') selection
  WHERE d.id=NEW.execution_decision_id AND d.origin_decision_id=NEW.origin_decision_id AND d.input_id=NEW.input_id
  AND d.family=NEW.family AND d.portfolio_id=NEW.portfolio_id AND d.model_version=NEW.model_version AND d.action='BET'
  AND j.match_id=NEW.match_id AND j.policy_hash=NEW.policy_hash AND p.version='funded-confidence-v1'
  AND json_extract(d.snapshot_json,'$.stakeMode')='CONFIDENCE_PERCENT_AVAILABLE'
  AND json_extract(selection.value,'$.selectionKey')=NEW.selection_key
  AND json_extract(selection.value,'$.market')=NEW.market AND json_extract(selection.value,'$.selection')=NEW.selection
  AND json_extract(selection.value,'$.quote.odds')=NEW.odds AND json_extract(selection.value,'$.confidence')=NEW.confidence
  AND json_extract(selection.value,'$.stakeCents')=NEW.stake_cents
  AND json_extract(selection.value,'$.stakePercent')=NEW.stake_percent
  AND json_extract(selection.value,'$.baseAvailableCents')=NEW.base_available_cents
  AND json_extract(selection.value,'$.quote')=json_extract(NEW.snapshot_json,'$.quote')
  AND json_extract(NEW.snapshot_json,'$.stakeMode')='CONFIDENCE_PERCENT_AVAILABLE'
  AND json_extract(NEW.snapshot_json,'$.stakeCents')=NEW.stake_cents
  AND json_extract(NEW.snapshot_json,'$.stakePercent')=NEW.stake_percent
  AND json_extract(NEW.snapshot_json,'$.baseAvailableCents')=NEW.base_available_cents
  AND json_extract(NEW.snapshot_json,'$.confidence')=NEW.confidence
  AND json_extract(NEW.snapshot_json,'$.effectiveExecutionDecisionId')=d.id
 ) THEN RAISE(ABORT,'funded bet authorization mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS funded_model_settlement_authorization BEFORE INSERT ON funded_model_settlements BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM funded_model_bets b WHERE b.id=NEW.bet_id
  AND NEW.return_cents=CAST(ROUND(b.stake_cents*NEW.multiplier) AS INTEGER)
  AND (ABS(NEW.multiplier)<1e-9 OR ABS(NEW.multiplier-0.5)<1e-9 OR ABS(NEW.multiplier-1)<1e-9
   OR ABS(NEW.multiplier-(b.odds+1)/2)<1e-9 OR ABS(NEW.multiplier-b.odds)<1e-9)
  AND json_valid(NEW.evidence_json) AND json_type(NEW.evidence_json)='object' AND NEW.evidence_json<>'{}'
 ) THEN RAISE(ABORT,'funded settlement authorization mismatch') END;
END;
