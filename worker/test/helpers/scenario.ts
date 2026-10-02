/**
 * Scenario helpers.
 *
 * These deliberately drive the public HTTP API rather than inserting rows
 * directly, so a scenario's setup is itself an exercise of the surface under
 * test: a break in login, app creation, or code generation fails these helpers
 * loudly instead of being bypassed.
 */
import type { Harness } from "./harness";
import { BOOTSTRAP_PASSWORD, BOOTSTRAP_USERNAME } from "./harness";

export type LicensedApp = {
  /** Bootstrap admin bearer token. */
  token: string;
  appId: string;
  appSecret: string;
  planCode: string;
  /** Plaintext activation codes, as returned once at generation time. */
  codes: string[];
  code: string;
  device: string;
};

export async function createLicensedApp(
  h: Harness,
  options: { planCode?: string; quantity?: number; name?: string } = {}
): Promise<LicensedApp> {
  const planCode = options.planCode ?? "monthly";
  const quantity = options.quantity ?? 3;
  const token = await h.loginBootstrap();

  const created = await h.post("/api/admin/apps", {
    token,
    body: { name: options.name ?? "Desktop Suite", platform: "desktop" }
  });
  if (!created.payload.ok) {
    throw new Error(`createApp failed: ${created.status} ${JSON.stringify(created.payload)}`);
  }
  const appId = created.data.app.app_id as string;
  const appSecret = created.data.app_secret as string;

  const batch = await h.post("/api/admin/codes/batch", {
    token,
    body: { app_id: appId, plan_code: planCode, quantity }
  });
  if (!batch.payload.ok) {
    throw new Error(`generateCodes failed: ${batch.status} ${JSON.stringify(batch.payload)}`);
  }
  const codes = batch.data.codes as string[];

  return {
    token,
    appId,
    appSecret,
    planCode,
    codes,
    code: codes[0],
    device: "device-fingerprint-A"
  };
}

/**
 * Creates a second managed admin user (admin role) via the user-management API
 * and logs it in, returning that user's token.
 */
export async function createManagedAdmin(
  h: Harness,
  options: { username: string; password?: string }
): Promise<{ id: number; token: string; username: string; password: string; superToken: string }> {
  const password = options.password ?? "managed-password-1";
  const superToken = await h.loginBootstrap();
  const created = await h.post("/api/admin/users", {
    token: superToken,
    body: { username: options.username, password, role: "admin" }
  });
  if (!created.payload.ok) {
    throw new Error(`createUser failed: ${created.status} ${JSON.stringify(created.payload)}`);
  }
  const id = created.data.id as number;
  // Newly created users carry must_change_password = 1; clear it so the returned
  // token is immediately usable for the scenarios that need an authenticated call.
  h.raw.prepare("UPDATE admin_users SET must_change_password = 0 WHERE username = ?").run(options.username);
  const login = await h.login(options.username, password);
  if (!login.payload.ok) {
    throw new Error(`managed admin login failed: ${login.status} ${JSON.stringify(login.payload)}`);
  }
  return { id, token: login.data.token as string, username: options.username, password, superToken };
}

export const bootstrapCredentials = {
  username: BOOTSTRAP_USERNAME,
  password: BOOTSTRAP_PASSWORD
};
