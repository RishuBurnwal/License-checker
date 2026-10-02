# API Specification

The public API prefix is `/api`. The signed-license client surface adds a versioned prefix `/api/v1` (mounted beside `/api` in `worker/src/index.ts`).

This document describes the HTTP contract observable by the admin console and clients. When an example shows only a business object, it represents the `data` of a successful response; the full response always uses the shared envelope.

## General Conventions

- Requests and responses use JSON; endpoints with a body send `Content-Type: application/json`.
- Field names use `snake_case`, and URL path parameters use the existing `:appId` and `:id` forms.
- Undeclared request fields must not be relied upon; a new field must state whether it is required, optional, nullable, and its default behavior.
- Time fields use UTC ISO 8601 strings.
- Business failures return a stable `error.code`; callers must not depend on `error.message` for program logic.
- The API never returns activation code HMACs, application secret HMACs, password hashes, password salts, or plaintext device fingerprints.

## Authentication Boundaries

| Endpoint scope | Authentication |
| --- | --- |
| `GET /api/health` | None |
| `POST /api/admin/login` | Username and password |
| `POST /api/recovery/admin-password` | Bootstrap username and recovery password, passed in the body |
| `/api/admin/password`, `/api/admin/me`, `/api/admin/logout` | Bearer Token, and still reachable while a forced password change is pending |
| Other `/api/admin/*` endpoints | `Authorization: Bearer <token>` |
| `/api/client/*` | `app_id` and `app_secret` in every request body |
| `/api/v1/license/*` | `app_id` and `app_secret` in every request body |

Client authentication confirms in order that the app exists, the app is enabled, and the secret matches. Passing app authentication does not mean the activation code is valid; code state evaluation still has to run.

Admin roles:

- Every authenticated admin account sees one global dataset; there is no data-partition context header.
- The management role lives in `admin_users.user_role` (`admin` or `staff`). User-management endpoints allow only an `admin`; a `staff` account receives `403 FORBIDDEN`.

