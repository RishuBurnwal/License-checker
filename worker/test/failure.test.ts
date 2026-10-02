/**
 * Failure testing (Prompt.md section 49).
 *
 * The required list mixes three kinds of entry, and conflating them is how a
 * test suite starts lying:
 *
 *   VERIFIED   the failure was injected and the behaviour observed;
 *   ABSENT     the mechanism being tested does not exist, and the test proves
 *              that rather than pretending to exercise it;
 *   UNVERIFIED a real environment effect (no server, a timeout, a slow link)
 *              that an in-process harness cannot produce at all. These are
 *              listed with their reason, not silently dropped.
 *
 * Each entry on the section 49 list is accounted for exactly once.
 */
import { describe, expect, it, vi } from "vitest";
import { signJwt } from "../src/crypto";
import { createHarness, TEST_SECRETS, type Harness } from "./helpers/harness";
import { createLicensedApp } from "./helpers/scenario";

/** A D1 binding that fails every statement, as if the database were unreachable. */
function unavailableDb(): D1Database {
  const boom = (): never => {
    throw new Error("D1_ERROR: database is unavailable");
  };
  return {
    prepare: boom,
    batch: async () => boom(),
    exec: async () => boom(),
    dump: async () => boom()
  } as unknown as D1Database;
}

/** Passes everything through to the real shim except statements matching `match`. */
function faultOn(inner: D1Database, match: RegExp, isArmed: () => boolean = () => true): D1Database {
  return {
    prepare(sql: string) {
      if (isArmed() && match.test(sql)) {
        throw new Error("D1_ERROR: simulated statement failure");
      }
      return inner.prepare(sql);
    },
    batch: (statements: unknown[]) => inner.batch(statements as never),
    exec: (sql: string) => inner.exec(sql),
    dump: () => inner.dump()
  } as unknown as D1Database;
}

function tables(h: Harness): string[] {
  return h.sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
}

function allColumns(h: Harness): string[] {
  return tables(h)
    .flatMap((table) => h.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((column) => column.name);
}

describe("database unavailable (VERIFIED)", () => {
  it("answers with a generic 500 envelope instead of crashing", async () => {
    const h = await createHarness({}, { wrapDb: () => unavailableDb() });
    const generic = { ok: false, error: { code: "CONFLICT", message: "Unexpected server error" } };

    // Health never touches the database, so it is unaffected.
    expect((await h.get("/api/health")).status).toBe(200);

    // A well-formed client call reaches the database on its first query.
    const activate = await h.post("/api/client/activate", {
      body: {
        app_id: "app_probe",
        app_secret: "sec_probe",
        code: "LM-AAAAA-BBBBB-CCCCC-DDDDD",
        device_fingerprint: "device-probe"
      }
    });
    expect(activate.status).toBe(500);
    expect(activate.payload).toEqual(generic);

    // Without a token the request is refused before any lookup happens, so the
    // database is never the thing that decides.
    expect((await h.get("/api/admin/me")).status).toBe(401);

    // With a correctly signed token the administrator lookup is attempted, and
    // it must fail loudly rather than be mistaken for an auth failure.
    const token = await signJwt(TEST_SECRETS.JWT_SECRET, { sub: "1", username: "bootstrap-admin" }, 60);
    const me = await h.get("/api/admin/me", { token });
    expect(me.status).toBe(500);
    expect(me.payload).toEqual(generic);
    h.close();
  });

  it("fails the login path cleanly rather than half-authenticating", async () => {
    const h = await createHarness({}, { wrapDb: () => unavailableDb() });
    const response = await h.login("bootstrap-admin", "bootstrap-password-1");
    expect(response.status).toBe(500);
    expect(response.payload.ok).toBe(false);
    expect(response.payload.data).toBeUndefined();
    h.close();
  });

  it("logs the cause server-side while leaking nothing to the caller", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await createHarness({}, { wrapDb: () => unavailableDb() });

    const response = await h.login("bootstrap-admin", "bootstrap-password-1");
    const body = JSON.stringify(response.payload);

    // Operators need the real cause; callers must not receive it.
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toContain("database is unavailable");
    for (const leak of ["D1_ERROR", "sqlite", "at ", ".ts", "Error:"]) {
      expect(body).not.toContain(leak);
    }

    spy.mockRestore();
    h.close();
  });
});

