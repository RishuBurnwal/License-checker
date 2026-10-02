/**
 * User management (FEAT-002) against the real HTTP surface + real SQLite.
 *
 * These drive `app.fetch()` through the production router, middleware and SQL,
 * so the role gate, the JWT session-epoch kick-out, the forced-password-change
 * wiring and the admin_sessions audit rows are all genuinely exercised. The one
 * forged-token case uses the same signJwt the login route uses, stamped with a
 * stale epoch, to prove the server rejects it after a kick.
 */
import { afterEach, describe, expect, it } from "vitest";
import { signJwt } from "../src/crypto";
import { USER_ROLE } from "../src/constants";
import { createHarness, TEST_SECRETS, type Harness } from "./helpers/harness";

const TTL = 8 * 60 * 60;

/** Signs a token for an existing admin at an explicit epoch (mirrors the login route). */
async function signToken(adminId: number, username: string, epoch: number): Promise<string> {
  return await signJwt(TEST_SECRETS.JWT_SECRET, { sub: String(adminId), username, epoch }, TTL);
}

/** Creates a user via the API and returns its id. */
async function createUser(
  h: Harness,
  token: string,
  input: { username: string; password: string; role: string }
) {
  return await h.post("/api/admin/users", { token, body: input });
}

/** Logs a freshly created user in and returns the login call. */
async function loginUser(h: Harness, username: string, password: string) {
  return await h.login(username, password);
}

describe("user management: create + list", () => {
  let harness: Harness | null = null;
  afterEach(() => harness?.close());

  it("creates admin and staff users and lists them", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();

    const admin = await createUser(h, token, { username: "ops-admin", password: "password-123", role: USER_ROLE.ADMIN });
    expect(admin.status).toBe(201);
    expect(admin.data).toMatchObject({ username: "ops-admin", role: "admin", must_change_password: true });

    const staff = await createUser(h, token, { username: "ops-staff", password: "password-123", role: USER_ROLE.STAFF });
    expect(staff.status).toBe(201);
    expect(staff.data.role).toBe("staff");

    const list = await h.get("/api/admin/users", { token });
    expect(list.status).toBe(200);
    const usernames = (list.data.items as Array<{ username: string }>).map((u) => u.username);
    expect(usernames).toContain("ops-admin");
    expect(usernames).toContain("ops-staff");
  });

  it("rejects an invalid role and a duplicate username", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();

    const bad = await createUser(h, token, { username: "nope", password: "password-123", role: "super_admin" });
    expect(bad.status).toBe(400);
    expect(bad.error?.code).toBe("BAD_REQUEST");

    await createUser(h, token, { username: "dupe", password: "password-123", role: USER_ROLE.ADMIN });
    const dupe = await createUser(h, token, { username: "dupe", password: "password-123", role: USER_ROLE.STAFF });
    expect(dupe.status).toBe(409);
    expect(dupe.error?.code).toBe("CONFLICT");
  });
});

describe("user management: staff denied server-side", () => {
  let harness: Harness | null = null;
  afterEach(() => harness?.close());

  it("returns 403 from every /api/admin/users* endpoint for a staff token", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    await createUser(h, token, { username: "staffer", password: "password-123", role: USER_ROLE.STAFF });

    // The staff user must change its password first; do that, then log in.
    const first = await loginUser(h, "staffer", "password-123");
    expect(first.data.admin.must_change_password).toBe(true);
    const staffToken = first.data.token as string;
    await h.patch("/api/admin/password", {
      token: staffToken,
      body: { current_password: "password-123", new_password: "staff-new-456" }
    });
    const relogin = await loginUser(h, "staffer", "staff-new-456");
    const liveStaffToken = relogin.data.token as string;

    const list = await h.get("/api/admin/users", { token: liveStaffToken });
    expect(list.status).toBe(403);
    expect(list.error?.code).toBe("FORBIDDEN");

    const create = await h.post("/api/admin/users", {
      token: liveStaffToken,
      body: { username: "x", password: "password-123", role: "staff" }
    });
    expect(create.status).toBe(403);

    const sessions = await h.get("/api/admin/users/1/sessions", { token: liveStaffToken });
    expect(sessions.status).toBe(403);
  });

  it("allows an admin-role user to manage users", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    await createUser(h, token, { username: "manager", password: "password-123", role: USER_ROLE.ADMIN });
    const first = await loginUser(h, "manager", "password-123");
    const t0 = first.data.token as string;
    await h.patch("/api/admin/password", {
      token: t0,
      body: { current_password: "password-123", new_password: "manager-new-456" }
    });
    const live = (await loginUser(h, "manager", "manager-new-456")).data.token as string;

    const list = await h.get("/api/admin/users", { token: live });
    expect(list.status).toBe(200);
  });
});

