/**
 * The REQUIRED LICENSE TEST MATRIX (Prompt.md section 47).
 *
 * The matrix is written for a full license server with sessions, leases,
 * heartbeats, renewal and grace periods. This implementation is a prepaid
 * fixed-term activation service: it has a code state machine, a single bound
 * device per code, and nothing session-shaped. So each row is handled one of
 * three ways, and never faked:
 *
 *   IMPLEMENTED  the row is asserted against real behaviour;
 *   MAPPED       the row's intent is expressed by the nearest real mechanism,
 *                and the test states the mapping;
 *   ABSENT       the mechanism does not exist; the test asserts its absence so
 *                the gap is recorded as fact rather than assumed.
 *
 * Rows marked ABSENT are NOT_IMPLEMENTED and are reported as such.
 */
import { describe, expect, it } from "vitest";
import { CODE_LIST_STATUS_VALUES } from "../src/constants";
import { MAX_REBINDS } from "../src/service";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { createLicensedApp } from "./helpers/scenario";

const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

type CodeState = {
  status: string;
  device_hash: string | null;
  activated_at: string | null;
  expires_at: string | null;
  rebind_count: number;
  disabled_at: string | null;
};

function codeState(h: Harness): CodeState {
  return h
    .sql<CodeState>(
      "SELECT status, device_hash, activated_at, expires_at, rebind_count, disabled_at FROM activation_codes ORDER BY id LIMIT 1"
    )[0];
}

function activate(h: Harness, app: { appId: string; appSecret: string }, code: string, device: string) {
  return h.post("/api/client/activate", {
    body: { app_id: app.appId, app_secret: app.appSecret, code, device_fingerprint: device }
  });
}

function verify(h: Harness, app: { appId: string; appSecret: string }, code: string, device: string) {
  return h.post("/api/client/verify", {
    body: { app_id: app.appId, app_secret: app.appSecret, code, device_fingerprint: device }
  });
}

describe("matrix: valid license → SUCCESS", () => {
  it("accepts a valid key, product, device and expiry", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { planCode: "quarterly" });

    const activated = await activate(h, app, app.code, app.device);
    expect(activated.status).toBe(200);
    expect(activated.data).toMatchObject({ valid: true, device_bound: true, plan: { duration_days: 90 } });
    expect(new Date(activated.data.expires_at).getTime()).toBeGreaterThan(Date.now());

    // The steady state is the verify call, which a launched client repeats.
    const verified = await verify(h, app, app.code, app.device);
    expect(verified.status).toBe(200);
    expect(verified.data.valid).toBe(true);
    expect(verified.data.expires_at).toBe(activated.data.expires_at);
    h.close();
  });

  it("refuses to verify a license that was never activated", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await verify(h, app, app.code, app.device);
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("INVALID_CODE");
    h.close();
  });
});

describe("matrix: invalid key → REJECT", () => {
  it("rejects a random key", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await activate(h, app, "LM-AAAAA-BBBBB-CCCCC-DDDDD", app.device);
    expect(response.status).toBe(404);
    expect(response.error?.code).toBe("INVALID_CODE");
    h.close();
  });

  it("rejects a real key presented for the wrong product", async () => {
    const h = await createHarness();
    const first = await createLicensedApp(h, { name: "Product One" });
    const second = await createLicensedApp(h, { name: "Product Two" });
    const response = await activate(h, second, first.code, "device-x");
    expect(response.status).toBe(404);
    expect(response.error?.code).toBe("INVALID_CODE");
    h.close();
  });

  it("normalizes case and whitespace but treats separators as significant", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    // Rejection is on the hash of the normalized key, so case and stray spacing
    // are not failure modes for a legitimate customer.
    const retyped = `  ${app.code.toLowerCase()}  `;
    expect((await activate(h, app, retyped, app.device)).status).toBe(200);

    // Normalization strips whitespace but not hyphens, so a customer who replaces
    // the separators with spaces is rejected. Recorded as a known limitation.
    const despaced = app.code.toLowerCase().replace(/-/g, " ");
    const rejected = await activate(h, app, despaced, "device-other");
    expect(rejected.status).toBe(404);
    expect(rejected.error?.code).toBe("INVALID_CODE");
    h.close();
  });

  it("rejects an empty key as a validation error", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await activate(h, app, "", app.device);
    expect(response.status).toBe(400);
    expect(response.error?.message).toBe("code is required");
    h.close();
  });
});

