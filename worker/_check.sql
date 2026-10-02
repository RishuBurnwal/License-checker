SELECT id, tenant_id, role, username, must_change_password, password_changed_at, length(password_hash) AS hash_len, length(password_salt) AS salt_len FROM admin_users;
