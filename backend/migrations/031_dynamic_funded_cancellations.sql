-- Cancel pending fixed-policy bets without erasing their immutable evidence.
CREATE TABLE IF NOT EXISTS funded_model_bet_cancellations (
  bet_id TEXT PRIMARY KEY REFERENCES funded_model_bets(id),
  cancelled_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason))>0)
);
CREATE TRIGGER IF NOT EXISTS funded_cancellations_immutable_update BEFORE UPDATE ON funded_model_bet_cancellations
BEGIN SELECT RAISE(ABORT,'funded cancellation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS funded_cancellations_immutable_delete BEFORE DELETE ON funded_model_bet_cancellations
BEGIN SELECT RAISE(ABORT,'funded cancellation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS funded_cancellation_authorization BEFORE INSERT ON funded_model_bet_cancellations BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM funded_model_bets b JOIN research_ledger l ON l.id='stake:'||b.id JOIN matches m ON m.match_id=b.match_id
  WHERE b.id=NEW.bet_id AND l.portfolio_id=b.portfolio_id AND l.bet_id IS NULL AND l.event='STAKE'
  AND l.available_delta_cents=-b.stake_cents AND l.committed_delta_cents=b.stake_cents
  AND NOT EXISTS(SELECT 1 FROM funded_model_settlements s WHERE s.bet_id=b.id)
  AND NOT EXISTS(SELECT 1 FROM research_ledger reversal WHERE reversal.id='cancel:'||b.id)
  AND julianday(NEW.cancelled_at) IS NOT NULL AND julianday(json_extract(b.snapshot_json,'$.kickoffAt')) IS NOT NULL
  AND m.home_goals IS NULL AND m.away_goals IS NULL AND julianday(m.date)=julianday(json_extract(b.snapshot_json,'$.kickoffAt'))
  AND julianday(NEW.cancelled_at)<julianday(json_extract(b.snapshot_json,'$.kickoffAt'))
 ) THEN RAISE(ABORT,'funded cancellation authorization mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS funded_cancellation_refund AFTER INSERT ON funded_model_bet_cancellations BEGIN
 INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at)
 SELECT 'cancel:'||b.id,b.portfolio_id,NULL,'SETTLE',b.stake_cents,-b.stake_cents,NEW.cancelled_at
 FROM funded_model_bets b WHERE b.id=NEW.bet_id;
END;
CREATE TRIGGER IF NOT EXISTS funded_cancelled_settlement_guard BEFORE INSERT ON funded_model_settlements
WHEN EXISTS(SELECT 1 FROM funded_model_bet_cancellations c WHERE c.bet_id=NEW.bet_id)
BEGIN SELECT RAISE(ABORT,'cancelled funded bet cannot be settled'); END;
