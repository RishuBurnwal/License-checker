# Database Specification

Cloudflare D1 is the only persistent store. D1 is SQLite, so the schema, SQL dialect, and migration files are plain SQLite. Local development runs the same migrations against a SQLite file in `.wrangler/state/`, and nothing in the schema or queries is D1-specific beyond the D1 binding API.

The schema evolves only through the root `migrations/` directory. The current database shape equals all migrations applied in filename order; do not infer it from the initial migration alone or from TypeScript types.

## Current Migrations

| Migration | Purpose |
| --- | --- |
| `0001_initial.sql` | Creates apps, plans, administrators, generation batches, activation codes, logs, indexes, and the built-in plans |
| `0002_add_purchase_url.sql` | Adds the optional `purchase_url` to `apps` |
| `0003_add_tenants.sql` | Historical: added an organization scaffold and a login-role column (both fully removed again in `0010`–`0012`) |
| `0004_localize_seed_data.sql` | Localizes the seeded plan names to English, guarded so operator-customized values are preserved |
| `0005_add_sessions_and_lease_settings.sql` | Adds plan session/heartbeat/grace settings and the app-scoped `license_sessions` lease table |
| `0006_add_forced_password_change.sql` | Adds `admin_users.must_change_password` (default 0, checked to 0/1) and `admin_users.password_changed_at` |
| `0007_add_signed_license.sql` | Adds the signed-license schema: `activation_codes.hold_at`/`hold_reason_code`/`max_activations`, the `code_activations` slot table, and the `security_events` log (all additive) |
| `0008_add_admin_users_and_sessions.sql` | Adds `admin_users.session_epoch` and `admin_users.user_role` (`admin`/`staff`), and the `admin_sessions` audit table |
| `0009_add_settings.sql` | Adds the global `settings(key, value, updated_at)` key/value store |
| `0010_drop_apps_tenant.sql` | `ALTER TABLE apps DROP COLUMN` for the organization column (after dropping its triggers and index) |
| `0011_drop_admin_users_tenant_and_role.sql` | `ALTER TABLE admin_users DROP COLUMN` for the organization column and the login-role column, leaving `user_role` as the sole role axis |
| `0012_drop_tenants.sql` | Drops the now-unreferenced organization table |

A published migration must never be modified to express a production change. Every schema change adds the next-numbered migration and must apply in order against both an empty database and an existing one.

## Relational Model

```text
apps ────────┬─< activation_batches >─ plans
             ├─< activation_codes  >── plans
             └─< activation_logs

activation_codes ─< license_sessions >── apps

admin_users ─┬─< activation_batches
             └─< activation_codes

activation_batches ─< activation_codes ─< activation_logs
```

- `apps`: app metadata, enabled state, optional purchase link, and the app secret HMAC.
- `plans`: plan code, name, base duration in days, and ordering.
- `admin_users`: administrator username, password hash, and salt, plus the `must_change_password` policy flag and the last `password_changed_at` timestamp.
- `activation_batches`: the app, plan, quantity, note, and creator of one bulk generation.
- `activation_codes`: activation code HMAC, suffix, lifecycle, disable flag, device binding, and license times.
- `activation_logs`: audit records of client and administrator operations.
- `license_sessions`: opaque-token hashes, device binding, lease timestamps, and kick status for live client sessions.

## Table-Level Invariants

### `apps`

- `app_id` is globally unique and is the public identifier; internal relationships use the auto-increment `id`.
- `status` can only be `active` or `disabled`.
- `app_secret_hash` stores an HMAC, never the plaintext secret.
- `description` and `purchase_url` may be null; `http`/`https` validation of `purchase_url` happens at the HTTP layer.
- An app can be physically deleted only when no batch, code, or log references it.

### `plans`

- `code` is globally unique and `duration_days > 0`.
- The initial plans are `weekly`, `monthly`, `quarterly`, and `yearly`; `0004_localize_seed_data.sql` sets their display names to `Weekly`, `Monthly`, `Quarterly`, and `Yearly`.
- `duration_days` is the base field; the actual expiry of calendar-month and calendar-year plans is computed by the service from the plan code.
- The code and semantics of a plan already in use must not be changed in place; add new plans as new data with an explicit calculation strategy.
- `session_limit` is positive, `heartbeat_interval_seconds` is positive, and `grace_period_seconds` is non-negative.

### `admin_users`

