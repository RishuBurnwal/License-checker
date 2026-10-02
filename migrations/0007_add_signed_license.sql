-- 0007_add_signed_license.sql
-- Signed-license schema (the AC-47 migration). All additive; never rebuilds a
-- published table. HOLD state, per-license activation limit, activation slots,
-- and a tenant-scoped security-event log.

-- HOLD state: dedicated, independent of disabled_at and status, releasable.
ALTER TABLE activation_codes ADD COLUMN hold_at TEXT;
ALTER TABLE activation_codes ADD COLUMN hold_reason_code TEXT;

-- Per-license activation limit. NULL = legacy single-device behavior (unchanged).
ALTER TABLE activation_codes ADD COLUMN max_activations INTEGER
  CHECK (max_activations IS NULL OR max_activations >= 1);

-- Activation slots. Populated ONLY when max_activations > 1; the NULL/1 path
-- keeps using activation_codes.device_hash exactly as today.
CREATE TABLE IF NOT EXISTS code_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL REFERENCES activation_codes(id),
  installation_hash TEXT NOT NULL,          -- HMAC(DEVICE_HMAC_SECRET, installation_id)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  activated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (code_id, installation_hash)
);
CREATE INDEX IF NOT EXISTS idx_code_activations_code_status
  ON code_activations(code_id, status);

-- Tenant-scoped security events + verification history for the signed surface.
-- No source_ip column (finding 8, SL-24): no code path can populate storage that
-- does not exist. No DB-level CHECK on event_type/reason_code; constants.ts is
-- the allowlist source, matching the activation_logs precedent.
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER REFERENCES apps(id),        -- tenant is resolved through the app
  code_id INTEGER REFERENCES activation_codes(id),
  event_type TEXT NOT NULL,                  -- allowlist, see constants.ts
  reason_code TEXT,                          -- allowlist, see constants.ts
  installation_hash TEXT,                    -- HMAC only, never raw
  protocol_version INTEGER,
  key_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_app_created
  ON security_events(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_code_created
  ON security_events(code_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type_created
  ON security_events(event_type, created_at DESC);
