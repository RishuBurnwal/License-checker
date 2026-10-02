/**
 * Global admin master-password suite (FEAT-002, Group B).
 *
 * Covers the login matrix (admin requires the master factor, staff never does),
 * the master-password lifecycle through PATCH /api/admin/settings/master-password,
 * the fail-closed behaviour when no master is stored and none can be seeded, and
 * the non-enumeration guarantee that every failure returns a byte-identical 401.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/crypto";
import {
  BOOTSTRAP_PASSWORD,
  BOOTSTRAP_USERNAME,
  MASTER_PASSWORD,
  createHarness,
  type Harness
} from "./helpers/harness";

const GENERIC_LOGIN_ERROR = "Invalid username or password";

/** Creates a staff account through the admin API and clears its forced change. */
async function createStaff(h: Harness, token: string, username = "staff-user", password = "staff-password-1") {
  const created = await h.post("/api/admin/users", {
    token,
    body: { username, password, role: "staff" }
  });
  if (!created.payload.ok) {
    throw new Error(`createStaff failed: ${created.status} ${JSON.stringify(created.payload)}`);
  }
  h.raw.prepare("UPDATE admin_users SET must_change_password = 0 WHERE username = ?").run(username);
  return { username, password, id: created.data.id as number };
}

function masterRows(h: Harness): Record<string, string> {
  const rows = h.sql<{ key: string; value: string }>("SELECT key, value FROM settings");
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

describe("admin login matrix", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.close());

  it("admits an admin with the correct master password", async () => {
    const res = await h.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD, MASTER_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.data.token).toBeTruthy();
    expect(res.data.admin.user_role).toBe("admin");
  });

  it("rejects an admin with the wrong master password (generic 401)", async () => {
    const res = await h.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD, "not-the-master");
    expect(res.status).toBe(401);
    expect(res.error?.message).toBe(GENERIC_LOGIN_ERROR);
  });

  it("rejects an admin with no master password (the 'User' form path) (generic 401)", async () => {
    // No master_password field at all — exactly what the 'User' dropdown submits.
    const res = await h.post("/api/admin/login", {
      body: { username: BOOTSTRAP_USERNAME, password: BOOTSTRAP_PASSWORD }
    });
    expect(res.status).toBe(401);
    expect(res.error?.message).toBe(GENERIC_LOGIN_ERROR);
  });

  it("admits a staff account with no master password", async () => {
    const token = await h.loginBootstrap();
    const staff = await createStaff(h, token);
    const res = await h.post("/api/admin/login", {
      body: { username: staff.username, password: staff.password }
    });
    expect(res.status).toBe(200);
    expect(res.data.admin.user_role).toBe("staff");
  });

  it("admits a staff account even when a master value is also sent, with no manager rights", async () => {
    const token = await h.loginBootstrap();
    const staff = await createStaff(h, token);
    const login = await h.login(staff.username, staff.password, MASTER_PASSWORD);
    expect(login.status).toBe(200);
    expect(login.data.admin.user_role).toBe("staff");
    // The dropdown is a hint only: a staff account never gains management rights.
    const users = await h.get("/api/admin/users", { token: login.data.token });
    expect(users.status).toBe(403);
  });
});

describe("master password storage", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.close());

  it("stores a hash + salt and never the plaintext master value", async () => {
    await h.loginBootstrap();
    const rows = masterRows(h);
    expect(typeof rows.master_password_hash).toBe("string");
    expect(typeof rows.master_password_salt).toBe("string");
    expect(rows.master_password_hash.length).toBeGreaterThan(0);
    expect(rows.master_password_salt.length).toBeGreaterThan(0);
    // Neither row may be the plaintext master password.
    expect(rows.master_password_hash).not.toBe(MASTER_PASSWORD);
    expect(rows.master_password_salt).not.toBe(MASTER_PASSWORD);
  });
});

