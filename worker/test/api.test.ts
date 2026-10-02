/**
 * API tests (Prompt.md section 46) against the real HTTP surface.
 *
 * Every call goes through `app.fetch()` — the actual Worker entry point — so
 * routing, the middleware chain, request validation, authorization and the
 * response envelope are all exercised as deployed code, not as re-implemented
 * test doubles.
 */
import { describe, expect, it } from "vitest";
import { MAX_CODE_BATCH_QUANTITY } from "../src/constants";
import { createHarness } from "./helpers/harness";
import { createLicensedApp, createManagedAdmin } from "./helpers/scenario";

describe("envelope and routing", () => {
  it("answers health checks with the standard success envelope", async () => {
    const h = await createHarness();
    const response = await h.get("/api/health");
    expect(response.status).toBe(200);
    expect(response.payload).toEqual({ ok: true, data: { status: "ok" } });
    h.close();
  });

  it("returns a NOT_FOUND envelope for unknown API routes", async () => {
    const h = await createHarness();
    const response = await h.get("/api/does-not-exist");
    expect(response.status).toBe(404);
    expect(response.error?.code).toBe("NOT_FOUND");
    h.close();
  });

  it("delegates non-API paths to the static asset binding", async () => {
    const h = await createHarness();
    const response = await h.get("/console");
    // The stubbed ASSETS fetcher answers, proving the Worker falls through
    // instead of treating the SPA shell as an API miss.
    expect(response.status).toBe(200);
    expect(response.payload.error?.code).toBe("NON_JSON");
    h.close();
  });

  it("always returns the ok/data or ok/error shape", async () => {
    const h = await createHarness();
    const success = await h.get("/api/health");
    expect(Object.keys(success.payload).sort()).toEqual(["data", "ok"]);

    const failure = await h.get("/api/admin/me");
    expect(failure.payload.ok).toBe(false);
    expect(failure.error).toHaveProperty("code");
    expect(failure.error).toHaveProperty("message");
    h.close();
  });
});

describe("admin authentication", () => {
  it("issues a token for correct bootstrap credentials with username and password only", async () => {
    const h = await createHarness();
    const response = await h.login("bootstrap-admin", "bootstrap-password-1");
    expect(response.status).toBe(200);
    expect(typeof response.data.token).toBe("string");
    expect(response.data.admin).toMatchObject({ username: "bootstrap-admin", user_role: "admin" });
    h.close();
  });

  it("never reveals which credential was wrong", async () => {
    const h = await createHarness();
    await h.login("bootstrap-admin", "bootstrap-password-1");

    const wrongPassword = await h.login("bootstrap-admin", "wrong-password");
    const wrongUser = await h.login("no-such-user", "bootstrap-password-1");

    for (const response of [wrongPassword, wrongUser]) {
      expect(response.status).toBe(401);
      expect(response.error?.code).toBe("UNAUTHORIZED");
      expect(response.error?.message).toBe("Invalid username or password");
    }
    h.close();
  });

  it("rejects malformed and missing login bodies with BAD_REQUEST", async () => {
    const h = await createHarness();
    const missing = await h.post("/api/admin/login", { body: { username: "bootstrap-admin" } });
    expect(missing.status).toBe(400);
    expect(missing.error?.message).toContain("password");

    const notJson = await h.post("/api/admin/login", { rawBody: "{not json" });
    expect(notJson.status).toBe(400);
    expect(notJson.error?.message).toBe("Invalid JSON body");

    const arrayBody = await h.post("/api/admin/login", { rawBody: "[1,2,3]" });
    expect(arrayBody.status).toBe(400);
    expect(arrayBody.error?.message).toBe("JSON body must be an object");
    h.close();
  });

  it("refuses protected routes without a usable bearer token", async () => {
    const h = await createHarness();
    const missing = await h.get("/api/admin/me");
    expect(missing.status).toBe(401);

    const malformed = await h.get("/api/admin/me", { headers: { Authorization: "Basic abc" } });
    expect(malformed.status).toBe(401);

    const garbage = await h.get("/api/admin/me", { token: "not-a-jwt" });
    expect(garbage.status).toBe(401);
    expect(garbage.error?.message).toBe("Invalid or expired token");
    h.close();
  });

  it("returns the principal for a valid token", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();
    const response = await h.get("/api/admin/me", { token });
    expect(response.status).toBe(200);
    expect(response.data.admin).toMatchObject({ username: "bootstrap-admin", user_role: "admin" });
    // Multi-tenancy is gone: the principal carries no tenant/role axis.
    expect(response.data.admin).not.toHaveProperty("tenant_id");
    expect(response.data.admin).not.toHaveProperty("role");
    h.close();
  });
});

