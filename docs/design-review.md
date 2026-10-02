# Design Review — Signed License Verification (Ed25519) + Standalone Checker

Reviewer: fresh design-review subagent (no authoring context).
Design under review: `docs/design-signed-license.md` (revision pass 3).
Requirements: `docs/requirements-signed-license.md`.
Governing docs read and cross-checked: `memory/RULES.md`, `AGENTS.md`, `docs/SECURITY.md`.
Source files read for verification: `worker/src/config.ts`, `worker/src/crypto.ts`, `worker/src/routes.ts`, `worker/src/repository.ts` (incl. `findCodeByHash` L319, `createOrReuseSession` L777), `worker/src/service.ts` (`hashDevice` L860, `requireValidClientApp` L702), `migrations/0001_initial.sql`, `migrations/0005_add_sessions_and_lease_settings.sql`, migrations directory listing (latest = `0006`).

This is a security-critical crypto design, so the canonicalization, signature coverage, primitive choice, private-key handling, installation_id HMAC, HOLD authorization, key rotation, migration numbering, admin layering, and the checker's key hygiene were each scrutinized against the actual source, not the design's prose.

---

## Verdict inputs

Count of HIGH findings: 0.
Count of MEDIUM findings: 0.
NIT findings: 5.

Because there are zero HIGH and zero MEDIUM findings, the mechanical verdict is **APPROVED**. The NITs below are worth folding in during implementation but do not block.

---

## Scrutiny of the security-critical items (all PASS)

- **Canonicalization determinism (NFR-2, AC-2/3, AC-16..23).** §4.1 pins: flat object, scalar-only values, keys sorted by default string comparison with the exact 12-key order enumerated, rebuild-then-`JSON.stringify` (not stringify of insertion order), UTF-8 via `TextEncoder`, `Date.prototype.toISOString()` millisecond `...sssZ` form for all three time fields, bare-digit integers constrained to JS safe-integer range with a fail-closed pre-sign assertion, and `true`/`false`/`null` literals. Nested objects and floats are explicitly excluded, with a documented extension rule. Both sides (worker `canonical.ts` and the byte-identical checker copy) are guarded by a REQUIRED cross-implementation fixture test including the `2^53−1 license_id` and `null expires_at` boundary cases. This is deterministic and reproducible byte-for-byte on both sides. No ambiguity rises to a HIGH.

- **Signature covers the whole canonical payload.** §3.1/§4.1/§5.2 sign the canonical bytes of the exact 12-field payload object; the client re-canonicalizes the echoed `payload` and verifies the detached signature against those bytes. Every signed field (incl. `installation_id`, `server_time`, `status`, `key_id`, `protocol_version`) is inside the signed bytes, so each tamper case (AC-16..23) changes the bytes and fails verification. Advisory fields (`public_key_id`, `verification_interval_seconds`) are deliberately outside the signed body and the client is instructed to trust only `payload.key_id`. Correct.

- **Established primitive, no custom crypto (FR-4, NFR-1).** WebCrypto `crypto.subtle` Ed25519 is the primary; `@noble/ed25519` (audited, well-known) is the isolated single-file fallback recorded in `decisions.md` only if a runtime gap is proven by the §10.1 smoke test. `crypto.ts` already proves `crypto.subtle` is the project's crypto surface (HMAC/PBKDF2 verified). No bespoke signing math. Correct. (The runtime-availability caveat is handled honestly as NIT 1 below.)

- **Private key never leaks (NFR-1, AC-5/46).** `LICENSE_SIGNING_PRIVATE_KEY` is env-only, imported once and cached, never returned, never logged, never committed; signed responses carry only the public `key_id`; security events store only HMACs/allowlisted codes; the checker ships `config/publicKeys.ts` with public keys only and a repo scan asserts no private key. Tests scan responses/logs for key material (AC-5). Correct.

