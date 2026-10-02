/**
 * Live end-to-end verification against a running Worker (real HTTP, real D1).
 *
 * Unlike the Vitest suite this drives the deployed dev server over the network,
 * so it proves the whole stack works: routes, auth, D1, crypto, and the
 * session/heartbeat/kick/renew/grace-period features.
 *
 * Usage: node scripts/e2e-live.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const results = [];

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, payload, data: payload?.data, error: payload?.error };
}

const suffix = Date.now().toString(36);

async function main() {
  // 1. Health
  const health = await call("GET", "/api/health");
  record("health endpoint", health.status === 200 && health.data?.status === "ok", `status=${health.status}`);

  // 2. Admin login (creates bootstrap admin on first call)
  const login = await call("POST", "/api/admin/login", {
    body: { username: "bootstrap-admin", password: "bootstrap-password-1" }
  });
  const token = login.data?.token;
  record("admin login", login.status === 200 && !!token, `status=${login.status}`);
  if (!token) throw new Error("login failed; cannot continue");

  // 2a. Admin/staff user management: create a user, forced-password-change on
  // first login, then kick that user and prove the pre-kick token is rejected.
  const newUsername = `ops-${suffix}`;
  const tempPassword = "temp-password-1";
  const newPassword = "fresh-password-2";
  const createUser = await call("POST", "/api/admin/users", {
    token,
    body: { username: newUsername, password: tempPassword, role: "admin" }
  });
  const newUserId = createUser.data?.id;
  record(
    "super admin creates user (must-change)",
    createUser.status === 201 && !!newUserId && createUser.data?.must_change_password === true,
    `id=${newUserId}, must_change=${createUser.data?.must_change_password}`
  );

  // New user logs in; login must report the forced-change flag.
  const userLogin = await call("POST", "/api/admin/login", {
    body: { username: newUsername, password: tempPassword }
  });
  const userToken = userLogin.data?.token;
  record(
    "new user login reports forced change",
    userLogin.status === 200 && !!userToken && userLogin.data?.admin?.must_change_password === true,
    `must_change=${userLogin.data?.admin?.must_change_password}`
  );

  // A non-exempt call is blocked with PASSWORD_CHANGE_REQUIRED until the change.
  const blocked = await call("GET", "/api/admin/apps", { token: userToken });
  record(
    "forced change blocks protected routes",
    blocked.status === 403 && blocked.error?.code === "PASSWORD_CHANGE_REQUIRED",
    `status=${blocked.status}, code=${blocked.error?.code}`
  );

  // Changing the password clears the flag; the same route now succeeds.
  const changed = await call("PATCH", "/api/admin/password", {
    token: userToken,
    body: { current_password: tempPassword, new_password: newPassword }
  });
  record("user changes password", changed.status === 200 && changed.data?.updated === true, `status=${changed.status}`);
  const afterChange = await call("GET", "/api/admin/apps", { token: userToken });
  record("protected route works after change", afterChange.status === 200, `status=${afterChange.status}`);

  // Super admin kicks the user; the pre-kick token must now be rejected 401.
  if (newUserId) {
    const kickUser = await call("POST", `/api/admin/users/${newUserId}/kick`, { token, body: {} });
    record("super admin kicks user", kickUser.status === 200 && kickUser.data?.kicked === true, `status=${kickUser.status}`);
    const afterUserKick = await call("GET", "/api/admin/apps", { token: userToken });
    record(
      "kicked user token rejected 401",
      afterUserKick.status === 401,
      `status=${afterUserKick.status}, code=${afterUserKick.error?.code}`
    );
  } else {
    record("super admin kicks user", false, "user id missing; skipped");
    record("kicked user token rejected 401", false, "skipped");
  }

  // 3. Create app
  const app = await call("POST", "/api/admin/apps", {
    token,
    body: { name: `Live App ${suffix}`, platform: "desktop" }
  });
  const appId = app.data?.app?.app_id;
  const appSecret = app.data?.app_secret;
  record("create app", app.status === 201 && !!appId && !!appSecret, `app_id=${appId}`);
  if (!appId) throw new Error("app creation failed; cannot continue");

  // 4. Generate a license code
  const batch = await call("POST", "/api/admin/codes/batch", {
    token,
    body: { app_id: appId, plan_code: "monthly", quantity: 1 }
  });
  const code = batch.data?.codes?.[0];
  record("generate code", batch.status === 201 && !!code, `code=${code}`);
  if (!code) throw new Error("code generation failed; cannot continue");

  const device = `live-device-${suffix}`;

  // 5. Activate — returns a session token
  const activate = await call("POST", "/api/client/activate", {
    body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device }
  });
  const sessionToken = activate.data?.session_token;
  record(
    "activate returns session token",
    activate.status === 200 && activate.data?.valid === true && !!sessionToken,
    `session_token=${sessionToken ? "present" : "MISSING"}, heartbeat_interval=${activate.data?.heartbeat_interval_seconds}, grace=${activate.data?.grace_period_seconds}`
  );

  // 6. Heartbeat keeps the session alive
  const heartbeat = await call("POST", "/api/client/heartbeat", {
    body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device, session_token: sessionToken }
  });
  record("heartbeat accepted", heartbeat.status === 200 && heartbeat.data?.valid === true, `status=${heartbeat.status}`);

  // 7. Admin can list the active session
  const sessions = await call("GET", "/api/admin/sessions", { token });
  const listed = sessions.data?.items ?? [];
  const mine = listed.find((s) => s.code_suffix === code.replace(/-/g, "").slice(-6));
  record("admin lists active session", sessions.status === 200 && !!mine, `count=${listed.length}`);

  // 8. Admin kicks the session
  if (mine) {
    const kick = await call("POST", `/api/admin/sessions/${mine.id}/kick`, { token, body: {} });
    record("admin kicks session", kick.status === 200 && kick.data?.kicked === true, `status=${kick.status}`);

    // 9. The kicked client is refused
    const afterKick = await call("POST", "/api/client/heartbeat", {
      body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device, session_token: sessionToken }
    });
    record(
      "kicked session rejected",
      afterKick.status === 403 && afterKick.error?.code === "SESSION_REVOKED",
      `status=${afterKick.status}, code=${afterKick.error?.code}`
    );

    // 10. Reactivation after a kick must work (this regressed before the fix)
    const reactivate = await call("POST", "/api/client/activate", {
      body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device, session_token: sessionToken }
    });
    record(
      "reactivate after kick",
      reactivate.status === 200 && reactivate.data?.valid === true,
      `status=${reactivate.status}`
    );
  } else {
    record("admin kicks session", false, "session row not found; skipped dependent checks");
    record("kicked session rejected", false, "skipped");
    record("reactivate after kick", false, "skipped");
  }

  // 11. Renewal extends the expiry
  const before = await call("POST", "/api/client/verify", {
    body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device }
  });
  const renew = await call("POST", "/api/client/renew", {
    body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device, session_token: sessionToken }
  });
  const extended =
    renew.status === 200 &&
    before.data?.expires_at &&
    renew.data?.expires_at &&
    new Date(renew.data.expires_at).getTime() > new Date(before.data.expires_at).getTime();
  record(
    "renew extends expiry",
    extended,
    `${before.data?.expires_at} -> ${renew.data?.expires_at}`
  );

  // 12. Grace period is reported on the license
  record(
    "grace period reported",
    typeof renew.data?.grace_period_seconds === "number" && renew.data.grace_period_seconds > 0,
    `grace_period_seconds=${renew.data?.grace_period_seconds}`
  );

  // 13. Second device is refused
  const otherDevice = await call("POST", "/api/client/activate", {
    body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: `other-${suffix}` }
  });
  record(
    "second device refused",
    otherDevice.status === 403 && otherDevice.error?.code === "DEVICE_MISMATCH",
    `status=${otherDevice.status}, code=${otherDevice.error?.code}`
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Live E2E crashed:", err.message);
  process.exit(1);
});