describe("multi-tenancy is fully removed", () => {
  it("serves apps globally without an X-Tenant-Id header", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();
    const apps = await h.get("/api/admin/apps", { token });
    expect(apps.status).toBe(200);
    expect(Array.isArray(apps.data.items)).toBe(true);
    h.close();
  });

  it("has no tenant routes (GET and POST /api/admin/tenants return 404)", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();
    const list = await h.get("/api/admin/tenants", { token });
    expect(list.status).toBe(404);
    const create = await h.post("/api/admin/tenants", {
      token,
      body: { name: "X", admin_username: "x", admin_password: "x-password-1" }
    });
    expect(create.status).toBe(404);
    h.close();
  });

  it("shares one global dataset across every admin account", async () => {
    const h = await createHarness();
    const superToken = await h.loginBootstrap();
    const managed = await createManagedAdmin(h, { username: "second-admin" });

    await h.post("/api/admin/apps", { token: superToken, body: { name: "Shared App", platform: "desktop" } });

    const seenBySecond = await h.get("/api/admin/apps", { token: managed.token });
    expect(seenBySecond.data.items.map((app: any) => app.name)).toContain("Shared App");
    h.close();
  });
});

describe("request validation", () => {
  it("reports the offending field for missing or blank inputs", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const noName = await h.post("/api/admin/apps", { token: app.token, body: { platform: "desktop" } });
    expect(noName.status).toBe(400);
    expect(noName.error?.message).toBe("name is required");

    const blankName = await h.post("/api/admin/apps", {
      token: app.token,
      body: { name: "   ", platform: "desktop" }
    });
    expect(blankName.status).toBe(400);
    h.close();
  });

  it("rejects non-http purchase URLs but accepts valid ones", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const bad = await h.post("/api/admin/apps", {
      token: app.token,
      body: { name: "Bad", platform: "desktop", purchase_url: "javascript:alert(1)" }
    });
    expect(bad.status).toBe(400);
    expect(bad.error?.message).toContain("valid http or https URL");

    const good = await h.post("/api/admin/apps", {
      token: app.token,
      body: { name: "Good", platform: "desktop", purchase_url: "https://example.com/buy" }
    });
    expect(good.status).toBe(201);
    expect(good.data.app.purchase_url).toBe("https://example.com/buy");
    h.close();
  });

  it("enforces batch quantity bounds", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const zero = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: app.appId, plan_code: "monthly", quantity: 0 }
    });
    expect(zero.status).toBe(400);

    const tooMany = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: app.appId, plan_code: "monthly", quantity: MAX_CODE_BATCH_QUANTITY + 1 }
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.error?.message).toBe(`quantity must be at most ${MAX_CODE_BATCH_QUANTITY}`);

    const fractional = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: app.appId, plan_code: "monthly", quantity: 2.5 }
    });
    expect(fractional.status).toBe(400);
    h.close();
  });

  it("validates pagination and list filters", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const badPage = await h.get("/api/admin/codes?page=0", { token: app.token });
    expect(badPage.status).toBe(400);

    const bigPage = await h.get("/api/admin/codes?page_size=101", { token: app.token });
    expect(bigPage.status).toBe(400);

    const badStatus = await h.get("/api/admin/codes?status=nonsense", { token: app.token });
    expect(badStatus.status).toBe(400);
    expect(badStatus.error?.message).toBe("Invalid status filter");

    const okList = await h.get("/api/admin/codes?page=1&page_size=2", { token: app.token });
    expect(okList.status).toBe(200);
    expect(okList.data.items).toHaveLength(2);
    expect(okList.data.total).toBe(3);
    h.close();
  });

  it("rejects invalid enum values on status updates and bulk actions", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const codes = await h.get("/api/admin/codes", { token: app.token });
    const codeId = codes.data.items[0].id;

    const badCodeStatus = await h.patch(`/api/admin/codes/${codeId}/status`, {
      token: app.token,
      body: { status: "active" }
    });
    expect(badCodeStatus.status).toBe(400);
    expect(badCodeStatus.error?.message).toBe("status must be enabled or disabled");

    const badAppStatus = await h.patch(`/api/admin/apps/${app.appId}/status`, {
      token: app.token,
      body: { status: "deleted" }
    });
    expect(badAppStatus.status).toBe(400);

    const badAction = await h.post("/api/admin/codes/bulk", {
      token: app.token,
      body: { action: "nuke", ids: [codeId] }
    });
    expect(badAction.status).toBe(400);
    h.close();
  });

  it("validates bulk id arrays", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const notArray = await h.post("/api/admin/codes/bulk", {
      token: app.token,
      body: { action: "disable", ids: "1" }
    });
    expect(notArray.status).toBe(400);
    expect(notArray.error?.message).toBe("ids must be an array");

    const empty = await h.post("/api/admin/codes/bulk", { token: app.token, body: { action: "disable", ids: [] } });
    expect(empty.status).toBe(400);

    const tooMany = await h.post("/api/admin/codes/bulk", {
      token: app.token,
      body: { action: "disable", ids: Array.from({ length: 101 }, (_, index) => index + 1) }
    });
    expect(tooMany.status).toBe(400);

    const negatives = await h.post("/api/admin/codes/bulk", { token: app.token, body: { action: "disable", ids: [-1] } });
    expect(negatives.status).toBe(400);
    h.close();
  });

  it("rejects a malformed :id path parameter", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.patch("/api/admin/codes/not-a-number/status", {
      token: app.token,
      body: { status: "disabled" }
    });
    expect(response.status).toBe(400);
    expect(response.error?.message).toBe("id must be an integer");
    h.close();
  });
});

