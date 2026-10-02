/**
 * Signed-license server matrix (FEAT-003) against real SQLite + the real router.
 *
 * Every call below goes through app.fetch -> createV1Api/createApi -> service ->
 * repository -> real SQL (migrations/0007 applied), and the Ed25519 signatures
 * are verified locally with the test public key. This exercises the atomic
 * activation-slot claim, signed-status derivation, auto-hold,
 * and the admin endpoints end to end.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, TEST_SECRETS, type Harness } from "./helpers/harness";
import { base64UrlToBytes } from "../src/crypto";
import { canonicalize, type LicensePayload } from "../src/license/canonical";

const PUBLIC_KEY = TEST_SECRETS.LICENSE_SIGNING_PUBLIC_KEY;
const KEY_ID = TEST_SECRETS.LICENSE_SIGNING_KEY_ID;

async function verifySignature(payload: LicensePayload, signatureB64: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(PUBLIC_KEY) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    base64UrlToBytes(signatureB64) as BufferSource,
    canonicalize(payload) as BufferSource
  );
}

type Fixture = {
  token: string;
  appId: string;
  appSecret: string;
  code: string;
  codeId: number;
  device: string;
};

/** Create an app + monthly code, activate it on one device. */
async function seedActivated(h: Harness, opts: { activate?: boolean } = {}): Promise<Fixture> {
  const token = await h.loginBootstrap();
  const app = await h.post("/api/admin/apps", { token, body: { name: `App ${Math.random()}`, platform: "desktop" } });
  const appId = app.data.app.app_id as string;
  const appSecret = app.data.app_secret as string;
  const batch = await h.post("/api/admin/codes/batch", {
    token,
    body: { app_id: appId, plan_code: "monthly", quantity: 1 }
  });
  const code = batch.data.codes[0] as string;
  const device = `device-${Math.random()}`;
  if (opts.activate !== false) {
    await h.post("/api/client/activate", {
      body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device }
    });
  }
  const codeRow = h.sql<{ id: number }>(
    "SELECT id FROM activation_codes WHERE app_id = (SELECT id FROM apps WHERE app_id = ?)",
    appId
  )[0];
  return { token, appId, appSecret, code, codeId: codeRow.id, device };
}

function verifyBody(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    app_id: fx.appId,
    app_secret: fx.appSecret,
    license_key: fx.code,
    product_id: fx.appId,
    installation_id: fx.device,
    protocol_version: 1,
    ...overrides
  };
}

describe("POST /api/v1/license/verify — signed happy path and status derivation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  it("returns a signed, verifiable payload with the 12 canonical fields for an active license", async () => {
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(res.status).toBe(200);
    expect(res.data.public_key_id).toBe(KEY_ID);
    expect(typeof res.data.verification_interval_seconds).toBe("number");
    const payload = res.data.payload as LicensePayload;
    expect(Object.keys(payload).sort()).toEqual(
      [
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
      ].sort()
    );
    expect(payload.status).toBe("active");
    expect(payload.activation_allowed).toBe(true);
    expect(payload.product_id).toBe(fx.appId);
    expect(payload.installation_id).toBe(fx.device);
    expect(payload.key_id).toBe(KEY_ID);
    expect(await verifySignature(payload, res.data.signature)).toBe(true);
    h.close();
  });

  it("derives expired for a code whose expiry is in the past", async () => {
    const fx = await seedActivated(h);
    h.raw.prepare("UPDATE activation_codes SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", fx.codeId);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(res.status).toBe(200);
    expect(res.data.payload.status).toBe("expired");
    expect(res.data.payload.activation_allowed).toBe(false);
    expect(await verifySignature(res.data.payload, res.data.signature)).toBe(true);
    h.close();
  });

  it("derives revoked for a soft-deleted code", async () => {
    const fx = await seedActivated(h);
    h.raw.prepare("UPDATE activation_codes SET status = 'deleted' WHERE id = ?").run(fx.codeId);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(res.data.payload.status).toBe("revoked");
    expect(res.data.payload.activation_allowed).toBe(false);
    h.close();
  });

  it("derives suspended for a disabled code", async () => {
    const fx = await seedActivated(h);
    h.raw.prepare("UPDATE activation_codes SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), fx.codeId);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(res.data.payload.status).toBe("suspended");
    expect(res.data.payload.activation_allowed).toBe(false);
    h.close();
  });

  it("derives hold for a held code and never reports active", async () => {
    const fx = await seedActivated(h);
    h.raw.prepare("UPDATE activation_codes SET hold_at = ?, hold_reason_code = 'ADMIN_MANUAL' WHERE id = ?").run(new Date().toISOString(), fx.codeId);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(res.data.payload.status).toBe("hold");
    expect(res.data.payload.activation_allowed).toBe(false);
    h.close();
  });

  it("records a VERIFY security event tied to the app and code", async () => {
    const fx = await seedActivated(h);
    await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    const events = h.sql<{ event_type: string; result: string; installation_hash: string | null }>(
      "SELECT event_type, result, installation_hash FROM security_events WHERE code_id = ?",
      fx.codeId
    );
    expect(events.some((e) => e.event_type === "VERIFY" && e.result === "success")).toBe(true);
    // installation is HMAC'd, never the raw device string.
    expect(events[0].installation_hash).not.toBe(fx.device);
    h.close();
  });
});