- **installation_id stored only as HMAC (A-3).** §5.2 step 5 computes `installation_hash = HMAC(DEVICE_HMAC_SECRET, installation_id)` reusing `hashDevice` (verified at `service.ts:860` to HMAC with `DEVICE_HMAC_SECRET`). `code_activations.installation_hash` and `security_events.installation_hash` store the HMAC; the raw value is echoed back inside the signed payload (so tampering is detectable) but never persisted or logged. Admin reads expose a `has_installation` boolean, not the hash. Correct.

- **HOLD actually blocks authorization (FR-6, AC-10).** `deriveSignedStatus` (§5.1) ranks `hold_at IS NOT NULL → "hold"` above `suspended`, `expired`, and `active`, so a held license can never derive to `active`. The signed `status:"hold"` is returned HTTP 200 signed so a MITM cannot downgrade it to silence. `hold_at` is a dedicated column independent of `status`/`disabled_at`, making Approve a clean restore. Correct.

- **Key rotation coherent (FR-12, AC-26/36/37).** Every payload stamps `key_id`; clients hold a `{key_id → public_key}` map with current + previous keys; an unknown `key_id` is rejected (AC-26); documented 4-step rotation (generate, publish, promote + move old to `PREVIOUS`, drop after overlap). Previous-key env vars are optional and validated only if present. Coherent.

- **Migration respects the 0007 rule (FR-15, AC-47/48).** Latest migration on disk is `0006` (verified). Phase 1 adds exactly one additive forward migration `0007_add_signed_license.sql` (ALTER ADD COLUMN + CREATE TABLE IF NOT EXISTS), edits no published migration, and the Phase-2 `admin_users`/`admin_sessions` schema is explicitly held to a later `0008` not created by Phase 1. The persisted `activation_codes.status` CHECK (`unused/active/deleted`), `disabled_at`, `expires_at`, `device_hash`, `rebind_count` all exist in `0001` as the design assumes. Correct.

- **Admin powers within existing patterns (FR-10, NFR-4, AC-32..35).** New endpoints live under `/api/admin/*`, Bearer-protected by `requireAdmin`, tenant-resolved via `resolveTenantId`, follow `routes → service → repository`, bound SQL with `app_id IN (SELECT id FROM apps WHERE tenant_id = ?)` guards, re-verify tenant on writes-by-id. Revoke/Delete reuse the existing soft-delete endpoint; only Hold/Approve/Validity/Max-activations/two views are new. Consistent with SECURITY.md and AGENTS.md layering.

- **Checker is private-key-free (FR-14, AC-46).** Only `config/publicKeys.ts` with public keys; app_secret is the user's own local config (consistent with OQ-1/A-2 and SECURITY.md's "client request body" classification for `app_secret`); a content scan asserts no private key. Correct.

- **Activation-limit atomicity (AC-12/13) — the pass-2 HIGH, now resolved.** The prior review's HIGH (count-then-insert race, false `transaction()` claim) is genuinely fixed. §5.4 now uses one statement — `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ... active) < max_activations ON CONFLICT(code_id, installation_hash) DO UPDATE ...` — and no longer claims a `DbAdapter.transaction()`. On D1 the subquery count and the insert evaluate within a single prepared statement against a serialized single-SQLite-instance writer, so two distinct installations cannot both observe a stale count; `node:sqlite` evaluates the same single statement identically. `createOrReuseSession` (verified at `repository.ts:777` to be a non-atomic `SELECT COUNT → INSERT` whose `UNIQUE` is on `session_token_hash`) is accurately described and explicitly NOT copied. `activation_allowed` is derived from a confirming `SELECT`, avoiding reliance on dialect-specific `meta.changes` for the conflict-update branch. This is sound.

---

## Findings

### 1. NIT — WebCrypto Ed25519 availability is an external runtime fact, mitigated but not pre-proven
Where: §4.2.
What: The design states the Workers runtime "is expected to support" `crypto.subtle` Ed25519 and only HMAC/PBKDF2 are proven in-repo (confirmed: `crypto.ts` uses `crypto.subtle` for HMAC/PBKDF2 only). This is handled honestly — a §10.1 live smoke test gates the choice and `@noble/ed25519` is the isolated fallback — so it is not a feasibility gap, but the design proceeds on an unverified primitive-availability assumption until implementation.
Concrete fix: Keep the §10.1 `importKey`/`sign`/`verify` Ed25519 smoke test as the FIRST step of the finalize e2e and treat its pass/fail as the gate that decides WebCrypto-vs-noble; record the actual outcome in `memory/decisions.md` (SL-1) with pasted output per RULES §5, so "no new dependency" is a verified result rather than an expectation.

