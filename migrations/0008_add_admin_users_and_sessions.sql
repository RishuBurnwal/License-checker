-- 0008_add_admin_users_and_sessions.sql
-- User-management schema (admin/staff). ADDITIVE ONLY; never edits a published
-- migration and never rebuilds the admin_users.role CHECK (decision SL-14): the
-- new admin/staff roles are enforced in code (constants.ts + service), the
-- published super_admin/tenant_admin CHECK stays valid.

-- Stateless JWT kick-out: the epoch stamped into a token at login is compared
-- against this column on every authenticated request. Incrementing it (a kick)
-- invalidates every JWT issued before the increment. Plain ADD COLUMN, no rebuild.
ALTER TABLE admin_users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

-- Management role (decision NU-2 Option C). The published `role` column keeps its
-- login/tenant meaning (super_admin / tenant_admin) and its CHECK untouched; this
-- NEW column carries the user-management role (admin / staff). A CHECK on a brand
-- new column is NOT a rebuild of a published one. Default 'admin' + the backfill
-- below keep every existing account a user-manager, so no one loses access they
-- have today (the 330-test baseline stays green). super_admin is treated as an
-- implicit manager in code regardless of this value, so the master is never locked out.
ALTER TABLE admin_users ADD COLUMN user_role TEXT NOT NULL DEFAULT 'admin' CHECK (user_role IN ('admin', 'staff'));

-- Backfill: every pre-existing row becomes a manager (preserves current behavior).
UPDATE admin_users SET user_role = 'admin';

-- Audit/display table for issued admin sessions. This is for the per-user
-- session listing and the kick-out UI only; enforcement lives on session_epoch
-- (UM-5), so a lost or edited row can never grant access.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ON DELETE CASCADE: this is an audit/display table tied to a user; removing
  -- the user removes its session rows, so deleting an admin stays FK-safe.
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  jti TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id, revoked_at);