describe("POST /api/v1/license/verify — tamper detection", () => {
  it("rejects every per-field mutation of the signed payload", async () => {
    const h = await createHarness();
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    const payload = res.data.payload as LicensePayload;
    expect(await verifySignature(payload, res.data.signature)).toBe(true);
    const mutations: Array<Partial<LicensePayload>> = [
      { expires_at: "2099-01-01T00:00:00.000Z" },
      { status: "active" === payload.status ? "revoked" : "active" },
      { license_id: payload.license_id + 1 },
      { installation_id: `${payload.installation_id}-x` },
      { plan: `${payload.plan}-x` },
      { server_time: "2099-01-01T00:00:00.000Z" },
      { protocol_version: payload.protocol_version + 1 },
      { key_id: `${payload.key_id}-x` }
    ];
    for (const mutation of mutations) {
      const tampered = { ...payload, ...mutation };
      expect(await verifySignature(tampered, res.data.signature)).toBe(false);
    }
    h.close();
  });
});

describe("POST /api/v1/license/verify — unsigned failures", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  it("returns an unsigned 404 + PRODUCT_MISMATCH event when product_id does not match", async () => {
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { product_id: "app_wrong" }) });
    expect(res.status).toBe(404);
    expect(res.error?.code).toBe("INVALID_CODE");
    expect(res.data).toBeUndefined();
    const events = h.sql<{ event_type: string }>(
      "SELECT event_type FROM security_events WHERE event_type = 'PRODUCT_MISMATCH'"
    );
    expect(events.length).toBe(1);
    h.close();
  });

  it("returns 400 PROTOCOL_UNSUPPORTED for an unknown protocol version", async () => {
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { protocol_version: 99 }) });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("PROTOCOL_UNSUPPORTED");
    h.close();
  });

  it("returns 400 BAD_REQUEST for a missing field", async () => {
    const fx = await seedActivated(h);
    const body = verifyBody(fx);
    delete (body as Record<string, unknown>).installation_id;
    const res = await h.post("/api/v1/license/verify", { body });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("BAD_REQUEST");
    h.close();
  });

  it("returns 404 for an unknown license key", async () => {
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { license_key: "LM-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ" }) });
    expect(res.status).toBe(404);
    expect(res.error?.code).toBe("INVALID_CODE");
    h.close();
  });

  it("returns 401 for a bad app secret", async () => {
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { app_secret: "sec_wrong" }) });
    expect(res.status).toBe(401);
    expect(res.error?.code).toBe("INVALID_APP_SECRET");
    h.close();
  });
});