describe("resource existence and conflicts", () => {
  it("returns NOT_FOUND for unknown apps and plans", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const unknownApp = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: "app_missing", plan_code: "monthly", quantity: 1 }
    });
    expect(unknownApp.status).toBe(404);
    expect(unknownApp.error?.message).toBe("App not found");

    const unknownPlan = await h.post("/api/admin/codes/batch", {
      token: app.token,
      body: { app_id: app.appId, plan_code: "decade", quantity: 1 }
    });
    expect(unknownPlan.status).toBe(404);
    expect(unknownPlan.error?.message).toBe("Plan not found");
    h.close();
  });

  it("refuses to delete an app that owns activation data", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.delete(`/api/admin/apps/${app.appId}`, { token: app.token });
    expect(response.status).toBe(409);
    expect(response.error?.message).toBe("App has activation data and cannot be deleted");
    h.close();
  });

  it("deletes an app that has no activation data", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();
    const created = await h.post("/api/admin/apps", {
      token,
      body: { name: "Disposable", platform: "cli" }
    });
    const response = await h.delete(`/api/admin/apps/${created.data.app.app_id}`, { token });
    expect(response.status).toBe(200);
    expect(response.data.deleted).toBe(true);
    h.close();
  });

  it("reports NOT_FOUND when a code update matches nothing", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.patch("/api/admin/codes/999999/status", {
      token: app.token,
      body: { status: "disabled" }
    });
    expect(response.status).toBe(404);
    expect(response.error?.message).toBe("Activation code not found");
    h.close();
  });

  it("reports NOT_FOUND when a bulk action updates nothing", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.post("/api/admin/codes/bulk", {
      token: app.token,
      body: { action: "disable", ids: [999999] }
    });
    expect(response.status).toBe(404);
    expect(response.error?.message).toBe("No activation codes were updated");
    h.close();
  });
});

