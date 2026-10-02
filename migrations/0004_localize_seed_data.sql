-- Localizes seed data introduced by 0001_initial.sql and 0003_add_tenants.sql.
--
-- Applied as a new migration so that already-deployed databases are updated too.
-- The legacy Chinese literals below are only used as guards: they prevent this
-- migration from overwriting values an operator has already customized.

UPDATE plans SET name = 'Weekly' WHERE code = 'weekly' AND name = '周卡';
UPDATE plans SET name = 'Monthly' WHERE code = 'monthly' AND name = '月卡';
UPDATE plans SET name = 'Quarterly' WHERE code = 'quarterly' AND name = '季卡';
UPDATE plans SET name = 'Yearly' WHERE code = 'yearly' AND name = '年卡';

UPDATE tenants
SET name = 'Default Tenant', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE slug = 'default' AND name = '默认租户';