describe("change master password", () => {
  let h: Harness;
  let token: string;
  beforeEach(async () => {
    h = await createHarness();
    token = await h.loginBootstrap();
  });
  afterEach(() => h.close());

  it("changes the master password and returns exactly {updated:true}", async () => {
    const res = await h.patch("/api/admin/settings/master-password", {
      token,
      body: { current_master_password: MASTER_PASSWORD, new_master_password: "fresh-master-9" }
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ updated: true });

    // The old master no longer works; the new one does.
    const oldLogin = await h.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD, MASTER_PASSWORD);
    expect(oldLogin.status).toBe(401);
    const newLogin = await h.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD, "fresh-master-9");
    expect(newLogin.status).toBe(200);
  });

  it("rejects a wrong current master and leaves the stored hash unchanged", async () => {
    const before = masterRows(h);
    const res = await h.patch("/api/admin/settings/master-password", {
      token,
      body: { current_master_password: "wrong-current", new_master_password: "fresh-master-9" }
    });
    expect(res.status).toBe(401);
    const after = masterRows(h);
    expect(after.master_password_hash).toBe(before.master_password_hash);
    expect(after.master_password_salt).toBe(before.master_password_salt);
  });

  it("rejects a new master shorter than 8 characters", async () => {
    const res = await h.patch("/api/admin/settings/master-password", {
      token,
      body: { current_master_password: MASTER_PASSWORD, new_master_password: "short" }
    });
    expect(res.status).toBe(400);
  });

  it("rejects a new master equal to the current one", async () => {
    const res = await h.patch("/api/admin/settings/master-password", {
      token,
      body: { current_master_password: MASTER_PASSWORD, new_master_password: MASTER_PASSWORD }
    });
    expect(res.status).toBe(400);
  });

  it("ignores the env seed once a master is stored (DB wins)", async () => {
    const changed = await h.patch("/api/admin/settings/master-password", {
      token,
      body: { current_master_password: MASTER_PASSWORD, new_master_password: "fresh-master-9" }
    });
    expect(changed.status).toBe(200);
    // ADMIN_MASTER_PASSWORD is still MASTER_PASSWORD in env, but the stored hash
    // was changed, so the seed must not resurrect the old value.
    const seedLogin = await h.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD, MASTER_PASSWORD);
    expect(seedLogin.status).toBe(401);
  });

  it("rejects a staff token with 403 and does not mutate the hash", async () => {
    const staff = await createStaff(h, token);
    const staffLogin = await h.login(staff.username, staff.password);
    const before = masterRows(h);
    const res = await h.patch("/api/admin/settings/master-password", {
      token: staffLogin.data.token,
      body: { current_master_password: MASTER_PASSWORD, new_master_password: "fresh-master-9" }
    });
    expect(res.status).toBe(403);
    const after = masterRows(h);
    expect(after.master_password_hash).toBe(before.master_password_hash);
  });
});

describe("fail-closed master password", () => {
  let h: Harness;
  beforeEach(async () => {
    // No settings rows AND no ADMIN_MASTER_PASSWORD seed available.
    h = await createHarness({ ADMIN_MASTER_PASSWORD: undefined });
  });
  afterEach(() => h.close());

  it("rejects an admin login with 401 (never 500, never skipped)", async () => {
    const res = await h.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD, "anything");
    expect(res.status).toBe(401);
    expect(res.error?.message).toBe(GENERIC_LOGIN_ERROR);
    // No master rows were seeded.
    expect(masterRows(h).master_password_hash).toBeUndefined();
  });

  it("still admits a staff account", async () => {
    // Seed a staff account directly, since no admin login is possible here.
    const { hash, salt } = await hashPassword("staff-password-1");
    h.raw
      .prepare(
        "INSERT INTO admin_users (username, password_hash, password_salt, must_change_password, user_role, updated_at) VALUES (?, ?, ?, 0, 'staff', ?)"
      )
      .run("staff-fc", hash, salt, new Date().toISOString());
    const res = await h.login("staff-fc", "staff-password-1");
    expect(res.status).toBe(200);
    expect(res.data.admin.user_role).toBe("staff");
  });
});

describe("login failures are non-enumerable", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.close());

  it("returns a byte-identical 401 across all causes, with no tenant wording", async () => {
    const token = await h.loginBootstrap();
    const staff = await createStaff(h, token);

    const failures = await Promise.all([
      h.login("no-such-user", BOOTSTRAP_PASSWORD, MASTER_PASSWORD),
      h.login(BOOTSTRAP_USERNAME, "wrong-password", MASTER_PASSWORD),
      h.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD, "wrong-master"),
      // Admin with no master_password at all (the 'User' form path).
      h.post("/api/admin/login", { body: { username: BOOTSTRAP_USERNAME, password: BOOTSTRAP_PASSWORD } }),
      h.post("/api/admin/login", { body: { username: staff.username, password: "wrong-password" } })
    ]);

    for (const failure of failures) {
      expect(failure.status).toBe(401);
      expect(failure.error?.code).toBe("UNAUTHORIZED");
      expect(failure.error?.message).toBe(GENERIC_LOGIN_ERROR);
      expect(failure.error?.message.toLowerCase()).not.toContain("tenant");
    }
  });
});