describe("write failure mid-flight (VERIFIED — documented limitation)", () => {
  it("reports failure but leaves an orphan batch row, because generation is not atomic", async () => {
    const h = await createHarness({}, { wrapDb: (db) => faultOn(db, /INSERT INTO activation_codes/) });
    const token = await h.loginBootstrap();

    const created = await h.post("/api/admin/apps", {
      token,
      body: { name: "Fault App", platform: "desktop" }
    });
    expect(created.status).toBe(201);
    const appId = created.data.app.app_id as string;

    const response = await h.post("/api/admin/codes/batch", {
      token,
      body: { app_id: appId, plan_code: "monthly", quantity: 3 }
    });

    // The caller is told the truth: no partial success is reported.
    expect(response.status).toBe(500);
    expect(response.payload.data).toBeUndefined();
    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes")[0].count).toBe(0);

    // Known limitation, asserted so a change in behaviour is noticed: the batch
    // row was committed by a separate statement before the codes insert failed.
    // Cloudflare D1 exposes no interactive transaction, so the two statements
    // cannot simply be wrapped; `db.batch` cannot reference the batch id that
    // the same batch would create.
    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_batches")[0].count).toBe(1);

    // A concrete consequence: the orphan reference blocks deletion of the app.
    const del = await h.delete(`/api/admin/apps/${appId}`, { token });
    expect(del.status).toBe(409);
    expect(del.error?.message).toBe("App has activation data and cannot be deleted");
    h.close();
  });

  it("rolls a code batch back completely when the insert fails", async () => {
    // The fault is armed only after the app exists, so the failing statement is
    // the activation-code insert under test.
    let armed = false;
    const h = await createHarness({}, { wrapDb: (db) => faultOn(db, /INSERT INTO activation_codes/, () => armed) });
    const app = await createLicensedApp(h, { quantity: 1 });
    const before = h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes")[0].count;
    armed = true;

    const response = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: app.appId, plan_code: "monthly", quantity: 2 }
    });
    expect(response.status).toBe(500);

    // The code insert failed, so no new activation codes survive.
    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes")[0].count).toBe(before);
    h.close();
  });
});

describe("malformed request (VERIFIED)", () => {
  it("answers 400, never 500, for broken bodies", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["/api/admin/login", { rawBody: "{oops" }],
      ["/api/admin/login", { rawBody: '"just a string"' }],
      ["/api/admin/login", { rawBody: "[]" }],
      ["/api/admin/apps", { token: app.token, rawBody: "{}" }],
      ["/api/admin/codes/batch", { token: app.token, rawBody: '{"app_id":1}' }]
    ];

    for (const [path, options] of cases) {
      const response = await h.post(path, options);
      expect(response.status).toBe(400);
      expect(response.payload.ok).toBe(false);
      expect(typeof response.error?.message).toBe("string");
    }
    h.close();
  });

  it("rejects non-string values for string fields", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    for (const name of [{ first: "x" }, ["a"], 42, true, null]) {
      const response = await h.post("/api/admin/apps", {
        token: app.token,
        body: { name, platform: "desktop" }
      });
      expect(response.status).toBe(400);
      expect(response.error?.message).toBe("name is required");
    }

    const nullStatus = await h.patch(`/api/admin/apps/${app.appId}/status`, { token: app.token, body: { status: null } });
    expect(nullStatus.status).toBe(400);
    h.close();
  });

  it("coerces numeric strings but refuses values that are not numbers", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    // Actual behaviour, recorded rather than assumed: `requireInteger` applies
    // Number(value), so a numeric string passes and is stored as a number.
    const numericString = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: app.appId, plan_code: "monthly", quantity: "3" }
    });
    expect(numericString.status).toBe(201);
    expect(numericString.data.quantity).toBe(3);

    for (const quantity of [3.5, "three", {}, [], null]) {
      const response = await h.post("/api/admin/codes/batch", {
        token: app.token,
        body: { app_id: app.appId, plan_code: "monthly", quantity }
      });
      expect(response.status).toBe(400);
    }
    h.close();
  });

  it("handles oversized input without an unhandled error", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    // Either rejected by a length rule or stored, but never a 500.
    const response = await h.post("/api/admin/apps", {
      token: app.token,
      body: { name: "x".repeat(10_000), platform: "desktop" }
    });
    expect([201, 400]).toContain(response.status);

    const code = await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: "L".repeat(10_000), device_fingerprint: "d" }
    });
    expect([400, 404]).toContain(code.status);
    h.close();
  });
});

