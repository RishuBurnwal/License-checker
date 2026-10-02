# Technical Design — Signed License Verification (Ed25519) + Standalone License Checker

Status: DESIGN for review (revision pass 3). Implements `docs/requirements-signed-license.md`. Design only; contains no implementation code. Every acceptance criterion (AC-1..AC-54) is traced in §13.

Governing constraints obeyed: `memory/RULES.md` (evidence gate, scope, stop-and-doubt, no new pattern/dep without reason), `AGENTS.md` (route → service → repository layering; SQL only in `repository.ts`; enums in `constants.ts`; i18n in `admin/src/i18n/`), `docs/SECURITY.md` (no plaintext secrets/keys/fingerprints; Bearer on admin; app_id+app_secret on client; bound SQL), `docs/DATABASE.md` (next migration `0007`, never edit published), `docs/BUSINESS_RULES.md` (persisted status model unchanged).

## 0. Revision log — how pass 3 resolves the design review

This pass (3) resolves every HIGH and MEDIUM finding in `docs/design-review.md` / `docs/design-review.json` (the pass-2 review). The two biggest structural changes:

- **Finding 1 (HIGH, activation-limit atomicity):** the limit is now enforced by a **single atomic conditional `INSERT ... SELECT ... WHERE (count) < max ON CONFLICT DO UPDATE`** that D1 executes atomically per request and `node:sqlite` executes identically; `activation_allowed` is decided from `meta.changes` + a follow-up read. The false claim that the D1 path wraps count-then-insert in a `transaction()` is removed everywhere (§5.4, §2.3). The design no longer calls `createOrReuseSession` a "compare-and-insert/CAS" — it is correctly described as the existing non-atomic sequence, and the new slot path does **not** copy it.
- **Finding 3 (MEDIUM, scope vs requirements):** the user-management, session-kickout, forced-password, dual-deployment, and finalize-docs work (old §15–§19) is **fenced into a clearly-separated Phase 2** (now §15, "separately-approved later scope"). Only the signed-license core — the scope the authoritative `docs/requirements-signed-license.md` actually specifies (FR-1..FR-15, AC-1..AC-54) — is cleared to build in Phase 1. §13 traces **only** AC-1..AC-54, with no "pending requirements sync" rows. Phase 2 does not block Phase 1 and is not required for any Phase-1 AC.

Decisions are recorded in `memory/decisions.md` as SL-13..SL-26.

| Finding | Severity | Resolution | Where |
| --- | --- | --- | --- |
| 1 — activation-limit check not atomic; §5.4 contradicts §19 | HIGH | **Atomic conditional INSERT (SL-24):** one statement enforces the limit; `activation_allowed` derived from `meta.changes`/row state; portable to `node:sqlite`. The §5.4 `transaction()` claim is deleted; `createOrReuseSession` is described accurately (non-atomic, NOT copied). | §2.3, §5.4 |
| 2 — "fails fast at startup" impossible on Workers | MEDIUM | **Reworded (SL-25):** signing-env validation runs in the existing per-request `validateEnv` middleware (first `/api/*` request), not at startup; signing keys + the Ed25519 length check are added to the `validateEnv` loop. The exact placeholder check is an equality test (not a prefix). | §1, §4.3, §9 |
| 3 — scope beyond the authoritative requirements | MEDIUM | **Scope fenced (SL-26):** user-management / session-kickout / forced-password / dual-deploy / finalize-docs are a separately-approved **Phase 2** (§15), explicitly NOT cleared to build now and NOT required by any Phase-1 AC. §13 traces only AC-1..AC-54 with zero pending-sync rows. | §0.1, §13, §15 |
| 4 — `activation_allowed` not in AC-2 "exactly" set | MEDIUM | **Requirements edit APPLIED** this pass: FR-2 and AC-2 in `docs/requirements-signed-license.md` now list the twelve fields including `activation_allowed`. Design and authoritative AC agree. | §0.1, §3.2, §4.1 |
| 5 — canonicalization number formatting not fully pinned | MEDIUM | **Integer range + fail-closed pinned (§4.1):** integer fields are JS safe integers (< 2^53); the builder rejects anything else with a server 500 **before** signing (never emits a non-conforming payload); the determinism fixture includes a large-but-safe `license_id` and a `null` `expires_at`. | §4.1, §10 |
| 6 — WebCrypto Ed25519 availability asserted | NIT | Smoke test folded into the §10.1 e2e; `@noble/ed25519` fallback isolated to `signing.ts`, recorded in `decisions.md` if used. | §4.2, §10.1 |
| 7 — single-report auto-hold is a self-DoS vector | NIT | **Default changed (SL-24):** auto-hold now requires corroboration — N≥2 high-severity reports from **distinct** `installation_hash` within a window, OR a report matching a server-detected anomaly; single-report-immediate-hold is config-gated **off** by default. Documented in §6.3 + the SECURITY.md threat-model row. | §6.3, §11 |
| 8 — `source_ip` column ships unconditionally | NIT | **Column held out of `0007` (SL-24):** `security_events` has no `source_ip` column until OQ-7 is confirmed; it is added by a later migration when approved. No code path can populate what does not exist. ASK-FIRST status noted in `docs/DATABASE.md`. | §2.1, §14 |

Prior-pass resolutions (SL-13..SL-23) that remain in force: migration numbering `0007`=signed-license (AC-47 verbatim); derived signed status; dedicated `hold_at`; `max_activations` + `code_activations`; dedicated `security_events`; `app_secret` on the signed endpoint; `server_time`+max-age freshness; Vite+React checker; exported base64url helpers; pinned freshness predicate; unsigned-404 product mismatch; checker WebCrypto feature-detect; `installation_id` ≤ 200 chars.

### 0.1 Requirements alignment (findings 3 + 4)

- **Finding 4 — APPLIED this pass.** `docs/requirements-signed-license.md` FR-2 and AC-2 now enumerate the twelve canonical fields including `activation_allowed`, matching §3.2/§4.1. The exact-key-set conformance test in §10 now checks against an AC that lists all twelve. No unapplied dependency remains.
- **Finding 3 — Scope fenced, not deferred to another party.** The authoritative requirements doc specifies the signed-license core (FR-1..FR-15, AC-1..AC-54). That is **Phase 1** and is the only scope cleared to build now; §13 traces every Phase-1 AC with no pending-sync rows. The user-management, JWT session-kickout, forced-password-bootstrap, dual-deployment, and finalize-docs work (confirmed by the user in `memory/decisions.md` UM-1..UM-7 / NEW-1..NEW-5, carried forward from prior passes) is a **separately-approved Phase 2**, specified at a design level in §15 but explicitly **not** required by any Phase-1 acceptance criterion and **not** cleared to implement until it has its own first-class FRs/ACs in the requirements doc. This removes the previous dependency on an un-reconciled scope: Phase 1 is self-consistent and fully traceable on its own, and nothing in Phase 1 depends on a Phase-2 schema change (per SL-24 the `0007` migration adds only signed-license schema).

---

## 1. Overview

The server gains an asymmetric integrity layer on top of the existing licensing engine. A new versioned client endpoint `POST /api/v1/license/verify` evaluates a license exactly the way the existing `/api/client/verify` does, then returns a **canonical JSON payload** plus a **detached Ed25519 signature** over the canonical bytes of that payload. The server holds the private key in an environment secret and never exposes it; clients (the standalone checker now, the desktop app later) hold only the public key and can verify but never forge. A companion endpoint `POST /api/v1/license/report` lets a client report a detected tamper/replay/clock event, which is recorded as a tenant-scoped security event and may auto-place the license into a new HOLD state.

The persisted domain model is unchanged in meaning. **Phase-1 (signed-license core, the scope of this requirements doc) adds a single forward migration, `0007_add_signed_license.sql`**, which introduces the HOLD marker, per-license activation limit, activation-slot table, and a dedicated `security_events` table — all additive. The signed statuses (`active/expired/revoked/suspended/hold`) are **derived at response time** from the existing four-dimension model plus the new HOLD marker — not a rename of `activation_codes.status`.

Signing-key configuration is validated by the **existing per-request `validateEnv` middleware** (the first `/api/*` request fails with `500 CONFLICT` if a signing secret is missing/placeholder/malformed); the Workers runtime has no module-load startup hook, so there is no "startup rejection" — the mechanism is the same per-request guard that already validates the core HMAC/JWT secrets (§4.3, finding 2).

A **separately-approved Phase 2** (admin+staff user management, JWT session kick-out, forced-password bootstrap, dual Cloudflare+Node/Vercel deployment, and the finalize documents) is specified at design level in §15 but is **not** part of this requirements doc, **not** required by any Phase-1 acceptance criterion, and **not** cleared to implement until it gains first-class FRs/ACs. Phase 1 stands alone.

The Phase-1 work is delivered across the existing layering (`routes.ts → service.ts → repository.ts`, constants/types/http/config/crypto/middleware/time) plus a new small `worker/src/license/` folder for canonicalization + signing + status + licensing-config helpers, expanded admin powers in `admin/src`, a documented client-integration contract, and a new `license-checker/` workspace package that exercises every server feature end to end.

The technology stack is locked for Phase 1: **Cloudflare Workers + Hono + D1 (SQLite)** runtime (unchanged); **WebCrypto Ed25519** for signing/verification (no new server dependency; `@noble/ed25519` is the isolated, documented fallback only if a runtime gap is proven); **TypeScript** throughout; **Vite + React + Ant Design** for both `admin/` (unchanged) and the new `license-checker/`; **pnpm** workspace; **vitest** for tests. (The Node/Vercel `DbAdapter` + `node:sqlite` runtime is Phase 2, §15.)

