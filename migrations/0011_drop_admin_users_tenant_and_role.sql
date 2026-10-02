-- 0011_drop_admin_users_tenant_and_role.sql
-- Destructive multi-tenancy removal (AC-A4/A7/A11): drop admin_users.tenant_id
-- and the login-role column (its super_admin / tenant_admin CHECK goes with it),
-- plus idx_admin_users_tenant. user_role (admin / staff) becomes the sole role
-- axis; session_epoch, must_change_password, password_changed_at, and the
-- username UNIQUE constraint are all preserved.
--
-- Uses native ALTER TABLE ... DROP COLUMN (3.35+) for the same reason as 0010:
-- a DROP + RENAME rebuild would leave admin_sessions.admin_id,
-- activation_batches.created_by, and activation_codes.created_by dangling across
-- the swap and fail the deferred-FK check at COMMIT on a populated database.
-- Dropping the columns in place keeps every child reference valid and preserves
-- the id of each account.
--
-- The dependent index must be removed before the columns can be dropped.
DROP INDEX IF EXISTS idx_admin_users_tenant;

ALTER TABLE admin_users DROP COLUMN tenant_id;
ALTER TABLE admin_users DROP COLUMN role;