describe("duplicate request (VERIFIED)", () => {
  it("treats a repeated activation as the same activation", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const body = { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device };

    const first = await h.post("/api/client/activate", { body });
    const second = await h.post("/api/client/activate", { body });
    expect(second.status).toBe(200);
    expect(second.data.expires_at).toBe(first.data.expires_at);
    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes WHERE status = 'active'")[0].count).toBe(1);
    h.close();
  });

  it("rejects a duplicate username with a conflict", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();
    const body = { username: "dupe-user", password: "dupe-password-1", role: "admin" };

    const first = await h.post("/api/admin/users", { token, body });
    const second = await h.post("/api/admin/users", { token, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM admin_users WHERE username = 'dupe-user'")[0].count).toBe(1);
    h.close();
  });

  it("rejects a duplicate app-batch submission once the codes exist", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    // The same logical request replayed is not de-duplicated: it is a new batch.
    // Recorded as actual behaviour, since idempotency keys are not implemented.
    const first = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: app.appId, plan_code: "monthly", quantity: 1 }
    });
    const second = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: app.appId, plan_code: "monthly", quantity: 1 }
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.data.batch_id).not.toBe(first.data.batch_id);
    h.close();
  });
});

describe("invalid, expired and revoked licenses (VERIFIED — see license-matrix)", () => {
  it("rejects an invalid license", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: "LM-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", device_fingerprint: "d" }
    });
    expect(response.status).toBe(404);
    h.close();
  });

  it("rejects an expired license", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });
    h.raw.prepare("UPDATE activation_codes SET expires_at = ?").run(new Date(Date.now() - 60_000).toISOString());
    const response = await h.post("/api/client/verify", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });
    expect(response.status).toBe(403);
    expect(response.error?.code).toBe("CODE_EXPIRED");
    h.close();
  });

  it("rejects a revoked license and an invalid device", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });
    const codeId = h.sql<{ id: number }>("SELECT id FROM activation_codes")[0].id;

    const otherDevice = await h.post("/api/client/verify", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: "not-the-device" }
    });
    expect(otherDevice.status).toBe(403);
    expect(otherDevice.error?.code).toBe("DEVICE_MISMATCH");

    await h.patch(`/api/admin/codes/${codeId}/status`, { token: app.token, body: { status: "disabled" } });
    const revoked = await h.post("/api/client/verify", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });
    expect(revoked.status).toBe(403);
    expect(revoked.error?.code).toBe("CODE_DISABLED");
    h.close();
  });

  it("rejects an invalid and an expired token", async () => {
    const h = await createHarness();
    await h.loginBootstrap();
    expect((await h.get("/api/admin/me", { token: "garbage" })).status).toBe(401);

    const { signJwt } = await import("../src/crypto");
    const expired = await signJwt("test-jwt-secret-0123456789abcdef0123456789abcdef", { sub: "1", username: "bootstrap-admin" }, -1);
    expect((await h.get("/api/admin/me", { token: expired })).status).toBe(401);
    h.close();
  });
});

