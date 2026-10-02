# Requirements — Signed License Verification (Ed25519) + Standalone License Checker

Status: DRAFT for design review. This document is requirements only; it does not design the implementation or contain code.

## Summary

Add an asymmetric (Ed25519) signing layer to the license server so a client can cryptographically verify that a verification response genuinely came from the server and was not tampered with in transit or in a local cache. A new versioned client endpoint `POST /api/v1/license/verify` returns a canonical JSON payload plus a detached Ed25519 signature over that payload. The server holds the private key (from an environment secret) and never exposes it; clients hold only the public key and can verify but never forge.

The feature also adds: an administrative HOLD state and a failure/security-event reporting endpoint (`POST /api/v1/license/report`); auto-hold on suspicious signals; per-license activation limits; signing-key rotation via a `key_id` stamped into every payload; centralized licensing config; and expanded admin powers (revoke, soft delete, hold, approve/release, extend/reduce validity, change activation limit, view activations/installations, view verification history and security events). Finally, it adds a separate standalone license-checker application (new folder at repo root) whose sole purpose is to exercise every server feature end-to-end, including signature verification and tamper rejection.

This builds on the existing verified architecture: strict `routes.ts -> service.ts -> repository.ts` layering with SQL only in `repository.ts` using `.bind()`; enums/error codes in `constants.ts`; unified success/failure envelopes in `http.ts`; admin Bearer auth in `middleware.ts`; expiry math in `time.ts`; env validation in `config.ts`. The domain is `tenants -> applications (app_id/app_secret) -> generation batches -> activation codes (the license keys, stored as HMAC + suffix) -> license_sessions`. The feature reuses the existing `applications` concept as `product_id` and reuses/extends the existing device-binding model as `installation_id` (stored only as an HMAC via `DEVICE_HMAC_SECRET`). The current latest migration is `0006_*`; the next migration must be `0007_*.sql`. Baseline is GREEN (218 tests: 199 worker + 19 admin; both type-checks exit 0) and must remain GREEN.

The real desktop app is explicitly out of scope for now; this work produces the server side plus the standalone checker, and a documented client-integration contract the desktop app will later consume.

## Assumptions (resolved ambiguities; flagged for design review)

- A-1: `product_id` in the request maps to the existing public `app_id` string (from `apps.app_id`). No parallel `products` table is created. (Instruction is explicit; confirming the field name mapping.)
- A-2: The signed endpoint still authenticates the calling app the same way existing `/api/client/*` endpoints do — the request must carry `app_secret` alongside `product_id` so the server validates the app exists, is enabled, and the secret matches before evaluating the license. `product_id` alone is not sufficient authentication. (Security invariant: client APIs validate `app_id` + `app_secret`. See Open Question OQ-1 if the desktop/checker contract must avoid shipping `app_secret`.)
- A-3: `installation_id` is a client-generated stable string that plays the role the existing `device_fingerprint` plays: it is HMAC'd with `DEVICE_HMAC_SECRET` into `device_hash` and stored/compared only as that HMAC. Its raw value is never persisted, logged, or echoed.
- A-4: The signed statuses `active`, `expired`, `revoked`, `suspended`, and the new `hold` are the vocabulary of the SIGNED PAYLOAD. They are derived/mapped from the existing persisted model (`status` in {`unused`,`active`,`deleted`} + `disabled_at` + `expires_at` + the new hold marker), not a rename of the persisted `activation_codes.status` enum. Existing persisted statuses and their four-dimension model keep working unchanged.
- A-5: `revoked` maps onto the existing soft-delete (`status = deleted`) OR administrative disable, and `suspended` maps onto administrative disable (`disabled_at`). The design review decides the exact mapping; requirements only require that each signed status is producible and testable. (See OQ-2.)
- A-6: `plan` in the payload is the existing plan code (`weekly`/`monthly`/`quarterly`/`yearly` or future plans).
- A-7: `grace_period_seconds` reuses `plans.grace_period_seconds`.
- A-8: HOLD is a new administrative state stored on the activation code (a new nullable column added by migration `0007`), independent of `disabled_at`/`deleted` so that "held" is distinguishable in the payload and releasable back to the prior state by an admin. (See OQ-3 for whether hold reuses `disabled_at` instead.)
- A-9: `max_activations` is a new per-license integer (nullable = unlimited, or defaulted) added by migration `0007`. An `installation_id` occupies one activation slot; the existing device-binding/rebind model is extended, not replaced. (See OQ-4 on single-device vs multi-slot semantics.)
- A-10: Security events and verification history are stored using the existing `activation_logs` table with new stable `action`/`error_code` values where possible, rather than a new table, unless the design review finds the existing schema insufficient. (See OQ-5.)
- A-11: The canonical JSON form is deterministic key ordering (lexicographic by key), UTF-8, no insignificant whitespace, with a documented, fixed representation for each field type (booleans, integers, ISO-8601 UTC strings). The exact canonical spec is authored in the design and mirrored in the client-integration doc so the checker reproduces byte-for-byte.
- A-12: The standalone checker is a Vite + React app mirroring `admin/src` conventions, added as a new workspace package. This is the default choice; the design records the final choice + reason in `decisions.md`. (See OQ-6.)
- A-13: `protocol_version` is a server-owned integer (starting at 1) describing the payload contract version; the server rejects unknown/unsupported client `protocol_version` values with a stable error and, where possible, a signed refusal.
- A-14: IP addresses may be recorded for audit/rate-limit/abuse logging only and are never used as identity. This preserves the existing "no IP as identity" project stance; recording IP at all is a new behavior gated by the design/security review. (See OQ-7.)