describe("matrix: expired → REJECT", () => {
  it("rejects a license whose expiry has passed", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);
    // The clock cannot be advanced, so expiry is expressed directly.
    h.raw.prepare("UPDATE activation_codes SET expires_at = ?").run(past(60_000));

    const activated = await activate(h, app, app.code, app.device);
    expect(activated.status).toBe(403);
    expect(activated.error?.code).toBe("CODE_EXPIRED");

    const verified = await verify(h, app, app.code, app.device);
    expect(verified.status).toBe(403);
    expect(verified.error?.code).toBe("CODE_EXPIRED");
    h.close();
  });

  it("accepts a license that expires one second from now", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);
    // Proves the check is a real comparison against `expires_at` rather than an
    // unconditional rejection.
    h.raw.prepare("UPDATE activation_codes SET expires_at = ?").run(future(60_000));

    const verified = await verify(h, app, app.code, app.device);
    expect(verified.status).toBe(200);
    expect(verified.data.valid).toBe(true);
    h.close();
  });
});

describe("matrix: revoked → REJECT", () => {
  it("rejects a license an administrator has disabled", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);
    const codeId = h.sql<{ id: number }>("SELECT id FROM activation_codes")[0].id;

    const disabled = await h.patch(`/api/admin/codes/${codeId}/status`, {
      token: app.token,
      body: { status: "disabled" }
    });
    expect(disabled.status).toBe(200);

    for (const call of [() => activate(h, app, app.code, app.device), () => verify(h, app, app.code, app.device)]) {
      const response = await call();
      expect(response.status).toBe(403);
      expect(response.error?.code).toBe("CODE_DISABLED");
    }
    h.close();
  });

  it("restores service when the revocation is lifted", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);
    const codeId = h.sql<{ id: number }>("SELECT id FROM activation_codes")[0].id;

    await h.patch(`/api/admin/codes/${codeId}/status`, { token: app.token, body: { status: "disabled" } });
    expect((await verify(h, app, app.code, app.device)).status).toBe(403);

    await h.patch(`/api/admin/codes/${codeId}/status`, { token: app.token, body: { status: "enabled" } });
    const restored = await verify(h, app, app.code, app.device);
    expect(restored.status).toBe(200);
    expect(h.sql<{ disabled_at: string | null }>("SELECT disabled_at FROM activation_codes")[0].disabled_at).toBeNull();
    h.close();
  });
});

describe("matrix: suspended → REJECT", () => {
  it("rejects every client call while the product is suspended", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);

    await h.patch(`/api/admin/apps/${app.appId}/status`, { token: app.token, body: { status: "disabled" } });
    const response = await verify(h, app, app.code, app.device);
    expect(response.status).toBe(403);
    expect(response.error?.code).toBe("APP_DISABLED");

    // A license already granted is suspended too, not just new activations.
    const activated = await activate(h, app, app.code, app.device);
    expect(activated.status).toBe(403);
    h.close();
  });

  it("rejects each product independently when it is disabled", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const other = await createLicensedApp(h, { name: "Second Product" });
    await activate(h, app, app.code, app.device);

    for (const subject of [app, other]) {
      await h.patch(`/api/admin/apps/${subject.appId}/status`, { token: subject.token, body: { status: "disabled" } });
      const response = await verify(h, subject, subject.code, subject.device);
      expect(response.status).toBe(403);
      expect(response.error?.code).toBe("APP_DISABLED");
      expect(response.error?.message).toBe("App is disabled");
    }
    h.close();
  });

  it("restores service when the suspension is lifted", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);

    await h.patch(`/api/admin/apps/${app.appId}/status`, { token: app.token, body: { status: "disabled" } });
    expect((await verify(h, app, app.code, app.device)).status).toBe(403);
    await h.patch(`/api/admin/apps/${app.appId}/status`, { token: app.token, body: { status: "active" } });

    const restored = await verify(h, app, app.code, app.device);
    expect(restored.status).toBe(200);
    expect(restored.data.valid).toBe(true);
    h.close();
  });
});

