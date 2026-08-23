-- Complete audit trail for nightly operational and saved-only bet decisions.
CREATE TABLE IF NOT EXISTS automated_bet_decisions (
  decision_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  market_name TEXT NOT NULL,
  selection TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,
  confidence TEXT,
  bookmaker_odds REAL,
  theoretical_stake_percent REAL,
  theoretical_stake_amount REAL,
  ranking_position INTEGER NOT NULL,
  operational_slot INTEGER CHECK (operational_slot IS NULL OR operational_slot BETWEEN 1 AND 3),
  decision_status TEXT NOT NULL CHECK (decision_status IN ('reserved', 'placed', 'dry_run', 'saved_only')),
  exclusion_reason TEXT,
  bet_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_automated_bet_decisions_match
  ON automated_bet_decisions(match_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automated_bet_decisions_user
  ON automated_bet_decisions(user_id, created_at);
INSERT OR IGNORE INTO automated_bet_decisions (
  decision_id, user_id, match_id, market_name, selection, opportunity_key, confidence,
  bookmaker_odds, theoretical_stake_percent, theoretical_stake_amount,
  ranking_position, operational_slot, decision_status, exclusion_reason, bet_id, created_at
)
SELECT
  'legacy-automation-' || ranked.bet_id,
  ranked.user_id,
  ranked.match_id,
  ranked.market_name,
  ranked.selection,
  lower(trim(ranked.market_name)) || char(31) || lower(trim(ranked.selection)) ||
    CASE WHEN ranked.opportunity_number = 1
      THEN ''
      ELSE char(31) || 'legacy-' || ranked.opportunity_number
    END,
  NULL,
  ranked.odds,
  NULL,
  ranked.stake,
  ranked.slot_number,
  CASE WHEN ranked.slot_number <= 3 THEN ranked.slot_number ELSE NULL END,
  'placed',
  CASE WHEN ranked.slot_number <= 3
    THEN 'backfilled_existing_automation_bet'
    ELSE 'legacy_automation_bet_above_cap'
  END,
  ranked.bet_id,
  ranked.placed_at
FROM (
  SELECT b.*,
    ROW_NUMBER() OVER (
      PARTITION BY b.user_id, b.match_id
      ORDER BY datetime(b.placed_at) ASC, b.bet_id ASC
    ) AS slot_number,
    ROW_NUMBER() OVER (
      PARTITION BY b.user_id, b.match_id, lower(trim(b.market_name)), lower(trim(b.selection))
      ORDER BY datetime(b.placed_at) ASC, b.bet_id ASC
    ) AS opportunity_number
  FROM bets b
  WHERE lower(trim(COALESCE(b.source, ''))) = 'automation'
) ranked;
CREATE UNIQUE INDEX IF NOT EXISTS idx_automated_bet_decisions_active_slot
  ON automated_bet_decisions(user_id, match_id, operational_slot)
  WHERE operational_slot IS NOT NULL AND decision_status IN ('reserved', 'placed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_automated_bet_decisions_active_opportunity
  ON automated_bet_decisions(user_id, match_id, opportunity_key)
  WHERE operational_slot IS NOT NULL AND decision_status IN ('reserved', 'placed');