## Functional Requirements

### FR-1 Signed verification endpoint
A new versioned endpoint `POST /api/v1/license/verify` accepts `{ license_key, product_id, installation_id, application_version, protocol_version }` (plus app authentication per A-2) and returns `{ payload, signature }` where `payload` is canonical JSON and `signature` is base64 Ed25519 over the canonical payload bytes.

### FR-2 Signed payload contents
The `payload` contains all security-relevant fields with deterministic key order: `activation_allowed`, `protocol_version`, `license_id`, `product_id`, `status`, `plan`, `issued_at`, `expires_at`, `server_time`, `installation_id`, `grace_period_seconds`, `key_id` (twelve fields). `server_time` is the authoritative server clock so a client can detect local clock rollback. `activation_allowed` is a signed boolean carrying the activation-limit decision (FR-11); it is a distinct field so the limit refusal does not collide with the lifecycle `status` value.

### FR-3 Signing keys and secrets
The server loads the Ed25519 private key and its key id from environment (`LICENSE_SIGNING_PRIVATE_KEY`, `LICENSE_SIGNING_KEY_ID`); these are added to the `Bindings` type and validated by `config.ts`. The public key is documented/exported for clients. Dev keys are generated into `worker/.dev.vars` (never committed) with a documented generation procedure. No real private key is ever committed.

### FR-4 Crypto primitive choice
Ed25519 signing uses WebCrypto if the Workers runtime supports it, otherwise an established pure-JS library (e.g. `@noble/ed25519`). No custom cryptography is written. The final choice and reason are recorded in `decisions.md`; any new dependency is justified there.

### FR-5 Status and lifecycle in payload
The signed payload can carry `active`, `expired`, `revoked`, `suspended`, and `hold`. These are derived from the existing persisted model plus the new hold marker (A-4, A-5, A-8). Existing persisted statuses and client endpoints continue to work unchanged.

### FR-6 HOLD state
A new administrative HOLD state blocks authorization until an admin resolves it. A held license's `/api/v1/license/verify` returns a signed payload whose `status` reflects the hold so the client stops authorizing; it is never silently reported as `active`.

### FR-7 Failure/security-event reporting endpoint
A new endpoint `POST /api/v1/license/report` accepts `{ installation_id, license_key or license_id, reason/code }` where reason/code is one of a fixed allowlist including `SIGNATURE_INVALID`, `PAYLOAD_TAMPERED`, `CLOCK_ROLLBACK`. It records a tenant-scoped security event.

### FR-8 Auto-hold on suspicious signals
On a client report (FR-7) and on server-side suspicious signals (wrong product, repeated invalid attempts, unknown installation, replay-looking requests), the server records a security event and MAY place the license into HOLD. The exact thresholds are a design decision; the requirement is that the capability exists and each trigger records a security event.