---

## 2. Database schema / migration plan

Phase 1 adds **one** new forward migration, `0007_add_signed_license.sql`. Migrations `0001`–`0006` are never touched (DATABASE.md rule; AC-47). D1 is SQLite, so this is additive-only: `ALTER TABLE ... ADD COLUMN` and new `CREATE TABLE IF NOT EXISTS` statements that preserve all existing data. **No published table is rebuilt.** The migration applies cleanly against an empty and a populated database (AC-48).

The Phase-2 user-management schema (`session_epoch` column + `admin_sessions`) is specified in §15 as a later migration (`0008_add_admin_users_and_sessions.sql`) and is **not** created by Phase 1.

### 2.1 Migration `0007_add_signed_license.sql` (signed-license schema — the AC-47 migration)

Purpose: HOLD state, activation limit, activation slots, security events. All additive.

```sql
-- 0007_add_signed_license.sql

-- HOLD state: dedicated, independent of disabled_at and status, releasable.
ALTER TABLE activation_codes ADD COLUMN hold_at TEXT;
ALTER TABLE activation_codes ADD COLUMN hold_reason_code TEXT;

-- Per-license activation limit. NULL = legacy single-device behavior (unchanged).
ALTER TABLE activation_codes ADD COLUMN max_activations INTEGER
  CHECK (max_activations IS NULL OR max_activations >= 1);

-- Activation slots. Populated ONLY when max_activations > 1; the NULL/1 path
-- keeps using activation_codes.device_hash exactly as today.
CREATE TABLE IF NOT EXISTS code_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL REFERENCES activation_codes(id),
  installation_hash TEXT NOT NULL,          -- HMAC(DEVICE_HMAC_SECRET, installation_id)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  activated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (code_id, installation_hash)
);
CREATE INDEX IF NOT EXISTS idx_code_activations_code_status
  ON code_activations(code_id, status);

-- Tenant-scoped security events + verification history for the signed surface.
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER REFERENCES apps(id),        -- tenant is resolved through the app
  code_id INTEGER REFERENCES activation_codes(id),
  event_type TEXT NOT NULL,                  -- allowlist, see §6.1
  reason_code TEXT,                          -- allowlist, see §6.1
  installation_hash TEXT,                    -- HMAC only, never raw
  protocol_version INTEGER,
  key_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_app_created
  ON security_events(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_code_created
  ON security_events(code_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type_created
  ON security_events(event_type, created_at DESC);
```

Notes:
- No CHECK on `event_type`/`reason_code`/`hold_reason_code` at the DB level (matches the `activation_logs` precedent where runtime constants are the constraint source, DATABASE.md); the allowlist is enforced in `constants.ts` + service validation.
- **No `source_ip` column (finding 8, SL-24).** OQ-7 flags that persisting any client IP conflicts with the "no IP tracking by design" stance in `soul.md` and needs user confirmation. Rather than ship a column that code must be trusted never to write, `security_events` has **no IP column at all** in `0007`. If the user later approves audit-only IP capture, it is added by a dedicated later migration (and `docs/DATABASE.md` records this ASK-FIRST status). This guarantees no code path can populate an IP, because the storage does not exist. Recording IP would never make it an identity input even then (A-14).
- AC-47 reads "A new `migrations/0007_*.sql` introduces all schema additions (hold marker, `max_activations`, any security-event fields)." Every field it names is here, so AC-47 passes verbatim.

### 2.2 Type + repository sync (DATABASE.md migration process)

- `worker/src/types.ts`: extend `CodeDetailRow`/code list rows with `hold_at`, `hold_reason_code`, `max_activations`; add `CodeActivationRow`, `SecurityEventRow`; add the new signing bindings to `Bindings` (§4.3).
- `worker/src/repository.ts`: `findCodeByHash` already selects `c.*` so new code columns flow automatically; add new columns to `listCodes`; add new bound methods (§5.4, §6.2, §7.3). SQL stays bound and in the repository only.
- `docs/DATABASE.md`: add the `0007` row to the migrations table, table-level invariants for `code_activations`, `security_events`, and the new `activation_codes` columns (AC-52), plus the ASK-FIRST note that no `source_ip` column exists until OQ-7 is confirmed.

### 2.3 Invariants owned by the DB / repository

