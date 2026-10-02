# Business Rules

This document is the specification source for product scope, domain terminology, and license status semantics. The implementation is mainly in `worker/src/service.ts`, persistence conditions are in `worker/src/repository.ts`, and behavior changes must be proven by tests.

## Product Boundary

The product currently provides:

- Multi-application, multi-platform license management.
- Application creation, editing, enable/disable, secret rotation, and restricted deletion.
- Activation code batch generation, querying, filtering, disable/enable, and soft deletion.
- Four built-in plans: weekly, monthly, quarterly, and yearly.
- Client-side app info retrieval, activation, verification, and self-service unbind transfer.
- Device-bound client sessions with atomic concurrent-session limits, renewable leases, heartbeat validation, and administrator kick-out.
- Server-authoritative renewal and a configurable offline grace/lease window returned to clients for local degraded-mode handling.
- Admin login, JWT sessions, password changes, and bootstrap password recovery.
- Admin/staff user management with a single global dataset.
- Admin statistics, operation logs, integration docs, SDK samples, and a Playground.

The following capabilities are not included yet. Adding any of them requires clarifying the data model, authentication, and compatibility impact first:

- Fine-grained permissions and custom roles beyond `admin`/`staff`.
- Payments, orders, invoices, or financial settlement.
- Recovery of plaintext activation codes.
- Installable SDK package publishing, version compatibility matrices, or forced upgrade policies.
- Multi-database or non-Cloudflare deployment support.

## Business Capability Highlights

This section explains the user value of each capability. Concrete decision conditions and immutable constraints remain governed by the sections below.

| Capability | Business value | Key boundary |
| --- | --- | --- |
| Duration starts at first activation | Codes can be generated, delivered, or stocked in advance without consuming the customer's license duration early | `activated_at` and `expires_at` are written once at first activation and are never recalculated by unbind, rebind, disable, or enable |
| One code, one device, with controlled transfer | Prevents arbitrary copying of a license between devices while keeping a self-service path for legitimate transfers | At most 3 self-service unbinds with at least 24 hours between effective unbinds; administrator manual unbinds do not consume the user's quota |
| Single global dataset | One deployment manages all apps and license data without a data-partition axis, keeping operations simple | Every admin account sees the same global data; access is gated only by the `admin`/`staff` management role |
| Minimal credential storage | A database or log leak does not directly expose usable activation codes, application secrets, or device fingerprints | Plaintext codes and `app_secret` are returned once, device fingerprints are never persisted, and sensitive values never enter URLs or logs |
| Lifecycle auditing | Disable, expiry, unbind, and deletion each keep distinct semantics, making license history traceable | Deletion is an irreversible soft delete; logs use stable actions, results, and error codes rather than inferring state from copy |
| Closed-loop integration | An administrator can create an app, understand the API, get samples, and validate a real request in one console | Samples must never embed a real `app_secret`; real Playground calls can change activation state and write logs |

## Domain Terminology

| Term | Meaning |
| --- | --- |
| App | An independent licensed product with a public `app_id`, a private `app_secret`, a platform, and an enabled state |
| Admin (`user_role=admin`) | Manages all business data and manages other users |
| Staff (`user_role=staff`) | Manages business data but cannot manage users; denied the user-management endpoints server-side |
| Plan | The definition that determines license duration after first activation |
| Batch | One administrator-initiated record of a bulk activation code generation |
| Code | A license credential belonging to one app and one plan that can bind to one device |
| Device binding | The HMAC of the device fingerprint stored on the activation code, indicating the device currently allowed to use the license |
| Self-service unbind | The currently bound device releases the binding, consuming one transfer from the quota |
| Manual unbind | An administrator releases the binding without consuming the user's transfer quota |
| Derived status | Display states such as `disabled` and `expired` computed from several fields and the current time instead of being stored directly in `status` |

## Core Invariants

- A full activation code appears exactly once, in the successful generation response. The database and logs store only an HMAC or a suffix.
- `app_secret` appears exactly once, in the successful create or rotate response. The database stores only an HMAC.
- Device fingerprints are used only to compute an HMAC and must never be written to the database, logs, or responses.
- An activation code belongs to exactly one app and one plan.
- Apps, batches, activation codes, and logs form one global dataset; a write-by-ID is matched by its own identifier and must not rely on frontend filtering alone.
- `activated_at` and `expires_at` are determined only at first activation; later unbind, rebind, disable, or enable must not recalculate them.
- Activation code deletion is an irreversible soft delete. A deleted code cannot be activated, verified, unbound, enabled, or disabled.
- Disabling an app blocks all client licensing operations but does not rewrite the original state of codes under that app.
- Auditable admin operations and client licensing results are logged with stable action and result values; logs must not widen the exposure of sensitive data.

