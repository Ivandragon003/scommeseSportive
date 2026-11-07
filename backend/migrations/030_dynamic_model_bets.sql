CREATE TABLE IF NOT EXISTS dynamic_model_bets (
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
  stake_percent REAL NOT NULL CHECK(stake_percent>0 AND stake_percent<=5),
  stake_basis_points INTEGER NOT NULL CHECK(stake_basis_points BETWEEN 1 AND 500),
  base_equity_cents INTEGER NOT NULL CHECK(base_equity_cents>0),
  confidence TEXT,
  snapshot_json TEXT NOT NULL, placed_at TEXT NOT NULL,
  UNIQUE(family,match_id,selection_key),
  CHECK(portfolio_id='shadow_'||family),
  CHECK(ABS(stake_percent*100-stake_basis_points)<0.0000001),
  CHECK(stake_cents=CAST(base_equity_cents/10000 AS INTEGER)*stake_basis_points + CAST((base_equity_cents%10000)*stake_basis_points/10000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS dynamic_model_bets_placed ON dynamic_model_bets(placed_at,id);
CREATE INDEX IF NOT EXISTS dynamic_model_bets_execution ON dynamic_model_bets(execution_decision_id);
CREATE TABLE IF NOT EXISTS dynamic_model_settlements (
  bet_id TEXT PRIMARY KEY REFERENCES dynamic_model_bets(id), multiplier REAL NOT NULL CHECK(multiplier>=0),
  return_cents INTEGER NOT NULL CHECK(return_cents>=0), evidence_json TEXT NOT NULL, settled_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS dynamic_model_bets_immutable_update BEFORE UPDATE ON dynamic_model_bets BEGIN SELECT RAISE(ABORT,'dynamic evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dynamic_model_bets_immutable_delete BEFORE DELETE ON dynamic_model_bets BEGIN SELECT RAISE(ABORT,'dynamic evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dynamic_model_settlements_immutable_update BEFORE UPDATE ON dynamic_model_settlements BEGIN SELECT RAISE(ABORT,'dynamic evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dynamic_model_settlements_immutable_delete BEFORE DELETE ON dynamic_model_settlements BEGIN SELECT RAISE(ABORT,'dynamic evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dynamic_model_bet_authorization BEFORE INSERT ON dynamic_model_bets BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id
  JOIN research_execution_jobs j ON j.id=i.job_id JOIN research_execution_policies p ON p.hash=j.policy_hash,
  json_each(d.snapshot_json,'$.selections') selection
  WHERE d.id=NEW.execution_decision_id AND d.origin_decision_id=NEW.origin_decision_id AND d.input_id=NEW.input_id
  AND d.family=NEW.family AND d.portfolio_id=NEW.portfolio_id AND d.model_version=NEW.model_version AND d.action='BET'
  AND j.match_id=NEW.match_id AND j.policy_hash=NEW.policy_hash AND p.version='funded-dynamic-stake-v1'
  AND json_extract(d.snapshot_json,'$.stakeMode')='MODEL_RECOMMENDED_PERCENT'
  AND json_extract(selection.value,'$.selectionKey')=NEW.selection_key
  AND json_extract(selection.value,'$.market')=NEW.market AND json_extract(selection.value,'$.selection')=NEW.selection
  AND json_extract(selection.value,'$.quote.odds')=NEW.odds AND json_extract(selection.value,'$.confidence') IS NEW.confidence
  AND json_extract(selection.value,'$.stakeCents')=NEW.stake_cents
  AND json_extract(selection.value,'$.stakePercent')=NEW.stake_percent
  AND json_extract(selection.value,'$.suggestedStakePercent')=NEW.stake_percent
  AND json_extract(selection.value,'$.stakeBasisPoints')=NEW.stake_basis_points
  AND json_extract(selection.value,'$.baseEquityCents')=NEW.base_equity_cents
  AND json_extract(selection.value,'$.quote')=json_extract(NEW.snapshot_json,'$.quote')
  AND json_extract(NEW.snapshot_json,'$.stakeMode')='MODEL_RECOMMENDED_PERCENT'
  AND json_extract(NEW.snapshot_json,'$.stakeCents')=NEW.stake_cents
  AND json_extract(NEW.snapshot_json,'$.stakePercent')=NEW.stake_percent
  AND json_extract(NEW.snapshot_json,'$.suggestedStakePercent')=NEW.stake_percent
  AND json_extract(NEW.snapshot_json,'$.stakeBasisPoints')=NEW.stake_basis_points
  AND json_extract(NEW.snapshot_json,'$.baseEquityCents')=NEW.base_equity_cents
  AND json_extract(NEW.snapshot_json,'$.confidence') IS NEW.confidence
  AND json_extract(NEW.snapshot_json,'$.effectiveExecutionDecisionId')=d.id
 ) THEN RAISE(ABORT,'dynamic bet authorization mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS dynamic_model_settlement_authorization BEFORE INSERT ON dynamic_model_settlements BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM dynamic_model_bets b WHERE b.id=NEW.bet_id
  AND NEW.return_cents=CAST(ROUND(b.stake_cents*NEW.multiplier) AS INTEGER)
  AND (ABS(NEW.multiplier)<1e-9 OR ABS(NEW.multiplier-0.5)<1e-9 OR ABS(NEW.multiplier-1)<1e-9
   OR ABS(NEW.multiplier-(b.odds+1)/2)<1e-9 OR ABS(NEW.multiplier-b.odds)<1e-9)
  AND json_valid(NEW.evidence_json) AND json_type(NEW.evidence_json)='object' AND NEW.evidence_json<>'{}'
 ) THEN RAISE(ABORT,'dynamic settlement authorization mismatch') END;
END;
