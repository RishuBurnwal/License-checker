import { describe, expect, it } from "vitest";
import { validateEnv } from "../src/config";
import { CODE_STATUS } from "../src/constants";
import { CANONICAL_KEYS, canonicalize, type LicensePayload } from "../src/license/canonical";
import {
  deriveSignedStatus,
  SIGNED_STATUS,
  SIGNED_STATUS_NOT_ACTIVATABLE
} from "../src/license/status";
import { loadPublicKeyMaterial, signPayload, verifySignature } from "../src/license/signing";
import type { ActivationCodeRow, Bindings } from "../src/types";

// Dev-only Ed25519 keypair (mirrors worker/test/helpers/harness.ts TEST_SECRETS):
// PKCS8 private (48 bytes) + raw public (32 bytes), base64url. Not a production key.
const SIGNING_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIJFuo2oq6mwiwNj6jABiYJTFdTSh_tN96k2x56qlpjRL";
const SIGNING_PUBLIC_KEY = "TOwxe9EweGiDchaoYOmHY_GuOZrgMiZAkueFVVmBxTQ";
const SIGNING_KEY_ID = "ed25519-test";

const signingEnv = {
  LICENSE_SIGNING_PRIVATE_KEY: SIGNING_PRIVATE_KEY,
  LICENSE_SIGNING_PUBLIC_KEY: SIGNING_PUBLIC_KEY,
  LICENSE_SIGNING_KEY_ID: SIGNING_KEY_ID
} as unknown as Bindings;

const validEnv = {
  DB: {} as D1Database,
  ASSETS: {} as Fetcher,
  JWT_SECRET: "jwt-secret",
  CODE_HMAC_SECRET: "code-secret",
  APP_SECRET_HMAC_SECRET: "app-secret-secret",
  DEVICE_HMAC_SECRET: "device-secret",
  LICENSE_SIGNING_PRIVATE_KEY: SIGNING_PRIVATE_KEY,
  LICENSE_SIGNING_PUBLIC_KEY: SIGNING_PUBLIC_KEY,
  LICENSE_SIGNING_KEY_ID: SIGNING_KEY_ID
} as Bindings;

function samplePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    activation_allowed: true,
    expires_at: "2026-12-31T23:59:59.000Z",
    grace_period_seconds: 0,
    installation_id: "stable-installation-id",
    issued_at: "2026-06-16T00:00:00.000Z",
    key_id: SIGNING_KEY_ID,
    license_id: 42,
    plan: "monthly",
    product_id: "app_demo",
    protocol_version: 1,
    server_time: "2026-06-16T00:00:00.000Z",
    status: SIGNED_STATUS.ACTIVE,
    ...overrides
  };
}

const decoder = new TextDecoder();