### FR-9 Security-event and failure logging
The server logs WHY a verification failed or a license was held, tenant-scoped, using stable action/error codes. No plaintext secret, full license key, private key, or raw installation fingerprint is ever stored or logged (only HMACs/suffixes as today).

### FR-10 Admin powers
Admin APIs and console UI support, per license/key, tenant-scoped, Bearer-protected: Revoke; Delete (soft); Hold; Approve (release hold back to the prior active state); Extend validity (increase `expires_at`); Reduce validity (decrease `expires_at`); Change activation/max-activations limit; View activations/installations; View verification history / security events. These reuse existing admin patterns (`routes.ts -> service.ts -> repository.ts`, `admin/src/api.ts`, i18n copy in `admin/src/i18n/`) and appear on the existing Codes page or a license-detail view.

### FR-11 Activation limit
Each license supports `max_activations` (A-9). An `installation_id` counts as one activation slot; reuse/extend the existing device-binding + rebind model. Reaching the limit returns a signed refusal payload / appropriate signed status. IP is never used as activation identity.

### FR-12 Key rotation
Every signed payload includes `key_id`. The server signs with a configured current private key and stamps its `key_id`. The client-integration doc documents current + previous public key handling so a client can verify a payload signed by a previous key during rotation.

### FR-13 Centralized licensing config and API versioning
Licensing config (signing key, `key_id`, `protocol_version`, default grace, a verification-interval hint returned to the client) is centralized server-side. The API is versioned under `/api/v1/`. The client contract is documented: the server base URL is client-configurable (base + `/api/v1/license/verify`) and is NOT hardcoded in the client.

### FR-14 Standalone license-checker app
A new self-contained folder (e.g. `license-checker/`) at repo root, added to the pnpm workspace (`pnpm-workspace.yaml` updated), provides:
- Add License form with configurable SERVER URL + LICENSE KEY (and `product_id`/`installation_id` as needed).
- A list supporting MULTIPLE licenses.
- Check action: for a selected license, call `/api/v1/license/verify`, verify the Ed25519 signature using the embedded PUBLIC key, validate the signed fields (`product_id`, `installation_id`, `expires_at`, `server_time`, `protocol_version`, `key_id`), and SHOW license details (status, plan, expiry, remaining, last verification, grace, `key_id`).
- A clear failure state ("license failed to load" / specific error) when signature or field validation fails.
- The ability to exercise `/api/v1/license/report` and demonstrate tamper rejection.
The checker holds ONLY the public key, can verify but never forge, and must NOT contain the private key. Its only inputs are server URL + license key (plus product/installation as needed), mirroring the future desktop app.

### FR-15 Migration
All schema additions (hold marker, `max_activations`, any security-event fields) are introduced by a new `0007_*.sql` migration. No published migration (`0001`–`0006`) is edited. The migration applies cleanly against both an empty and an existing database.

## Non-Functional Requirements

### NFR-1 Security invariants (never weakened)
- Never store/log plaintext secrets, license keys, installation fingerprints, or the private key.
- SQL only in `repository.ts` via `.bind()`; no user input concatenated into SQL.
- Every `/api/admin/*` route except login stays Bearer-protected; new admin endpoints included.
- Client/signed endpoints validate `app_id` + `app_secret`.
- No custom cryptography; use an established Ed25519 primitive/library.
- No new dependency without a stated reason.
- The private key never appears in any response, log, admin API, committed file, or the checker app.

### NFR-2 Determinism
Canonicalization is byte-for-byte identical on the sign side (server) and the verify side (checker/client). The canonical form is fully documented.

### NFR-3 Compatibility
Existing `/api/client/*` endpoints, admin endpoints, persisted status model, and all 218 existing tests keep passing. New behavior is additive.

### NFR-4 Tenant scoping
All new admin queries and writes-by-id carry a tenant constraint and re-verify the resource's tenant, matching existing rules.

### NFR-5 Windows-friendly
The checker runs on Windows without heavy setup, consistent with the existing pnpm + Vite toolchain.

## Acceptance Criteria (numbered, testable)