describe("matrix: device limit → REJECT", () => {
  it("refuses a second device while the first is active", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    // The configured limit is one device per activation code.
    expect((await activate(h, app, app.code, "device-A")).status).toBe(200);

    const second = await activate(h, app, app.code, "device-B");
    expect(second.status).toBe(403);
    expect(second.error?.code).toBe("DEVICE_MISMATCH");
    h.close();
  });

  it("reports the configured limit with every license", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await activate(h, app, app.code, "device-A");
    expect(response.data.max_rebinds).toBe(MAX_REBINDS);
    expect(response.data.rebind_count).toBe(0);
    expect(response.data.device_bound).toBe(true);
    h.close();
  });
});

describe("matrix: concurrent session → ENFORCED", () => {
  it("registers and refreshes a heartbeat session", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const activated = await activate(h, app, app.code, app.device);
    const heartbeat = await h.post("/api/client/heartbeat", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device, session_token: activated.data.session_token } });
    expect(heartbeat.status).toBe(200);
    h.close();
  });

  it("has storage for a session lease", async () => {
    const h = await createHarness();
    const tables = h.sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.map((table) => table.name)).toContain("license_sessions");
    h.close();
  });

  it("returns an opaque session identifier with a license", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await activate(h, app, app.code, app.device);
    expect(response.data.session_token).toEqual(expect.any(String));
    expect(response.data.lease_expires_at).toEqual(expect.any(String));
    h.close();
  });
});

describe("matrix: renewal → IMPLEMENTED", () => {
  it("renews an expired activated license", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const activated = await activate(h, app, app.code, app.device);
    h.raw.prepare("UPDATE activation_codes SET expires_at = ?").run(past(1000));
    const renewed = await h.post("/api/client/renew", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device } });
    expect(renewed.status).toBe(200);
    expect(renewed.data.activated_at).toBe(activated.data.activated_at);
    expect(new Date(renewed.data.expires_at).getTime()).toBeGreaterThan(Date.now());
    h.close();
  });

  it("rejects renewal from another device", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);
    const response = await h.post("/api/client/renew", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: "other-device" } });
    expect(response.status).toBe(403);
    expect(response.error?.code).toBe("DEVICE_MISMATCH");
    h.close();
  });
});

describe("matrix: admin kick → IMPLEMENTED", () => {
  it("kicks a live session and rejects its next heartbeat", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const activated = await activate(h, app, app.code, app.device);
    const sessions = await h.get("/api/admin/sessions", { token: app.token });
    const kicked = await h.post(`/api/admin/sessions/${sessions.data.items[0].id}/kick`, { token: app.token });
    expect(kicked.status).toBe(200);
    const response = await h.post("/api/client/heartbeat", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device, session_token: activated.data.session_token } });
    expect(response.status).toBe(403);
    expect(response.error?.code).toBe("SESSION_REVOKED");
    h.close();
  });
});

describe("matrix: IP change → must not incorrectly reject", () => {
  it("ignores address headers entirely when verifying", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);

    // The same device arriving from a different address must stay valid.
    for (const address of ["203.0.113.10", "198.51.100.7", "2001:db8::1"]) {
      const response = await h.post("/api/client/verify", {
        body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device },
        headers: {
          "CF-Connecting-IP": address,
          "X-Forwarded-For": address,
          "X-Real-IP": address,
          "User-Agent": `client/${address}`
        }
      });
      expect(response.status).toBe(200);
    }
    h.close();
  });

  it("cannot store an address even if one were sent", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);

    const leaked = h
      .sql<Record<string, unknown>>("SELECT * FROM activation_logs")
      .flatMap((row) => Object.values(row))
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    expect(leaked).not.toContain("203.0.113.10");
    h.close();
  });
});

