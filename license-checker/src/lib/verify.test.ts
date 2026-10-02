import { describe, expect, it } from "vitest";
import { CANONICAL_KEYS, type LicensePayload } from "./canonical";
import { evaluateFreshness, verifyEd25519, verifyLicenseResponse } from "./verify";
import { BASE_FIXTURE } from "./__fixtures__/workerCanonical";

// A fixed "now" close to the fixture's server_time so the genuine-signature cases
// pass the max-age predicate deterministically.
const NOW_MS = Date.parse("2026-06-16T12:10:00.000Z");
const INTERVAL = 3600;

function expectations(overrides: Partial<Parameters<typeof verifyLicenseResponse>[2]> = {}) {
  return {
    productId: BASE_FIXTURE.payload.product_id,
    installationId: BASE_FIXTURE.payload.installation_id,
    lastSeenServerTime: null,
    verificationIntervalSeconds: INTERVAL,
    nowMs: NOW_MS,
    ...overrides
  };
}

describe("verifyEd25519 against the worker-signed fixture", () => {
  it("accepts the genuine detached signature over the canonical bytes", async () => {
    const bytes = new TextEncoder().encode(BASE_FIXTURE.canonicalJson);
    await expect(
      verifyEd25519("TOwxe9EweGiDchaoYOmHY_GuOZrgMiZAkueFVVmBxTQ", bytes, BASE_FIXTURE.signature)
    ).resolves.toBe(true);
  });

  it("rejects a signature over different bytes", async () => {
    const bytes = new TextEncoder().encode(BASE_FIXTURE.canonicalJson.replace("active", "revoke"));
    await expect(
      verifyEd25519("TOwxe9EweGiDchaoYOmHY_GuOZrgMiZAkueFVVmBxTQ", bytes, BASE_FIXTURE.signature)
    ).resolves.toBe(false);
  });
});

describe("verifyLicenseResponse end-to-end (AC-14/15/26/45)", () => {
  it("accepts a genuine signed payload and anchors last_seen (first check)", async () => {
    const result = await verifyLicenseResponse(BASE_FIXTURE.payload, BASE_FIXTURE.signature, expectations());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextLastSeenServerTime).toBe(BASE_FIXTURE.payload.server_time);
    }
  });

  // Every signed field, when mutated, must break verification (AC-15/45). The
  // signature is unchanged, so re-canonicalizing the mutated payload no longer
  // matches the signed bytes.
  const tamperCases: Array<{ key: keyof LicensePayload; value: unknown }> = [
    { key: "activation_allowed", value: false },
    { key: "expires_at", value: "2099-01-01T00:00:00.000Z" },
    { key: "grace_period_seconds", value: 0 },
    { key: "installation_id", value: "install-tampered-999" },
    { key: "issued_at", value: "2026-06-16T13:00:00.000Z" },
    { key: "license_id", value: 43 },
    { key: "plan", value: "free" },
    { key: "product_id", value: "app_tampered" },
    { key: "protocol_version", value: 2 },
    { key: "server_time", value: "2026-06-16T12:00:01.000Z" },
    { key: "status", value: "revoked" }
  ];

  it.each(CANONICAL_KEYS.filter((k) => k !== "key_id"))("rejects a tampered %s field", async (key) => {
    const match = tamperCases.find((c) => c.key === key)!;
    const tampered = { ...BASE_FIXTURE.payload, [key]: match.value } as LicensePayload;
    // Guard: the mutation must actually change the payload for the test to mean something.
    expect(tampered[key as keyof LicensePayload]).not.toBe(BASE_FIXTURE.payload[key as keyof LicensePayload]);
    const result = await verifyLicenseResponse(tampered, BASE_FIXTURE.signature, expectations());
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown key_id without even checking the signature (AC-26)", async () => {
    const tampered = { ...BASE_FIXTURE.payload, key_id: "ed25519-not-configured" };
    const result = await verifyLicenseResponse(tampered, BASE_FIXTURE.signature, expectations());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("KEY_ID_UNKNOWN");
    }
  });

  it("rejects a missing signature", async () => {
    const result = await verifyLicenseResponse(BASE_FIXTURE.payload, "", expectations());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("SIGNATURE_INVALID");
    }
  });

  it("rejects a product_id that does not match the installation", async () => {
    const result = await verifyLicenseResponse(
      BASE_FIXTURE.payload,
      BASE_FIXTURE.signature,
      expectations({ productId: "app_other" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("PRODUCT_MISMATCH");
    }
  });

  it("rejects an installation_id that does not match this installation", async () => {
    const result = await verifyLicenseResponse(
      BASE_FIXTURE.payload,
      BASE_FIXTURE.signature,
      expectations({ installationId: "someone-else" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("INSTALLATION_MISMATCH");
    }
  });
});

describe("pinned freshness / replay predicate (§8.4, AC-28)", () => {
  it("accepts the first-ever check and anchors server_time", () => {
    const result = evaluateFreshness(BASE_FIXTURE.payload.server_time, null, INTERVAL, NOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextLastSeenServerTime).toBe(BASE_FIXTURE.payload.server_time);
    }
  });

  it("rejects a rolled-back server_time (older than last seen)", () => {
    const result = evaluateFreshness(
      "2026-06-16T11:00:00.000Z",
      "2026-06-16T12:00:00.000Z",
      INTERVAL,
      NOW_MS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CLOCK_ROLLBACK");
    }
  });

  it("accepts an equal server_time (idempotent re-check)", () => {
    const result = evaluateFreshness(
      BASE_FIXTURE.payload.server_time,
      BASE_FIXTURE.payload.server_time,
      INTERVAL,
      NOW_MS
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextLastSeenServerTime).toBe(BASE_FIXTURE.payload.server_time);
    }
  });

  it("rejects a stale response beyond interval + 300s skew", () => {
    // server_time is INTERVAL + 301s before now.
    const serverTime = new Date(NOW_MS - (INTERVAL + 301) * 1000).toISOString();
    const result = evaluateFreshness(serverTime, null, INTERVAL, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("STALE");
    }
  });

  it("accepts a response just inside interval + 300s skew", () => {
    const serverTime = new Date(NOW_MS - (INTERVAL + 299) * 1000).toISOString();
    const result = evaluateFreshness(serverTime, null, INTERVAL, NOW_MS);
    expect(result.ok).toBe(true);
  });
});