describe("canonicalize", () => {
  it("emits the exactly 12 keys in lexicographic sorted order (AC-2)", () => {
    const json = decoder.decode(canonicalize(samplePayload()));
    const keys = Object.keys(JSON.parse(json));
    expect(keys).toEqual([...CANONICAL_KEYS]);
    expect(keys).toHaveLength(12);
    // The expected sorted order, stated independently of the module constant.
    expect(keys).toEqual([
      "activation_allowed",
      "expires_at",
      "grace_period_seconds",
      "installation_id",
      "issued_at",
      "key_id",
      "license_id",
      "plan",
      "product_id",
      "protocol_version",
      "server_time",
      "status"
    ]);
  });

  it("is deterministic byte-for-byte regardless of input key insertion order", () => {
    const a = canonicalize(samplePayload());
    const reordered: LicensePayload = {
      status: SIGNED_STATUS.ACTIVE,
      server_time: "2026-06-16T00:00:00.000Z",
      protocol_version: 1,
      product_id: "app_demo",
      plan: "monthly",
      license_id: 42,
      key_id: SIGNING_KEY_ID,
      issued_at: "2026-06-16T00:00:00.000Z",
      installation_id: "stable-installation-id",
      grace_period_seconds: 0,
      expires_at: "2026-12-31T23:59:59.000Z",
      activation_allowed: true
    };
    const b = canonicalize(reordered);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("formats the safe-integer boundary license_id as bare digits (2^53 - 1)", () => {
    const json = decoder.decode(canonicalize(samplePayload({ license_id: 9007199254740991 })));
    expect(json).toContain('"license_id":9007199254740991');
    expect(json).not.toContain("9007199254740991.0");
    expect(json).not.toContain("e+");
  });

  it("formats a null expires_at as JSON null", () => {
    const json = decoder.decode(canonicalize(samplePayload({ expires_at: null })));
    expect(json).toContain('"expires_at":null');
  });

  it("fails closed when an integer field is a float (never signs a bad payload)", () => {
    expect(() => canonicalize(samplePayload({ grace_period_seconds: 1.5 }))).toThrowError(
      /grace_period_seconds is not a safe integer/
    );
  });

  it("fails closed when an integer field is >= 2^53", () => {
    expect(() => canonicalize(samplePayload({ license_id: Number.MAX_SAFE_INTEGER + 1 }))).toThrowError(
      /license_id is not a safe integer/
    );
  });
});

describe("signPayload / verifySignature round-trip (AC-3, AC-14)", () => {
  it("produces a signature that verifies against a genuine payload", async () => {
    const bytes = canonicalize(samplePayload());
    const signature = await signPayload(signingEnv, bytes);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    const ok = await verifySignature(SIGNING_PUBLIC_KEY, bytes, signature);
    expect(ok).toBe(true);
  });

  it("rejects a signature verified against the wrong bytes", async () => {
    const signature = await signPayload(signingEnv, canonicalize(samplePayload()));
    const otherBytes = canonicalize(samplePayload({ license_id: 43 }));
    const ok = await verifySignature(SIGNING_PUBLIC_KEY, otherBytes, signature);
    expect(ok).toBe(false);
  });

  // AC-16..23: mutating any signed field invalidates the signature.
  const tamperCases: Array<[string, Partial<LicensePayload>]> = [
    ["expires_at", { expires_at: "2099-01-01T00:00:00.000Z" }],
    ["status", { status: SIGNED_STATUS.EXPIRED }],
    ["license_id", { license_id: 9999 }],
    ["installation_id", { installation_id: "attacker-installation" }],
    ["plan", { plan: "yearly" }],
    ["server_time", { server_time: "2000-01-01T00:00:00.000Z" }],
    ["protocol_version", { protocol_version: 2 }],
    ["key_id", { key_id: "ed25519-forged" }],
    ["activation_allowed", { activation_allowed: false }],
    ["grace_period_seconds", { grace_period_seconds: 86400 }],
    ["issued_at", { issued_at: "2000-01-01T00:00:00.000Z" }],
    ["product_id", { product_id: "app_other" }]
  ];

  for (const [field, override] of tamperCases) {
    it(`rejects a tampered ${field} (AC-16..23)`, async () => {
      const original = samplePayload();
      const signature = await signPayload(signingEnv, canonicalize(original));
      const tamperedBytes = canonicalize(samplePayload(override));
      const ok = await verifySignature(SIGNING_PUBLIC_KEY, tamperedBytes, signature);
      expect(ok).toBe(false);
    });
  }
});

describe("loadPublicKeyMaterial", () => {
  it("returns the configured current key material with no previous key", () => {
    const material = loadPublicKeyMaterial(signingEnv);
    expect(material).toEqual({
      keyId: SIGNING_KEY_ID,
      publicKey: SIGNING_PUBLIC_KEY,
      previousKeyId: null,
      previousPublicKey: null
    });
  });
});

describe("deriveSignedStatus (AC-6..10)", () => {
  const now = new Date("2026-06-16T00:00:00.000Z");

  function code(overrides: Partial<ActivationCodeRow>): ActivationCodeRow {
    return {
      id: 1,
      batch_id: null,
      app_id: 1,
      plan_id: 1,
      code_hash: "hash",
      code_suffix: "ABCDEF",
      status: CODE_STATUS.ACTIVE,
      disabled_at: null,
      activated_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-12-31T23:59:59.000Z",
      device_hash: null,
      rebind_count: 0,
      last_rebind_at: null,
      hold_at: null,
      hold_reason_code: null,
      max_activations: null,
      created_by: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      ...overrides
    };
  }

  it("maps deleted => revoked", () => {
    expect(deriveSignedStatus(code({ status: CODE_STATUS.DELETED }), now)).toBe(SIGNED_STATUS.REVOKED);
  });

  it("maps hold_at set => hold (outranks suspended/expired)", () => {
    expect(
      deriveSignedStatus(code({ hold_at: "2026-06-01T00:00:00.000Z", disabled_at: "2026-06-01T00:00:00.000Z" }), now)
    ).toBe(SIGNED_STATUS.HOLD);
  });

  it("maps disabled_at set => suspended", () => {
    expect(deriveSignedStatus(code({ disabled_at: "2026-06-01T00:00:00.000Z" }), now)).toBe(
      SIGNED_STATUS.SUSPENDED
    );
  });

  it("maps active + past expiry => expired", () => {
    expect(deriveSignedStatus(code({ expires_at: "2026-01-01T00:00:00.000Z" }), now)).toBe(
      SIGNED_STATUS.EXPIRED
    );
  });

  it("maps active + future expiry => active", () => {
    expect(deriveSignedStatus(code({ expires_at: "2027-01-01T00:00:00.000Z" }), now)).toBe(
      SIGNED_STATUS.ACTIVE
    );
  });

  it("maps unused => not-activatable sentinel", () => {
    expect(deriveSignedStatus(code({ status: CODE_STATUS.UNUSED, expires_at: null }), now)).toBe(
      SIGNED_STATUS_NOT_ACTIVATABLE
    );
  });
});

describe("validateEnv signing-key guard (AC-40)", () => {
  it("throws 500 CONFLICT on a missing signing key", () => {
    const env = { ...validEnv, LICENSE_SIGNING_PRIVATE_KEY: "" };
    expect(() => validateEnv(env)).toThrowError("LICENSE_SIGNING_PRIVATE_KEY is not configured");
  });

  it("throws 500 CONFLICT on the placeholder signing key", () => {
    const env = { ...validEnv, LICENSE_SIGNING_PRIVATE_KEY: "replace-with-a-signing-key" };
    expect(() => validateEnv(env)).toThrowError(
      "LICENSE_SIGNING_PRIVATE_KEY must not use the example placeholder value"
    );
  });

  it("throws 500 CONFLICT on a malformed (wrong-length) signing key", () => {
    const env = { ...validEnv, LICENSE_SIGNING_PRIVATE_KEY: "TOwxe9EweGiDchaoYOmHY_GuOZrgMiZAkueFVVmBxTQ" };
    expect(() => validateEnv(env)).toThrowError(
      "LICENSE_SIGNING_PRIVATE_KEY is not a valid Ed25519 private key"
    );
  });
});

describe("no private key material leaks into produced strings (AC-5)", () => {
  it("the signature output does not contain the private key", async () => {
    const signature = await signPayload(signingEnv, canonicalize(samplePayload()));
    expect(signature).not.toContain(SIGNING_PRIVATE_KEY);
  });

  it("the canonical payload does not contain the private key", () => {
    const json = decoder.decode(canonicalize(samplePayload()));
    expect(json).not.toContain(SIGNING_PRIVATE_KEY);
    expect(JSON.stringify(loadPublicKeyMaterial(signingEnv))).not.toContain(SIGNING_PRIVATE_KEY);
  });
});
