# Client Integration Guide (Signed License)

This document is the complete contract for a client that verifies a signed license against the License Manager server. It covers the configurable server URL, the `/api/v1/license/verify` and `/api/v1/license/report` shapes, the exact byte canonical form, signature verification, the public-key map and rotation, protocol and key-id handling, the freshness/replay predicate, and `activation_allowed`.

The reference implementation of every rule below is the standalone `license-checker/` package (`src/lib/canonical.ts`, `src/lib/verify.ts`, `src/lib/base64url.ts`, `src/config/publicKeys.ts`). The server side is in [API.md](API.md#signed-license-client-endpoints-apiv1) and the trust model is in [SECURITY.md](SECURITY.md#signed-license-threat-model).

## Configurable Server URL

The server base URL is **never hardcoded** in the client. The user supplies it (the deployment URL changes over time), and the client joins it with the fixed paths:

- `{base}/api/v1/license/verify`
- `{base}/api/v1/license/report`

Only the path suffix (`/api/v1/license/...`) and the `protocol_version` are fixed; everything else (base URL, license key, product id, installation id, app secret) is provided per installation.

## Verify Request and Response

`POST {base}/api/v1/license/verify`

Request body (JSON):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `app_id` | string | yes | Application id |
| `app_secret` | string | yes | Application secret; body only, never a URL/query |
| `license_key` | string | yes | The license key |
| `product_id` | string | yes | Must equal the app's public `app_id` |
| `installation_id` | string | yes | Stable per-installation id; echoed in the payload |
| `application_version` | string | no | Optional client version |
| `protocol_version` | integer | yes | `>= 1`; currently `1` |

Success response uses the shared envelope `{ "ok": true, "data": { ... } }`, where `data` is:

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

- `signature` is a detached base64url Ed25519 signature over the canonical byte form of `payload`.
- `public_key_id` duplicates `payload.key_id`.
- `verification_interval_seconds` is the recommended re-verify cadence and feeds the freshness predicate.

Business "no" outcomes (`expired`, `revoked`, `suspended`, `hold`, over the activation limit) still return a signed `200` with the true `status` and `activation_allowed: false`. Hard failures are unsigned HTTP errors with a stable `error.code` (`INVALID_CODE`, `PROTOCOL_UNSUPPORTED`, `INVALID_APP_SECRET`, `BAD_REQUEST`); treat the absence of a verifiable signed payload as "license failed to load".

## Report Request and Response

`POST {base}/api/v1/license/report`

Use this to report a client-side anomaly (e.g. a signature that failed to verify). Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `app_id` | string | yes | |
| `app_secret` | string | yes | |
| `installation_id` | string | yes | |
| `license_key` or `license_id` | string / integer | exactly one | Both or neither is `400 BAD_REQUEST` |
| `reason_code` | string | yes | One of the `SECURITY_REASON_CODE` values |
| `detail` | string | no | Short note, truncated server-side |

`reason_code` allowlist (from `worker/src/constants.ts`): `SIGNATURE_INVALID`, `PAYLOAD_TAMPERED`, `CLOCK_ROLLBACK`, `KEY_ID_UNKNOWN`, `PROTOCOL_UNSUPPORTED`, `REPLAY_SUSPECTED`, `MALFORMED_RESPONSE`.

Success `data`:

```json
{
  "recorded": true,
  "held": true
}
```

`held` is `true` only when the corroborated auto-hold threshold is met (see [SECURITY.md](SECURITY.md#signed-license-threat-model)).

## Exact Byte Canonical Form (§4.1)

The message that is signed and verified is the UTF-8 byte encoding of the payload serialized with a pinned, deterministic form. Both the server (`worker/src/license/canonical.ts`) and the client (`license-checker/src/lib/canonical.ts`) must produce byte-identical output.

Rules:

1. The payload has exactly these 12 keys, emitted in this fixed lexicographic order:
   `activation_allowed`, `expires_at`, `grace_period_seconds`, `installation_id`, `issued_at`, `key_id`, `license_id`, `plan`, `product_id`, `protocol_version`, `server_time`, `status`.
2. Rebuild the object by inserting the keys in that order, then serialize with `JSON.stringify` (scalars only, so there is no whitespace and no key reordering).
3. UTF-8 encode the resulting string with `TextEncoder`. Those bytes are the signed message.
4. Values are only `string`, integer `number`, `boolean`, or `null`. Time fields use ISO-8601 strings (`expires_at` may be `null`).
5. The integer fields `grace_period_seconds`, `license_id`, and `protocol_version` must be JS safe integers (`Number.isInteger` and magnitude `<= 2^53 - 1`). A non-conforming field fails closed (throws before producing bytes), so a bad payload is never signed or trusted.

To verify, the client rebuilds the canonical bytes from the received `payload` with the identical algorithm and checks the signature over those bytes. Any field tampering changes the bytes and fails verification.

## base64url Encoding

Signatures and public keys use the base64url variant: `+` becomes `-`, `/` becomes `_`, and padding `=` is dropped. Decode by reversing the substitutions and re-padding to a multiple of 4. The reference is `license-checker/src/lib/base64url.ts`, kept byte-identical to `worker/src/crypto.ts`.

## Signature Verification Steps

Given `payload`, `signature`, and the client's expectations (`product_id`, `installation_id`, `verification_interval_seconds`, and the stored last-seen `server_time`):

1. Re-canonicalize `payload` locally (step above). A payload that fails the canonical guard is `MALFORMED_RESPONSE`.
2. Look up `payload.key_id` in the embedded public-key map. An unknown id is `KEY_ID_UNKNOWN` (never trust a key the client was not shipped).
3. Verify the detached Ed25519 `signature` over the canonical bytes with that public key. A missing or invalid signature is `SIGNATURE_INVALID`.
4. Check `payload.product_id` equals the expected product (`PRODUCT_MISMATCH`).
5. Check `payload.installation_id` equals this installation (`INSTALLATION_MISMATCH`).
6. Check `payload.protocol_version` is supported (`PROTOCOL_UNSUPPORTED`).
7. Apply the freshness predicate (below). On any failure, surface a clear "license failed to load" state with the specific reason; optionally report it with the matching reason code.

Prefer `crypto.subtle` Ed25519 and feature-detect it once at startup (import a known public key); fall back to a pure library such as `@noble/ed25519` only if the runtime lacks it. All verification stays in one module so the choice is isolated.

## Public-Key Map and Rotation

The client ships a map of `key_id -> base64url 32-byte raw public key` and trusts **only** the key named by the signed `payload.key_id`. It holds **public keys only**; a private key must never appear in the client.

To support rotation, keep both the current and the previous key in the map so a client still trusts a payload signed just before a rotation. See the key-rotation runbook in [DEPLOYMENT.md](DEPLOYMENT.md#key-rotation-runbook). A payload whose `key_id` is absent from the map is rejected as `KEY_ID_UNKNOWN`.

Reference: `license-checker/src/config/publicKeys.ts`.

## Protocol Version Handling

The client sends a fixed `protocol_version` (currently `1`) in each verify request. The server rejects an unsupported version with `400 PROTOCOL_UNSUPPORTED`. The client also checks the `protocol_version` in the returned payload against its own supported set and rejects a mismatch, so a payload cannot be reinterpreted under a different protocol than the client understands.

## key_id Handling

`key_id` identifies which key signed the payload. The client never infers the key from anything other than the signed `key_id`, and it must find that id in its public-key map before verifying. `public_key_id` in the envelope duplicates `payload.key_id`; treat the signed `payload.key_id` as authoritative.

## Freshness / Replay Predicate (§8.4)

To defeat replay and clock rollback, the client stores the highest `server_time` it has accepted for each license (the freshness anchor) and applies this predicate against the new `payload.server_time`, using a fixed clock-skew allowance of **300 seconds** and the response's `verification_interval_seconds`:

1. First check ever for this license (no stored anchor): accept and anchor to `server_time` (subject to the max-age check below).
2. If `server_time` is earlier than the stored anchor: reject as `CLOCK_ROLLBACK` (replay or a clock set backward).
3. Max-age: if `now - server_time` exceeds `verification_interval_seconds + 300`, reject as `STALE`.
4. If `server_time` equals the anchor: accept (idempotent re-check).
5. On accept, the new anchor is `max(stored anchor, server_time)`; persist it.

A `server_time` that is not a valid timestamp is `MALFORMED_RESPONSE`. The predicate is pure: it returns the next anchor to persist and never mutates storage itself. Reference: `evaluateFreshness` in `license-checker/src/lib/verify.ts`.

## activation_allowed Handling

`activation_allowed` is the authoritative "may this installation run" signal. It is `true` only when the derived `status` is `active` and this installation holds (or could claim) an activation slot. Treat the combination as follows:

- `status: "active"` and `activation_allowed: true`: fully licensed; run normally.
- `activation_allowed: false` with `status: "active"`: the activation limit is reached for other installations; this installation is not authorized. No slot is consumed by a refused verify, and an installation that already holds a slot always re-verifies `true`.
- `status` other than `active` (`expired`, `revoked`, `suspended`, `hold`): the license is not usable; `activation_allowed` is `false`. Show the specific status.

The client must not run on a verified payload when `activation_allowed` is `false`, regardless of `status`. Enforcement between verifies is client-side within the freshness window and the server-supplied grace period; the server cannot reach a client it is offline from.
