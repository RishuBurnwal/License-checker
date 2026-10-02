-- 0012_drop_tenants.sql
-- Destructive multi-tenancy removal (AC-A3). Final step: after 0010/0011 removed
-- every REFERENCES tenants(id), the tenants table can be dropped outright.
DROP TABLE tenants;