describe("administrator password management", () => {
  it("validates length, difference and the current password", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();

    const tooShort = await h.patch("/api/admin/password", {
      token,
      body: { current_password: "bootstrap-password-1", new_password: "short" }
    });
    expect(tooShort.status).toBe(400);

    const unchanged = await h.patch("/api/admin/password", {
      token,
      body: { current_password: "bootstrap-password-1", new_password: "bootstrap-password-1" }
    });
    expect(unchanged.status).toBe(400);
    expect(unchanged.error?.message).toBe("New password must be different from current password");

    const wrongCurrent = await h.patch("/api/admin/password", {
      token,
      body: { current_password: "not-the-password", new_password: "replacement-password-9" }
    });
    expect(wrongCurrent.status).toBe(401);
    h.close();
  });

  it("changes the password and keeps the existing token valid", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();

    const changed = await h.patch("/api/admin/password", {
      token,
      body: { current_password: "bootstrap-password-1", new_password: "replacement-password-9" }
    });
    expect(changed.status).toBe(200);
    expect(changed.data.updated).toBe(true);

    // The service states this explicitly in the docs: no server-side revocation.
    const stillValid = await h.get("/api/admin/me", { token });
    expect(stillValid.status).toBe(200);

    const oldPassword = await h.login("bootstrap-admin", "bootstrap-password-1");
    expect(oldPassword.status).toBe(401);
    const newPassword = await h.login("bootstrap-admin", "replacement-password-9");
    expect(newPassword.status).toBe(200);
    h.close();
  });

  it("blocks password changes for the reserved read-only account", async () => {
    const h = await createHarness();
    await h.loginBootstrap();
    h.raw
      .prepare("INSERT INTO admin_users (username, password_hash, password_salt, updated_at) VALUES ('test', 'h', 's', ?)")
      .run(new Date().toISOString());
    h.raw.prepare("UPDATE admin_users SET password_hash = ?, password_salt = ? WHERE username = 'test'").run("h", "s");

    // Authenticate as the reserved account by reusing a token that resolves to it.
    const adminId = h.sql<{ id: number }>("SELECT id FROM admin_users WHERE username = 'test'")[0].id;
    const { signJwt } = await import("../src/crypto");
    const token = await signJwt(
      "test-jwt-secret-0123456789abcdef0123456789abcdef",
      { sub: String(adminId), username: "test" },
      3600
    );

    const response = await h.patch("/api/admin/password", {
      token,
      body: { current_password: "anything", new_password: "another-password-1" }
    });
    expect(response.status).toBe(403);
    expect(response.error?.message).toBe("Password changes are disabled for this account");
    h.close();
  });

  it("gates recovery on configuration and the recovery password", async () => {
    const h = await createHarness();
    await h.loginBootstrap();

    const wrongRecovery = await h.post("/api/recovery/admin-password", {
      body: { username: "bootstrap-admin", recovery_password: "wrong", new_password: "recovered-password-1" }
    });
    expect(wrongRecovery.status).toBe(401);

    const sameAsRecovery = await h.post("/api/recovery/admin-password", {
      body: { username: "bootstrap-admin", recovery_password: "bootstrap-password-1", new_password: "bootstrap-password-1" }
    });
    expect(sameAsRecovery.status).toBe(400);

    const works = await h.post("/api/recovery/admin-password", {
      body: { username: "bootstrap-admin", recovery_password: "bootstrap-password-1", new_password: "recovered-password-1" }
    });
    expect(works.status).toBe(200);
    expect(works.data.reset).toBe(true);

    const relogin = await h.login("bootstrap-admin", "recovered-password-1");
    expect(relogin.status).toBe(200);
    h.close();
  });

  it("refuses recovery entirely when no bootstrap account is configured", async () => {
    const h = await createHarness({ ADMIN_BOOTSTRAP_USERNAME: undefined, ADMIN_BOOTSTRAP_PASSWORD: undefined });
    const response = await h.post("/api/recovery/admin-password", {
      body: { username: "anyone", recovery_password: "x", new_password: "y-password-1" }
    });
    expect(response.status).toBe(403);
    expect(response.error?.message).toBe("Password reset is not configured");
    h.close();
  });
});

