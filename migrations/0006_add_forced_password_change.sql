-- Forces a password change on the next authenticated request after an
-- administrative reset. The column defaults to 0 so existing accounts are
-- unaffected; only an explicit reset (or the reset script) sets it to 1.
ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));

-- Records when the password was last set, so operators can audit staleness.
ALTER TABLE admin_users ADD COLUMN password_changed_at TEXT;