### 2. NIT — AC-2 "exactly twelve fields" depends on a requirements edit the design says it already applied
Where: §0.1, §3.2; requirements FR-2/AC-2.
What: The design claims it edited `docs/requirements-signed-license.md` so FR-2/AC-2 enumerate all twelve fields including `activation_allowed`. The authoritative requirements file I read does list all twelve (FR-2 and AC-2 both include `activation_allowed`), so the two agree today. The residual risk is purely process: a design doc asserting it mutated the requirements doc is a coupling that can silently drift if either is regenerated.
Concrete fix: Add a one-line conformance test (already implied in §10) that asserts the signed payload key set equals the AC-2 enumerated set from a single shared constant, so neither doc nor code can drift without a red test. No wording change needed to the requirements.

### 3. NIT — `issued_at == server_time` duplication is carried without a current consumer
Where: §3.2.
What: `issued_at` and `server_time` are specified as always equal "by construction," kept only because FR-2 names them separately and "a future protocol version may diverge them." Shipping two identical signed fields with no divergence rule is mild scope the client must still validate.
Concrete fix: Either (a) keep both but document in `CLIENT_INTEGRATION.md` that in `protocol_version: 1` the client MUST treat them as required-equal and reject a payload where `issued_at != server_time` (turning the redundancy into an extra tamper check), or (b) note explicitly that the client ignores `issued_at` in v1. Pick (a); it adds a free integrity assertion rather than dead weight.

### 4. NIT — Freshness predicate accepts in-window replays; stated as out of scope but the max-age SKEW is a soft knob
Where: §8.4 (steps 3 and 5), OQ-8.
What: The replay defense is `server_time` monotonicity + a max-age of `verification_interval_seconds + SKEW` (SKEW = 300s). A replay of a still-in-window response is explicitly accepted (nonce deferred to future hardening). This matches the requirements' AC-28 "using `server_time` (and any documented freshness rule)" and OQ-8's stateless default, so it meets the bar — but a server-controlled `verification_interval_seconds` means a misconfigured large interval widens the replay window silently.
Concrete fix: Document a hard client-side ceiling on the accepted max-age (e.g. `min(verification_interval_seconds, 86400) + SKEW`) in `CLIENT_INTEGRATION.md` and the checker so a server hint cannot push the replay window arbitrarily wide; record the nonce option as the OQ-8 follow-up.

### 5. NIT — `app_secret` shipped in the checker/desktop is a shared-secret auto-hold DoS surface; default is correct but document the residual risk at the contract level
Where: §3.3, §6.3, §14 (OQ-1), SECURITY.md threat-model rows planned in §11.
What: Because `/verify` and `/report` authenticate with `app_id` + `app_secret` (A-2) and that secret is shared across all installations of an app, any holder can submit reports. The design correctly defaults auto-hold to require corroboration (N≥2 distinct `installation_hash`, single-report-immediate-hold OFF) and routes the real fix (device-scoped token) through OQ-1 ASK-FIRST. This is a reasonable Phase-1 posture, not a defect.
Concrete fix: Ensure the `CLIENT_INTEGRATION.md` contract states plainly that `app_secret` is a shared app credential (not a per-device identity), that `/report` is therefore advisory and rate-limited by corroboration, and carry OQ-1's device-token alternative as the documented path if the desktop threat model later forbids shipping `app_secret`. No code change for Phase 1.

---

## Verified Assumptions