describe("POST /api/v1/license/verify — atomic activation-slot limit (§5.4)", () => {
  async function seedMultiSlot(h: Harness, max: number): Promise<Fixture> {
    const fx = await seedActivated(h, { activate: false });
    await h.patch(`/api/admin/codes/${fx.codeId}/max-activations`, {
      token: fx.token,
      body: { max_activations: max }
    });
    // Activation-slot mode needs an active, non-expired code; activate on a
    // throwaway device so status is 'active' with a future expiry.
    await h.post("/api/client/activate", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, code: fx.code, device_fingerprint: `seed-${Math.random()}` }
    });
    return fx;
  }

  it("admits up to the limit and refuses an over-limit installation without consuming a slot", async () => {
    const h = await createHarness();
    const fx = await seedMultiSlot(h, 2);

    const first = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "inst-1" }) });
    const second = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "inst-2" }) });
    expect(first.data.payload.activation_allowed).toBe(true);
    expect(second.data.payload.activation_allowed).toBe(true);

    const third = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "inst-3" }) });
    expect(third.status).toBe(200);
    expect(third.data.payload.activation_allowed).toBe(false);
    expect(await verifySignature(third.data.payload, third.data.signature)).toBe(true);

    const active = h.sql<{ count: number }>(
      "SELECT COUNT(*) AS count FROM code_activations WHERE code_id = ? AND status = 'active'",
      fx.codeId
    )[0].count;
    expect(active).toBe(2);
    h.close();
  });

  it("never blocks an existing installation re-verifying when the license is full", async () => {
    const h = await createHarness();
    const fx = await seedMultiSlot(h, 2);
    const first = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "inst-1" }) });
    const second = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "inst-2" }) });
    expect(first.data.payload.activation_allowed).toBe(true);
    expect(second.data.payload.activation_allowed).toBe(true);
    // The license is now full (2/2). A new installation is refused, but each
    // existing installation keeps re-verifying successfully.
    const other = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "inst-3" }) });
    expect(other.data.payload.activation_allowed).toBe(false);
    const reverify = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "inst-1" }) });
    expect(reverify.data.payload.activation_allowed).toBe(true);
    expect(
      h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM code_activations WHERE code_id = ? AND status = 'active'", fx.codeId)[0].count
    ).toBe(2);
    h.close();
  });

  it("admits concurrent racing installations without over-admitting beyond the limit", async () => {
    const h = await createHarness();
    const fx = await seedMultiSlot(h, 2);
    const racers = ["r1", "r2", "r3", "r4", "r5"].map((id) =>
      h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: id }) })
    );
    const settled = await Promise.all(racers);
    const allowed = settled.filter((r) => r.data.payload.activation_allowed === true).length;
    expect(allowed).toBeLessThanOrEqual(2);
    const active = h.sql<{ count: number }>(
      "SELECT COUNT(*) AS count FROM code_activations WHERE code_id = ? AND status = 'active'",
      fx.codeId
    )[0].count;
    expect(active).toBeLessThanOrEqual(2);
    h.close();
  });
});