describe("client endpoints", () => {
  it("activates a license and reports the plan", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { planCode: "weekly" });

    const response = await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      valid: true,
      device_bound: true,
      app_id: app.appId,
      plan: { code: "weekly", duration_days: 7 },
      rebind_count: 0,
      max_rebinds: 3
    });
    expect(typeof response.data.expires_at).toBe("string");
    expect(response.data.remaining_seconds).toBeGreaterThan(0);
    h.close();
  });

  it("serves app info without exposing the stored secret hash", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const response = await h.post("/api/client/app-info", {
      body: { app_id: app.appId, app_secret: app.appSecret }
    });
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ app_id: app.appId, platform: "desktop", status: "active" });
    expect(JSON.stringify(response.payload)).not.toContain("app_secret_hash");
    h.close();
  });

  it("rejects an invalid app secret", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.post("/api/client/app-info", { body: { app_id: app.appId, app_secret: "sec_wrong" } });
    expect(response.status).toBe(401);
    expect(response.error?.code).toBe("INVALID_APP_SECRET");
    h.close();
  });

  it("reports an unknown app as NOT_FOUND", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.post("/api/client/app-info", { body: { app_id: "app_nope", app_secret: app.appSecret } });
    expect(response.status).toBe(404);
    h.close();
  });

  it("refuses a disabled app", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    await h.patch(`/api/admin/apps/${app.appId}/status`, { token: app.token, body: { status: "disabled" } });
    const disabledApp = await h.post("/api/client/app-info", { body: { app_id: app.appId, app_secret: app.appSecret } });
    expect(disabledApp.status).toBe(403);
    expect(disabledApp.error?.code).toBe("APP_DISABLED");

    await h.patch(`/api/admin/apps/${app.appId}/status`, { token: app.token, body: { status: "active" } });
    const reEnabled = await h.post("/api/client/app-info", { body: { app_id: app.appId, app_secret: app.appSecret } });
    expect(reEnabled.status).toBe(200);
    h.close();
  });

  it("does not let one app's code be used against another app", async () => {
    const h = await createHarness();
    const first = await createLicensedApp(h, { name: "First" });
    const second = await createLicensedApp(h, { name: "Second" });

    const response = await h.post("/api/client/activate", {
      body: { app_id: second.appId, app_secret: second.appSecret, code: first.code, device_fingerprint: "device-x" }
    });
    expect(response.status).toBe(404);
    expect(response.error?.code).toBe("INVALID_CODE");
    h.close();
  });

  it("rejects a random activation code", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const response = await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ", device_fingerprint: "device-x" }
    });
    expect(response.status).toBe(404);
    expect(response.error?.code).toBe("INVALID_CODE");
    h.close();
  });

  it("requires every client field", async () => {
    const h = await createHarness();
    const response = await h.post("/api/client/activate", { body: { app_id: "app_x" } });
    expect(response.status).toBe(400);
    expect(response.error?.message).toBe("app_secret is required");
    h.close();
  });

  it("is idempotent for a repeated activation on the same device", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const body = { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device };

    const first = await h.post("/api/client/activate", { body });
    const second = await h.post("/api/client/activate", { body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Expiry must not drift on a repeat call.
    expect(second.data.expires_at).toBe(first.data.expires_at);
    expect(second.data.rebind_count).toBe(0);
    h.close();
  });
});
