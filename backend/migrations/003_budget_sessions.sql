-- Preserve bankroll history across resets. A reset closes the current
-- session and starts a new one, and bets are never deleted.
ALTER TABLE budgets ADD COLUMN active_session_id TEXT;
ALTER TABLE bets ADD COLUMN budget_session_id TEXT;

CREATE TABLE IF NOT EXISTS budget_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  initial_budget REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_budget_sessions_user ON budget_sessions(user_id, started_at);

INSERT OR IGNORE INTO budget_sessions (session_id, user_id, initial_budget, status, started_at)
SELECT 'legacy-' || user_id, user_id, total_budget, 'active', COALESCE(created_at, datetime('now'))
FROM budgets;

UPDATE budgets SET active_session_id = 'legacy-' || user_id
WHERE active_session_id IS NULL OR trim(active_session_id) = '';

UPDATE bets SET budget_session_id = 'legacy-' || user_id
WHERE budget_session_id IS NULL OR trim(budget_session_id) = '';

CREATE INDEX IF NOT EXISTS idx_bets_budget_session
  ON bets(user_id, budget_session_id, placed_at);