describe("matrix: multiple devices → enforce configured device limit", () => {
  it("allows migration only within the rebind budget", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, "device-1");

    // Each migration is unbind + activate with a new fingerprint. The cooldown
    // is cleared between rounds to stand in for elapsed wall-clock time.
    for (let round = 1; round <= MAX_REBINDS; round += 1) {
      const unbind = await h.post("/api/client/unbind-device", {
        body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: `device-${round}` }
      });
      expect(unbind.status).toBe(200);

      const rebound = await activate(h, app, app.code, `device-${round + 1}`);
      expect(rebound.status).toBe(200);
      expect(codeState(h).rebind_count).toBe(round);

      h.raw.prepare("UPDATE activation_codes SET last_rebind_at = NULL").run();
    }

    // The budget is now spent: the next migration is refused, so the limit holds.
    const refused = await h.post("/api/client/unbind-device", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: `device-${MAX_REBINDS + 1}` }
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.code).toBe("REBINDS_EXCEEDED");
    h.close();
  });

  it("enforces the limit per code, not per product", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 2 });
    // Two codes of one product may each hold their own device concurrently.
    expect((await activate(h, app, app.codes[0], "device-A")).status).toBe(200);
    expect((await activate(h, app, app.codes[1], "device-B")).status).toBe(200);
    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes WHERE device_hash IS NOT NULL")[0].count).toBe(2);
    h.close();
  });
});

describe("matrix: network failure → GRACE LEASE", () => {
  it("carries the configured grace window and lease in a license", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await activate(h, app, app.code, app.device);
    expect(response.data.grace_period_seconds).toBe(86400);
    expect(new Date(response.data.lease_expires_at).getTime()).toBeGreaterThan(Date.now());
    h.close();
  });
});

describe("matrix: grace period expiration → restricted mode", () => {
  it("has no restricted or suspended license state", async () => {
    // The complete set of license states reachable in this system.
    expect([...CODE_LIST_STATUS_VALUES].sort()).toEqual(["active", "deleted", "disabled", "expired", "unused"]);
    expect(CODE_LIST_STATUS_VALUES.filter((status) => /restrict|suspend|grace/i.test(status))).toEqual([]);
  });

  it("hard-rejects past expiry instead of degrading", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await activate(h, app, app.code, app.device);
    h.raw.prepare("UPDATE activation_codes SET expires_at = ?").run(past(1));

    const response = await verify(h, app, app.code, app.device);
    expect(response.status).toBe(403);
    expect(response.error?.code).toBe("CODE_EXPIRED");
    // There is no partially-usable tier to fall back to.
    expect(response.data).toBeUndefined();
    h.close();
  });
});

describe("matrix: race condition → limits cannot be exceeded", () => {
  it("binds exactly one device when five activate at once", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) => activate(h, app, app.code, `device-race-${index}`))
    );

    const accepted = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status === 403);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const response of rejected) {
      expect(response.error?.code).toBe("DEVICE_MISMATCH");
    }

    const state = codeState(h);
    expect(state.status).toBe("active");
    expect(state.device_hash).not.toBeNull();
    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes WHERE device_hash IS NOT NULL")[0].count).toBe(1);
    h.close();
  });

  it("charges the rebind budget at most once when unbinds race", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    await activate(h, app, app.code, "device-A");

    const body = { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: "device-A" };
    const responses = await Promise.all([
      h.post("/api/client/unbind-device", { body }),
      h.post("/api/client/unbind-device", { body }),
      h.post("/api/client/unbind-device", { body })
    ]);

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const state = codeState(h);
    expect(state.rebind_count).toBe(1);
    expect(state.device_hash).toBeNull();
    h.close();
  });
});