- `username` is globally unique.
- `user_role` can only be `admin` or `staff` and is the sole role axis; `admin` manages users while `staff` cannot. `session_epoch` backs stateless kick-out.
- Passwords are stored with a random salt and hash; a password update must replace `password_hash` and `password_salt` together.
- `must_change_password` is `0` or `1`. While it is `1`, every `/api/admin/*` request except the password-change, current-administrator, and logout paths is refused with `403 PASSWORD_CHANGE_REQUIRED`. A successful password change clears it and stamps `password_changed_at` in the same statement.
- Bootstrap configuration is never written directly into the table; only initialization or recovery creates and updates the corresponding administrator.

### `settings`

- A global key/value store: `key` is the primary key, `value` is required, and `updated_at` records the last write.

### `activation_batches`

- Every batch is permanently associated with one app and one plan.
- `quantity > 0`, and the current API further limits it to at most 300.
- Batch records never store plaintext activation codes.

### `activation_codes`

| Field | Invariant |
| --- | --- |
| `code_hash` | Globally unique HMAC; cannot be used to recover plaintext |
| `code_suffix` | Used only for human recognition and fuzzy search; not an authentication credential |
| `status` | Only `unused`, `active`, `deleted` |
| `disabled_at` | Non-null means administratively disabled; does not change the original `status` |
| `activated_at` | Written only at first activation; never changes afterwards |
| `expires_at` | Computed only at first activation; never changes afterwards |
| `device_hash` | Device fingerprint HMAC; may be null after an unbind |
| `rebind_count` | Incremented only on a successful self-service unbind; starts at 0 |
| `last_rebind_at` | Updated only on a successful self-service unbind; a manual unbind does not update it |
| `hold_at` | Non-null means the license is on hold; independent of `disabled_at` and `status`; cleared on approve |
| `hold_reason_code` | Set with `hold_at` from the `HOLD_REASON_CODE` allowlist; `ADMIN_MANUAL` for an admin hold |
| `max_activations` | `NULL` or `1` keeps the legacy single-device model; `>= 1` CHECK; a value `> 1` enables multi-slot activation |

Valid field combinations:

| Scenario | `status` | Activation/expiry | `device_hash` |
| --- | --- | --- | --- |
| Not activated | `unused` | Both null | Null |
| In normal use | `active` | Both non-null | Non-null |
| Unbound, awaiting rebind | `active` | Both non-null | Null |
| Deleted | `deleted` | Retains pre-deletion values | Retains the pre-deletion value or is null |

A soft delete only updates `status` to `deleted`. It does not physically remove the row and does not clear historical fields needed for auditing.

### `activation_logs`

- `action`, `result`, and `error_code` use stable values; the current schema has no CHECK constraint, and the runtime constants are the constraint source.
- A log can relate to an activation code through `code_id`, or keep a direct app context through `app_id`.
- `device_hash` may be stored as an HMAC; device fingerprints, full activation codes, secrets, and passwords must not be.
- `message` is for human reading. Statistics and program logic use the structured fields and must not parse the message.

### `license_sessions`

- `session_token_hash` is unique and is the only persisted session credential.
- An active session is usable only while `lease_expires_at` is in the future; `kicked` is terminal for that token.
- `device_hash` is an HMAC and must never be returned by client or admin APIs.
- Session list and kick queries are global; a kick matches an active session by id alone.

### `code_activations`

The activation-slot table, populated only when `activation_codes.max_activations > 1`; the `NULL`/`1` path continues to use `activation_codes.device_hash` unchanged.

- `installation_hash` is `HMAC(DEVICE_HMAC_SECRET, installation_id)`; the raw installation id is never stored. `UNIQUE (code_id, installation_hash)` is one slot per installation per code.
- `status` is `active` or `released`.
- Atomic-claim invariant: a slot is claimed by a single `INSERT ... SELECT ... WHERE (count of active slots) < max_activations ON CONFLICT(code_id, installation_hash) DO UPDATE` statement followed by a confirming `SELECT`. The claim never over-admits under concurrency, and an installation that already holds a slot always re-verifies without being blocked.
- The admin API exposes slots only through `GET /api/admin/codes/:id/activations` and never surfaces the raw hash.

### `security_events`

The signed-license audit log.