describe("user management: forced password change on reset", () => {
  let harness: Harness | null = null;
  afterEach(() => harness?.close());

  it("sets must_change_password=1 and blocks non-exempt routes until changed", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const created = await createUser(h, token, { username: "resettee", password: "password-123", role: USER_ROLE.ADMIN });
    const userId = created.data.id as number;

    // Clear the initial forced-change so we start from a clean state.
    const firstLogin = await loginUser(h, "resettee", "password-123");
    const firstToken = firstLogin.data.token as string;
    await h.patch("/api/admin/password", {
      token: firstToken,
      body: { current_password: "password-123", new_password: "clean-pass-456" }
    });

    // Admin resets the user's password.
    const reset = await h.patch(`/api/admin/users/${userId}/password`, {
      token,
      body: { new_password: "reset-pass-789" }
    });
    expect(reset.status).toBe(200);
    expect(reset.data.must_change_password).toBe(true);

    const row = h.sql<{ must_change_password: number }>(
      "SELECT must_change_password FROM admin_users WHERE id = ?",
      userId
    )[0];
    expect(row.must_change_password).toBe(1);

    // Next login is forced through the change-password flow: a non-exempt route is blocked.
    const afterReset = await loginUser(h, "resettee", "reset-pass-789");
    expect(afterReset.data.admin.must_change_password).toBe(true);
    const blockedToken = afterReset.data.token as string;
    const blocked = await h.get("/api/admin/apps", { token: blockedToken });
    expect(blocked.status).toBe(403);
    expect(blocked.error?.code).toBe("PASSWORD_CHANGE_REQUIRED");

    // The exempt change-password route still works and clears the flag.
    const change = await h.patch("/api/admin/password", {
      token: blockedToken,
      body: { current_password: "reset-pass-789", new_password: "final-pass-012" }
    });
    expect(change.status).toBe(200);
  });
});

describe("user management: admin set-any-user-password (FEAT-003)", () => {
  let harness: Harness | null = null;
  afterEach(() => harness?.close());

  /** Creates an admin-role user and clears its initial forced-change flag. */
  async function createUsableUser(h: Harness, token: string, username: string, password: string) {
    const created = await createUser(h, token, { username, password, role: USER_ROLE.ADMIN });
    const userId = created.data.id as number;
    const firstToken = (await loginUser(h, username, password)).data.token as string;
    await h.patch("/api/admin/password", {
      token: firstToken,
      body: { current_password: password, new_password: `${password}-clean` }
    });
    return userId;
  }

  it("sets the password hashed at rest, revokes sessions, and lets the user log in", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const userId = await createUsableUser(h, token, "setme", "password-123");

    const epochBefore = h.sql<{ session_epoch: number }>(
      "SELECT session_epoch FROM admin_users WHERE id = ?",
      userId
    )[0].session_epoch;

    const reset = await h.patch(`/api/admin/users/${userId}/password`, {
      token,
      body: { new_password: "fresh-pass-456", force_change: false }
    });
    expect(reset.status).toBe(200);
    expect(reset.data.must_change_password).toBe(false);

    const row = h.sql<{ password_hash: string; must_change_password: number; session_epoch: number }>(
      "SELECT password_hash, must_change_password, session_epoch FROM admin_users WHERE id = ?",
      userId
    )[0];
    // force_change OFF leaves the flag clear but still bumps the epoch.
    expect(row.must_change_password).toBe(0);
    expect(row.session_epoch).toBe(epochBefore + 1);
    // Password is hashed at rest; the plaintext never lands in the column.
    expect(row.password_hash).not.toContain("fresh-pass-456");

    // The user can log in with the new password and is NOT forced to change it.
    const login = await loginUser(h, "setme", "fresh-pass-456");
    expect(login.status).toBe(200);
    expect(login.data.admin.must_change_password).toBe(false);
  });

  it("forces the change flow when force_change is ON (default)", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const userId = await createUsableUser(h, token, "forceme", "password-123");

    // Omitting force_change defaults it ON.
    const reset = await h.patch(`/api/admin/users/${userId}/password`, {
      token,
      body: { new_password: "forced-pass-789" }
    });
    expect(reset.status).toBe(200);
    expect(reset.data.must_change_password).toBe(true);
    expect(
      h.sql<{ must_change_password: number }>(
        "SELECT must_change_password FROM admin_users WHERE id = ?",
        userId
      )[0].must_change_password
    ).toBe(1);

    const login = await loginUser(h, "forceme", "forced-pass-789");
    expect(login.data.admin.must_change_password).toBe(true);
  });
});