Signing and payload:
1. `POST /api/v1/license/verify` with a valid `license_key` + matching `product_id` + valid `installation_id` returns `{ payload, signature }` with HTTP 200 and `ok: true` envelope semantics consistent with `http.ts`.
2. The returned `payload` contains exactly the twelve fields `activation_allowed, protocol_version, license_id, product_id, status, plan, issued_at, expires_at, server_time, installation_id, grace_period_seconds, key_id`, in deterministic (lexicographically sorted) key order, with UTC ISO-8601 time fields.
3. Verifying `signature` against the canonical bytes of `payload` with the documented PUBLIC key succeeds for a genuine response (valid signature verifies).
4. `server_time` in the payload equals the server's authoritative time at response, allowing a client to detect a local clock earlier than `server_time` (clock rollback).
5. The private key never appears in any response body, log line, admin API response, or committed file (asserted by tests scanning responses/logs).

Status/lifecycle:
6. A valid, active, in-date, correctly-bound license returns `status = active`.
7. A license past `expires_at` returns `status = expired`.
8. A revoked license returns `status = revoked` (mapping per A-5).
9. A suspended (admin-disabled) license returns `status = suspended`.
10. A held license returns `status = hold` (or the agreed suspended/hold value) and is never returned as `active`.
11. A request with a `product_id` that does not match the license's app is rejected / returns the agreed signed refusal, and is recorded as a security event.

Activation limit:
12. When `max_activations` is reached, a new `installation_id` receives a signed refusal payload / the agreed signed status, and no new activation slot is consumed.
13. IP address is never used to decide activation identity; changing the source IP for the same `installation_id` does not change the activation decision.

Signature verification and tamper tests (critical — the verifier must REJECT each):
14. A VALID signature verifies successfully.
15. An INVALID/garbage signature is rejected.
16. Taking a valid signed response and modifying `expires_at` without re-signing: the verifier REJECTS it.
17. Modifying `status` without re-signing: REJECTED.
18. Modifying `license_id` without re-signing: REJECTED.
19. Modifying `installation_id` without re-signing: REJECTED.
20. Modifying `plan` without re-signing: REJECTED.
21. Modifying `server_time` without re-signing: REJECTED.
22. Modifying `protocol_version` without re-signing: REJECTED.
23. Modifying `key_id` without re-signing: REJECTED.
24. A malformed response body (not the expected shape) is rejected with a clear failure state.
25. A response with a missing `signature` is rejected.
26. A payload stamped with an unknown/unconfigured `key_id` is rejected by the client.
27. A request/response with an unknown or unsupported `protocol_version` is rejected (server returns the agreed error; client rejects an unexpected value).
28. A replayed prior valid response is detectable/rejectable using `server_time` (and any documented freshness rule) — the client does not accept a stale response as current.

Reporting, auto-hold, security events:
29. `POST /api/v1/license/report` with a valid reason code (`SIGNATURE_INVALID`, `PAYLOAD_TAMPERED`, `CLOCK_ROLLBACK`, etc.) records a tenant-scoped security event.
30. A qualifying report and/or server-detected suspicious signal can transition the license into HOLD, after which `/verify` reflects the hold (AC-10).
31. Every verification failure and every hold records WHY, using stable action/error codes, with no plaintext secret/key/fingerprint in the record.

Admin powers:
32. Revoke, soft Delete, Hold, Approve (release hold), Extend validity, Reduce validity, Change max-activations, View activations/installations, and View verification history / security events each work via a Bearer-protected, tenant-scoped admin endpoint.
33. Approve releases a held license back to its prior active state, and a subsequent `/verify` returns the restored status.
34. Extend increases `expires_at` and Reduce decreases it; a subsequent `/verify` reflects the new `expires_at`.
35. A cross-tenant admin cannot read or modify another tenant's license/security events (tenant-scope negative test).

Key rotation:
36. The server signs with the configured current private key and stamps the matching `key_id`.
37. The client-integration doc documents current + previous public-key handling, and a payload signed by a documented previous key verifies client-side during rotation.

Config/versioning:
38. Licensing config (signing key, `key_id`, `protocol_version`, default grace, verification-interval hint) is centralized server-side, and the verification-interval hint is returned to the client.
39. The endpoint is reachable under `/api/v1/license/verify`, and the server base URL is client-configurable (not hardcoded).
40. `config.ts` rejects startup when `LICENSE_SIGNING_PRIVATE_KEY` or `LICENSE_SIGNING_KEY_ID` is missing or uses a placeholder value.