- `app_id` and `code_id` are nullable foreign keys; events join through `apps` for display.
- `event_type` and `reason_code` have no DB-level CHECK; `worker/src/constants.ts` (`SECURITY_EVENT_TYPE`, `SECURITY_REASON_CODE`) is the allowlist source, matching the `activation_logs` precedent.
- `result` is `success` or `failure`.
- `installation_hash` stores an HMAC only; it is exposed to the admin API solely as a `has_installation` boolean, never as the raw hash.
- There is **no `source_ip` column** (finding 8, SL-24): the request IP is never persisted. Adding one is an ASK-FIRST decision gated on confirming open question OQ-7.

## Derived Status

`disabled` and `expired` are not written into `activation_codes.status`. The shared decision order is:

```sql
CASE
  WHEN status = 'deleted' THEN 'deleted'
  WHEN disabled_at IS NOT NULL THEN 'disabled'
  WHEN status = 'active' AND expires_at <= :now THEN 'expired'
  WHEN status = 'active' THEN 'active'
  ELSE 'unused'
END
```

Dashboard, trend, and frontend displays that must collapse to a single primary status have to follow the same priority. When the counting semantics change, check list filtering, total-count queries, dashboard aggregation, and frontend status tags together.

The signed-license surface derives its own status (`worker/src/license/status.ts`, `deriveSignedStatus`) with the priority `deleted => revoked`, `hold_at != null => hold`, `disabled_at != null => suspended`, `active` + expired `=> expired`, `active => active`. This maps the stored lifecycle to the client-facing `status` field in the signed payload; it never writes `hold`, `revoked`, or `suspended` back into `activation_codes.status`.

In the current activation code list filter:

- `disabled` excludes deleted rows.
- `expired` includes only rows that are activated, not disabled, and past their expiry.
- `unused` and `active` filter by stored lifecycle and exclude disabled rows; callers still need `expires_at` to tell a valid active code from an expired one.
- `deleted` filters directly on the stored status.

## Atomic Updates

The following state changes must be protected again by SQL `WHERE` preconditions; they must not rely only on a decision made after the service read the row:

- First activation: update only when `unused`, not disabled, and the activation/expiry/device fields are empty.
- Device rebind: update only when `active`, not disabled, and `device_hash IS NULL`.
- Self-service unbind: update only when `active`, not disabled, the device matches, and `rebind_count < max`.
- Manual unbind: update only when `active`, not disabled, not expired, and bound.
- Enable/disable: exclude `deleted`.
- App deletion: re-confirm that no batch, code, or log references exist.

When a conditional update affects a row count other than 1, the repository reports failure and the service returns `NOT_FOUND` or `CONFLICT` depending on the scenario. It must never overwrite concurrent state unconditionally.

## SQL Rules

- Keep SQL only in `worker/src/repository.ts` or migration files.
- All user input goes through D1 prepared statements and `.bind(...)`; never concatenate strings.
- Dynamic filtering may concatenate fixed SQL fragments, but values must go into bindings.
- Time fields are stored uniformly as UTC ISO strings and compared in the same format.
- List queries and `COUNT(*)` must share the same filter conditions to prevent inconsistent page totals.
- Bulk writes may build a fixed number of placeholders, but must never insert input values into the SQL text.
- Do not add redundant statistics tables; the dashboard uses read-only aggregate queries and reuses the derived status semantics.

## Index Requirements

Current key indexes:

- `idx_apps_app_id`
- `idx_codes_app_plan_status`
- `idx_codes_suffix`
- `idx_codes_expires_at`
- `idx_codes_created_at`
- `idx_logs_code_created_at`
- `idx_logs_app_created_at`
- `idx_logs_created_at`

Before adding a high-frequency filter or sort, check the existing query plans and index prefixes. When changing list ordering, evaluate page stability, the total-count query, and indexes together instead of adding indexes blindly for one page.

## Migration Process

For a schema change, complete these steps in order:

1. Add `migrations/NNNN_description.sql`.
2. Update the database row types in `worker/src/types.ts`.
3. Update the SELECT, INSERT, UPDATE, and mapping code in `worker/src/repository.ts`.
4. For enum changes, synchronize `worker/src/constants.ts` and the frontend constants.
5. For response changes, synchronize `admin/src/types.ts`, the calling pages, and `docs/API.md`.
6. Update the repository/service tests and this document.
7. Run local migration, Worker type-check, and tests.

```bash
pnpm db:migrate:local
pnpm --filter @license-manager/worker type-check
pnpm --filter @license-manager/worker test
```

Remote migration is a deployment step. Run it only according to the [Deployment Guide](DEPLOYMENT.md), after confirming production configuration and a backup strategy:

```bash
pnpm db:migrate:remote
```
