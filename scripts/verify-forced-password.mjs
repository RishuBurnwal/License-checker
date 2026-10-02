/**
 * Verifies the admin/admin reset plus the forced password change.
 * Usage: node scripts/verify-forced-password.mjs
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:8787";

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await res.json().catch(() => null);
  return { status: res.status, data: payload?.data, error: payload?.error };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. The reset credential works.
const login = await call("POST", "/api/admin/login", {
  body: { username: "admin", password: "admin" }
});
check("login with admin/admin", login.status === 200, `status=${login.status}`);
const token = login.data?.token;
if (!token) {
  console.log("\nCannot continue without a token.");
  process.exit(1);
}

// 2. Login must advertise that a change is required.
check(
  "login reports must_change_password",
  login.data?.admin?.must_change_password === true,
  `must_change_password=${login.data?.admin?.must_change_password}`
);

// 3. A protected route must be refused.
const blocked = await call("GET", "/api/admin/dashboard", { token });
check(
  "protected route refused",
  blocked.status === 403 && blocked.error?.code === "PASSWORD_CHANGE_REQUIRED",
  `status=${blocked.status}, code=${blocked.error?.code}`
);

// 4. The password-change route stays reachable.
const me = await call("GET", "/api/admin/me", { token });
check("password-change-exempt route reachable", me.status === 200, `status=${me.status}`);

// 5. A weak replacement must be rejected.
const weak = await call("PATCH", "/api/admin/password", {
  token,
  body: { current_password: "admin", new_password: "admin" }
});
check("refuses reusing the same password", weak.status === 400, `status=${weak.status}, code=${weak.error?.code}`);

// 6. Change the password.
const NEW_PASSWORD = "s3cure-Passw0rd-2026";
const change = await call("PATCH", "/api/admin/password", {
  token,
  body: { current_password: "admin", new_password: NEW_PASSWORD }
});
check("password change accepted", change.status === 200, `status=${change.status}, error=${change.error?.message ?? "none"}`);

// 7. The flag must now be cleared and routes unlocked.
const after = await call("GET", "/api/admin/dashboard", { token });
check(
  "protected route unlocked after change",
  after.status === 200 && typeof after.data === "object",
  `status=${after.status}`
);

const meAfter = await call("GET", "/api/admin/me", { token });
check(
  "must_change_password cleared",
  meAfter.data?.admin?.must_change_password === false,
  `must_change_password=${meAfter.data?.admin?.must_change_password}`
);

// 8. Old credential must no longer work; new one must.
const oldLogin = await call("POST", "/api/admin/login", {
  body: { username: "admin", password: "admin" }
});
check("old password rejected", oldLogin.status === 401, `status=${oldLogin.status}`);

const newLogin = await call("POST", "/api/admin/login", {
  body: { username: "admin", password: NEW_PASSWORD }
});
check("new password accepted", newLogin.status === 200, `status=${newLogin.status}`);
check(
  "no forced change on the new password",
  newLogin.data?.admin?.must_change_password === false,
  `must_change_password=${newLogin.data?.admin?.must_change_password}`
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
