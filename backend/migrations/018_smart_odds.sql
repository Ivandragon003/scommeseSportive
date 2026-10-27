-- Additive, account-scoped HTTP reservations. Request/result/event history is append-only.
CREATE TABLE IF NOT EXISTS smart_odds_budgets (
  provider TEXT NOT NULL, account_scope TEXT NOT NULL, month TEXT NOT NULL,
  measured_used REAL, measured_remaining REAL, header_charged_anchor REAL NOT NULL DEFAULT 0,
  header_observed_at TEXT, reset_confirmed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider,account_scope,month)
);
CREATE TABLE IF NOT EXISTS smart_odds_requests (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_scope TEXT NOT NULL, month TEXT NOT NULL,
  request_key_hash TEXT NOT NULL, endpoint TEXT NOT NULL, operation TEXT NOT NULL,
  markets_json TEXT NOT NULL, regions_json TEXT NOT NULL, bookmakers_json TEXT NOT NULL,
  expected_credits REAL NOT NULL, priority TEXT NOT NULL, reserved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS smart_odds_request_month ON smart_odds_requests(provider,account_scope,month);
CREATE TABLE IF NOT EXISTS smart_odds_results (
  request_id TEXT PRIMARY KEY REFERENCES smart_odds_requests(id), status TEXT NOT NULL,
  charged_credits REAL NOT NULL, measured_cost REAL, headers_json TEXT NOT NULL,
  finished_at TEXT NOT NULL, error_code TEXT
);
CREATE TABLE IF NOT EXISTS smart_odds_cache (
  provider TEXT NOT NULL, account_scope TEXT NOT NULL, request_key_hash TEXT NOT NULL,
  data_json TEXT NOT NULL, headers_json TEXT NOT NULL, fetched_at TEXT NOT NULL, request_id TEXT NOT NULL,
  PRIMARY KEY(provider,account_scope,request_key_hash)
);
CREATE TABLE IF NOT EXISTS smart_odds_leases (
  provider TEXT NOT NULL, account_scope TEXT NOT NULL, request_key_hash TEXT NOT NULL,
  token TEXT NOT NULL, request_id TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY(provider,account_scope,request_key_hash)
);
CREATE TABLE IF NOT EXISTS smart_odds_events (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_scope TEXT NOT NULL, request_key_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL, operation TEXT NOT NULL, markets_json TEXT NOT NULL,
  type TEXT NOT NULL, reason TEXT, request_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS smart_odds_event_recent ON smart_odds_events(created_at,provider,account_scope);
