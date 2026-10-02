# Security Specification

This document defines the security boundaries that must not be relaxed for feature convenience. When business rules conflict with this document, choose the implementation that does not expose credentials, does not widen permissions, and does not persist plaintext, then fix the specification to match.

## Data Classification

| Data | Classification | Allowed locations | Forbidden locations |
| --- | --- | --- | --- |
| Plaintext activation code | One-time secret | Generation success response and the matching one-time UI | Database, logs, URLs, repository files |
| `app_secret` | Long-lived application credential | Create/rotate success response, client request body, the user's private configuration | Database plaintext, logs, URLs, SDK samples, repository files |
| Device fingerprint | Terminal identifier secret | Client request body and the HMAC input in memory | Database plaintext, logs, responses, URLs |
| Administrator password / recovery password | Highly sensitive credential | Password input, hashing flow, Wrangler secret | Logs, URLs, database plaintext, public configuration |
| Activation code / app secret HMAC, password hash | Credential-derived value | The matching database field and server-side comparison | API responses, admin console display, logs |
| `device_hash` | Stable derived device identifier | Database, structured audit fields, internal admin API decisions | Client API, admin console visible text, log `message` |
| Bearer JWT | Session credential | Authorization header, frontend token helper | URLs, logs, commit-able files |
| Activation code suffix | Low-sensitivity recognition information | Admin lists, log correlation, and search | Must never be treated as an authentication credential |

## Sensitive Data

- Activation codes are stored as HMACs.
- Application secrets are stored as HMACs.
- Rotating an app secret stores only the new secret's HMAC; the new secret is returned exactly once in the response and the old secret stops working immediately.
- Device fingerprints are stored as HMACs.
- Administrator passwords must use a random salt and hash and must never be stored in plaintext.
- The JWT secret, HMAC secrets, and production administrator passwords must be managed through Wrangler secrets.
- `ADMIN_BOOTSTRAP_PASSWORD` doubles as the administrator password recovery key when login is impossible. It must be a high-strength random value stored only in a Wrangler secret or equivalent private configuration.
- `.dev.vars`, `wrangler.production.toml`, real secrets, production account passwords, and production database IDs must never be committed; the public `worker/wrangler.toml` keeps only local development placeholders.

## Environment Variable Validation

The Worker validates the following core cryptographic secrets at runtime:

- `JWT_SECRET`
- `CODE_HMAC_SECRET`
- `APP_SECRET_HMAC_SECRET`
- `DEVICE_HMAC_SECRET`

These secrets must be present and must not use the example placeholder values.

The signed-license surface adds signing-key variables:

- `LICENSE_SIGNING_PRIVATE_KEY` — required. Base64url of the 48-byte PKCS8 Ed25519 private key. Validated for presence, not equal to the placeholder `replace-with-a-signing-key`, and that it decodes to the expected byte length; any failure is `500 CONFLICT`.
- `LICENSE_SIGNING_KEY_ID` — required. The `key_id` stamped into every signed payload. Presence- and placeholder-checked.
- `LICENSE_SIGNING_PUBLIC_KEY` — required binding, base64url of the 32-byte raw public key. Not a secret, so it is not placeholder-checked.
- `LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY` / `LICENSE_SIGNING_PREVIOUS_KEY_ID` — optional, validated only when present (both-or-neither) to support key rotation.

Validation runs per-request inside the `/api/*` and `/api/v1/*` middleware, not at startup; a missing or malformed signing key therefore fails the first request that needs it with `500 CONFLICT`. No `source_ip` is validated or persisted anywhere in the signed-license surface. The private key is never written to a committed file; see [DEPLOYMENT.md](DEPLOYMENT.md) for generation and rotation.

Bootstrap initialization and password recovery use:

- `ADMIN_BOOTSTRAP_USERNAME`
- `ADMIN_BOOTSTRAP_PASSWORD`

Both must be configured as a pair. If bootstrap initialization or password recovery is enabled in production, `ADMIN_BOOTSTRAP_PASSWORD` must be managed as a Wrangler secret and set to a high-strength random value.

In production:

