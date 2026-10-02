// Cross-implementation determinism fixtures (design §10, NFR-2).
//
// These values were produced by the WORKER's own canonicalization + Ed25519
// signing (worker/src/license/canonical.ts + signing.ts) run against the project
// dev/test keypair (worker/test/helpers/harness.ts TEST_SECRETS). The checker's
// lib/canonical.ts and lib/verify.ts must reproduce them byte-for-byte; if either
// side drifts, the fixture tests fail. PUBLIC key only — no signing secret here.
//
// To regenerate: run the worker canonicalize+sign over these payloads with the
// TEST_SECRETS keypair and paste the base64url canonical bytes + signature.

import type { LicensePayload } from "../canonical";

export const FIXTURE_PUBLIC_KEY = "TOwxe9EweGiDchaoYOmHY_GuOZrgMiZAkueFVVmBxTQ";
export const FIXTURE_KEY_ID = "ed25519-test";

export type CanonicalFixture = {
  payload: LicensePayload;
  /** The exact JSON string the worker produced (canonical bytes, UTF-8). */
  canonicalJson: string;
  /** base64url of the canonical UTF-8 bytes. */
  canonicalBase64Url: string;
  /** base64url detached Ed25519 signature over the canonical bytes. */
  signature: string;
};

// Standard payload.
export const BASE_FIXTURE: CanonicalFixture = {
  payload: {
    activation_allowed: true,
    expires_at: "2027-01-01T00:00:00.000Z",
    grace_period_seconds: 3600,
    installation_id: "install-abc-123",
    issued_at: "2026-06-16T12:00:00.000Z",
    key_id: "ed25519-test",
    license_id: 42,
    plan: "pro",
    product_id: "app_demo",
    protocol_version: 1,
    server_time: "2026-06-16T12:00:00.000Z",
    status: "active"
  },
  canonicalJson:
    '{"activation_allowed":true,"expires_at":"2027-01-01T00:00:00.000Z","grace_period_seconds":3600,"installation_id":"install-abc-123","issued_at":"2026-06-16T12:00:00.000Z","key_id":"ed25519-test","license_id":42,"plan":"pro","product_id":"app_demo","protocol_version":1,"server_time":"2026-06-16T12:00:00.000Z","status":"active"}',
  canonicalBase64Url:
    "eyJhY3RpdmF0aW9uX2FsbG93ZWQiOnRydWUsImV4cGlyZXNfYXQiOiIyMDI3LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJncmFjZV9wZXJpb2Rfc2Vjb25kcyI6MzYwMCwiaW5zdGFsbGF0aW9uX2lkIjoiaW5zdGFsbC1hYmMtMTIzIiwiaXNzdWVkX2F0IjoiMjAyNi0wNi0xNlQxMjowMDowMC4wMDBaIiwia2V5X2lkIjoiZWQyNTUxOS10ZXN0IiwibGljZW5zZV9pZCI6NDIsInBsYW4iOiJwcm8iLCJwcm9kdWN0X2lkIjoiYXBwX2RlbW8iLCJwcm90b2NvbF92ZXJzaW9uIjoxLCJzZXJ2ZXJfdGltZSI6IjIwMjYtMDYtMTZUMTI6MDA6MDAuMDAwWiIsInN0YXR1cyI6ImFjdGl2ZSJ9",
  signature:
    "jodf0dBI-howF3zda-UR0hDg7Ol8tZUVri6XpL60XtpDgtZ7aCn4oSbD6Sn0z9znavZ_-SUS8Tz64UjDVNhNCQ"
};

// Boundary payload: license_id = 2^53-1 (largest safe integer) and expires_at = null.
export const BOUNDARY_FIXTURE: CanonicalFixture = {
  payload: {
    activation_allowed: false,
    expires_at: null,
    grace_period_seconds: 0,
    installation_id: "x",
    issued_at: "2026-06-16T12:00:00.000Z",
    key_id: "ed25519-test",
    license_id: 9007199254740991,
    plan: "free",
    product_id: "app_demo",
    protocol_version: 1,
    server_time: "2026-06-16T12:00:00.000Z",
    status: "expired"
  },
  canonicalJson:
    '{"activation_allowed":false,"expires_at":null,"grace_period_seconds":0,"installation_id":"x","issued_at":"2026-06-16T12:00:00.000Z","key_id":"ed25519-test","license_id":9007199254740991,"plan":"free","product_id":"app_demo","protocol_version":1,"server_time":"2026-06-16T12:00:00.000Z","status":"expired"}',
  canonicalBase64Url:
    "eyJhY3RpdmF0aW9uX2FsbG93ZWQiOmZhbHNlLCJleHBpcmVzX2F0IjpudWxsLCJncmFjZV9wZXJpb2Rfc2Vjb25kcyI6MCwiaW5zdGFsbGF0aW9uX2lkIjoieCIsImlzc3VlZF9hdCI6IjIwMjYtMDYtMTZUMTI6MDA6MDAuMDAwWiIsImtleV9pZCI6ImVkMjU1MTktdGVzdCIsImxpY2Vuc2VfaWQiOjkwMDcxOTkyNTQ3NDA5OTEsInBsYW4iOiJmcmVlIiwicHJvZHVjdF9pZCI6ImFwcF9kZW1vIiwicHJvdG9jb2xfdmVyc2lvbiI6MSwic2VydmVyX3RpbWUiOiIyMDI2LTA2LTE2VDEyOjAwOjAwLjAwMFoiLCJzdGF0dXMiOiJleHBpcmVkIn0",
  signature:
    "dYOXNPk0pV_kBRqjRxedrvkHk6BKW97piv79o0OVtBBl_LqGXJJjBpu4_ijWMWiR9cige0vLxtd4p3O03reBBw"
};

// A base64url round-trip fixture (worker crypto.ts bytesToBase64Url of UTF-8 "license fixture").
export const BASE64URL_ROUNDTRIP = {
  text: "license fixture",
  base64Url: "bGljZW5zZSBmaXh0dXJl"
};
