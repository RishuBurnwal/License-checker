import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "./base64url";
import { CANONICAL_KEYS, canonicalize, type LicensePayload } from "./canonical";
import { BASE_FIXTURE, BOUNDARY_FIXTURE } from "./__fixtures__/workerCanonical";

const decoder = new TextDecoder();

describe("canonicalize cross-implementation determinism (NFR-2)", () => {
  it("produces bytes byte-identical to the worker fixture (base payload)", () => {
    const bytes = canonicalize(BASE_FIXTURE.payload);
    expect(decoder.decode(bytes)).toBe(BASE_FIXTURE.canonicalJson);
    expect(bytesToBase64Url(bytes)).toBe(BASE_FIXTURE.canonicalBase64Url);
  });

  it("matches the worker fixture for boundary values (license_id=2^53-1, expires_at=null)", () => {
    expect(BOUNDARY_FIXTURE.payload.license_id).toBe(Number.MAX_SAFE_INTEGER);
    expect(BOUNDARY_FIXTURE.payload.expires_at).toBeNull();
    const bytes = canonicalize(BOUNDARY_FIXTURE.payload);
    expect(decoder.decode(bytes)).toBe(BOUNDARY_FIXTURE.canonicalJson);
    expect(bytesToBase64Url(bytes)).toBe(BOUNDARY_FIXTURE.canonicalBase64Url);
  });

  it("emits exactly the 12 keys in fixed lexicographic order", () => {
    expect(CANONICAL_KEYS).toHaveLength(12);
    expect([...CANONICAL_KEYS]).toEqual([...CANONICAL_KEYS].slice().sort());
    const parsed = JSON.parse(BASE_FIXTURE.canonicalJson) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...CANONICAL_KEYS]);
  });

  it("is independent of insertion order", () => {
    const shuffled: LicensePayload = {
      status: BASE_FIXTURE.payload.status,
      server_time: BASE_FIXTURE.payload.server_time,
      protocol_version: BASE_FIXTURE.payload.protocol_version,
      product_id: BASE_FIXTURE.payload.product_id,
      plan: BASE_FIXTURE.payload.plan,
      license_id: BASE_FIXTURE.payload.license_id,
      key_id: BASE_FIXTURE.payload.key_id,
      issued_at: BASE_FIXTURE.payload.issued_at,
      installation_id: BASE_FIXTURE.payload.installation_id,
      grace_period_seconds: BASE_FIXTURE.payload.grace_period_seconds,
      expires_at: BASE_FIXTURE.payload.expires_at,
      activation_allowed: BASE_FIXTURE.payload.activation_allowed
    };
    expect(decoder.decode(canonicalize(shuffled))).toBe(BASE_FIXTURE.canonicalJson);
  });

  it("fails closed on a non-safe-integer field (float / >=2^53)", () => {
    expect(() => canonicalize({ ...BASE_FIXTURE.payload, grace_period_seconds: 1.5 })).toThrow();
    expect(() => canonicalize({ ...BASE_FIXTURE.payload, license_id: 2 ** 53 })).toThrow();
    expect(() => canonicalize({ ...BASE_FIXTURE.payload, protocol_version: Number.NaN })).toThrow();
  });
});