## Status Model

Activation code status consists of four independent dimensions:

| Dimension | Field | Meaning |
| --- | --- | --- |
| Lifecycle | `status` | `unused`, `active`, `deleted` |
| Admin switch | `disabled_at` | Non-null means disabled by an administrator |
| Time validity | `expires_at` | `active` with `expires_at <= now` means expired |
| Device binding | `device_hash` | When `active`, non-null means bound and empty means waiting to be rebound |

The persisted lifecycle allows only:

```text
unused -> active -> deleted
unused ----------> deleted
```

`active -> unused`, `deleted -> active`, and `deleted -> unused` are forbidden.

The admin console computes the display status with the following priority so one code never shows several primary statuses at once:

1. `status = deleted` -> `deleted`
2. `disabled_at IS NOT NULL` -> `disabled`
3. `status = active AND expires_at <= now` -> `expired`
4. `status = active` -> `active`
5. Otherwise -> `unused`

"Unbound and awaiting rebind" is not a separate primary status. It is the binding sub-state where `status = active`, the code is not expired, and `device_hash IS NULL`.

## Plans and Expiry

| Plan | Expiry calculation |
| --- | --- |
| `weekly` | First activation time plus 7 days |
| `monthly` | First activation time plus 1 calendar month |
| `quarterly` | First activation time plus 3 calendar months |
| `yearly` | First activation time plus 1 calendar year |

- Expiry is calculated from the first activation instant, not from the generation time.
- Calendar months and years preserve the activation time of day. When the target month has no such date, the last day of the target month is used.
- Expiry uses `expires_at <= now`; reaching that instant counts as invalid.
- Rebinding after an unbind restores only the device relationship and does not extend the license.

## Client Decision Tables

Before evaluating an activation code, every client endpoint must validate the app: it exists, its status is `active`, and `app_secret` matches. If any of these fails, no licensing operation may continue.

### Activate

| Code condition | Result |
| --- | --- |
| `deleted` | Reject with `CODE_DELETED` |
| Disabled | Reject with `CODE_DISABLED` |
| Expired | Reject with `CODE_EXPIRED` |
| `unused` | Write the first activation time, expiry, and current device, then succeed |
| `active` and bound to the current device | Idempotent success, returning the existing license |
| `active` and bound to another device | Reject with `DEVICE_MISMATCH` |
| `active` and unbound | Atomically bind the current device while keeping the original license times, then succeed |

### Verify

| Code condition | Result |
| --- | --- |
| `deleted`, disabled, or expired | Reject with the corresponding stable error |
| `unused` | Reject with `INVALID_CODE` |
| `active` and unbound | Reject with `DEVICE_MISMATCH`; activation rebinding is required first |
| `active` and bound to another device | Reject with `DEVICE_MISMATCH` |
| `active` and bound to the current device | Succeed and return the license |

### Self-Service Unbind

Only when the code is `active`, not deleted, not disabled, not expired, and bound to the current device does evaluation continue to the transfer limits:

| Condition | Result |
| --- | --- |
| `rebind_count >= 3` | Reject with `REBINDS_EXCEEDED` |
| Less than 24 hours since `last_rebind_at` | Reject with `REBINDS_TOO_FREQUENT` |
| Otherwise | Atomically clear the device binding, set `rebind_count + 1`, update `last_rebind_at`, then succeed |

After a successful unbind, `status = active`, `activated_at`, and `expires_at` are preserved. The new device must call the activate endpoint to complete rebinding.

## Administration Rules

### Apps

- Creating an app generates `app_id` and `app_secret`; only the plaintext secret is returned once.
- After an app is disabled, client app info retrieval, activation, verification, and unbind all fail.
- After a secret rotation, the old secret stops working immediately, the new secret is returned once, and `rotate_app_secret` is logged.
- An app can be physically deleted only when no activation codes, batches, or operation logs reference it; an app with license data should be disabled instead.

### Activation Codes