Standalone checker:
41. The checker is a self-contained folder at repo root, in the pnpm workspace, with its own `package.json`, and builds/runs on Windows.
42. The checker Add License form accepts server URL + license key (and product/installation as needed) and supports MULTIPLE licenses in a list.
43. Checking a selected license calls `/api/v1/license/verify`, verifies the Ed25519 signature with the embedded public key, validates the signed fields, and shows license details (status, plan, expiry, remaining, last verification, grace, `key_id`).
44. On signature or field-validation failure the checker shows a clear failure state (e.g. "license failed to load" + specific error).
45. The checker can call `/api/v1/license/report` and can demonstrate tamper rejection (modify a signed field and show the verifier rejecting it).
46. The checker contains only the public key; a repository/content scan confirms no private key is present.

Migration and baseline:
47. A new `migrations/0007_*.sql` introduces all schema additions; migrations `0001`–`0006` are unchanged.
48. `0007` applies cleanly against both an empty and an existing database (`pnpm db:migrate:local`).
49. After the feature, `pnpm --filter @license-manager/worker type-check`, `pnpm --filter @license-manager/admin type-check`, and the full test suites all pass; the prior 218 tests still pass.

Documentation:
50. `docs/API.md` documents the two new endpoints, request/response fields, the versioned prefix, error codes, and the canonical payload.
51. `docs/SECURITY.md` adds a threat-model table with rows Threat/Impact/Mitigation/Residual-Risk for: key sharing, response modification, replay, MITM, private-key theft, local-cache modification, clock manipulation, activation abuse, API abuse.
52. `docs/DATABASE.md` documents the `0007` schema additions and their invariants.
53. `docs/DEPLOYMENT.md` documents signing-key generation, secret configuration (Wrangler secrets), key rotation, and the checker build.
54. A CLIENT INTEGRATION doc documents the full client contract: configurable server URL, the request/response shape, the exact canonical form, signature verification steps, public-key distribution, current + previous key handling, `protocol_version` handling, and clock-rollback detection.

## Out of Scope

- The real desktop/Electron/Tauri application (a documented client-integration contract is produced instead).
- Payments, orders, invoices, or financial settlement.
- Recovery of plaintext license keys or secrets.
- Non-Cloudflare/multi-database deployment support.
- Fine-grained in-tenant roles/permissions.
- Rate-limiting/brute-force infrastructure beyond recording the security events and the auto-hold behavior specified here (any dedicated rate-limit engine is a separate future decision).
- Changing the meaning of existing plans or existing persisted `activation_codes.status` values.

## Open Questions / Ambiguities

Resolved (assumptions above): mapping of `product_id` to `app_id` (A-1); app authentication still required (A-2); `installation_id` reuses device HMAC model (A-3); signed-status vocabulary is derived, not a rename (A-4); `grace_period_seconds` reuse (A-7); Vite+React checker default (A-12); IP for audit only (A-14).

Still needing a decision from the user or design review:
- OQ-1: Should the signed endpoint require `app_secret` in the request (consistent with existing client APIs, A-2), given the checker and future desktop app would then need to hold the app secret? If the desktop threat model forbids shipping `app_secret`, an alternative client-auth mechanism for `/api/v1/license/*` must be chosen. This is a security-invariant-adjacent product decision (ASK-FIRST).
- OQ-2 / OQ-5: Exact mapping of `revoked` vs `suspended` onto the existing persisted model, and whether security events/verification history reuse `activation_logs` or need a new table.
- OQ-3: Whether HOLD is a new dedicated column or reuses `disabled_at` with a distinguishing marker.
- OQ-4: Activation-limit semantics — does `max_activations > 1` relax the current strict one-device binding, and how does it interact with the existing 3-rebind self-service transfer quota?
- OQ-6: Final checker tech (Vite+React vs minimal Node/TS CLI + tiny web UI) — to be recorded with reason in `decisions.md`.
- OQ-7: Whether recording client IP at all (even for audit only) is acceptable given the project's explicit "no IP tracking by design" stance in `soul.md`; needs user confirmation before any IP is persisted.
- OQ-8: Freshness/replay rule specifics — is `server_time` plus a client-side max-age sufficient, or is a server-issued nonce required? (Affects AC-28.)