```bash
cd worker
pnpm wrangler secret put JWT_SECRET --config wrangler.production.toml --env production
pnpm wrangler secret put CODE_HMAC_SECRET --config wrangler.production.toml --env production
pnpm wrangler secret put APP_SECRET_HMAC_SECRET --config wrangler.production.toml --env production
pnpm wrangler secret put DEVICE_HMAC_SECRET --config wrangler.production.toml --env production
pnpm wrangler secret put ADMIN_BOOTSTRAP_PASSWORD --config wrangler.production.toml --env production
pnpm wrangler secret put LICENSE_SIGNING_PRIVATE_KEY --config wrangler.production.toml --env production
pnpm wrangler secret put LICENSE_SIGNING_KEY_ID --config wrangler.production.toml --env production
```

`LICENSE_SIGNING_PUBLIC_KEY` (and any previous-key variables) are not secret and may live in `[env.production.vars]`. Only the private key must be a Wrangler secret.

## Endpoint Security

- Every `/api/admin/*` endpoint must be protected by Bearer Token authentication.
- An administrator whose `must_change_password` flag is set is refused with `403 PASSWORD_CHANGE_REQUIRED` on every `/api/admin/*` route except `/api/admin/password`, `/api/admin/me`, and `/api/admin/logout`. Those three remain under Bearer Token authentication; the exemption only widens the business gate so the forced change can be satisfied, it is not an authentication bypass.
- Administrator login looks up the account by its globally unique username; a wrong username or password returns the same response to prevent account enumeration.
- An account with `user_role` `admin` must pass a second factor: a single global master password supplied alongside its own credentials. The master value is stored only as a hash and salt in the `settings` table, seeded once from the optional `ADMIN_MASTER_PASSWORD` variable and changeable through `PATCH /api/admin/settings/master-password` (admin only). A wrong or missing master value returns the same `UNAUTHORIZED` as any other login failure, and with no master configured and no seed available the admin login fails closed. A `staff` login does not involve the master factor. The master password is never stored or logged in plaintext.
- The management role lives in `admin_users.user_role` (`admin` or `staff`). User-management endpoints allow only an `admin`; a `staff` account is denied server-side, not merely hidden in the UI.
- Admin SQL for apps, activation codes, logs, and the dashboard operates on a single global dataset; there is no per-account data partition.
- `/api/recovery/admin-password` is not part of `/api/admin/*` and exists only for administrator password recovery after a failed login; the request body must validate the bootstrap username and `ADMIN_BOOTSTRAP_PASSWORD`, and the recovery password must never be passed through the URL.
- Client endpoints must validate `app_id` and `app_secret` together.
- A disabled app must not be activated, verified, or unbound.
- All user input must pass basic type and range validation.
- SQL must use prepared statements and `.bind(...)` and must never concatenate user input.
- Error information returned to the frontend and clients should be stable and concise and must not expose internal exceptions, SQL, or secret information.
- Sensitive credentials travel only in a JSON request body or the Authorization header, never in paths or query parameters.
- App secret comparison, recovery password comparison, and hash comparison should use constant-time comparison functions instead of comparing sensitive derived values with plain string equality.
- Client error decisions use stable error codes; error messages must not reveal enumerable information such as whether a code belongs to another app.

## Logging Security

- Operation logs may record the device hash but must not record a plaintext device fingerprint.
- An administrator manual unbind only clears the device hash and neither needs nor may request a plaintext device fingerprint.
- Never log a full plaintext activation code.
- Failure logs should include the stable error code to make diagnosis and statistics easier.
- The signed-license `security_events` table stores only an `installation_hash` (HMAC), never a raw installation id, and the admin API exposes it only as a `has_installation` boolean.

## Signed-License Threat Model