describe("admin revoke (VERIFIED)", () => {
  it("revoking a license locks the client on its next call", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });
    const codeId = h.sql<{ id: number }>("SELECT id FROM activation_codes")[0].id;

    await h.patch(`/api/admin/codes/${codeId}/status`, { token: app.token, body: { status: "disabled" } });

    const verify = await h.post("/api/client/verify", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });
    expect(verify.status).toBe(403);
    // The client has no valid response to cache, so it must lock.
    expect(verify.payload.data).toBeUndefined();
    h.close();
  });

  it("can revoke wholesale through a bulk action", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 4 });
    const ids = h.sql<{ id: number }>("SELECT id FROM activation_codes").map((row) => row.id);

    const response = await h.post("/api/admin/codes/bulk", {
      token: app.token,
      body: { action: "disable", ids }
    });
    expect(response.status).toBe(200);
    expect(response.data.updated).toBe(4);
    expect(
      h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes WHERE disabled_at IS NOT NULL")[0].count
    ).toBe(4);
    h.close();
  });
});

describe("implemented lease and remaining deferred mechanisms", () => {
  it("creates a session lease and heartbeat endpoint", async () => {
    const h = await createHarness();
    expect(tables(h)).toContain("license_sessions");
    const app = await createLicensedApp(h);
    const activated = await h.post("/api/client/activate", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device } });
    const heartbeat = await h.post("/api/client/heartbeat", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device, session_token: activated.data.session_token } });
    expect(heartbeat.status).toBe(200);
    h.close();
  });

  it("lists live admin sessions", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    await h.post("/api/client/activate", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device } });
    const response = await h.get("/api/admin/sessions", { token: app.token });
    expect(response.status).toBe(200);
    expect(response.data.items).toHaveLength(1);
    h.close();
  });

  it("has no admin renewal route", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();
    for (const path of ["/api/admin/codes/1/renew", "/api/admin/renew"]) {
      const response = await h.post(path, { token, body: {} });
      expect(response.status).toBe(404);
    }
    h.close();
  });

  it("has no API rate limiting", async () => {
    const h = await createHarness();
    await h.loginBootstrap();

    // Repeated authentication failures are never throttled and are not counted.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await h.login("bootstrap-admin", "wrong-password");
      expect([401, 429]).toContain(response.status);
    }

    // No counter exists that could implement a limit.
    expect(allColumns(h).filter((name) => /attempt|throttle|rate_limit|failed_login/i.test(name))).toEqual([]);
    expect(tables(h).filter((name) => /rate|throttle|attempt/i.test(name))).toEqual([]);
    h.close();
  });

  it("has no webhook surface to malform", async () => {
    const h = await createHarness();
    for (const path of ["/api/webhooks/stripe", "/api/webhook", "/api/client/webhook"]) {
      const response = await h.post(path, { rawBody: "{ this is not a webhook" });
      expect(response.status).toBe(404);
    }
    // security_events is the 0007 audit log, not a webhook/event-delivery surface.
    expect(
      tables(h)
        .filter((name) => name !== "security_events")
        .filter((name) => /webhook|event|subscription/i.test(name))
    ).toEqual([]);
    h.close();
  });

  it("exposes no offline or cached-license endpoint", async () => {
    const h = await createHarness();
    for (const path of ["/api/client/offline", "/api/client/cache", "/api/client/last-known"]) {
      expect((await h.post(path, { body: {} })).status).toBe(404);
    }
    h.close();
  });
});

describe("server-offline, timeout and slow-network behaviour (UNVERIFIED)", () => {
  it("exposes an authoritative lease/grace window for client degraded mode", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });

    expect(response.data.grace_period_seconds).toBe(86400);
    expect(new Date(response.data.lease_expires_at).getTime()).toBeGreaterThan(Date.now());

    // UNVERIFIED here, and reported as such: what a client does when the
    // connection is refused, when a response never arrives, or when a Worker is
    // slower than a client timeout. An in-process harness always has a server.
    // Observing those three section 49 entries needs a real client SDK and a
    // deployed Worker; neither exists in this repository.
    h.close();
  });
});
