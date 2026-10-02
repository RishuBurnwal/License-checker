-- 0010_drop_apps_tenant.sql
-- Destructive multi-tenancy removal (AC-A1/A3): drop apps.tenant_id, its
-- NOT-NULL triggers, and idx_apps_tenant_created.
--
-- This uses SQLite's native ALTER TABLE ... DROP COLUMN (3.35+) rather than a
-- DROP + RENAME table rebuild. The rebuild is unsafe here: dropping the parent
-- `apps` table while child tables (activation_codes, activation_batches,
-- activation_logs, security_events, license_sessions) still reference it leaves
-- the deferred-foreign-key counter non-zero at COMMIT on a POPULATED database,
-- so the whole transaction is rolled back with "FOREIGN KEY constraint failed"
-- even though the data is consistent (PRAGMA foreign_key_check reports nothing).
-- DROP COLUMN edits `apps` in place, so no child reference is ever dangling and
-- the migration applies cleanly on both an empty and a data-bearing database.
--
-- The dependent trigger and index must be removed before the column can be
-- dropped. idx_apps_app_id is unrelated and is preserved.
DROP TRIGGER IF EXISTS trg_apps_tenant_required_insert;
DROP TRIGGER IF EXISTS trg_apps_tenant_required_update;
DROP INDEX IF EXISTS idx_apps_tenant_created;

ALTER TABLE apps DROP COLUMN tenant_id;
