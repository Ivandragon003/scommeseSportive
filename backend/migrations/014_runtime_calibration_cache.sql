-- Disposable, content-addressed profiles. Match data and prediction archives are untouched.
CREATE TABLE IF NOT EXISTS runtime_calibration_profiles (
  cache_key TEXT PRIMARY KEY,
  competition TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