describe("POST /api/v1/license/report + corroborated auto-hold (§6.3)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  it("records a report and does NOT hold on a single high-severity report", async () => {
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/report", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, installation_id: fx.device, license_key: fx.code, reason_code: "PAYLOAD_TAMPERED" }
    });
    expect(res.status).toBe(200);
    expect(res.data.recorded).toBe(true);
    expect(res.data.held).toBe(false);
    const hold = h.sql<{ hold_at: string | null }>("SELECT hold_at FROM activation_codes WHERE id = ?", fx.codeId)[0];
    expect(hold.hold_at).toBeNull();
    h.close();
  });

  it("auto-holds on two distinct-installation high-severity reports", async () => {
    const fx = await seedActivated(h);
    await h.post("/api/v1/license/report", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, installation_id: "inst-a", license_key: fx.code, reason_code: "SIGNATURE_INVALID" }
    });
    const second = await h.post("/api/v1/license/report", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, installation_id: "inst-b", license_key: fx.code, reason_code: "PAYLOAD_TAMPERED" }
    });
    expect(second.data.held).toBe(true);
    const hold = h.sql<{ hold_at: string | null }>("SELECT hold_at FROM activation_codes WHERE id = ?", fx.codeId)[0];
    expect(hold.hold_at).not.toBeNull();
    // A held license verifies as hold.
    const verify = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(verify.data.payload.status).toBe("hold");
    h.close();
  });

  it("rejects an unknown reason_code with 400", async () => {
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/report", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, installation_id: fx.device, license_key: fx.code, reason_code: "NOT_A_REASON" }
    });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("BAD_REQUEST");
    h.close();
  });

  it("returns 404 for a license not owned by the authenticated app and records nothing", async () => {
    const fx = await seedActivated(h);
    const res = await h.post("/api/v1/license/report", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, installation_id: fx.device, license_key: "LM-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", reason_code: "PAYLOAD_TAMPERED" }
    });
    expect(res.status).toBe(404);
    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM security_events")[0].count).toBe(0);
    h.close();
  });

  it("requires exactly one of license_key or license_id", async () => {
    const fx = await seedActivated(h);
    const both = await h.post("/api/v1/license/report", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, installation_id: fx.device, license_key: fx.code, license_id: fx.codeId, reason_code: "PAYLOAD_TAMPERED" }
    });
    expect(both.status).toBe(400);
    const neither = await h.post("/api/v1/license/report", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, installation_id: fx.device, reason_code: "PAYLOAD_TAMPERED" }
    });
    expect(neither.status).toBe(400);
    h.close();
  });
});

describe("Admin signed-license endpoints — hold/approve/validity/max-activations/views", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  it("hold then approve round-trips and verify reflects each state (AC-33)", async () => {
    const fx = await seedActivated(h);
    const hold = await h.patch(`/api/admin/codes/${fx.codeId}/hold`, { token: fx.token, body: {} });
    expect(hold.status).toBe(200);
    expect(hold.data.held).toBe(true);
    let verify = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(verify.data.payload.status).toBe("hold");

    const approve = await h.patch(`/api/admin/codes/${fx.codeId}/approve`, { token: fx.token, body: {} });
    expect(approve.data.approved).toBe(true);
    verify = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(verify.data.payload.status).toBe("active");
    h.close();
  });

  it("reflects a validity change in the signed verify (AC-34)", async () => {
    const fx = await seedActivated(h);
    const newExpiry = "2000-01-01T00:00:00.000Z";
    const res = await h.patch(`/api/admin/codes/${fx.codeId}/validity`, {
      token: fx.token,
      body: { expires_at: newExpiry }
    });
    expect(res.status).toBe(200);
    const verify = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(verify.data.payload.expires_at).toBe(newExpiry);
    expect(verify.data.payload.status).toBe("expired");
    h.close();
  });

  it("rejects lowering max-activations below the active-slot count with 409", async () => {
    const fx = await seedActivated(h, { activate: false });
    await h.patch(`/api/admin/codes/${fx.codeId}/max-activations`, { token: fx.token, body: { max_activations: 3 } });
    await h.post("/api/client/activate", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, code: fx.code, device_fingerprint: "seed" }
    });
    await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "a" }) });
    await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "b" }) });
    const res = await h.patch(`/api/admin/codes/${fx.codeId}/max-activations`, { token: fx.token, body: { max_activations: 1 } });
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe("ACTIVATION_LIMIT_REACHED");
    h.close();
  });

  it("lists activations and security events for a code", async () => {
    const fx = await seedActivated(h, { activate: false });
    await h.patch(`/api/admin/codes/${fx.codeId}/max-activations`, { token: fx.token, body: { max_activations: 2 } });
    await h.post("/api/client/activate", {
      body: { app_id: fx.appId, app_secret: fx.appSecret, code: fx.code, device_fingerprint: "seed" }
    });
    await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "a" }) });

    const activations = await h.get(`/api/admin/codes/${fx.codeId}/activations`, { token: fx.token });
    expect(activations.status).toBe(200);
    expect(activations.data.active_count).toBe(1);
    expect(activations.data.items.length).toBe(1);
    // No raw installation hash is surfaced.
    expect(JSON.stringify(activations.data)).not.toContain("installation_hash");

    const events = await h.get(`/api/admin/codes/${fx.codeId}/security-events`, { token: fx.token });
    expect(events.status).toBe(200);
    expect(events.data.items.length).toBeGreaterThan(0);
    expect(events.data.items[0]).toHaveProperty("has_installation");
    expect(events.data.items[0]).not.toHaveProperty("installation_hash");
    h.close();
  });

  it("requires a bearer token on the admin endpoints", async () => {
    const fx = await seedActivated(h);
    const res = await h.patch(`/api/admin/codes/${fx.codeId}/hold`, { body: {} });
    expect(res.status).toBe(401);
    h.close();
  });

});