describe("user management: generate random password (FEAT-003)", () => {
  let harness: Harness | null = null;
  afterEach(() => harness?.close());

  const BASE64URL = /^[A-Za-z0-9_-]+$/;

  async function createUsableUser(h: Harness, token: string, username: string, password: string) {
    const created = await createUser(h, token, { username, password, role: USER_ROLE.ADMIN });
    const userId = created.data.id as number;
    const firstToken = (await loginUser(h, username, password)).data.token as string;
    await h.patch("/api/admin/password", {
      token: firstToken,
      body: { current_password: password, new_password: `${password}-clean` }
    });
    return userId;
  }

  it("returns a base64url password of length >= 16 once, hashed at rest and absent from logs", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const userId = await createUsableUser(h, token, "genme", "password-123");

    const epochBefore = h.sql<{ session_epoch: number }>(
      "SELECT session_epoch FROM admin_users WHERE id = ?",
      userId
    )[0].session_epoch;

    const gen = await h.post(`/api/admin/users/${userId}/password/generate`, { token, body: {} });
    expect(gen.status).toBe(200);
    const password = gen.data.password as string;
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(password).toMatch(BASE64URL);
    expect(gen.data.must_change_password).toBe(true);

    const row = h.sql<{ password_hash: string; must_change_password: number; session_epoch: number }>(
      "SELECT password_hash, must_change_password, session_epoch FROM admin_users WHERE id = ?",
      userId
    )[0];
    expect(row.password_hash).not.toContain(password);
    expect(row.must_change_password).toBe(1);
    expect(row.session_epoch).toBe(epochBefore + 1);

    // The generated plaintext must never be logged.
    const logs = h.sql<{ message: string | null }>("SELECT message FROM activation_logs");
    for (const entry of logs) {
      expect(entry.message ?? "").not.toContain(password);
    }

    // The user can authenticate with the generated password.
    const login = await loginUser(h, "genme", password);
    expect(login.status).toBe(200);
  });

  it("produces distinct passwords across generations", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const userId = await createUsableUser(h, token, "distinct", "password-123");

    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const gen = await h.post(`/api/admin/users/${userId}/password/generate`, { token, body: {} });
      expect(gen.status).toBe(200);
      seen.add(gen.data.password as string);
    }
    expect(seen.size).toBe(5);
  });

  it("honours force_change = false", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const userId = await createUsableUser(h, token, "gennoforce", "password-123");

    const gen = await h.post(`/api/admin/users/${userId}/password/generate`, {
      token,
      body: { force_change: false }
    });
    expect(gen.status).toBe(200);
    expect(gen.data.must_change_password).toBe(false);
    expect(
      h.sql<{ must_change_password: number }>(
        "SELECT must_change_password FROM admin_users WHERE id = ?",
        userId
      )[0].must_change_password
    ).toBe(0);

    const login = await loginUser(h, "gennoforce", gen.data.password as string);
    expect(login.status).toBe(200);
    expect(login.data.admin.must_change_password).toBe(false);
  });
});

