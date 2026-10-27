-- In-app delivery only. Incident identities persist across process restarts.
CREATE TABLE IF NOT EXISTS research_monitor_incidents (
  incident_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('OPEN','RESOLVED')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  opened_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  details_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('technical_error','daily_summary')),
  incident_key TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_notifications_created ON research_notifications(created_at);