- HOLD independence: `hold_at` never mutates `status` or `disabled_at`. Enforced by the service writing only `hold_at`/`hold_reason_code`.
- **Activation-slot limit atomicity (finding 1, SL-24):** `UNIQUE (code_id, installation_hash)` guarantees one slot per installation per license, and the limit itself is enforced by a **single atomic conditional `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ... active) < max_activations ON CONFLICT(code_id, installation_hash) DO UPDATE ...`** statement (§5.4). Because the count predicate and the insert are one statement, D1 (which executes each prepared statement atomically within the request) and `node:sqlite` both enforce the bound without a read-then-write race. The decision (`activation_allowed`) is read from `meta.changes` plus a confirming `SELECT`. This design does **not** reuse the non-atomic `SELECT COUNT → INSERT` sequence that `createOrReuseSession` uses for live-session leases (that method's `UNIQUE` is on `session_token_hash` and bounds duplicate rows, not the active count; it is intentionally left unchanged, NFR-3).
- Tenant scoping: `security_events` has no `tenant_id`; every read joins through `apps.tenant_id` (same pattern as `activation_logs`), so a cross-tenant read is impossible (AC-35, NFR-4).

---

## 3. API contract

Both endpoints live under a new versioned router mounted at `/api/v1` (decision SL-2). `worker/src/index.ts` adds `app.route("/api/v1", createV1Api())` beside the existing `app.route("/api", createApi())`. The new `createV1Api()` reuses the same per-request `validateEnv` middleware (`api.use("*", ...)`) that `createApi()` uses, so a missing/placeholder/malformed signing key fails the first `/api/v1/*` request with `500 CONFLICT` (§4.3, finding 2). The shared success/failure envelope from `http.ts` (`ok`/`fail`) is reused unchanged (AC-1). Error codes come from `constants.ts` (existing + new, §3.4).

### 3.1 `POST /api/v1/license/verify`

Authentication: `app_id` + `app_secret` in the body (decision SL-7 / A-2), validated by the existing `requireValidClientApp` path.

Request body:
```json
{
  "app_id": "app_xxx",
  "app_secret": "sec_xxx",
  "license_key": "LM-XXXXX-XXXXX-XXXXX-XXXXX",
  "product_id": "app_xxx",
  "installation_id": "stable-installation-id",
  "application_version": "1.4.2",
  "protocol_version": 1
}
```

Field validation (route layer, reusing `requireString`/`requireInteger`):
| Field | Required | Type | Rules | On failure |
| --- | --- | --- | --- | --- |
| `app_id` | yes | string | non-empty, trimmed | 400 BAD_REQUEST |
| `app_secret` | yes | string | non-empty | 400; mismatch → 401 INVALID_APP_SECRET |
| `license_key` | yes | string | normalized via `normalizeCode` | 400; unknown → 404 INVALID_CODE |
| `product_id` | yes | string | must equal the license's `app.app_id` | **mismatch → `404 INVALID_CODE` (unsigned) + `PRODUCT_MISMATCH` security event** (§3.1.1, AC-11) |
| `installation_id` | yes | string | non-empty, **≤ 200 chars, printable** (SL-23); HMAC'd, raw never stored | 400 |
| `application_version` | optional | string | ≤ 64 chars | 400 if present and invalid |
| `protocol_version` | yes | integer | must be a server-supported value (currently `1`) | unsupported → `400 PROTOCOL_UNSUPPORTED` (§3.1.2, AC-27) |

The `product_id` row above is corrected per finding 7 (SL-19): a mismatch is an **unsigned** `404`, never a signed refusal, so the server does not sign a payload for a product the caller is not authenticated against (enumeration safety).

Success response (HTTP 200, `ok:true`):
```json
{
  "ok": true,
  "data": {
    "payload": { /* canonical object, see §3.2 and §4 */ },
    "signature": "base64url-ed25519-signature",
    "public_key_id": "ed25519-2026-01",
    "verification_interval_seconds": 3600
  }
}
```
- `payload` is the exact object the server signed; the client re-canonicalizes it (§4) and verifies `signature` against those bytes.
- `signature` is base64url (matching the exported `crypto.ts` `bytesToBase64Url`, SL-16), detached, over the canonical UTF-8 bytes.
- `public_key_id` duplicates `payload.key_id` outside the signed body for convenience; the client trusts only the signed `payload.key_id`.
- `verification_interval_seconds` is a client hint from centralized config (FR-13, AC-38); it is outside the signed payload (advisory only).

#### 3.1.1 Signed refusals

Business "no" outcomes that the client must still cryptographically trust (expired, revoked, suspended, hold, activation-limit-reached) are returned as **HTTP 200 with a signed payload** whose `status`/`activation_allowed` conveys the refusal, so a MITM cannot downgrade a refusal into silence and a tampered cache cannot flip it to `active`. Concretely:
- `expired` → `status:"expired"`, HTTP 200, signed.
- `revoked` (deleted) → `status:"revoked"`, HTTP 200, signed.
- `suspended` (disabled) → `status:"suspended"`, HTTP 200, signed.
- `hold` → `status:"hold"`, HTTP 200, signed (AC-10, never `active`).
- `product_id` mismatch → **NOT signed**. A `404 INVALID_CODE` failure envelope is returned (the license does not belong to that product/app), and a `PRODUCT_MISMATCH` security event is recorded (AC-11). Rationale: signing a payload for a product the caller isn't authenticated against would leak cross-app existence; the unsigned stable error matches existing enumeration-safety rules in SECURITY.md. (This is the single authoritative statement; the §3.1 table agrees — finding 7 resolved.)
- activation limit reached → a signed payload with the true `status` plus the signed boolean `activation_allowed:false` (§3.2). The client treats `activation_allowed:false` as "do not authorize this installation" (AC-12). No new slot is consumed.

Hard input failures (bad JSON, missing required field, bad app secret, unknown license, unsupported protocol) return the **unsigned** `fail(...)` envelope with the appropriate HTTP status, because there is no authenticated license context to sign and the client's failure state (AC-24/25) covers them.

#### 3.1.2 Protocol version handling

`protocol_version` is a server-owned integer starting at `1` (A-13). Supported values live in centralized config (`SUPPORTED_PROTOCOL_VERSIONS = [1]`). An unknown value returns `400 PROTOCOL_UNSUPPORTED` (unsigned). The signed `payload.protocol_version` always reflects the server's response contract version. The client rejects any signed `protocol_version` it does not itself support (AC-22, AC-27).

### 3.2 Signed payload contents (FR-2)

The payload object, in the fixed key order produced by canonicalization (lexicographic, §4). Types are exact:

| Key | Type | Meaning |
| --- | --- | --- |
| `activation_allowed` | boolean | `false` only when the activation limit blocks this installation (§3.1.1) |
| `expires_at` | string / null | UTC ISO-8601 `...sssZ`; null only when not yet activated |
| `grace_period_seconds` | integer | from `plans.grace_period_seconds` (A-7) |
| `installation_id` | string | echoed raw request value (bound into the signature so tampering is detectable, AC-19); not persisted |
| `issued_at` | string | server response time, UTC ISO-8601; identical to `server_time` |
| `key_id` | string | signing key id (§4.3) |
| `license_id` | integer | `activation_codes.id` |
| `plan` | string | plan code (A-6) |
| `product_id` | string | `app.app_id` |
| `protocol_version` | integer | currently `1` |
| `server_time` | string | authoritative server clock, UTC ISO-8601 (AC-4, clock-rollback anchor) |
| `status` | string | one of `active/expired/revoked/suspended/hold` (§5.1) |

`activation_allowed` is a first-class signed field (SL-17). The requirements author must add it to FR-2/AC-2 (§0.1); encoding the limit refusal in `status` was rejected because it would collide with the lifecycle status. `issued_at == server_time` by construction; both are kept because FR-2 names them separately and a future protocol version may diverge them.

The client MUST verify (see the pinned predicate in §8.4): signature validity, `key_id` is a configured key, `product_id` matches its expected product, `installation_id` matches its own, `protocol_version` is supported, and `server_time` freshness (clock-rollback + max-age, AC-28).

### 3.3 `POST /api/v1/license/report` (FR-7)

Authentication: `app_id` + `app_secret` (same as verify).

Request body:
```json
{
  "app_id": "app_xxx",
  "app_secret": "sec_xxx",
  "installation_id": "stable-installation-id",
  "license_key": "LM-...",
  "reason_code": "PAYLOAD_TAMPERED",
  "detail": "optional short client note"
}
```
- Exactly one of `license_key` or `license_id` is required; `license_key` is normalized+HMAC'd to locate the row, `license_id` is validated as an integer belonging to the authenticated app.
- `reason_code` must be in the allowlist (§6.1): `SIGNATURE_INVALID`, `PAYLOAD_TAMPERED`, `CLOCK_ROLLBACK`, `KEY_ID_UNKNOWN`, `PROTOCOL_UNSUPPORTED`, `REPLAY_SUSPECTED`, `MALFORMED_RESPONSE`. Unknown → `400 BAD_REQUEST`.
- `detail` optional, ≤ 256 chars, stored in `message` (never a secret; client-supplied and treated as untrusted display text).

Response (HTTP 200):
```json
{ "ok": true, "data": { "recorded": true, "held": false } }
```
`held` is `true` when the report crossed the auto-hold threshold and the license was placed on HOLD (§6.3). A report for a license not owned by the authenticated app returns `404 INVALID_CODE` and records nothing (enumeration-safe).

### 3.4 New error codes (constants.ts)

Add to `ERROR_CODE` (and the values array + `docs/API.md`):
- `PROTOCOL_UNSUPPORTED` (HTTP 400) — returned by `/api/v1/license/verify` on an unsupported `protocol_version`, and by `/api/v1/license/report` is NOT used (report validates `reason_code` with `BAD_REQUEST`).
- `ACTIVATION_LIMIT_REACHED` (HTTP 409) — named caller (SL-23, resolves NIT 10): the **admin** `PATCH /api/admin/codes/:id/max-activations` endpoint returns it when an admin tries to set `max_activations` below the current count of active slots. The signed verify path never uses it (it uses `activation_allowed:false`).
- `LICENSE_HOLD` — **dropped** (SL-23): the signed path uses `status:"hold"` and no unsigned caller needs it. Not added, to avoid a dead code (resolves NIT 10).

Adding codes follows the API.md contract-change rule (sync `constants.ts`, frontend constants, tests, docs).

### 3.5 Versioning

The prefix `/api/v1/` is the version boundary (FR-13, AC-39). The existing `/api/*` surface is unversioned and unchanged (NFR-3). The client base URL is fully client-configurable: the checker/desktop store a base URL and append `/api/v1/license/verify`; nothing is hardcoded (AC-39).

---

## 4. Canonicalization + crypto architecture

### 4.1 Canonicalization spec (NFR-2, AC-2/3, AC-16..23)

A new module `worker/src/license/canonical.ts` exports `canonicalize(payload): Uint8Array`. The checker ships a byte-identical TypeScript copy at `license-checker/src/lib/canonical.ts`. The spec, precise enough to reproduce identically:

1. The payload is a flat JSON object (no nesting in v1) whose values are only: string, integer number, boolean, or null.
2. **Key order**: keys sorted ascending by JavaScript default string comparison (`Array.prototype.sort()` with no comparator), which for the ASCII-only key set here is lexicographic by UTF-16 code unit. The fixed sorted order for v1 is exactly the **12 keys**: `activation_allowed, expires_at, grace_period_seconds, installation_id, issued_at, key_id, license_id, plan, product_id, protocol_version, server_time, status`.
3. **Serialization**: `JSON.stringify` is NOT applied to the raw object (its key order is insertion order, not sorted). Instead the object is rebuilt into a new object by inserting keys in the sorted order above, then serialized with `JSON.stringify(sorted)`. Because every value is a JSON scalar, `JSON.stringify` produces a deterministic form: strings with standard JSON escaping, integers as bare digits (no `.0`, no exponent), booleans as `true`/`false`, null as `null`, no insignificant whitespace, `:` and `,` separators with no spaces.
4. **Encoding**: the resulting string is encoded to bytes with `new TextEncoder().encode(...)` (UTF-8). Those bytes are the message that is signed and verified.
5. **Time fields** (`expires_at`, `issued_at`, `server_time`): always the exact `Date.prototype.toISOString()` form `YYYY-MM-DDTHH:mm:ss.sssZ` (millisecond precision, `Z` suffix), matching the project-wide UTC ISO convention (`time.ts` `nowIso`). `expires_at` may be `null`.
6. **Integers** (`license_id`, `protocol_version`, `grace_period_seconds`): plain JSON integers. **Range + fail-closed guard (finding 5):** each integer field must be a JavaScript *safe* integer, i.e. `Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER` (`< 2^53`). The payload builder asserts this **before** canonicalizing/signing; a value that fails the assertion (a float, a NaN, or a magnitude ≥ 2^53) throws a server error that `onError` converts to `500 CONFLICT`. **The server never signs a non-conforming payload (fail closed)** — a drift can therefore never be silently signed and shipped to a client. `license_id` is `activation_codes.id` (SQLite autoincrement), realistically far below 2^53; the explicit bound is stated so a future producer (e.g. a non-JS re-implementation of the server) cannot diverge on exponent/precision formatting.
7. **Booleans** (`activation_allowed`): JSON `true`/`false`.

Because both sides sort keys deterministically and only emit JSON scalars within the pinned ranges, `JSON.stringify(sorted)` is byte-identical on server and client (AC-3, AC-14..23). The design deliberately avoids nested objects and floats so `JSON.stringify` determinism is total; if a future field needs nesting, the spec must be extended to recurse the sort (documented as the extension rule).

The REQUIRED cross-implementation determinism fixture (§10) covers not just the nominal sample but the boundary cases that this guard pins: (a) a **large-but-safe `license_id`** (e.g. `9007199254740991`, i.e. `2^53 − 1`) to prove bare-digit formatting at the safe-integer boundary, and (b) a payload with **`expires_at: null`** to prove the null form. Both the worker producer and the checker consumer must emit/accept byte-identical canonical bytes for these fixtures.

Tamper detection is automatic: modifying any signed field (AC-16..23) changes the canonical bytes, so the signature no longer verifies against the recomputed message. A cross-implementation fixture test (worker emits canonical bytes for a fixed payload → the checker asserts identical bytes) is a REQUIRED test to guard drift between the two copies (§10).

### 4.2 Crypto primitive choice (FR-4, decision SL-1)

**Chosen: WebCrypto Ed25519** via `crypto.subtle`, no new server dependency.

Reasoning: `crypto.ts` already uses `crypto.subtle` for HMAC/PBKDF2, so the runtime and the pattern are proven in this project. The Workers runtime at `compatibility_date = 2026-06-16` with `nodejs_compat` is expected to support the Ed25519 algorithm in `crypto.subtle` (`importKey`, `sign`, `verify` with `{ name: "Ed25519" }`). This satisfies NFR-1 (no custom crypto, no new dependency without reason).

**Runtime availability is verified, not assumed (finding 6).** Ed25519 *algorithm* support in `crypto.subtle` is an external runtime fact not demonstrated in-repo (only HMAC/PBKDF2 are proven). During implementation, a one-line `importKey`/`sign`/`verify` Ed25519 smoke test is run against the **real local Worker** (folded into the §10.1 live e2e). If it passes, WebCrypto is used with no new dependency. If it fails, `signing.ts` is flipped to the `@noble/ed25519` fallback (a well-known, audited, dependency-light pure-JS Ed25519) and that single new dependency is recorded in `memory/decisions.md` with its reason per RULES §8. The entire sign/verify surface is isolated to one file (`worker/src/license/signing.ts`) so the swap is contained and does not touch `service.ts` or the route layer.

Base64url reuse (SL-16, resolves finding 4): `worker/src/crypto.ts` currently keeps `bytesToBase64Url` and `base64UrlToBytes` module-private (verified). This design **exports** both so `worker/src/license/signing.ts` uses the same byte-compatible `-`/`_`/no-`=` variant (and the Phase-2 JWT `epoch` change, §15.2, reuses them too). The checker ships a byte-identical decoder in `license-checker/src/lib/base64url.ts`, exercised by the fixture test so key material and signatures round-trip.

New module `worker/src/license/signing.ts` exports:
- `signPayload(env, payloadBytes: Uint8Array): Promise<string>` — imports the private key from env once (cached like `hmacKeyCache`), signs, returns base64url via the exported helper.
- `loadPublicKeyMaterial(env)` — for the export/documentation tooling.

Server fallback (documented, not implemented unless proven necessary): if `crypto.subtle.sign({name:"Ed25519"}, ...)` is unavailable at runtime, switch the two signing helpers in `signing.ts` to `@noble/ed25519` (a well-known, audited, dependency-light pure-JS Ed25519). This would be the single justified new dependency, recorded in `decisions.md`. The signing/verifying surface is isolated to one file so the swap is contained.

Checker verification (SL-23, resolves NIT 8): `license-checker/src/lib/verify.ts` **feature-detects** `crypto.subtle` Ed25519 (attempt an `importKey` of a known public key at startup) and falls back to `@noble/ed25519` when absent, so an older browser never silently fails. All current evergreen browsers at the target date support WebCrypto Ed25519; the fallback is the safety net.

### 4.3 Keys, key_id, rotation (FR-3, FR-12, AC-36/37, AC-40)

Environment (added to `Bindings` in `types.ts`, validated in `config.ts`):
- `LICENSE_SIGNING_PRIVATE_KEY` — the current Ed25519 private key, base64url. **Never committed, never returned, never logged.**
- `LICENSE_SIGNING_KEY_ID` — the current key id string (e.g. `ed25519-2026-01`), stamped into every payload as `key_id`.
- `LICENSE_SIGNING_PUBLIC_KEY` — the current public key, base64url (documented/exported for clients; safe to publish).
- `LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY` (optional) + `LICENSE_SIGNING_PREVIOUS_KEY_ID` (optional) — the prior public key for rotation overlap.

`config.ts` changes (extending the existing `validateEnv` per-request validation, finding 2 / SL-25, AC-40):

**Mechanism correction.** The Workers runtime has **no module-load/startup hook** that can reject a deploy; `validateEnv(c.env)` is invoked from the per-request middleware `api.use("*", ...)` in `createApi()` (verified `worker/src/routes.ts:22-28`). So signing-key validation fires on the **first request to any `/api/*` (and the new `/api/v1/*`) route**, not "at startup." The functional outcome satisfies AC-40 (a misconfigured signing key yields `500 CONFLICT` before any license is signed), but the design states the real mechanism so the implementer does not try to add a startup check that cannot exist.

Concretely, inside the existing `validateEnv` loop (which today iterates `CORE_SECRET_KEYS` and compares each value against the exact placeholder string `"replace-with-a-long-random-secret"` — an **equality** check, not a prefix match, verified `worker/src/config.ts`):
- Add `LICENSE_SIGNING_PRIVATE_KEY` and `LICENSE_SIGNING_KEY_ID` as required keys validated by the same `requireEnv` + exact-placeholder-equality pattern (`500 CONFLICT` when missing/empty or equal to the documented placeholder value).
- In the same loop, after presence/placeholder checks, decode `LICENSE_SIGNING_PRIVATE_KEY` with the exported base64url helper and assert it decodes to the expected Ed25519 key length; a malformed key throws `500 CONFLICT` on that same first request (not "at startup").
- Previous-key vars (`LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY`/`_KEY_ID`) are optional and validated only if present.
- The signing-key import in `signing.ts` caches the imported `CryptoKey` after the first successful validation (mirroring the existing `hmacKeyCache`), so the per-request validation cost is a cheap presence/format check, not a re-import on every request.

**Key generation procedure** (documented in `docs/DEPLOYMENT.md`, AC-53): a one-off script `scripts/gen-signing-key.mjs` uses Node WebCrypto (`crypto.subtle.generateKey({name:"Ed25519"}, true, ["sign","verify"])`), exports PKCS8/raw, prints base64url private+public+suggested key_id to stdout for the operator to paste into `.dev.vars` (local) or `wrangler secret put` (Cloudflare prod; a Phase-2 Node/Vercel target would set the same values as plain env vars). The script never writes the private key to a committed file. `scripts/init-dev-env.mjs` is extended to also generate a dev signing keypair + key_id into `worker/.dev.vars`.

**Rotation design** (FR-12): the server always signs with the current private key and stamps `LICENSE_SIGNING_KEY_ID`. Clients hold a map `{ key_id → public_key }` containing the current and (during overlap) previous public keys. A payload whose `key_id` matches a known public key is verified with that key; a payload with an unknown `key_id` is rejected (AC-26). Rotation steps (documented): (1) generate new keypair + new key_id; (2) publish the new public key to clients as an additional entry; (3) once clients have it, set the new private key + key_id as current and move the old public key into `LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY`; (4) after the overlap window, drop the previous key. During overlap the client-integration doc's key map lets a client verify payloads from either key (AC-37).

### 4.4 Public-key distribution

The public key(s) are documented in `docs/CLIENT_INTEGRATION.md` and embedded in the checker at build time via a checker config file (`license-checker/src/config/publicKeys.ts`) holding only public keys + key_ids (AC-46: a repo scan finds no private key in the checker). The desktop app later consumes the same documented key map.

---

## 5. Activation / renewal / revocation / hold / grace flows and status mapping

### 5.1 Signed-status derivation (FR-5, decision SL-3, resolves OQ-2/A-5)

A new pure function `deriveSignedStatus(code, now)` in `worker/src/license/status.ts` maps the persisted model to the signed vocabulary, priority order (mirrors DATABASE.md derived-status order, with HOLD inserted):

```
1. status = 'deleted'                        → "revoked"
2. hold_at IS NOT NULL                        → "hold"
3. disabled_at IS NOT NULL                    → "suspended"
4. status = 'active' AND expires_at <= now    → "expired"
5. status = 'active'                          → "active"
6. otherwise (unused)                         → treated as not-activatable → signed refusal / INVALID_CODE
```

- `revoked` maps to soft-delete (`status='deleted'`), the existing irreversible revocation, satisfying AC-8.
- `suspended` maps to admin disable (`disabled_at`), AC-9.
- `hold` is the new marker, AC-10; it outranks `suspended` and `expired` so a held license is never reported `active`.
- `active`/`expired` unchanged from the existing model (AC-6/7).

This function is the single source of truth used by `/api/v1/license/verify`. The existing `/api/client/*` decision tables are untouched (NFR-3).

### 5.2 Verify flow (server)

`LicenseService.verifySigned(input)`:
1. `requireValidClientApp(app_id, app_secret)` (existing) → 401/403/404 as today.
2. Validate `product_id === app.app_id`; mismatch → record `PRODUCT_MISMATCH` security event, throw `404 INVALID_CODE` (unsigned, §3.1.1, AC-11).
3. Validate `protocol_version` supported; else `400 PROTOCOL_UNSUPPORTED`.
4. HMAC the `license_key` and load the code (`findCodeByHash`); wrong app → `404 INVALID_CODE`.
5. Compute `installation_hash = HMAC(DEVICE_HMAC_SECRET, installation_id)` (reuses `hashDevice`, A-3).
6. Activation-slot / device-binding evaluation (§5.4) → determines `activation_allowed`.
7. `status = deriveSignedStatus(code, now)`.
8. Build the payload object (§3.2) with `server_time = issued_at = nowIso()`.
9. `bytes = canonicalize(payload)`; `signature = signPayload(env, bytes)`.
10. Record a `VERIFY` security event (success) with `installation_hash`, `key_id`, `protocol_version` (no raw values).
11. Return `{ payload, signature, public_key_id, verification_interval_seconds }`.

No SQL is written for a plain verify except the security-event insert (and a slot touch in multi-slot mode); expiry/activation math reuses `time.ts` and the existing calendar rules.

### 5.3 Renewal / revocation / hold / grace (admin-driven, §7)

- **Renewal**: admins extend/reduce `expires_at` via the admin API (§7). The next signed verify reflects the new `expires_at` (AC-34). The existing client `/api/client/renew` is unchanged.
- **Revocation**: admin Revoke = existing soft delete (`status='deleted'`) → signed `revoked` (AC-8/32).
- **Hold**: admin Hold sets `hold_at`+`hold_reason_code`; admin Approve clears them, restoring the prior derived status (AC-33). Hold does not alter `status`/`disabled_at`, so approve deterministically returns the license to whatever it was (active/expired/suspended) before.
- **Grace**: `grace_period_seconds` is carried in the payload from `plans.grace_period_seconds` (A-7). The server does not enforce grace; it hands the client the allowance, consistent with BUSINESS_RULES "explicit client-side degraded-mode allowance".

### 5.4 Activation limit + device binding (FR-11, decision SL-5, resolves OQ-4)

Two modes, chosen by `max_activations`:
- **`max_activations` IS NULL or = 1 (default/legacy)**: behavior is exactly today's single-device model on `activation_codes.device_hash`. The signed verify treats a matching `device_hash` as the one allowed installation; a mismatched/absent binding yields `activation_allowed:false` with the true status (the client must activate via `/api/client/activate` first). No `code_activations` rows are used. This preserves NFR-3 and the existing 3-rebind self-service quota untouched.
- **`max_activations` > 1 (opt-in, admin-set)**: slots are tracked in `code_activations`, and the limit is enforced by a **single atomic conditional upsert** (finding 1 / SL-24). The slot evaluation is **not** a `SELECT COUNT → INSERT` sequence and does **not** reuse `createOrReuseSession` (which is non-atomic and bounds only duplicate session tokens, not an active count — see §2.3). Instead, `repository.claimActivationSlot(codeId, installationHash, maxActivations, now)` runs one statement:

  ```sql
  INSERT INTO code_activations (code_id, installation_hash, status, activated_at, last_seen_at)
  SELECT ?1, ?2, 'active', ?3, ?3
  WHERE (
    SELECT COUNT(*) FROM code_activations
    WHERE code_id = ?1 AND status = 'active'
  ) < ?4
  ON CONFLICT(code_id, installation_hash) DO UPDATE
    SET last_seen_at = excluded.last_seen_at,
        status       = 'active',
        released_at  = NULL;
  ```

  The `WHERE (count) < max` predicate and the insert are **one statement**, which both D1 (each prepared statement is atomic within the request) and `node:sqlite` evaluate without a read-then-write race, so two distinct installations racing cannot both pass the bound and over-admit (closing the AC-12 concurrency gap). The `ON CONFLICT ... DO UPDATE` makes an already-claimed installation idempotently refresh its slot (and un-release a previously released one) regardless of the count, so a legitimate re-verify of an existing installation is never blocked by a full license.

  Deciding `activation_allowed`: after the statement, inspect the outcome. If the row now exists `active` for this `(code_id, installation_hash)` → `activation_allowed:true`. The repository returns `meta.changes` plus a confirming `SELECT ... WHERE code_id=? AND installation_hash=? AND status='active'`: a present row ⇒ allowed; **no** row (the conditional insert found the count at the limit and the `ON CONFLICT` branch did not fire because no existing row matched) ⇒ `activation_allowed:false`, **no slot consumed** (AC-12). The confirming `SELECT` disambiguates the two zero-`changes` cases (a `DO UPDATE` that touched an existing row also reports changes on D1/SQLite, but the subsequent `SELECT` is authoritative and avoids relying on dialect-specific `changes` semantics for conflict-updates).

  Admin "Change activation limit" and "View activations/installations" operate on this table (§7).

IP is never consulted for activation identity; changing source IP for the same `installation_id` does not change the decision (AC-13) because the decision keys only on `installation_hash`.

Interaction with the existing rebind quota: in multi-slot mode, releasing a slot is an admin/self-service action on `code_activations.status='released'`; the legacy `rebind_count`/`last_rebind_at` quota continues to govern the single-device path only. The design does not change the 3-rebind rule for legacy codes (out-of-scope per requirements).

---

## 6. Auto-hold, suspicious-signal detection, security-event logging

### 6.1 Allowlists (constants.ts)

New `SECURITY_EVENT_TYPE` = `{ VERIFY, REPORT, PRODUCT_MISMATCH, AUTO_HOLD, ADMIN_HOLD, ADMIN_APPROVE, LIMIT_REACHED, REPEATED_FAILURE }`.
New `SECURITY_REASON_CODE` = `{ SIGNATURE_INVALID, PAYLOAD_TAMPERED, CLOCK_ROLLBACK, KEY_ID_UNKNOWN, PROTOCOL_UNSUPPORTED, REPLAY_SUSPECTED, MALFORMED_RESPONSE }`.
New `HOLD_REASON_CODE` = report-driven subset + `ADMIN_MANUAL`.
These are values-only enums (like `LOG_ACTION`), synchronized to frontend constants and `docs/API.md`.

### 6.2 Security-event logging (FR-9, AC-31, decision SL-6)

`repository.insertSecurityEvent(input)` — a single bound INSERT into `security_events`, taking only HMACs/allowlisted codes/ids (never raw installation_id, license key, secret, or key material). The service calls it on: every signed verify (success/failure), every report, every auto-hold, product mismatch, and limit-reached. Tenant scope is via `app_id`. Logging WHY = `event_type` + `reason_code` + optional `message` (no plaintext), satisfying AC-31 and NFR-1.

`repository.listSecurityEvents({ tenantId, codeId?, page, pageSize })` — tenant-scoped read joined through `apps.tenant_id`, for the admin history view (§7, AC-32/35). The raw `installation_hash` is not shown to the UI; the admin API returns event metadata + a `has_installation` boolean rather than the hash (SECURITY.md: device_hash never in admin-visible text).

### 6.3 Auto-hold (FR-8, AC-30)

**Abuse-resistant default (finding 7 / SL-24).** `/report` is authenticated only by `app_id` + `app_secret`, which is shared by every installation of an app and shipped in the checker/desktop. A naive "a single high-severity report ⇒ immediate HOLD" default would let any party holding the app secret HOLD any license of that app by reporting `PAYLOAD_TAMPERED` for its key — a cheap denial-of-service against legitimate licenses. The chosen default therefore **requires corroboration** before auto-HOLD:

- **Report-driven HOLD (default ON, corroborated):** a license is auto-held only when it accumulates **N ≥ 2 high-severity reports (`SIGNATURE_INVALID`, `PAYLOAD_TAMPERED`, `CLOCK_ROLLBACK`) from distinct `installation_hash` values within a window** (defaults: `reportHoldDistinctThreshold = 2`, `reportHoldWindowSeconds = 86400`), OR a single high-severity report that **matches a server-detected anomaly** for the same code (e.g. the same code also tripped the repeated-failure signal below). A lone, uncorroborated high-severity report **records the `REPORT` security event but does NOT hold** — it is surfaced to the admin instead. Every report, held or not, is recorded (satisfying AC-29/AC-31; AC-30 is satisfied because a qualifying — i.e. corroborated — report transitions to HOLD).
- **Single-report-immediate-hold (config-gated, default OFF):** `autoHold.singleHighSeverityReportHolds = false`. An operator who wants maximum sensitivity can enable it, accepting the DoS tradeoff; it is admin-reversible via Approve. The default is OFF for the abuse reason above.
- **Server-side signals (default OFF for auto-hold):** repeated `INVALID_CODE`/`PRODUCT_MISMATCH`/limit-reached from the same `installation_hash` within a window (defaults: `repeatedFailureThreshold = 10`, `repeatedFailureWindowSeconds = 600`) record a `REPEATED_FAILURE` event; auto-hold on this signal is `repeatedFailureHolds = false` by default to avoid self-inflicted lockout, on-by-config.

All thresholds are centralized config values (§6.4), not magic numbers scattered in code. Auto-hold is idempotent (setting `hold_at` on an already-held code is a no-op) and only ever writes to a code already located and confirmed to belong to the authenticated app (tenant-safe). The chosen default is documented identically in the `docs/SECURITY.md` threat-model rows for "API abuse" and "activation abuse" (§11), stating that single-report-immediate-hold is an accepted, admin-reversible, config-gated tradeoff that ships OFF.

### 6.4 Centralized licensing config (FR-13, AC-38)

New `worker/src/license/config.ts` exporting `getLicensingConfig(env)` → `{ keyId, supportedProtocolVersions, currentProtocolVersion, defaultGraceSeconds, verificationIntervalSeconds, autoHold: { reportHoldDistinctThreshold, reportHoldWindowSeconds, singleHighSeverityReportHolds, repeatedFailureThreshold, repeatedFailureWindowSeconds, repeatedFailureHolds } }`. Defaults (per §6.3): `reportHoldDistinctThreshold = 2`, `reportHoldWindowSeconds = 86400`, `singleHighSeverityReportHolds = false`, `repeatedFailureThreshold = 10`, `repeatedFailureWindowSeconds = 600`, `repeatedFailureHolds = false`. Values come from env with these safe defaults; the signing key/key_id come from the validated env. The corroboration count is computed by `repository.countDistinctInstallationReports(codeId, highSeverityReasonCodes, sinceIso)` (a bound `SELECT COUNT(DISTINCT installation_hash)` over `security_events`). `verification_interval_seconds` is returned to the client in the verify response (AC-38). This keeps thresholds, interval, protocol versions, and key_id in one place.

---

## 7. Admin powers (FR-10, AC-32..35)

All new admin endpoints live under `/api/admin/*`, Bearer-protected by the existing `requireAdmin` middleware (NFR-1), tenant-resolved via `resolveTenantId` (NFR-4). They follow `routes.ts → service.ts → repository.ts`. Each write records an `activation_logs` entry (existing audit) and, where relevant, a `security_events` entry.

### 7.1 Endpoints (new)

| Method + path | Power | Effect |
| --- | --- | --- |
| `PATCH /api/admin/codes/:id/hold` | Hold | sets `hold_at`+`hold_reason_code='ADMIN_MANUAL'` |
| `PATCH /api/admin/codes/:id/approve` | Approve (release hold) | clears `hold_at`+`hold_reason_code` |
| `PATCH /api/admin/codes/:id/validity` | Extend / Reduce | sets `expires_at` to a new value (server-validated) |
| `PATCH /api/admin/codes/:id/max-activations` | Change limit | sets `max_activations` (NULL or ≥1); `409 ACTIVATION_LIMIT_REACHED` if below current active-slot count |
| `GET /api/admin/codes/:id/activations` | View activations/installations | lists `code_activations` (metadata + bound/released, no raw hash) |
| `GET /api/admin/codes/:id/security-events` | View history | lists `security_events` for the code (tenant-scoped) |

Existing powers reused as-is: **Revoke** = `DELETE /api/admin/codes/:id` (soft delete); **Delete (soft)** = same endpoint; **Disable/Enable** = existing `PATCH /api/admin/codes/:id/status`. So FR-10's Revoke and Delete both map to the existing soft-delete + disable endpoints; only Hold, Approve, Extend/Reduce, Change-limit, and the two views are new.

Validity change rules (route validation): `expires_at` must be a valid UTC ISO string; "Extend" and "Reduce" are the same endpoint with a new absolute `expires_at` (the UI computes +/- deltas), keeping the server simple and the write atomic. The service re-verifies the code belongs to the tenant before writing (SECURITY.md "update by id must re-verify tenant"). Reducing below `now` immediately makes the license `expired` on next verify (AC-34).

The `max-activations` endpoint is the named caller for `ACTIVATION_LIMIT_REACHED` (SL-23, NIT 10).

### 7.2 Service methods

`holdCode`, `approveCode`, `setCodeValidity`, `setMaxActivations`, `listCodeActivations`, `listCodeSecurityEvents` — each loads the code with a tenant constraint, performs a bound conditional UPDATE (row-count check → `NOT_FOUND`/`CONFLICT`), writes the audit log + security event. Approve restores prior derived status simply by clearing `hold_at` (no stored "previous status" needed because the underlying `status`/`disabled_at`/`expires_at` were never changed by hold).

### 7.3 Repository methods

Bound SQL only, all with `app_id IN (SELECT id FROM apps WHERE tenant_id = ?)` guards, mirroring `softDeleteCode`/`updateCodeDisabled`:
- `holdCode(codeId, tenantId, reasonCode, at)`, `approveCode(codeId, tenantId, at)` — conditional UPDATEs on non-deleted rows.
- `setCodeExpiry(codeId, tenantId, expiresAt, now)` — updates only `status='active'` (or activated) rows.
- `setMaxActivations(codeId, tenantId, value, now)` — guarded against setting below the active-slot count.
- `listCodeActivations(codeId, tenantId)`, `listSecurityEvents({tenantId, codeId?, page, pageSize})`.

### 7.4 Admin UI + i18n (FRONTEND per AGENTS.md)

- New actions on `admin/src/pages/CodesPage.tsx` action column (or a new license-detail drawer): Hold / Approve (mutually exclusive by `hold_at`), Extend/Reduce validity (date picker modal), Change max-activations (number input modal), View activations, View security events. These reuse the existing `apiRequest` + `modal.confirm` + `message` + `actionRef.reload()` pattern already in `CodesPage`.
- A new **License Detail** view (drawer or `admin/src/pages/`) shows the code's derived signed status, hold state, activation slots (bound/released, count vs limit), and the security-event history table. A drawer avoids a new route.
- `admin/src/types.ts`: add `hold_at`, `hold_reason_code`, `max_activations` to the code item; add `CodeActivationItem`, `SecurityEventItem`.
- `admin/src/shared/constants.ts`: add the new statuses/reason codes for display; extend the status tag helper to render `hold`.
- `admin/src/i18n/messages.ts`: add all new copy under `codes.*` / a new `security.*` namespace (no untranslated inline text, AGENTS.md). `admin/src/shared/logMessage.ts` stays in sync if any new stored log message template is added.

---

## 8. Standalone license-checker app (FR-14, decision SL-9, AC-41..46)

### 8.1 Tech choice + reason

**Vite + React + Ant Design** app in `license-checker/` (decision SL-9). Reason: mirrors `admin/` conventions and toolchain exactly (NFR-5, Windows-friendly pnpm+Vite), and the requirement asks for an add form, a multi-license list, and per-license detail views — a UI, not a CLI. A minimal Node CLI was considered and rejected because it cannot satisfy the "show license details" list/detail UX cleanly.

### 8.2 Folder layout

```
license-checker/
  package.json                # name: @license-manager/license-checker, private
  vite.config.ts
  tsconfig.json
  index.html
  src/
    main.tsx
    App.tsx
    config/publicKeys.ts       # { key_id -> base64url public key } — PUBLIC ONLY
    lib/base64url.ts           # byte-identical copy of crypto.ts base64url variant (SL-16)
    lib/canonical.ts           # byte-identical copy of worker canonical spec (§4.1)
    lib/verify.ts              # WebCrypto Ed25519 verify (+ @noble fallback) + field validation + freshness
    lib/api.ts                 # fetch wrapper: POST {base}/api/v1/license/verify | /report
    store/licenses.ts          # localStorage-backed multi-license list + last_seen_server_time per license
    pages/
      LicenseListPage.tsx      # add form + list + per-row Check / Report / Tamper-test
      LicenseDetailView.tsx    # shows status, plan, expiry, remaining, last verify, grace, key_id
    types.ts
```

### 8.3 pnpm workspace wiring

`pnpm-workspace.yaml` gains `- "license-checker"` (AC-41). The package has its own `package.json` with `dev`/`build`/`type-check`/`test` scripts (Vite + vitest), independent of the worker/admin. `docs/DEPLOYMENT.md` documents `pnpm --filter @license-manager/license-checker build` (AC-53).

### 8.4 Features

- **Add License form** (AC-42): inputs = Server base URL, License Key, Product ID (`app_id`), Installation ID (generated + editable), and App Secret (private config; kept in memory/localStorage on the user's machine, never committed — the checker is the user's own tool). Supports adding **multiple** licenses into a persisted list.
- **Check** (AC-43): calls `{base}/api/v1/license/verify`; on response, re-canonicalizes `payload` with `lib/canonical.ts`, looks up the public key by `payload.key_id` in `config/publicKeys.ts` (unknown key_id → reject, AC-26), verifies the signature (AC-14), validates `product_id`/`installation_id`/`protocol_version` match expectations, runs the freshness predicate below, then shows details: status, plan, expiry, remaining seconds, last verification time, grace period, `key_id`.
- **Freshness / replay predicate (pinned, SL-18, resolves finding 6 / AC-28)**, evaluated per license using `last_seen_server_time` persisted in `store/licenses.ts`:
  1. If there is no stored `last_seen_server_time` (first-ever check): **accept** and store `payload.server_time`.
  2. Reject (clock-rollback / replay) if `payload.server_time < last_seen_server_time`.
  3. Reject (stale / max-age) if `now_client - payload.server_time > verification_interval_seconds + SKEW`, where `SKEW = 300` seconds.
  4. `payload.server_time == last_seen_server_time` is **accepted** (idempotent re-check).
  5. On accept, update `last_seen_server_time = max(last_seen_server_time, payload.server_time)`.
  Replay of an old-but-still-in-window response is explicitly out of scope for v1 max-age; the server-issued nonce is the documented future hardening (SL-8/OQ-8).
- **Failure state** (AC-24/25/44): invalid signature, missing signature, malformed body, key_id unknown, product/installation mismatch, stale/rolled-back `server_time` → a clear "license failed to load" state with the specific reason. On these, the checker offers to call `/report` with the matching reason code.
- **Report + tamper demo** (AC-45): a "Tamper test" action takes a genuine signed response, mutates one signed field (e.g. `expires_at`), re-verifies locally, and shows the verifier REJECTING it; a "Report" action posts `/api/v1/license/report` with a chosen reason code and shows the `{recorded, held}` result.
- **No private key** (AC-46): `config/publicKeys.ts` holds only public keys; a repo/content scan finds no private key in `license-checker/`.

### 8.5 Client integration contract (FR-13, FR-12, AC-54)

New `docs/CLIENT_INTEGRATION.md` documents: configurable server base URL (never hardcoded), the exact `/verify` and `/report` request/response shapes, the byte-exact canonical form (§4.1 reproduced), the signature-verification steps, the public-key map for current+previous keys and rotation handling (AC-37), `protocol_version` handling, `key_id` handling (AC-26), the exact freshness/`server_time` clock-rollback + replay predicate (§8.4, AC-28), and `activation_allowed` handling. This is the contract the future desktop app consumes (the real desktop app remains out of scope).

---

## 9. Error handling (per operation)

| Operation | Failure condition | Recoverable? | Caller receives | Logged? |
| --- | --- | --- | --- | --- |
| verify: bad JSON / missing field | client bug | fatal to request | `400 BAD_REQUEST` (unsigned) | no security event (no license context) |
| verify: app not found / disabled / tenant disabled | config | fatal | `404/403` (unsigned), existing codes | no |
| verify: wrong app_secret | auth | fatal | `401 INVALID_APP_SECRET` (unsigned) | no |
| verify: unknown license_key | client | fatal | `404 INVALID_CODE` (unsigned) | none |
| verify: product_id mismatch | client/attack | fatal | `404 INVALID_CODE` (unsigned) | `PRODUCT_MISMATCH` event (failure) |
| verify: unsupported protocol_version | client | fatal | `400 PROTOCOL_UNSUPPORTED` (unsigned) | optional event |
| verify: expired/revoked/suspended/hold | business | expected | **HTTP 200 signed** payload with the status | `VERIFY` event (success) |
| verify: activation limit reached | business | expected | **HTTP 200 signed** payload, `activation_allowed:false` | `LIMIT_REACHED` event |
| verify: signing key missing/invalid | server misconfig | fatal (whole request) | `500 CONFLICT` — rejected by the per-request `validateEnv` middleware on the first `/api/*` or `/api/v1/*` request (not a startup hook; finding 2) | server console only, no key material |
| report: bad reason_code / missing license | client | fatal | `400 BAD_REQUEST` | none |
| report: license not owned by app | client/attack | fatal | `404 INVALID_CODE` | none (enumeration-safe) |
| report: valid | — | — | `200 { recorded, held }` | `REPORT` event (+ `AUTO_HOLD` if held) |
| admin hold/approve/validity/limit: code not found in tenant | client | fatal | `404 NOT_FOUND` | audit log |
| admin max-activations below active slots | client | retryable | `409 ACTIVATION_LIMIT_REACHED` | audit log |
| admin write: concurrent state (row count ≠ 1) | concurrency | retryable | `409 CONFLICT` | audit log |

Global: `index.ts` (and the Node entry) `onError` converts `ApiError` to the stable envelope and never leaks internals (SECURITY.md); unexpected errors become `500 CONFLICT`. No response, log, or event ever contains the private key, plaintext license key, plaintext installation_id, or an app secret (NFR-1, AC-5, AC-46) — only HMACs, suffixes, and allowlisted codes.

Validation rules for each external input are specified inline in §3.1/§3.3/§7.1 (required/optional, type, limits, failure behavior).

---

## 10. Testability

- **Unit (worker/test, vitest, MemoryRepo pattern already in `service.test.ts`)**: `canonicalize` byte-stability and 12-key order (AC-2) including the finding-5 boundary fixtures (large-but-safe `license_id = 2^53−1`, `null` `expires_at`) and the fail-closed assertion (a float/≥2^53 integer field throws before signing); sign/verify round-trip (AC-3/14); every tamper case rejects (AC-16..23, done by canonicalizing a mutated payload and asserting `verify` fails); `deriveSignedStatus` for all six branches (AC-6..10); the **atomic activation-slot claim** (AC-12/13) including a concurrency test (two distinct installations racing against `max_activations = N` never over-admit; an existing installation re-verifying is never blocked); corroborated auto-hold threshold (AC-30: a single high-severity report does NOT hold, two distinct-installation reports DO); protocol/key_id rejection (AC-22/26/27); `validateEnv` rejects missing/placeholder/malformed signing env on the first request (AC-40); response/log scans assert no private key / no plaintext (AC-5).
- **Integration (worker/test/database.test.ts pattern, real D1-local via better-sqlite harness)**: `0007` (signed-license) applies to empty + existing DB and preserves data (AC-48); the single-statement activation-slot limit is exercised concurrently against the real SQLite harness to prove it never over-admits (finding 1); tenant-scope negative tests for security events + admin powers (AC-35); admin hold→verify→approve→verify round-trips (AC-33); validity change reflected in verify (AC-34).
- **Checker (license-checker vitest)**: `lib/canonical.ts` produces identical bytes to a fixture generated by the worker (cross-implementation determinism, NFR-2) including the finding-5 boundary fixtures; `lib/base64url.ts` round-trips against a worker fixture; `lib/verify.ts` accepts a genuine signature and rejects each tampered field and unknown key_id (AC-14/15/26/45); the pinned freshness predicate (§8.4) accepts first-check, rejects rollback, rejects stale (AC-28).
- **Baseline**: the existing 218 tests must stay green; new code is additive (NFR-3, AC-49). The real count is re-confirmed by running the Verification Matrix at implementation time. Commands per AGENTS.md: worker type-check + test, admin type-check + test, `pnpm db:migrate:local`, plus the new checker's type-check + test.

A canonicalization spec shared as prose + two mirrored implementations is inherently risky for drift; the cross-implementation fixture test (worker generates canonical bytes → checker asserts identical) is the guard that keeps them byte-identical and is a REQUIRED test, not optional.

### 10.1 Local live end-to-end verification (Phase 1)

Beyond vitest, the finalize phase runs a real-HTTP local end-to-end pass and captures actual output as proof (RULES §5). This extends the existing `scripts/e2e-live.mjs` and `worker/test/e2e.test.ts` (both verified present) rather than starting fresh.

Plan (Phase 1):
- Add a `--verify` mode (or a sibling `scripts/e2e-signed.mjs`) that boots a **real local Worker** via `wrangler dev` / miniflare against the local D1, after `pnpm db:migrate:local` applies `0001`–`0007`.
- **Ed25519 smoke test first (finding 6):** a one-line `importKey`/`sign`/`verify` against the real local Worker proves `crypto.subtle` Ed25519 is available before the rest runs; on failure, `signing.ts` flips to the `@noble/ed25519` fallback (recorded in `decisions.md`) and the e2e re-runs.
- Exercise, over real HTTP, with pasted output: the signed-verify happy path; each tamper case (mutate `expires_at`/`status`/`license_id`/`installation_id`/`plan`/`server_time`/`protocol_version`/`key_id`) and assert rejection; missing/garbage signature; unknown `key_id`; the atomic activation-limit path (fill `max_activations`, assert the next distinct installation gets `activation_allowed:false`); `/report` with each reason code and the corroborated auto-hold transition; and a `license-checker` run (built, pointed at the local server) performing Check + Tamper-test + Report.

**Honesty constraint (explicit):** "live" here means **fully working and verified locally**, plus exact copy-paste deploy commands and a deploy guide. The implementing agent **does not and cannot** deploy to the user's real Cloudflare account — it has no credentials, and a production deploy is the user's decision. The design, the finalize summary, and `docs/DEPLOYMENT.md` state this plainly; no step claims a remote production deploy was performed.

---

## 11. Documentation sync (AC-50..54, Phase 1)

- `docs/API.md`: the two `/api/v1/*` endpoints, request/response fields, the `/api/v1/` prefix, new error codes, and the canonical payload (AC-50).
- `docs/SECURITY.md`: threat-model table (key sharing, response modification, replay, MITM, private-key theft, local-cache modification, clock manipulation, activation abuse, API abuse) with Threat/Impact/Mitigation/Residual-Risk rows (AC-51); the "API abuse" and "activation abuse" rows state the corroborated auto-hold default and that single-report-immediate-hold ships OFF (finding 7); add signing-key env vars to the validation + secrets sections, noting validation is per-request (finding 2) and that no `source_ip` is persisted (finding 8).
- `docs/DATABASE.md`: the `0007` row + new table/column invariants (`code_activations` incl. the atomic-claim invariant, `security_events`, the new `activation_codes` columns), AC-52, plus the ASK-FIRST note that `security_events` has no `source_ip` column until OQ-7 is confirmed (finding 8).
- `docs/DEPLOYMENT.md`: the Cloudflare Workers install/deploy path, signing-key dev-vs-prod generation, `wrangler secret put` for the new secrets, the rotation runbook, the checker build, and the honesty constraint from §10.1 (AC-53). (The Node/Vercel adapter deploy path is Phase 2, §15.)
- `docs/CLIENT_INTEGRATION.md` (new): full client contract (AC-54).
- `worker/wrangler.toml` keeps only local placeholders; real keys go to `.dev.vars`/secrets (never committed).

Documentation for Phase-2 scope (user management, dual deploy, finalize README/graphify) is produced only when Phase 2 is cleared (§15), so it never implies un-built behavior exists.

---

## 12. Files touched (implementation map)

New:
- `migrations/0007_add_signed_license.sql` (signed-license schema, §2.1 — the AC-47 migration)
- `worker/src/license/canonical.ts`, `signing.ts`, `status.ts`, `config.ts`
- `scripts/gen-signing-key.mjs`
- `scripts/e2e-signed.mjs` or `--verify` mode in `scripts/e2e-live.mjs` (§10.1)
- `license-checker/**` (new workspace package)
- `docs/CLIENT_INTEGRATION.md`

Modified (Phase 1):
- `worker/src/index.ts` (mount `/api/v1` via `app.route("/api/v1", createV1Api())`)
- `worker/src/routes.ts` (new `createV1Api()` v1 router with the same per-request `validateEnv`; new admin code routes under `/api/admin/codes/:id/*`)
- `worker/src/service.ts` (`verifySigned`, `reportEvent`, `holdCode`/`approveCode`/`setCodeValidity`/`setMaxActivations`, `deriveSignedStatus` wiring) — existing business logic unchanged
- `worker/src/repository.ts` (new bound queries: `security_events`, `code_activations` incl. the atomic `claimActivationSlot`, admin hold/approve/validity/limit) — still SQL-only, `.bind()`, `D1Database` as today (no adapter in Phase 1)
- `worker/src/constants.ts` (new error codes `PROTOCOL_UNSUPPORTED`/`ACTIVATION_LIMIT_REACHED`, `SECURITY_EVENT_TYPE`/`SECURITY_REASON_CODE`/`HOLD_REASON_CODE` allowlists)
- `worker/src/types.ts` (`Bindings` signing vars, `SecurityEventRow`, `CodeActivationRow`, extended code rows)
- `worker/src/config.ts` (validate signing env inside the existing `validateEnv` loop)
- `worker/src/crypto.ts` (**export** `bytesToBase64Url` + `base64UrlToBytes` (SL-16))
- `scripts/init-dev-env.mjs` (generate dev signing keypair into `worker/.dev.vars`)
- `pnpm-workspace.yaml` (add `license-checker`)
- `admin/src/pages/CodesPage.tsx`, `admin/src/routes.tsx`, `admin/src/types.ts`, `admin/src/shared/constants.ts`, `admin/src/shared/format.tsx`, `admin/src/i18n/messages.ts`
- `README.md`, `docs/API.md`, `docs/SECURITY.md`, `docs/DATABASE.md`, `docs/DEPLOYMENT.md`

Phase 2 only (NOT touched by Phase 1 — see §15): `migrations/0008_add_admin_users_and_sessions.sql`, `worker/src/db/{adapter,d1,nodeSqlite}.ts`, `worker/src/entry-node.ts`, `admin/src/pages/UsersPage.tsx`, `JwtPayload.epoch` in `crypto.ts`, the `requireUserManager`/epoch changes in `middleware.ts`, `admin/src/api.ts` 401-on-kick handling, and the graphify/README finalize refresh.

---

## 13. Acceptance-criteria traceability (Phase 1 only — every row is an authoritative AC)

This table traces **only** the authoritative acceptance criteria AC-1..AC-54 from `docs/requirements-signed-license.md`. There are **no "proposed" or "pending requirements sync" rows** (finding 3): every row below maps to an existing AC and an existing design section. Phase 2 (§15) has no AC in this requirements doc and is therefore not traced here; it is not cleared to build.

| AC | Where satisfied |
| --- | --- |
| 1 | §3.1 (200 + `ok` envelope via `http.ts`) |
| 2 | §3.2 + §4.1 (fixed 12 sorted keys incl. `activation_allowed`, ISO times) — FR-2/AC-2 now list all 12 fields (applied in requirements, §0.1) |
| 3, 14 | §4.2 verify round-trip; §10 tests |
| 4, 28 | §3.2 `server_time`; §8.4 pinned freshness predicate (SL-18) |
| 5, 46 | §4.3/§9 no key in responses/logs; §8.4 checker public-only |
| 6–10 | §5.1 `deriveSignedStatus` |
| 11 | §3.1 (table corrected) + §3.1.1 + §5.2 product mismatch (unsigned 404) |
| 12, 13 | §5.4 atomic activation-slot claim, IP-independent |
| 15–23, 24, 25, 26 | §4.1 canonical tamper detection; §8.4 checker failure states |
| 27 | §3.1.2 protocol handling |
| 29, 31 | §3.3 report; §6.2 security events |
| 30 | §6.3 auto-hold (corroborated default) |
| 32–35 | §7 admin powers, tenant scope |
| 36, 37 | §4.3 key_id + rotation |
| 38, 39 | §6.4 config + interval hint; §3.5 versioning/configurable base |
| 40 | §4.3 config.ts validation in the per-request `validateEnv` middleware (finding 2) |
| 41–45 | §8 checker |
| 47, 48 | §2.1 (`0007` has all signed-license schema, passes AC-47 verbatim; single Phase-1 migration, applies to empty + existing DB) |
| 49 | §10 baseline green (count re-confirmed at implementation) |
| 50–54 | §11 docs |

All 54 Phase-1 ACs trace to a design section with no gaps. The design is implementation-ready for Phase 1 on its own.

---

## 14. Open items carried to the user (RULES.md §7, ASK-FIRST)

Product/security decisions the design has taken a default position on that need user confirmation before the corresponding code ships:
- **OQ-1 / SL-7**: the signed endpoint requires `app_secret` in the request. If the desktop threat model forbids shipping `app_secret`, a device-scoped token scheme must replace it. Default: keep `app_secret` (matches existing invariant). The checker works either way.
- **OQ-7 / SL-24 (finding 8)**: recording any client IP (even audit-only) conflicts with the "no IP tracking by design" stance in `soul.md`. Default: **no `source_ip` column exists** in `0007`; if the user later approves audit-only IP capture, it is added by a dedicated later migration. Nothing can populate what does not exist.
- **OQ-8 / SL-8/SL-18**: `server_time` + client max-age freshness (pinned in §8.4) vs a server-issued nonce for replay. Default: stateless max-age in v1; nonce documented as future hardening.
- **Phase 2 clearance (finding 3)**: the §15 scope (user management, JWT session kick-out, forced-password bootstrap, dual Cloudflare+Node/Vercel deployment, finalize README/graphify) is **confirmed by the user in `memory/decisions.md`** but is **not in this requirements doc** and **not required by any Phase-1 AC**. Before Phase 2 is implemented it must gain first-class FRs/ACs in `docs/requirements-signed-license.md` (and, if the user wants true distinct DB `role` values, a dedicated SQLite table-copy migration with full safeguards — ASK-FIRST). Phase 1 ships independently of this.

---

## 15. Phase 2 — separately-approved later scope (NOT cleared to build in Phase 1)

This section is a **design-level outline** of the user-confirmed scope that is **outside the authoritative `docs/requirements-signed-license.md`** (finding 3). It is recorded so the overall direction is visible and so Phase 1 is designed not to block it, but **none of it is implemented in Phase 1**: Phase 1 adds no `admin_users` column, no `admin_sessions` table, no `DbAdapter`, no Node entry point, no `UsersPage`, and no `JwtPayload.epoch`. Phase 2 is cleared only after it has first-class FRs/ACs in the requirements doc. Nothing in Phase 1's §13 traceability depends on anything below.

### 15.1 Admin + staff user management (NEW-1 / UM-1, UM-2)

Customers never log in (hard invariant, UM-1): they only present a license key to `/api/v1/license/*`. Phase 2 adds staff-account management on top of the existing `admin_users` model only. Roles stay within the published `admin_users.role` CHECK (`super_admin`/`tenant_admin`) — **no table rebuild**; the UI-facing `admin`/`staff` distinction is carried by an additive `is_user_manager` capability column (default 1) added by the Phase-2 migration, with `requireUserManager` gating `/api/admin/users*`. If the user instead wants literal `admin`/`staff` DB `role` values, that is a dedicated SQLite table-copy migration (enumerate every index/trigger, `PRAGMA foreign_key_check` zero rows) — ASK-FIRST, not auto-done, because `activation_batches.created_by`/`activation_codes.created_by` FK and `idx_admin_users_tenant` reference the table. Endpoints: `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id/password|role`, `POST /api/admin/users/:id/kick`, `GET /api/admin/users/:id/sessions`, all Bearer + `requireUserManager`, tenant-scoped, `routes→service→repository`. UI: a new `admin/src/pages/UsersPage.tsx` gated by an `isUserManager` menu check, with `users.*` i18n.

### 15.2 Session management + kick-out on JWT (NEW-2 / UM-3, UM-5)

Admin auth stays a stateless HS256 JWT; `requireAdmin` already re-reads the admin per request. Kick-out is enforced by a monotonic `session_epoch` column on `admin_users` (Phase-2 migration, additive, default 0 so pre-deploy tokens with `epoch` undefined → treated as 0 → no forced logout). `signJwt`/`verifyJwt`/`JwtPayload` gain an additive `epoch` claim; `requireAdmin` rejects when `(payload.epoch ?? 0) !== admin.session_epoch`. A display-only `admin_sessions` audit table lists sessions; enforcement never trusts it (only the epoch), so editing a session row cannot grant access. Kicking or resetting a password increments the epoch.

### 15.3 Forced password change + dev-only bootstrap (NEW-3 / UM-4)

Reuses the existing `must_change_password` flag (migration 0006) and the exempt-paths middleware unchanged. New-user creation and admin resets set the flag. The dev bootstrap password may be `"admin"` for local use only, gated by forced change on first login; production must set a strong `ADMIN_BOOTSTRAP_PASSWORD` (already enforced by `config.ts` placeholder rejection). PBKDF2 hashing unchanged; plaintext never stored.

### 15.4 Dual deployment target — storage/runtime adapter (ADD-1)

The same `routes→service→repository` code runs on both Cloudflare Workers + D1 and Node/Vercel + SQLite via a new `DbAdapter` boundary (`prepare/bind/first/all/run/batch/transaction`). `Repository` would depend on `DbAdapter` instead of `D1Database`. `D1Adapter` delegates 1:1 to `env.DB` (byte-for-byte current behavior, all existing tests green — no logic change); `NodeSqliteAdapter` wraps `node:sqlite` (Node 22 built-in, no new dependency; `better-sqlite3` documented fallback) and provides a real `BEGIN/COMMIT` transaction for `.batch()` (tenant create/delete) and for `createOrReuseSession`. A new `worker/src/entry-node.ts` mounts the same Hono app for a VPS/Vercel handler. **Note:** the Phase-1 atomic activation-slot claim (§5.4) is a *single statement*, so it is portable to both runtimes without needing adapter-level transaction support — Phase 1 does not depend on `DbAdapter`.

### 15.5 Finalize documents (NEW-5 / UM-7, ADD-3)

A refreshed top-level `README.md` (whole-system overview), a complete multi-platform `docs/DEPLOYMENT.md` (Cloudflare native + Node/Vercel adapter path + Ed25519 key generation + rotation runbook + checker build + the honesty constraint that the agent verifies locally and never remote-deploys), and a graphify/architecture-diagram refresh (regenerate `graphify-out/` if the toolchain runs, else an equivalent Mermaid diagram, outcome recorded in `memory/tools-status.md`).

### 15.6 Phase-2 verification

When Phase 2 is cleared, it extends the §10.1 local live e2e with: admin user-management (create/reset/change-role), kick-out invalidating a token on the next request, forced-password-change on first login, and — if the `DbAdapter` lands — running the same e2e against the Node entry point to prove parity. The honesty constraint (local verification only; no agent remote deploy) applies identically.