describe("user management: staff denied on set-password + generate (FEAT-003)", () => {
  let harness: Harness | null = null;
  afterEach(() => harness?.close());

  it("returns 403 for a staff token on create, set-password, generate, and kick", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    // A target user to point the staff calls at.
    const target = await createUser(h, token, { username: "target", password: "password-123", role: USER_ROLE.ADMIN });
    const targetId = target.data.id as number;

    // Bring a staff account to a usable, logged-in state.
    await createUser(h, token, { username: "staffer2", password: "password-123", role: USER_ROLE.STAFF });
    const firstToken = (await loginUser(h, "staffer2", "password-123")).data.token as string;
    await h.patch("/api/admin/password", {
      token: firstToken,
      body: { current_password: "password-123", new_password: "staff-new-456" }
    });
    const staffToken = (await loginUser(h, "staffer2", "staff-new-456")).data.token as string;

    const create = await h.post("/api/admin/users", {
      token: staffToken,
      body: { username: "nope", password: "password-123", role: "staff" }
    });
    expect(create.status).toBe(403);

    const setPassword = await h.patch(`/api/admin/users/${targetId}/password`, {
      token: staffToken,
      body: { new_password: "hijack-pass-456" }
    });
    expect(setPassword.status).toBe(403);

    const generate = await h.post(`/api/admin/users/${targetId}/password/generate`, { token: staffToken, body: {} });
    expect(generate.status).toBe(403);

    const kick = await h.post(`/api/admin/users/${targetId}/kick`, { token: staffToken });
    expect(kick.status).toBe(403);
  });

  it("createUser stores only user_role (no separate login role column)", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const created = await createUser(h, token, { username: "roleonly", password: "password-123", role: USER_ROLE.STAFF });
    const userId = created.data.id as number;

    const columns = h.sql<{ name: string }>("PRAGMA table_info(admin_users)").map((c) => c.name);
    expect(columns).toContain("user_role");
    expect(columns).not.toContain("role");

    expect(
      h.sql<{ user_role: string }>("SELECT user_role FROM admin_users WHERE id = ?", userId)[0].user_role
    ).toBe("staff");
  });
});

describe("user management: kick-out via session epoch", () => {
  let harness: Harness | null = null;
  afterEach(() => harness?.close());

  it("increments session_epoch and rejects a pre-kick JWT with 401", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const created = await createUser(h, token, { username: "victim", password: "password-123", role: USER_ROLE.ADMIN });
    const userId = created.data.id as number;

    // Bring the victim to a usable state (epoch still 0 for creation, but the
    // forced-change clears without bumping epoch via self change-password).
    const firstToken = (await loginUser(h, "victim", "password-123")).data.token as string;
    await h.patch("/api/admin/password", {
      token: firstToken,
      body: { current_password: "password-123", new_password: "victim-new-456" }
    });

    const epochBefore = h.sql<{ session_epoch: number }>(
      "SELECT session_epoch FROM admin_users WHERE id = ?",
      userId
    )[0].session_epoch;

    // A token stamped at the current epoch works on a non-exempt route.
    const liveToken = await signToken(userId, "victim", epochBefore);
    const okCall = await h.get("/api/admin/apps", { token: liveToken });
    expect(okCall.status).toBe(200);

    // Admin kicks the victim.
    const kick = await h.post(`/api/admin/users/${userId}/kick`, { token });
    expect(kick.status).toBe(200);
    expect(kick.data.kicked).toBe(true);

    const epochAfter = h.sql<{ session_epoch: number }>(
      "SELECT session_epoch FROM admin_users WHERE id = ?",
      userId
    )[0].session_epoch;
    expect(epochAfter).toBe(epochBefore + 1);

    // The pre-kick token is now rejected 401.
    const rejected = await h.get("/api/admin/apps", { token: liveToken });
    expect(rejected.status).toBe(401);
    expect(rejected.error?.code).toBe("UNAUTHORIZED");
  });
});

describe("user management: admin_sessions listing", () => {
  let harness: Harness | null = null;
  afterEach(() => harness?.close());

  it("records a session row at login and returns it in the per-user listing", async () => {
    const h = (harness = await createHarness());
    const token = await h.loginBootstrap();
    const created = await createUser(h, token, { username: "listme", password: "password-123", role: USER_ROLE.ADMIN });
    const userId = created.data.id as number;

    // The user logs in, which writes an admin_sessions row.
    await loginUser(h, "listme", "password-123");

    const sessions = await h.get(`/api/admin/users/${userId}/sessions`, { token });
    expect(sessions.status).toBe(200);
    expect(Array.isArray(sessions.data.items)).toBe(true);
    expect(sessions.data.items.length).toBeGreaterThanOrEqual(1);
    expect(sessions.data).toHaveProperty("current_epoch");
  });
});