- A-1 / `product_id` = `app.app_id`: consistent with `apps.app_id` (verified `migrations/0001`) and §3.1 validation `product_id === app.app_id`. ✓
- A-2 / signed endpoint requires `app_secret`: §3.1/§5.2 reuse `requireValidClientApp` (verified `service.ts:702`, validates `app_id` + secret). ✓
- A-3 / installation_id HMAC: §5.2 reuses `hashDevice` (verified `service.ts:860` HMAC with `DEVICE_HMAC_SECRET`). ✓
- A-4/A-5 / signed status derived, not a rename: `activation_codes.status` CHECK is `('unused','active','deleted')` with separate `disabled_at`/`expires_at` (verified `migrations/0001`); `deriveSignedStatus` (§5.1) maps onto these without altering the persisted enum. ✓
- A-7 / grace from `plans.grace_period_seconds`: column exists (verified `migrations/0005`); `findCodeByHash` already selects it (verified `repository.ts:319` selects `p.grace_period_seconds`). ✓
- `findCodeByHash` selects `c.*` so new columns flow automatically (§2.2): verified `repository.ts:319`. ✓
- `createOrReuseSession` is a non-atomic `SELECT COUNT → INSERT` with `UNIQUE(session_token_hash)` (§2.3/§5.4 characterization): verified `repository.ts:777`. ✓
- `validateEnv` is per-request middleware with an exact-equality placeholder check against `"replace-with-a-long-random-secret"` over `CORE_SECRET_KEYS` (§4.3, finding-2 correction): verified `config.ts` + `routes.ts:22-25` (`api.use("*", ...)`). ✓
- `bytesToBase64Url` / `base64UrlToBytes` are currently module-private in `crypto.ts` and must be exported (§4.2, SL-16): verified `crypto.ts` (no `export` on either). ✓
- Latest migration is `0006`; next is `0007` (FR-15/AC-47): verified by directory listing (`0001`–`0006` present). ✓
- `admin_users` is FK-referenced by `activation_batches.created_by` / `activation_codes.created_by` (Phase-2 §15.1 table-copy risk note): verified `migrations/0001`. ✓
- Admin layering `routes → service → repository`, Bearer `requireAdmin`, tenant guards (§7): consistent with AGENTS.md Code Boundaries and SECURITY.md Endpoint Security.
- D1 single-statement atomicity for the conditional slot insert (§5.4): sound given D1's serialized single-SQLite-instance write model; the statement is one prepared statement, not a read-then-write pair.

## Unverified / Wrong Assumptions

- **UNVERIFIED (external runtime): `crypto.subtle` Ed25519 availability on the target Workers `compatibility_date`.** Not demonstrable from the repo (only HMAC/PBKDF2 are proven). The design mitigates with a gated smoke test + `@noble` fallback, so it is tracked as NIT 1, not a blocker. (`crypto.ts`, §4.2/§10.1)
- **No wrong assumptions found in this pass.** The two mischaracterizations flagged by the pass-2 review — the `createOrReuseSession` "CAS" overstatement and the "fails fast at startup" mechanism — are corrected in this revision: §5.4/§2.3 now describe `createOrReuseSession` accurately as non-atomic and not copied (matches `repository.ts:777`), and §1/§4.3/§9 now state env validation runs in per-request `validateEnv` middleware with an exact-equality placeholder check (matches `config.ts` + `routes.ts`). The prior "prefix match" wording is gone; §4.3 explicitly calls it an equality test. Verified correct.

---

## Conclusion

Every security-critical item the review was charged to scrutinize passes against the actual source: the canonicalization is deterministic and byte-reproducible, the signature covers the whole payload, the primitive is established (with an honest, gated fallback), the private key is structurally confined to env and never emitted, `installation_id` is HMAC-only, HOLD outranks `active` in derivation, key rotation is coherent, the migration is a single additive `0007` that touches no published migration, admin powers stay inside the Bearer/tenant/layering patterns, and the checker holds only public keys. The pass-2 HIGH (activation-limit atomicity) and MEDIUMs (startup-validation mechanism, scope fencing, AC-2 field set, number formatting) are genuinely resolved and re-verified. The five remaining items are NITs.

Zero HIGH + zero MEDIUM ⇒ **APPROVED**.
