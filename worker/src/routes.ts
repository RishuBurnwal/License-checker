import { Hono } from "hono";
import { requireEnv, validateEnv } from "./config";
import {
  APP_STATUS,
  CODE_BULK_ACTION,
  CODE_TOGGLE_STATUS,
  MAX_CODE_BATCH_QUANTITY,
  isAppStatus,
  isCodeBulkAction,
  isCodeListStatus,
  isCodeToggleStatus
} from "./constants";
import { signJwt } from "./crypto";
import { ok, optionalBoolean, optionalHttpUrl, optionalString, readJson, requireInteger, requireString } from "./http";
import { requireAdmin, requireUserManager } from "./middleware";
import { D1Adapter } from "./db/adapter";
import { Repository } from "./repository";
import { LicenseService } from "./service";
import { ApiError, Bindings, Variables } from "./types";

export function createApi() {
  const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  api.use("*", async (c, next) => {
    validateEnv(c.env);
    await next();
  });

  api.get("/health", (c) => c.json(ok({ status: "ok" })));

  api.post("/admin/login", async (c) => {
    const body = await readJson(c.req.raw);
    const username = requireString(body.username, "username");
    const password = requireString(body.password, "password");
    // Optional: only an admin account requires it; the login UI's role dropdown
    // is a hint and is NOT sent as an authorization signal.
    const masterPassword = optionalString(body.master_password);
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const admin = await service.authenticateAdmin(username, password, masterPassword);
    const ttlSeconds = 8 * 60 * 60;
    const token = await signJwt(
      requireEnv(c.env, "JWT_SECRET"),
      { sub: String(admin.id), username: admin.username, epoch: admin.session_epoch },
      ttlSeconds
    );
    await service.recordAdminSession({
      adminId: admin.id,
      epoch: admin.session_epoch,
      ttlSeconds,
      userAgent: c.req.header("User-Agent") ?? null
    });
    return c.json(ok({ token, admin }));
  });

  api.post("/recovery/admin-password", async (c) => {
    const body = await readJson(c.req.raw);
    const username = requireString(body.username, "username");
    const recoveryPassword = requireString(body.recovery_password, "recovery_password");
    const newPassword = requireString(body.new_password, "new_password");
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.resetAdminPassword({
      username,
      recoveryPassword,
      newPassword
    });
    return c.json(ok(result));
  });

  api.use("/admin/*", requireAdmin);

  api.get("/admin/me", (c) => c.json(ok({ admin: c.get("admin") })));

  api.get("/admin/dashboard", async (c) => {
    const repo = new Repository(new D1Adapter(c.env.DB));
    return c.json(ok(await repo.getDashboardStats()));
  });

  api.patch("/admin/password", async (c) => {
    const body = await readJson(c.req.raw);
    const currentPassword = requireString(body.current_password, "current_password");
    const newPassword = requireString(body.new_password, "new_password");
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.changeAdminPassword({
      adminId: c.get("admin").id,
      currentPassword,
      newPassword
    });
    return c.json(ok(result));
  });

  api.get("/admin/plans", async (c) => {
    const repo = new Repository(new D1Adapter(c.env.DB));
    return c.json(ok({ items: await repo.getPlans() }));
  });

  api.get("/admin/apps", async (c) => {
    const repo = new Repository(new D1Adapter(c.env.DB));
    return c.json(ok({ items: await repo.listApps() }));
  });

  api.post("/admin/apps", async (c) => {
    const body = await readJson(c.req.raw);
    const name = requireString(body.name, "name");
    const description = optionalString(body.description);
    const purchaseUrl = optionalHttpUrl(body.purchase_url, "purchase_url");
    const platform = requireString(body.platform, "platform");
    const status = optionalString(body.status) === APP_STATUS.DISABLED ? APP_STATUS.DISABLED : APP_STATUS.ACTIVE;
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const app = await service.createApp({ name, description, purchaseUrl, platform, status });
    return c.json(ok(app), 201);
  });

  api.patch("/admin/apps/:appId", async (c) => {
    const body = await readJson(c.req.raw);
    const name = requireString(body.name, "name");
    const description = optionalString(body.description);
    const purchaseUrl = optionalHttpUrl(body.purchase_url, "purchase_url");
    const platform = requireString(body.platform, "platform");
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const app = await service.updateApp({ appId: c.req.param("appId"), name, description, purchaseUrl, platform });
    return c.json(ok(app));
  });

  api.patch("/admin/apps/:appId/status", async (c) => {
    const body = await readJson(c.req.raw);
    const status = requireString(body.status, "status");
    if (!isAppStatus(status)) {
      throw new ApiError(400, "BAD_REQUEST", "status must be active or disabled");
    }
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.updateAppStatus({
      appId: c.req.param("appId"),
      status,
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.patch("/admin/apps/:appId/secret", async (c) => {
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.rotateAppSecret({
      appId: c.req.param("appId"),
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.delete("/admin/apps/:appId", async (c) => {
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.deleteApp(c.req.param("appId"));
    return c.json(ok(result));
  });

  api.post("/admin/codes/batch", async (c) => {
    const body = await readJson(c.req.raw);
    const appId = requireString(body.app_id, "app_id");
    const planCode = requireString(body.plan_code, "plan_code");
    const quantity = requireInteger(body.quantity, "quantity", { min: 1, max: MAX_CODE_BATCH_QUANTITY });
    const note = optionalString(body.note);
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.generateCodes({
      appId,
      planCode,
      quantity,
      note,
      adminId: c.get("admin").id
    });
    return c.json(ok(result), 201);
  });

  api.get("/admin/codes", async (c) => {
    const repo = new Repository(new D1Adapter(c.env.DB));
    const page = requireInteger(c.req.query("page") ?? 1, "page", { min: 1 });
    const pageSize = requireInteger(c.req.query("page_size") ?? 20, "page_size", { min: 1, max: 100 });
    const status = c.req.query("status");
    const normalizedStatus = status && isCodeListStatus(status) ? status : undefined;
    if (status && !normalizedStatus) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid status filter");
    }
    const result = await repo.listCodes({
      query: c.req.query("query") || undefined,
      appId: c.req.query("app_id") || undefined,
      planCode: c.req.query("plan_code") || undefined,
      status: normalizedStatus,
      page,
      pageSize
    });
    return c.json(ok(result));
  });

  api.patch("/admin/codes/:id/status", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const body = await readJson(c.req.raw);
    const status = requireString(body.status, "status");
    if (!isCodeToggleStatus(status)) {
      throw new ApiError(400, "BAD_REQUEST", "status must be enabled or disabled");
    }
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.updateCodeDisabled({
      codeId: id,
      disabled: status === CODE_TOGGLE_STATUS.DISABLED,
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.patch("/admin/codes/:id/unbind-device", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.manuallyUnbindDevice({
      codeId: id,
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.post("/admin/codes/bulk", async (c) => {
    const body = await readJson(c.req.raw);
    const action = requireString(body.action, "action");
    if (!isCodeBulkAction(action)) {
      throw new ApiError(400, "BAD_REQUEST", "action must be delete, enable or disable");
    }
    const ids = requireIntegerArray(body.ids, "ids", { min: 1, max: 100 });
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.bulkUpdateCodes({
      codeIds: ids,
      action,
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.delete("/admin/codes/:id", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    await service.deleteCode(id, c.get("admin").id);
    return c.json(ok({ deleted: true }));
  });

  api.patch("/admin/codes/:id/hold", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.holdCode({
      codeId: id,
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.patch("/admin/codes/:id/approve", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.approveCode({
      codeId: id,
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.patch("/admin/codes/:id/validity", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const body = await readJson(c.req.raw);
    const expiresAt = requireString(body.expires_at, "expires_at");
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.setCodeValidity({
      codeId: id,
      expiresAt,
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.patch("/admin/codes/:id/max-activations", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const body = await readJson(c.req.raw);
    const value =
      body.max_activations === null ? null : requireInteger(body.max_activations, "max_activations", { min: 1 });
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.setMaxActivations({
      codeId: id,
      value,
      adminId: c.get("admin").id
    });
    return c.json(ok(result));
  });

  api.get("/admin/codes/:id/activations", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.listCodeActivations({
      codeId: id
    });
    return c.json(ok(result));
  });

  api.get("/admin/codes/:id/security-events", async (c) => {
    const id = requireInteger(c.req.param("id"), "id", { min: 1 });
    const page = requireInteger(c.req.query("page") ?? 1, "page", { min: 1 });
    const pageSize = requireInteger(c.req.query("page_size") ?? 20, "page_size", { min: 1, max: 100 });
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.listCodeSecurityEvents({
      codeId: id,
      page,
      pageSize
    });
    return c.json(ok(result));
  });

  api.get("/admin/logs", async (c) => {
    const repo = new Repository(new D1Adapter(c.env.DB));
    const page = requireInteger(c.req.query("page") ?? 1, "page", { min: 1 });
    const pageSize = requireInteger(c.req.query("page_size") ?? 20, "page_size", { min: 1, max: 100 });
    const result = await repo.listLogs({
      query: c.req.query("query") || undefined,
      appId: c.req.query("app_id") || undefined,
      action: c.req.query("action") || undefined,
      page,
      pageSize
    });
    return c.json(ok(result));
  });

  api.get("/admin/sessions", async (c) => {
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.listActiveSessions()));
  });

  api.post("/admin/sessions/:id/kick", async (c) => {
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.kickSession(requireInteger(c.req.param("id"), "id", { min: 1 }), c.get("admin").id)));
  });

  // --- User management. Gated to admin (user_role) via requireUserManager;
  // staff is denied SERVER-SIDE (not merely hidden).
  api.get("/admin/users", async (c) => {
    requireUserManager(c);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.listUsers()));
  });

  api.post("/admin/users", async (c) => {
    requireUserManager(c);
    const body = await readJson(c.req.raw);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.createUser({
      username: requireString(body.username, "username"),
      password: requireString(body.password, "password"),
      role: requireString(body.role, "role"),
      actorId: c.get("admin").id
    });
    return c.json(ok(result), 201);
  });

  api.patch("/admin/users/:id/password", async (c) => {
    requireUserManager(c);
    const body = await readJson(c.req.raw);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.resetUserPassword({
      adminId: requireInteger(c.req.param("id"), "id", { min: 1 }),
      newPassword: requireString(body.new_password, "new_password"),
      forceChange: optionalBoolean(body.force_change) ?? true,
      actorId: c.get("admin").id
    })));
  });

  api.post("/admin/users/:id/password/generate", async (c) => {
    requireUserManager(c);
    const body = await readJson(c.req.raw);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.generateUserPassword({
      adminId: requireInteger(c.req.param("id"), "id", { min: 1 }),
      forceChange: optionalBoolean(body.force_change) ?? true,
      actorId: c.get("admin").id
    })));
  });

  api.post("/admin/users/:id/kick", async (c) => {
    requireUserManager(c);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.kickUser({
      adminId: requireInteger(c.req.param("id"), "id", { min: 1 }),
      actorId: c.get("admin").id
    })));
  });

  api.patch("/admin/users/:id/role", async (c) => {
    requireUserManager(c);
    const body = await readJson(c.req.raw);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.setUserRole({
      adminId: requireInteger(c.req.param("id"), "id", { min: 1 }),
      role: requireString(body.role, "role"),
      actorId: c.get("admin").id
    })));
  });

  api.get("/admin/users/:id/sessions", async (c) => {
    requireUserManager(c);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.listUserSessions({
      adminId: requireInteger(c.req.param("id"), "id", { min: 1 })
    })));
  });

  // Change the global admin master password. Manager-gated (staff -> 403); the
  // route never echoes the plaintext back (AC-B12).
  api.patch("/admin/settings/master-password", async (c) => {
    requireUserManager(c);
    const body = await readJson(c.req.raw);
    const currentMasterPassword = requireString(body.current_master_password, "current_master_password");
    const newMasterPassword = requireString(body.new_master_password, "new_master_password");
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.changeMasterPassword({ currentMasterPassword, newMasterPassword })));
  });

  api.post("/client/activate", async (c) => {
    const body = await readJson(c.req.raw);
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.activate({
      appId: requireString(body.app_id, "app_id"),
      appSecret: requireString(body.app_secret, "app_secret"),
      code: requireString(body.code, "code"),
      deviceFingerprint: requireString(body.device_fingerprint, "device_fingerprint"),
      sessionToken: optionalString(body.session_token)
    });
    return c.json(ok(result));
  });

  api.post("/client/app-info", async (c) => {
    const body = await readJson(c.req.raw);
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.getClientAppInfo({
      appId: requireString(body.app_id, "app_id"),
      appSecret: requireString(body.app_secret, "app_secret")
    });
    return c.json(ok(result));
  });

  api.post("/client/verify", async (c) => {
    const body = await readJson(c.req.raw);
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.verify({
      appId: requireString(body.app_id, "app_id"),
      appSecret: requireString(body.app_secret, "app_secret"),
      code: requireString(body.code, "code"),
      deviceFingerprint: requireString(body.device_fingerprint, "device_fingerprint")
    });
    return c.json(ok(result));
  });

  api.post("/client/heartbeat", async (c) => {
    const body = await readJson(c.req.raw);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.heartbeat({
      appId: requireString(body.app_id, "app_id"),
      appSecret: requireString(body.app_secret, "app_secret"),
      code: requireString(body.code, "code"),
      deviceFingerprint: requireString(body.device_fingerprint, "device_fingerprint"),
      sessionToken: requireString(body.session_token, "session_token")
    })));
  });

  api.post("/client/renew", async (c) => {
    const body = await readJson(c.req.raw);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    return c.json(ok(await service.renew({
      appId: requireString(body.app_id, "app_id"),
      appSecret: requireString(body.app_secret, "app_secret"),
      code: requireString(body.code, "code"),
      deviceFingerprint: requireString(body.device_fingerprint, "device_fingerprint"),
      sessionToken: optionalString(body.session_token)
    })));
  });

  api.post("/client/unbind-device", async (c) => {
    const body = await readJson(c.req.raw);
    const repo = new Repository(new D1Adapter(c.env.DB));
    const service = new LicenseService(repo, c.env);
    const result = await service.unbindDevice({
      appId: requireString(body.app_id, "app_id"),
      appSecret: requireString(body.app_secret, "app_secret"),
      code: requireString(body.code, "code"),
      deviceFingerprint: requireString(body.device_fingerprint, "device_fingerprint")
    });
    return c.json(ok(result));
  });

  return api;
}

/**
 * Versioned client surface for signed license verification (design §3). Reuses
 * the same per-request validateEnv middleware as createApi(), so a missing or
 * malformed signing key fails the first /api/v1/* request with 500 CONFLICT.
 */
export function createV1Api() {
  const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  api.use("*", async (c, next) => {
    validateEnv(c.env);
    await next();
  });

  api.post("/license/verify", async (c) => {
    const body = await readJson(c.req.raw);
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.verifySigned({
      appId: requireString(body.app_id, "app_id"),
      appSecret: requireString(body.app_secret, "app_secret"),
      licenseKey: requireString(body.license_key, "license_key"),
      productId: requireString(body.product_id, "product_id"),
      installationId: requireString(body.installation_id, "installation_id"),
      applicationVersion: optionalString(body.application_version),
      protocolVersion: requireInteger(body.protocol_version, "protocol_version", { min: 1 })
    });
    return c.json(ok(result));
  });

  api.post("/license/report", async (c) => {
    const body = await readJson(c.req.raw);
    const hasKey = body.license_key !== undefined && body.license_key !== null;
    const hasId = body.license_id !== undefined && body.license_id !== null;
    if (hasKey === hasId) {
      throw new ApiError(400, "BAD_REQUEST", "Exactly one of license_key or license_id is required");
    }
    const service = new LicenseService(new Repository(new D1Adapter(c.env.DB)), c.env);
    const result = await service.reportEvent({
      appId: requireString(body.app_id, "app_id"),
      appSecret: requireString(body.app_secret, "app_secret"),
      installationId: requireString(body.installation_id, "installation_id"),
      licenseKey: hasKey ? requireString(body.license_key, "license_key") : undefined,
      licenseId: hasId ? requireInteger(body.license_id, "license_id", { min: 1 }) : undefined,
      reasonCode: requireString(body.reason_code, "reason_code"),
      detail: optionalString(body.detail)
    });
    return c.json(ok(result));
  });

  return api;
}

function requireIntegerArray(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {}
): number[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, "BAD_REQUEST", `${name} must be an array`);
  }
  if (options.min !== undefined && value.length < options.min) {
    throw new ApiError(400, "BAD_REQUEST", `${name} must contain at least ${options.min} item`);
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new ApiError(400, "BAD_REQUEST", `${name} must contain at most ${options.max} items`);
  }
  const ids = value.map((item, index) => requireInteger(item, `${name}[${index}]`, { min: 1 }));
  return Array.from(new Set(ids));
}