- A single generation request accepts 1 to 300 codes, and the server must guarantee uniqueness within the batch and within the database.
- The plaintext `codes` in the generation result are shown only in that successful response, and the frontend must prompt the user to save them immediately.
- Disabling does not change `status`, activation time, expiry, or device binding; enabling restores the original lifecycle state.
- Both single and bulk deletion are soft deletes.
- A bulk delete, disable, or enable accepts at most 100 unique IDs at a time and allows some IDs not to be updated; it returns `requested` and `updated`.
- Administrator manual unbind is allowed only for codes that are active, valid, and bound to a device; it does not increase `rebind_count` and does not modify `last_rebind_at`.

### Administrators

- A successful login issues an 8-hour JWT.
- Login submits the username and password; the account is located by its globally unique username.
- Changing the password requires a new password of at least 8 characters that differs from the current one; on success the frontend clears the session and logs in again.
- Password recovery applies only to the administrator matching `ADMIN_BOOTSTRAP_USERNAME` and must verify `ADMIN_BOOTSTRAP_PASSWORD` at the same time.
- The recovered new password must be at least 8 characters and must not equal the recovery password.
- The bootstrap administrator is for initialization and recovery only; production must not rely on a weak default password.
- The bootstrap administrator is seeded with `user_role = admin`.
- The public demo account `test` is a read-only credential account and may not change its password through the admin password-change endpoint.

### User management

- Only an `admin` (`user_role`) can create users, reset or generate their passwords, change their role, and kick their sessions; a `staff` account is denied these endpoints server-side.
- A created username is globally unique and the initial password is at least 8 characters; a new user must change the password on first login.

## Logging Rules

- Client activation, verification, and unbind record a success or failure result after the owning activation code is found.
- Administrator bulk generation, app status changes, secret rotation, activation code status changes, deletion, and manual unbind record success logs.
- Log action values are governed by `worker/src/constants.ts`; a new action must be synchronized with frontend filtering and `docs/API.md`.
- Stored log messages are stable English templates produced by `worker/src/service.ts` and rendered for display by `admin/src/shared/logMessage.ts`; error statistics rely on the stable `error_code` and must not parse the message to determine a result.
- Heartbeats, renewals, and session kicks are logged with stable actions; session tokens and device fingerprints are never logged.
- `device_hash` may be logged. Device fingerprints, full activation codes, `app_secret`, administrator passwords, and recovery passwords must not be.

## Concurrency and Idempotency

- First activation and rebinding an unbound device must use state-conditioned atomic updates; a lost race returns `CONFLICT`.
- Re-activating the same valid code on the same device is an idempotent success and does not increase the unbind count or change license times.
- Device matching and the transfer limit for a self-service unbind must be constrained again inside the write condition; the 24-hour cooldown is checked by the service from `last_rebind_at` before writing.
- A generation batch returns plaintext results only after every activation code is persisted successfully; a uniqueness conflict should return `CONFLICT` and require a retry.
- Session creation counts only active leases under the plan's `session_limit` and performs the check and insert in the same SQLite/D1 request boundary; an existing session token refreshes its own lease instead of creating a duplicate.
- Heartbeats refresh `lease_expires_at` from server time. A kicked or expired session cannot be revived by heartbeat; the client must activate or renew again.
- Renewal extends from the later of the stored expiry and server time by the plan's duration, preserving the original activation timestamp.

## Sessions, Heartbeats, and Grace

- Every successful activation creates or refreshes an opaque session token. Only an HMAC of the token is persisted.
- A session is valid only when its license, app, device binding, status, and lease are all valid.
- The plan controls `session_limit`, `heartbeat_interval_seconds`, and `grace_period_seconds`; defaults are one session, five minutes, and 24 hours respectively.
- The server does not claim that an unavailable server can be made authoritative. The returned grace/lease metadata is an explicit client-side degraded-mode allowance; once exhausted, the client must lock protected functionality and require a successful server response.

## Rule Change Requirements

When changing behavior described in this document, at minimum check:

- The decision order and returned errors in `worker/src/service.ts`.
- The atomic update conditions and counting semantics in `worker/src/repository.ts`.
- `worker/src/constants.ts`, Worker/frontend types, and UI status display.
- `worker/test/service.test.ts`, `repository.test.ts`, and the time-related tests.
- `docs/API.md` and `docs/DATABASE.md`; also update `docs/SECURITY.md` when sensitive data is involved.
