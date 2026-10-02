-- 0009_add_settings.sql
-- Global key/value settings store (AC-B9). Additive CREATE only — no rebuild.
-- Consumed later by the master-password feature (FEAT-002); created here so the
-- 0009–0012 migration sequence stays contiguous and applies in order.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