The signed-license surface (`/api/v1/license/*` plus the admin code powers) protects an offline client response with a detached Ed25519 signature over a fixed 12-field canonical payload. The byte canonical form, verification steps, and freshness predicate are documented in [CLIENT_INTEGRATION.md](CLIENT_INTEGRATION.md); the server-side payload and endpoints are in [API.md](API.md#signed-license-client-endpoints-apiv1).

| Threat | Impact | Mitigation | Residual risk |
| --- | --- | --- | --- |
| License key sharing across machines | One paid license runs on many machines | Per-license activation limit (`max_activations`) with atomic slot claim; `activation_allowed` is `false` once the limit is reached and no slot is consumed | A legitimate re-install consumes a slot until released; operators tune the limit |
| Response modification (tamper) | Client is told a worse/better status than the server issued | The whole payload is signed; the client re-canonicalizes and verifies, rejecting any altered field with `SIGNATURE_INVALID`/`PAYLOAD_TAMPERED` | None beyond breaking Ed25519 |
| Replay of an old valid response | Expired/revoked license keeps working from a cached response | Client freshness predicate: reject `server_time` older than the last accepted one, and reject responses older than `verification_interval + 300s` skew | A response may be reused only within the freshness window while offline |
| Man-in-the-middle | Response swapped in transit | Transport is HTTPS and the payload signature is verified independently of TLS; an unknown `key_id` is rejected | None beyond breaking Ed25519/TLS |
| Private-key theft | Attacker forges valid licenses | Private key lives only in a Wrangler secret, never committed or logged, and only the HMAC/suffix forms of other secrets are stored; rotation via `key_id` + previous-key map retires a compromised key | A theft is unmitigated until the key is rotated and the old `key_id` removed from clients |
| Local cache modification | User edits the stored license/anchor to extend access | Signature + freshness anchor are checked on every verify; a tampered cache fails verification; the real authority is the server response | An offline client can only extend access within the freshness window |
| Clock manipulation (rollback) | Setting the clock back to defeat expiry/freshness | Freshness predicate rejects a `server_time` earlier than the last accepted one (`CLOCK_ROLLBACK`); the server stamps `server_time` itself | A forward clock jump is bounded by the skew allowance |
| Activation abuse (many installs) | Exhaust or bypass the activation limit | Atomic single-statement slot claim never over-admits under concurrency; an existing installation re-verify never blocks | Operators set the limit appropriately for their product |
| API abuse (report flooding / repeated failures) | Spurious reports try to force a hold, or noise hides real abuse | Auto-hold is **corroborated**: a report holds only when at least `reportHoldDistinctThreshold` (default `2`) distinct installations file a high-severity report within the window; single-report-immediate-hold ships **OFF** (`singleHighSeverityReportHolds: false`) and repeated-failure auto-hold ships **OFF** | A coordinated set of distinct installations could trigger a hold; an admin can approve to release |

The auto-hold defaults are centralized in `worker/src/license/config.ts` (`reportHoldDistinctThreshold: 2`, `reportHoldWindowSeconds: 86400`, `singleHighSeverityReportHolds: false`, `repeatedFailureHolds: false`). High-severity report reason codes are `SIGNATURE_INVALID`, `PAYLOAD_TAMPERED`, and `CLOCK_ROLLBACK`.

## Frontend Security

- Admin console token storage and clearing go through `admin/src/api.ts` only.
- On a 401 or an expired session the frontend must clear the token and return to the login page.
- The frontend must not display app secret hashes, device hashes, device fingerprints, or other sensitive derived values or plaintext; a device is shown only as bound or not bound.
- The Playground and SDK/documentation samples must never persist, pre-fill, or echo a real `app_secret`.
- After a one-time secret or activation code modal is closed, it must not remain in page state, the URL, localStorage, or debug logs.

## Security Change Checklist

When authentication, secrets, logging, client requests, or new database fields are involved, answer at least:

- Does the new data count as a secret, a personal identifier, or a value usable for authentication?
- Can it be stored as only an HMAC, hash, suffix, or boolean state?
- On request failure, do the logs and error response leak existence or credential details?
- Is the new endpoint in the correct authentication scope, and can it bypass the `/api/admin/*` middleware?
- Is every SQL parameter bound, and do dynamic fragments come from a fixed allowlist?
- Does the frontend write tokens, secrets, or activation codes into the URL, persistent storage, or the console?
- Do the example environment, production secret checks, and deployment documentation need synchronizing?
- Do the tests prove that sensitive fields never appear in database reads, API responses, or logs?

## Production Requirements

- Production must not use a weak default bootstrap password.
- Production variables should be configured in the `[env.production.vars]` section of the private `worker/wrangler.production.toml`.
- The password should be changed immediately after the first administrator is created.
- If bootstrap administrator initialization is no longer needed, the related configuration should be removed or replaced.
