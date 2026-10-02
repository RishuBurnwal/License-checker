ALTER TABLE plans ADD COLUMN session_limit INTEGER NOT NULL DEFAULT 1 CHECK (session_limit > 0);
ALTER TABLE plans ADD COLUMN grace_period_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (grace_period_seconds >= 0);
ALTER TABLE plans ADD COLUMN heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (heartbeat_interval_seconds > 0);

CREATE TABLE IF NOT EXISTS license_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token_hash TEXT NOT NULL UNIQUE,
  code_id INTEGER NOT NULL REFERENCES activation_codes(id),
  app_id INTEGER NOT NULL REFERENCES apps(id),
  device_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'kicked', 'expired')),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  kicked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_license_sessions_code_status ON license_sessions(code_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_license_sessions_app_status ON license_sessions(app_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_license_sessions_last_seen ON license_sessions(last_seen_at);