## Response Format

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid JSON body"
  }
}
```

Error code constants are defined in `worker/src/constants.ts`, and API types are exported from `worker/src/types.ts`:

- `BAD_REQUEST`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `APP_DISABLED`
- `INVALID_APP_SECRET`
- `INVALID_CODE`
- `CODE_DISABLED`
- `CODE_DELETED`
- `CODE_EXPIRED`
- `DEVICE_MISMATCH`
- `REBINDS_EXCEEDED`
- `REBINDS_TOO_FREQUENT`
- `CONFLICT`
- `SESSION_LIMIT_REACHED`
- `SESSION_REVOKED`
- `SESSION_EXPIRED`
- `PASSWORD_CHANGE_REQUIRED`
- `PROTOCOL_UNSUPPORTED`
- `ACTIVATION_LIMIT_REACHED`

`PROTOCOL_UNSUPPORTED` and `ACTIVATION_LIMIT_REACHED` belong to the signed-license surface. `PROTOCOL_UNSUPPORTED` (`400`) is returned by `POST /api/v1/license/verify` when the client sends a `protocol_version` the server does not support. `ACTIVATION_LIMIT_REACHED` (`409`) is returned only by `PATCH /api/admin/codes/:id/max-activations` when the new limit is below the current active-slot count.

In addition, an administrator whose `must_change_password` flag is set is refused every `/api/admin/*` route except `/api/admin/password`, `/api/admin/me`, and `/api/admin/logout`. Those three stay reachable so the requirement can actually be satisfied; they are still authenticated, so this is a business gate and not an authentication bypass. See [Change Password](#change-password).

Common HTTP status semantics:

| HTTP | Usage |
| --- | --- |
| `400` | Invalid JSON, type, range, or a failed precondition for the current operation |
| `401` | Invalid administrator credentials, Bearer Token, or application secret |
| `403` | The resource exists but is disabled, expired, device-mismatched, or over a business limit; also used with `PASSWORD_CHANGE_REQUIRED` when a pending forced password change blocks the route |
| `404` | The route, app, administrator, or target resource does not exist; an invalid activation code uses `INVALID_CODE` |
| `409` | Concurrent state change, uniqueness conflict, or a resource still referenced |
| `410` | The activation code has been soft deleted |
| `429` | A self-service unbind is still in its cooldown period |
| `500` | Unexpected internal exception, reported externally as `CONFLICT` without exposing internal details |

## Endpoint Overview

| Method and path | Purpose | Main effect |
| --- | --- | --- |
| `GET /api/health` | Health check | Read-only |
| `POST /api/admin/login` | Administrator login | May initialize the bootstrap administrator |
| `POST /api/recovery/admin-password` | Recover an administrator password | Updates the password hash and salt |
| `GET /api/admin/me` | Current administrator | Read-only |
| `PATCH /api/admin/password` | Change password | Updates the password hash and salt |
| `PATCH /api/admin/settings/master-password` | Change the global admin master password | Updates the master password hash and salt; `admin` role only |
| `GET /api/admin/dashboard` | Dashboard statistics | Read-only aggregation |
| `GET /api/admin/plans` | Plan list | Read-only |
| `GET /api/admin/apps` | App list | Read-only |
| `POST /api/admin/apps` | Create an app | Writes the app and returns the secret once |
| `PATCH /api/admin/apps/:appId` | Update app details | Writes the app |
| `PATCH /api/admin/apps/:appId/status` | Enable/disable an app | Writes the app and a log |
| `PATCH /api/admin/apps/:appId/secret` | Rotate the app secret | Writes the app and a log, returns the secret once |
| `DELETE /api/admin/apps/:appId` | Delete an unreferenced app | Physically deletes the app |
| `POST /api/admin/codes/batch` | Bulk generate activation codes | Writes a batch, codes, and a log |
| `GET /api/admin/codes` | Activation code list | Read-only, paginated |
| `PATCH /api/admin/codes/:id/status` | Enable/disable an activation code | Writes the code and a log |
| `PATCH /api/admin/codes/:id/unbind-device` | Administrator manual unbind | Writes the code and a log |
| `POST /api/admin/codes/bulk` | Bulk delete/enable/disable | Writes codes and logs |
| `DELETE /api/admin/codes/:id` | Soft delete an activation code | Writes the code and a log |
| `PATCH /api/admin/codes/:id/hold` | Place a license on hold | Writes the code, a log, and a security event |
| `PATCH /api/admin/codes/:id/approve` | Release a hold | Writes the code, a log, and a security event |
| `PATCH /api/admin/codes/:id/validity` | Change the license expiry | Writes the code and a log |
| `PATCH /api/admin/codes/:id/max-activations` | Change the activation limit | Writes the code and a log |
| `GET /api/admin/codes/:id/activations` | List activation slots | Read-only |
| `GET /api/admin/codes/:id/security-events` | List security events | Read-only, paginated |
| `GET /api/admin/logs` | Operation logs | Read-only, paginated |
| `POST /api/client/app-info` | Get public app information | Read-only |
| `POST /api/client/activate` | First activation or rebind | May write a code and a log |
| `POST /api/client/verify` | Verify a license | Writes an audit log |
| `POST /api/client/unbind-device` | Self-service unbind transfer | Writes the code and a log |
| `POST /api/client/heartbeat` | Refresh a client lease | Updates the active session lease |
| `POST /api/client/renew` | Extend an activated license | Extends from the current expiry or now |
| `GET /api/admin/sessions` | List live sessions | Active sessions only |
| `POST /api/admin/sessions/:id/kick` | Revoke one live session | The next heartbeat returns `SESSION_REVOKED` |
| `POST /api/v1/license/verify` | Signed license verification | Writes a security event; returns a signed payload |
| `POST /api/v1/license/report` | Report a client-side anomaly | Records a security event; may auto-hold |

## Pagination Conventions

- `page` starts at 1.
- `page_size` defaults to 20.
- `page_size` is at most 100.
- The response returns `items` and `total`.

## Admin Endpoints

Every admin endpoint except login requires `Authorization: Bearer <token>`.

The admin business endpoints below read or modify a single global dataset; there is no data-partition context header.

### Login

`POST /api/admin/login`

```json
{
  "username": "admin",
  "password": "password",
  "master_password": "master"
}
```

The account is located by its globally unique `username`. If the username or password does not match, the response is the same `UNAUTHORIZED` in every case and does not reveal which item was wrong.

An account whose `user_role` is `admin` must additionally supply the correct global `master_password`; a wrong or missing master value fails with the same `UNAUTHORIZED` as any other login error. A `staff` account authenticates with username and password only, and a `master_password` sent for a staff account neither helps nor hurts. The master password is a single global value stored as a hash and salt in the `settings` table (never in plaintext); the server authorizes purely on the stored `user_role`, so the console's "Log in as" dropdown is a UI hint only and is not sent as an auth signal. If no master password has been configured and no `ADMIN_MASTER_PASSWORD` seed is available, admin logins fail closed with `UNAUTHORIZED` while staff logins still succeed.

Response:

```json
{
  "token": "jwt",
  "admin": {
    "id": 1,
    "username": "admin",
    "user_role": "admin",
    "must_change_password": false
  }
}
```

`must_change_password` is `true` when the account still carries a reset credential. A `true` value means every other `/api/admin/*` route will answer `403 PASSWORD_CHANGE_REQUIRED` until the password is replaced; the admin console uses this flag to show the change-password screen before any business page.

### Current Administrator

`GET /api/admin/me`

Response:

```json
{
  "admin": {
    "id": 1,
    "username": "admin",
    "user_role": "admin",
    "must_change_password": false
  }
}
```

### Change Password

`PATCH /api/admin/password`

```json
{
  "current_password": "old-password",
  "new_password": "new-password"
}
```

The public demo account `test` may not change its password; calling this endpoint returns `403 FORBIDDEN`.

This endpoint clears `must_change_password` and stamps `password_changed_at` in the same update. It stays reachable while the flag is set, together with `GET /api/admin/me` and `/api/admin/logout`, which is what lets an administrator satisfy a forced change. Reusing the current password is rejected with `400`; the responses must not be relied on for the reason beyond the stable code.

### Change Master Password

`PATCH /api/admin/settings/master-password`

```json
{
  "current_master_password": "master",
  "new_master_password": "new-master-password"
}
```

Only an `admin` account may call this route; a `staff` token is refused with `403` and the stored value is left unchanged. The `current_master_password` is verified with a constant-time comparison before any change; a wrong value is rejected and the hash is not touched. The `new_master_password` must be at least 8 characters and must differ from the current one. On success the response is exactly `{ "updated": true }` with no plaintext echoed, and the new master value is required for every subsequent admin login. A stored master password always takes precedence over the `ADMIN_MASTER_PASSWORD` environment seed.

### Reset Administrator Password

`POST /api/recovery/admin-password`

This endpoint resets the bootstrap administrator password when login is impossible. It is not part of `/api/admin/*`, but it requires the `ADMIN_BOOTSTRAP_PASSWORD` configured for the environment as the recovery password.

```json
{
  "username": "admin",
  "recovery_password": "bootstrap-secret",
  "new_password": "new-password"
}
```

Constraints:

- `username` must match `ADMIN_BOOTSTRAP_USERNAME`.
- `recovery_password` must match `ADMIN_BOOTSTRAP_PASSWORD`.
- `new_password` is at least 8 characters and must not equal the recovery password.

### Dashboard Statistics

`GET /api/admin/dashboard`

Returns the aggregate data for the admin console home page:

```json
{
  "overview": {
    "apps_total": 2,
    "apps_active": 1,
    "codes_total": 100,
    "codes_unused": 30,
    "codes_active": 55,
    "codes_disabled": 5,
    "codes_expired": 8,
    "codes_deleted": 2,
    "logs_today": 20,
    "client_failures_today": 3
  },
  "code_status": [{ "status": "active", "count": 55 }],
  "app_code_ranking": [
    {
      "app_id": "app_xxx",
      "app_name": "Desktop App",
      "platform": "windows",
      "total": 80,
      "active": 50,
      "unused": 20,
      "disabled": 3,
      "expired": 5,
      "deleted": 2
    }
  ],
  "plan_distribution": [{ "plan_code": "monthly", "plan_name": "Monthly", "count": 60 }],
  "log_trend": [{ "date": "2026-06-22", "success": 18, "failure": 2 }],
  "code_trend": [{ "date": "2026-06-22", "activated": 12, "expired": 3, "active": 55 }]
}
```

Counting semantics:

- `codes_active` excludes disabled, deleted, and expired activation codes.
- `codes_disabled` includes non-deleted activation codes with `disabled_at IS NOT NULL`.
- `codes_expired` counts activation codes that are activated, not disabled, and have `expires_at <= now`.
- `client_failures_today` counts only today's failed client activation, verification, and unbind logs.
- `code_trend` is the last 7 days of activation code movement; `activated` counts by the day of `activated_at`, `expired` counts by the day of `expires_at`, and `active` is the number of activation codes still in use at the end of that day.

### Plan List

`GET /api/admin/plans`

### App List

`GET /api/admin/apps`

### Create App

`POST /api/admin/apps`

```json
{
  "name": "Desktop App",
  "description": "optional description",
  "purchase_url": "https://example.com/buy-license",
  "platform": "windows",
  "status": "active"
}
```

`description` may be omitted or empty.

`purchase_url` may be omitted or empty and accepts only `http` or `https` links.

The response contains an `app_secret` shown exactly once.

### Update App Details

`PATCH /api/admin/apps/:appId`

```json
{
  "name": "Desktop App",
  "description": "optional description",
  "purchase_url": "https://example.com/buy-license",
  "platform": "windows"
}
```

`description` may be omitted or empty; an empty value clears the description.

`purchase_url` may be omitted or empty; an empty value clears the purchase link, and only `http` or `https` links are accepted.

The response returns the updated `app` without `app_secret` or the secret hash.

### Update App Status

`PATCH /api/admin/apps/:appId/status`

```json
{
  "status": "disabled"
}
```

`status` can only be `active` or `disabled`.

### Rotate App Secret

`PATCH /api/admin/apps/:appId/secret`

Generates a new `app_secret`, and the old secret stops working immediately.

The response contains the new `app_secret` shown exactly once, and never the secret hash.

### Delete App

`DELETE /api/admin/apps/:appId`

Only an app with no activation code, generation batch, or operation log references can be deleted. An app with license data returns `CONFLICT`.

### Generate Activation Codes

`POST /api/admin/codes/batch`

```json
{
  "app_id": "app_xxx",
  "plan_code": "monthly",
  "quantity": 10,
  "note": "optional note"
}
```

Constraints:

- `quantity` ranges from 1 to 300.
- The returned `codes` are plaintext activation codes and appear only in this response.

### Activation Code List

`GET /api/admin/codes`

Query parameters:

- `page`
- `page_size`
- `query`
- `app_id`
- `plan_code`
- `status`

`status` supports:

- `unused`
- `active`
- `disabled`
- `deleted`
- `expired`

Filter semantics:

- `disabled`: not deleted and `disabled_at` is non-null.
- `expired`: `status = active`, not disabled, and `expires_at <= now`.
- `unused`: stored status is `unused` and not disabled.
- `active`: stored status is `active` and not disabled; the current implementation may still include expired rows, and callers display `expired` based on `expires_at`.
- `deleted`: stored status is `deleted`.

The returned `items` include `device_hash`, used only so the admin console can tell whether a device is bound; the UI never shows the raw hash. An unactivated code returns `null`, and the endpoint never returns a plaintext device fingerprint.

### Update Activation Code Disabled State

`PATCH /api/admin/codes/:id/status`

```json
{
  "status": "disabled"
}
```

`status` can only be `disabled` or `enabled`. Enabling restores the code's original unused or active state; a deleted activation code cannot be enabled.

### Delete Activation Code

`DELETE /api/admin/codes/:id`

Deletion is a soft delete.

### Manual Device Unbind

`PATCH /api/admin/codes/:id/unbind-device`

An administrator manually releases the activation code's current device binding. Only activation codes that are activated, not disabled, not deleted, not expired, and bound to a device can be manually unbound. A manual unbind does not increase `rebind_count` and does not update `last_rebind_at`; afterwards the user can activate and bind the same code on a new device, and the license validity period is not recalculated.

### Bulk Activation Code Operations

`POST /api/admin/codes/bulk`

```json
{
  "action": "delete",
  "ids": [1, 2, 3]
}
```

`action` supports:

- `delete`: bulk soft delete.
- `disable`: bulk disable.
- `enable`: bulk enable.

Constraints:

- `ids` count ranges from 1 to 100.
- Deletion is a soft delete.
- A deleted activation code cannot be enabled or disabled.
- The response returns `requested` and the actually updated count `updated`.

### Signed-License Code Powers

These six endpoints manage the signed-license surface of an activation code. They are Bearer-protected like every other `/api/admin/*` business route; an unknown code id returns `404`.

#### Hold

`PATCH /api/admin/codes/:id/hold`

Places the license on hold. Hold is an independent state (separate from `disabled_at` and `status`) that the signed status derivation reports as `hold`. Sets `hold_at`, `hold_reason_code = ADMIN_MANUAL`, writes a `disable_code` log and an `ADMIN_HOLD` security event. A code that does not exist or is already on hold returns `404 NOT_FOUND`.

```json
{
  "held": true
}
```

#### Approve

`PATCH /api/admin/codes/:id/approve`

Releases an existing hold. Clears `hold_at` and `hold_reason_code`, writes an `enable_code` log and an `ADMIN_APPROVE` security event. A code that does not exist or is not on hold returns `404 NOT_FOUND`.

```json
{
  "approved": true
}
```

#### Change Validity

`PATCH /api/admin/codes/:id/validity`

```json
{
  "expires_at": "2026-12-31T23:59:59.000Z"
}
```

Sets a new absolute expiry on an active, activated code. `expires_at` must be a valid ISO-8601 timestamp; an invalid value returns `400 BAD_REQUEST`. A code that is not an active, activated license returns `404 NOT_FOUND`. The next signed verify reflects the new `expires_at` (and reports `expired` when the new value is in the past).

```json
{
  "updated": true,
  "expires_at": "2026-12-31T23:59:59.000Z"
}
```

#### Change Activation Limit

`PATCH /api/admin/codes/:id/max-activations`

```json
{
  "max_activations": 5
}
```

`max_activations` is either an integer `>= 1` or `null`. `null` (or `1`) keeps the legacy single-device model; a value `> 1` enables multi-slot activation tracked in `code_activations`. If the new value is below the current active-slot count the endpoint returns `409 ACTIVATION_LIMIT_REACHED` (this is the only endpoint that emits that code). A missing code returns `404 NOT_FOUND`.

```json
{
  "updated": true,
  "max_activations": 5
}
```

#### List Activations

`GET /api/admin/codes/:id/activations`

Returns the activation slots for the code. The raw `installation_hash` is never surfaced.

```json
{
  "max_activations": 5,
  "active_count": 2,
  "items": [
    {
      "id": 1,
      "status": "active",
      "activated_at": "2026-07-14T08:00:00.000Z",
      "last_seen_at": "2026-07-20T08:00:00.000Z",
      "released_at": null,
      "created_at": "2026-07-14T08:00:00.000Z"
    }
  ]
}
```

`status` is `active` or `released`. `max_activations` is `null` for a single-device code.

#### List Security Events

`GET /api/admin/codes/:id/security-events`

Query parameters: `page`, `page_size`. Paginated, read-only.

```json
{
  "items": [
    {
      "id": 1,
      "code_id": 10,
      "event_type": "VERIFY",
      "reason_code": null,
      "has_installation": true,
      "protocol_version": 1,
      "key_id": "ed25519-2026-06",
      "result": "success",
      "message": "Signed verify (active)",
      "created_at": "2026-07-20T08:00:00.000Z"
    }
  ],
  "total": 1
}
```

The stored `installation_hash` is replaced by a `has_installation` boolean; the raw hash is never returned. `event_type` values come from `SECURITY_EVENT_TYPE` and `reason_code` values from `SECURITY_REASON_CODE` in `worker/src/constants.ts`.

### Operation Logs

`GET /api/admin/logs`

Query parameters:

- `page`
- `page_size`
- `query`
- `app_id`
- `action`

Common `action` values:

- `batch_generate`: bulk generation
- `activate`: activation
- `verify`: verification
- `unbind_device`: unbind
- `manual_unbind_device`: manual unbind
- `delete_code`: delete activation code
- `disable_code`: disable activation code
- `enable_code`: enable activation code
- `disable_app`: disable app
- `enable_app`: enable app
- `rotate_app_secret`: rotate app secret

The stored `message` field uses stable English templates and is rendered for display by `admin/src/shared/logMessage.ts`. Use `error_code` and `action` for filtering, never the message text.

## Client Endpoints

The `app_secret`, `code`, and `device_fingerprint` in client requests may only be placed in the JSON request body, never in a URL, query parameters, or logs.

### Get App Information

`POST /api/client/app-info`

```json
{
  "app_id": "app_xxx",
  "app_secret": "sec_xxx"
}
```

The request validates that the app exists, is enabled, and that the secret matches. On success, `data` contains only public app information, never the internal database ID, app secret, or secret hash:

```json
{
  "ok": true,
  "data": {
    "app_id": "app_xxx",
    "name": "Desktop App",
    "description": "optional description",
    "purchase_url": "https://example.com/buy-license",
    "platform": "windows",
    "status": "active"
  }
}
```

### Activate

`POST /api/client/activate`

```json
{
  "app_id": "app_xxx",
  "app_secret": "sec_xxx",
  "code": "LM-XXXXX-XXXXX-XXXXX-XXXXX",
  "device_fingerprint": "stable-device-id"
}
```

Activate, verify, and unbind all return license information on success. `device_bound` indicates whether the activation code is currently bound to a device; after a successful unbind the field is `false`, and it returns to `true` once the new device re-activates.

License `data` structure:

```json
{
  "valid": true,
  "device_bound": true,
  "app_id": "app_xxx",
  "plan": {
    "code": "monthly",
    "name": "Monthly",
    "duration_days": 30
  },
  "activated_at": "2026-07-14T08:00:00.000Z",
  "expires_at": "2026-08-14T08:00:00.000Z",
  "remaining_seconds": 2678400,
  "rebind_count": 0,
  "max_rebinds": 3
}
```

- `valid` is always `true` in a successful response; an invalid license is expressed through the failure envelope, never as a success with `valid: false`.
- `remaining_seconds` is rounded down with a minimum of 0 and represents only the remaining time at the response instant.
- `duration_days` is the plan's base field; the actual `expires_at` of monthly, quarterly, and yearly plans is computed in calendar months/years.
- When `device_bound` is `false`, the license keeps its original expiry, but verification fails until it is re-activated and bound.

### Verify

`POST /api/client/verify`

```json
{
  "app_id": "app_xxx",
  "app_secret": "sec_xxx",
  "code": "LM-XXXXX-XXXXX-XXXXX-XXXXX",
  "device_fingerprint": "stable-device-id"
}
```

### Unbind

`POST /api/client/unbind-device`

```json
{
  "app_id": "app_xxx",
  "app_secret": "sec_xxx",
  "code": "LM-XXXXX-XXXXX-XXXXX-XXXXX",
  "device_fingerprint": "stable-device-id"
}
```

After a successful unbind, the activation code keeps its original `activated_at` and `expires_at` but clears the bound device. The new device calls the activate endpoint again with its own `device_fingerprint` to complete the rebind, and the license validity period is not recalculated.

### Session, Heartbeat, and Renewal

`POST /api/client/activate` accepts an optional `session_token`. On a successful activation it returns a one-time random `session_token`, `lease_expires_at`, `grace_period_seconds`, and `heartbeat_interval_seconds`. The token is opaque to the client and only its HMAC is stored.

`POST /api/client/heartbeat` requires `app_id`, `app_secret`, `code`, `device_fingerprint`, and `session_token`. It verifies the current license, device, session status, and lease, then refreshes the lease. A kicked session returns `SESSION_REVOKED`; a stale lease returns `SESSION_EXPIRED`; a plan's live-session limit returns `SESSION_LIMIT_REACHED` during activation.

`POST /api/client/renew` requires the same licensing fields and optionally `session_token`. It can renew an activated, device-bound license even after its prior expiry, but never a deleted, disabled, unactivated, or device-mismatched code. Renewal extends from the later of the current expiry and server time by the plan duration and returns a new authoritative `expires_at`.

`GET /api/admin/sessions` returns only active, unexpired sessions. It exposes session metadata and a `device_bound` boolean, never the session token hash or device hash. `POST /api/admin/sessions/:id/kick` atomically marks one session as kicked; its next heartbeat is rejected.

## Signed-License Client Endpoints (`/api/v1`)

The signed-license surface lets an untrusted client verify a license and receive a response it can validate offline with an embedded public key. Both endpoints authenticate with `app_id` and `app_secret` in the body, exactly like `/api/client/*`. The full client-side contract (byte canonical form, signature verification, key rotation, freshness predicate) is documented in [CLIENT_INTEGRATION.md](CLIENT_INTEGRATION.md).

### Verify (Signed)

`POST /api/v1/license/verify`

```json
{
  "app_id": "app_xxx",
  "app_secret": "sec_xxx",
  "license_key": "LM-XXXXX-XXXXX-XXXXX-XXXXX",
  "product_id": "app_xxx",
  "installation_id": "stable-installation-id",
  "application_version": "1.4.0",
  "protocol_version": 1
}
```

- `product_id` must equal the authenticated app's public `app_id`. A mismatch is an enumeration-safe `404 INVALID_CODE` that records a `PRODUCT_MISMATCH` security event and returns no signed body.
- `protocol_version` is a required integer `>= 1`. An unsupported version returns `400 PROTOCOL_UNSUPPORTED`.
- `application_version` is optional.
- `installation_id` is echoed back raw in the signed payload; only its HMAC is stored.
- **First verify activates an unused key.** If the key is unused (and not held or disabled), this call activates it on the calling installation with the same atomic compare-and-set as `POST /api/client/activate`: the license period starts now and the installation becomes the bound device. The client does not need a separate activate call. Re-verifying on the same installation never recalculates the expiry; a different installation on a single-device key gets a signed `activation_allowed: false`.
- **CORS:** `/api/v1/license/*` answers browser preflights and sets `Access-Control-Allow-Origin: *` on every response (success and error), so browser clients such as the license checker can call a user-supplied server URL. No cookies or Bearer tokens are involved. `/api/admin/*` never sends CORS headers.

Success (`200`) `data`:

```json
{
  "payload": {
    "activation_allowed": true,
    "expires_at": "2026-08-14T08:00:00.000Z",
    "grace_period_seconds": 0,
    "installation_id": "stable-installation-id",
    "issued_at": "2026-07-20T08:00:00.000Z",
    "key_id": "ed25519-2026-06",
    "license_id": 10,
    "plan": "monthly",
    "product_id": "app_xxx",
    "protocol_version": 1,
    "server_time": "2026-07-20T08:00:00.000Z",
    "status": "active"
  },
  "signature": "base64url-detached-ed25519-signature",
  "public_key_id": "ed25519-2026-06",
  "verification_interval_seconds": 3600
}
```

The `payload` carries exactly the 12 canonical fields, in that fixed set, and `signature` is a detached base64url Ed25519 signature over the canonical byte form of those 12 fields (see [CLIENT_INTEGRATION.md](CLIENT_INTEGRATION.md) for the exact byte form). `public_key_id` duplicates `payload.key_id`. `verification_interval_seconds` is the recommended re-verification interval.

Business "no" outcomes (`expired`, `revoked`, `suspended`, `hold`, and over the activation limit) still return a signed `200` with the true `status` and `activation_allowed: false`; no activation slot is consumed when over the limit, and an installation that already holds a slot always re-verifies. Hard failures are unsigned: product mismatch (`404 INVALID_CODE`), unknown protocol (`400 PROTOCOL_UNSUPPORTED`), unknown key (`404 INVALID_CODE`), bad secret (`401 INVALID_APP_SECRET`), and malformed input (`400 BAD_REQUEST`). A missing or malformed signing key configuration fails the request with `500` (reported as `CONFLICT`).

Payload field semantics:

- `activation_allowed`: whether this installation may run. `true` only when the derived `status` is `active` and the installation holds (or can claim) an activation slot.
- `status`: the derived signed status, one of `active`, `expired`, `revoked`, `suspended`, `hold`.
- `license_id`: the internal `activation_codes.id`.
- `plan`: the plan code.
- `product_id`: the authenticated app's public `app_id`.
- `key_id`: the id of the key that signed this payload.
- `issued_at` and `server_time`: equal server-side ISO timestamps for this response.
- `expires_at`: the license expiry ISO timestamp, or `null`.
- `grace_period_seconds` and `protocol_version`: non-negative integers.

### Report (Signed)

`POST /api/v1/license/report`

```json
{
  "app_id": "app_xxx",
  "app_secret": "sec_xxx",
  "installation_id": "stable-installation-id",
  "license_key": "LM-XXXXX-XXXXX-XXXXX-XXXXX",
  "reason_code": "SIGNATURE_INVALID",
  "detail": "optional short note"
}
```

- Exactly one of `license_key` or `license_id` is required; sending both or neither returns `400 BAD_REQUEST`.
- `reason_code` must be one of the `SECURITY_REASON_CODE` values (`worker/src/constants.ts`); an unknown value returns `400 BAD_REQUEST`.
- `detail` is optional and truncated server-side.
- A license not owned by the authenticated app returns `404 INVALID_CODE` and records nothing.

Success (`200`) `data`:

```json
{
  "recorded": true,
  "held": true
}
```

A `REPORT` security event is always recorded. `held` is `true` only when the corroborated auto-hold threshold is met; see [SECURITY.md](SECURITY.md#signed-license-threat-model) for the exact threshold and the shipped defaults.

## Contract Change Requirements

- When adding or changing a route, synchronize `worker/src/routes.ts` and this document.
- When adding an error code, synchronize `worker/src/constants.ts`, the frontend constants/handling, tests, and this document.
- When response fields change, synchronize the Worker return types, `admin/src/types.ts`, all callers, and the examples.
- A persisted field change also needs a new migration plus updates to `worker/src/repository.ts`, `types.ts`, and `docs/DATABASE.md`.
- A client behavior change must synchronize `docs/BUSINESS_RULES.md` and cover success, rejection, and concurrent conflict tests.
- Deleting or renaming a field is a breaking change; do not modify a published client contract directly without an explicit version migration plan.