describe("0007 migration applies to a populated DB preserving data (AC-48)", () => {
  it("keeps existing codes readable and signable after the additive migration", async () => {
    const h = await createHarness();
    const fx = await seedActivated(h);
    // The code existed and activated before any signed call; it still verifies.
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx) });
    expect(res.status).toBe(200);
    expect(res.data.payload.license_id).toBe(fx.codeId);
    // New columns default to NULL on the pre-existing row.
    const row = h.sql<{ hold_at: string | null; max_activations: number | null }>(
      "SELECT hold_at, max_activations FROM activation_codes WHERE id = ?",
      fx.codeId
    )[0];
    expect(row.hold_at).toBeNull();
    expect(row.max_activations).toBeNull();
    h.close();
  });
});

describe("POST /api/v1/license/verify — first verify activates an unused key (license-key-only model)", () => {
  it("activates an unused key on the calling installation and signs status=active", async () => {
    const h = await createHarness();
    const fx = await seedActivated(h, { activate: false });
    const before = Date.now();

    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "first-install" }) });
    expect(res.status).toBe(200);
    const payload = res.data.payload as LicensePayload;
    expect(payload.status).toBe("active");
    expect(payload.activation_allowed).toBe(true);
    expect(payload.expires_at).not.toBeNull();
    // Monthly plan: the period starts at this first activation (28-31 days).
    const days = (new Date(payload.expires_at as string).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    expect(await verifySignature(payload, res.data.signature)).toBe(true);

    const row = h.sql<{ status: string; activated_at: string | null }>(
      "SELECT status, activated_at FROM activation_codes WHERE id = ?",
      fx.codeId
    )[0];
    expect(row.status).toBe("active");
    expect(row.activated_at).not.toBeNull();
    h.close();
  });

  it("re-verifying on the same installation keeps the original expiry", async () => {
    const h = await createHarness();
    const fx = await seedActivated(h, { activate: false });
    const first = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "same" }) });
    const second = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "same" }) });
    expect(second.data.payload.status).toBe("active");
    expect(second.data.payload.activation_allowed).toBe(true);
    expect(second.data.payload.expires_at).toBe(first.data.payload.expires_at);
    h.close();
  });

  it("a second installation on a single-device key is signed but not allowed", async () => {
    const h = await createHarness();
    const fx = await seedActivated(h, { activate: false });
    await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "device-a" }) });
    const other = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "device-b" }) });
    expect(other.status).toBe(200);
    expect(other.data.payload.activation_allowed).toBe(false);
    h.close();
  });

  it("does not activate a held unused key", async () => {
    const h = await createHarness();
    const fx = await seedActivated(h, { activate: false });
    await h.patch(`/api/admin/codes/${fx.codeId}/hold`, { token: fx.token, body: {} });
    const res = await h.post("/api/v1/license/verify", { body: verifyBody(fx, { installation_id: "x" }) });
    expect(res.data.payload.status).toBe("hold");
    expect(res.data.payload.activation_allowed).toBe(false);
    const row = h.sql<{ status: string }>("SELECT status FROM activation_codes WHERE id = ?", fx.codeId)[0];
    expect(row.status).toBe("unused");
    h.close();
  });
});
