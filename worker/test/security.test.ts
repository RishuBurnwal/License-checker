/**
 * Security tests (Prompt.md section 46) and failure cases (section 49).
 *
 * These assert the properties the architecture documents claim, at the level
 * where they can actually be falsified: what reaches the database, what leaves
 * the API, and what the cryptographic primitives do. A claim such as "secrets
 * are never stored in plaintext" is only meaningful if something checks it.
 */
import { describe, expect, it } from "vitest";
import {
  codeSuffix,
  generateActivationCode,
  hashPassword,
  hmacSha256,
  normalizeCode,
  signJwt,
  timingSafeEqual,
  verifyJwt,
  verifyPassword
} from "../src/crypto";
import { createHarness, TEST_SECRETS } from "./helpers/harness";
import { createLicensedApp, createManagedAdmin } from "./helpers/scenario";

const PLACEHOLDER = "replace-with-a-long-random-secret";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Every string value stored in a table, for "secret must not appear" checks. */
function dumpText(h: Awaited<ReturnType<typeof createHarness>>, table: string): string {
  const rows = h.raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  return rows
    .flatMap((row) => Object.values(row))
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

describe("environment validation", () => {
  it("rejects the example placeholder for each core secret", async () => {
    for (const key of ["JWT_SECRET", "CODE_HMAC_SECRET", "APP_SECRET_HMAC_SECRET", "DEVICE_HMAC_SECRET"] as const) {
      const h = await createHarness({ [key]: PLACEHOLDER });
      const response = await h.get("/api/health");
      expect(response.status).toBe(500);
      expect(response.error?.message).toBe(`${key} must not use the example placeholder value`);
      h.close();
    }
  });

  it("rejects missing or blank core secrets", async () => {
    const blank = await createHarness({ JWT_SECRET: "   " });
    const response = await blank.get("/api/health");
    expect(response.status).toBe(500);
    expect(response.error?.message).toBe("JWT_SECRET is not configured");
    blank.close();

    const missing = await createHarness({ DEVICE_HMAC_SECRET: undefined });
    expect((await missing.get("/api/health")).status).toBe(500);
    missing.close();
  });

  it("requires the bootstrap credentials to be configured as a pair", async () => {
    const onlyUsername = await createHarness({ ADMIN_BOOTSTRAP_PASSWORD: undefined });
    const response = await onlyUsername.get("/api/health");
    expect(response.status).toBe(500);
    expect(response.error?.message).toBe(
      "ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD must be configured together"
    );
    onlyUsername.close();

    const onlyPassword = await createHarness({ ADMIN_BOOTSTRAP_USERNAME: undefined });
    expect((await onlyPassword.get("/api/health")).status).toBe(500);
    onlyPassword.close();
  });

  it("rejects the example bootstrap password", async () => {
    const h = await createHarness({ ADMIN_BOOTSTRAP_PASSWORD: "change-me-before-use" });
    const response = await h.get("/api/health");
    expect(response.status).toBe(500);
    expect(response.error?.message).toBe("ADMIN_BOOTSTRAP_PASSWORD must not use the example placeholder value");
    h.close();
  });

  it("validates the environment before serving any API route", async () => {
    const h = await createHarness({ JWT_SECRET: PLACEHOLDER });
    for (const path of ["/api/health", "/api/admin/me", "/api/client/activate"]) {
      expect((await h.get(path)).status).toBe(500);
    }
    h.close();
  });
});

describe("cryptographic primitives", () => {
  it("compares secrets without leaking length or position", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    // Same length, difference only in the final byte.
    expect(timingSafeEqual("abcde", "abcdf")).toBe(false);
    // Difference only in the first byte.
    expect(timingSafeEqual("zbcde", "abcde")).toBe(false);
    // Different lengths must be unequal, not an error.
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "a")).toBe(false);
  });

  it("verifies passwords only for the correct input", async () => {
    const record = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", record.salt, record.hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", record.salt, record.hash)).toBe(false);
    expect(await verifyPassword("", record.salt, record.hash)).toBe(false);
    // Salt is random per call, so the same password yields different hashes.
    const other = await hashPassword("correct horse battery staple");
    expect(other.salt).not.toBe(record.salt);
    expect(other.hash).not.toBe(record.hash);
  });

  it("uses a distinct key for each HMAC purpose", async () => {
    const message = "shared-input";
    const withCodeKey = await hmacSha256(TEST_SECRETS.CODE_HMAC_SECRET, message);
    const withAppKey = await hmacSha256(TEST_SECRETS.APP_SECRET_HMAC_SECRET, message);
    const withDeviceKey = await hmacSha256(TEST_SECRETS.DEVICE_HMAC_SECRET, message);

    // Separating keys is what stops a leaked hash in one domain being replayed
    // in another.
    expect(new Set([withCodeKey, withAppKey, withDeviceKey]).size).toBe(3);
    expect(await hmacSha256(TEST_SECRETS.CODE_HMAC_SECRET, message)).toBe(withCodeKey);
    expect(withCodeKey).toMatch(BASE64URL);
    // HMAC-SHA256 is 32 bytes, base64url-encoded without padding.
    expect(withCodeKey).toHaveLength(43);
  });

  it("generates activation codes from an unambiguous alphabet", () => {
    const codes = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const code = generateActivationCode();
      expect(code).toMatch(/^LM-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      // I, O, 0 and 1 are excluded to avoid transcription errors.
      expect(code).not.toMatch(/[IO01]/);
      codes.add(code);
    }
    expect(codes.size).toBe(200);
  });

  it("normalizes codes consistently and derives only a suffix", () => {
    const code = generateActivationCode();
    expect(normalizeCode(`  ${code.toLowerCase()} `)).toBe(code);
    expect(normalizeCode(code.replace(/-/g, " "))).toBe(code.replace(/-/g, ""));
    // The stored suffix is six characters, so a database leak does not reveal a
    // usable code. Note it can span a separator, so it is not always a substring
    // of the formatted code.
    expect(codeSuffix(code)).toHaveLength(6);
    expect(codeSuffix(code)).toBe(code.replace(/-/g, "").slice(-6));
    expect(code.replace(/-/g, "")).toMatch(new RegExp(`${codeSuffix(code)}$`));
  });

  it("rejects forged, tampered and expired tokens", async () => {
    const secret = TEST_SECRETS.JWT_SECRET;
    const payload = { sub: "1", username: "bootstrap-admin" };

    const valid = await signJwt(secret, payload, 60);
    expect(await verifyJwt(secret, valid)).toMatchObject(payload);

    expect(await verifyJwt("a-different-secret", valid)).toBeNull();

    const [header, body, signature] = valid.split(".");
    expect(await verifyJwt(secret, `${header}.${body}`)).toBeNull();
    expect(await verifyJwt(secret, `${header}.${body}.${signature}x`)).toBeNull();

    const expired = await signJwt(secret, payload, -10);
    expect(await verifyJwt(secret, expired)).toBeNull();
  });

  it("rejects a token whose payload was edited", async () => {
    const secret = TEST_SECRETS.JWT_SECRET;
    const token = await signJwt(secret, { sub: "1", username: "bootstrap-admin" }, 60);
    const [header, , signature] = token.split(".");
    const forgedBody = btoa(JSON.stringify({ sub: "1", username: "attacker", iat: 1, exp: 9999999999 }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(await verifyJwt(secret, `${header}.${forgedBody}.${signature}`)).toBeNull();
  });
});

describe("token handling through the API", () => {
  it("rejects a token signed with the wrong key", async () => {
    const h = await createHarness();
    await h.loginBootstrap();
    const forged = await signJwt("not-the-real-secret", { sub: "1", username: "bootstrap-admin" }, 3600);
    const response = await h.get("/api/admin/me", { token: forged });
    expect(response.status).toBe(401);
    h.close();
  });

  it("rejects an expired token", async () => {
    const h = await createHarness();
    await h.loginBootstrap();
    const expired = await signJwt(TEST_SECRETS.JWT_SECRET, { sub: "1", username: "bootstrap-admin" }, -60);
    const response = await h.get("/api/admin/me", { token: expired });
    expect(response.status).toBe(401);
    expect(response.error?.message).toBe("Invalid or expired token");
    h.close();
  });

  it("rejects a token whose subject is not a real administrator", async () => {
    const h = await createHarness();
    await h.loginBootstrap();

    const nonNumeric = await signJwt(TEST_SECRETS.JWT_SECRET, { sub: "not-a-number", username: "x" }, 3600);
    expect((await h.get("/api/admin/me", { token: nonNumeric })).status).toBe(401);

    const missing = await signJwt(TEST_SECRETS.JWT_SECRET, { sub: "999999", username: "ghost" }, 3600);
    const response = await h.get("/api/admin/me", { token: missing });
    expect(response.status).toBe(401);
    expect(response.error?.message).toBe("Admin no longer exists");
    h.close();
  });

  it("invalidates a token when its administrator is removed", async () => {
    const h = await createHarness();
    const admin = await createManagedAdmin(h, { username: "revoke-me-admin" });
    expect((await h.get("/api/admin/me", { token: admin.token })).status).toBe(200);

    // The principal is re-read per request, so deleting the row is enough.
    h.raw.prepare("DELETE FROM admin_users WHERE username = ?").run("revoke-me-admin");
    const response = await h.get("/api/admin/me", { token: admin.token });
    expect(response.status).toBe(401);
    expect(response.error?.message).toBe("Admin no longer exists");
    h.close();
  });

  it("reflects a user_role change immediately without reissuing the token", async () => {
    const h = await createHarness();
    const admin = await createManagedAdmin(h, { username: "downgrade-admin" });
    // As an admin manager, the Users area is reachable.
    const before = await h.get("/api/admin/users", { token: admin.token });
    expect(before.status).toBe(200);

    // Demote to staff: the gate is re-evaluated per request from the DB.
    h.raw.prepare("UPDATE admin_users SET user_role = 'staff' WHERE username = ?").run("downgrade-admin");
    const after = await h.get("/api/admin/users", { token: admin.token });
    expect(after.status).toBe(403);
    h.close();
  });
});

describe("secret storage", () => {
  it("stores only a hash of the app secret and reveals it exactly once", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);

    const stored = h.sql<{ app_secret_hash: string }>("SELECT app_secret_hash FROM apps WHERE app_id = ?", app.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0].app_secret_hash).not.toBe(app.appSecret);
    expect(stored[0].app_secret_hash).toMatch(BASE64URL);
    expect(stored[0].app_secret_hash).toHaveLength(43);

    // The plaintext secret must not exist anywhere in the apps table.
    expect(dumpText(h, "apps")).not.toContain(app.appSecret);

    // Nor may it reappear when the app is read back.
    const readBack = await h.post("/api/client/app-info", { body: { app_id: app.appId, app_secret: app.appSecret } });
    expect(JSON.stringify(readBack.payload)).not.toContain(app.appSecret);
    expect(JSON.stringify(readBack.payload)).not.toContain(stored[0].app_secret_hash);
    h.close();
  });

  it("never stores an activation code in plaintext", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 5 });

    const rows = h.sql<{ code_hash: string; code_suffix: string }>(
      "SELECT code_hash, code_suffix FROM activation_codes"
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.code_hash).toHaveLength(43);
      expect(app.codes).not.toContain(row.code_hash);
    }
    const dump = dumpText(h, "activation_codes");
    for (const code of app.codes) {
      expect(dump).not.toContain(code);
      // Only the six-character suffix is retained for display.
      expect(dump).toContain(codeSuffix(code));
    }
    h.close();
  });

  it("stores only a hash of the device fingerprint", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const fingerprint = "fingerprint-CPU-9F3A-hardware-id";
    await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: fingerprint }
    });

    const stored = h.sql<{ device_hash: string }>(
      "SELECT device_hash FROM activation_codes WHERE code_suffix = ?",
      codeSuffix(app.code)
    );
    expect(stored[0].device_hash).toHaveLength(43);
    expect(stored[0].device_hash).not.toBe(fingerprint);
    expect(dumpText(h, "activation_codes")).not.toContain(fingerprint);
    h.close();
  });

  it("keeps codes, secrets and fingerprints out of the audit log", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const boundDevice = "log-device-bound";
    const otherDevice = "log-device-other";

    await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: boundDevice }
    });

    // A code that resolves but is used from the wrong device is a logged failure.
    const mismatch = await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: otherDevice }
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.error?.code).toBe("DEVICE_MISMATCH");

    const logs = h.sql<{ action: string; result: string; message: string | null; error_code: string | null }>(
      "SELECT action, result, message, error_code FROM activation_logs"
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((log) => log.result === "failure")).toBe(true);

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(app.appSecret);
    expect(serialized).not.toContain(app.code);
    expect(serialized).not.toContain(boundDevice);
    expect(serialized).not.toContain(otherDevice);
    h.close();
  });

  it("does not write an audit row for a code that cannot be resolved", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const before = h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_logs")[0].count;

    const response = await h.post("/api/client/activate", {
      body: {
        app_id: app.appId,
        app_secret: app.appSecret,
        code: "LM-AAAAA-BBBBB-CCCCC-DDDDD",
        device_fingerprint: "unknown-code-device"
      }
    });
    expect(response.status).toBe(404);
    expect(response.error?.code).toBe("INVALID_CODE");

    // Documented gap, asserted here so it cannot change silently: the lookup runs
    // before the audited block, so brute-force attempts are not recorded.
    const after = h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_logs")[0].count;
    expect(after).toBe(before);
    h.close();
  });

  it("keeps administrator password material out of responses and storage", async () => {
    const h = await createHarness();
    const login = await h.login("bootstrap-admin", "bootstrap-password-1");
    const serialized = JSON.stringify(login.payload);
    // No credential, hash or salt may be echoed. `must_change_password` is a
    // boolean policy flag, not password material, so it is checked separately.
    expect(serialized).not.toContain("bootstrap-password-1");
    expect(serialized).not.toContain("password_hash");
    expect(serialized).not.toContain("password_salt");
    expect(login.payload.data.admin).not.toHaveProperty("password_hash");
    expect(login.payload.data.admin).not.toHaveProperty("password_salt");

    const row = h.sql<{ password_hash: string; password_salt: string }>(
      "SELECT password_hash, password_salt FROM admin_users WHERE username = 'bootstrap-admin'"
    );
    expect(row[0].password_hash).not.toContain("bootstrap-password-1");
    expect(row[0].password_hash).toHaveLength(43);
    expect(row[0].password_salt.length).toBeGreaterThan(0);
    h.close();
  });

  it("has no column anywhere that could hold a client IP address", async () => {
    const h = await createHarness();
    for (const table of ["activation_logs", "activation_codes", "apps", "admin_users", "activation_batches"]) {
      const columns = (h.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
      expect(columns.filter((name) => /(^|_)ip($|_)|ip_address|remote_addr|client_ip/i.test(name))).toEqual([]);
    }

    // A fingerprint is the only client identifier, and it is caller-supplied.
    const logColumns = (h.raw.prepare("PRAGMA table_info(activation_logs)").all() as { name: string }[]).map((c) => c.name);
    expect(logColumns).toContain("device_hash");
    h.close();
  });
});

describe("injection and scoping resistance", () => {
  it("treats filter input as data, not SQL", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const before = h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes")[0].count;

    for (const attack of ["'; DROP TABLE activation_codes; --", "1' OR '1'='1", "%' UNION SELECT 1 --"]) {
      const response = await h.get(`/api/admin/codes?query=${encodeURIComponent(attack)}`, { token: app.token });
      expect(response.status).toBe(200);
      expect(response.data.items).toEqual([]);
    }

    const after = h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes")[0].count;
    expect(after).toBe(before);

    // The status filter is validated against an allow-list, so injection there is
    // a 400 rather than a query.
    const statusAttack = await h.get(`/api/admin/codes?status=${encodeURIComponent("active' OR '1'='1")}`, {
      token: app.token
    });
    expect(statusAttack.status).toBe(400);
    h.close();
  });

  it("does not disclose whether a code from a different app exists", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { name: "Leak Probe" });
    const other = await createLicensedApp(h, { name: "Other App" });

    const foreignCode = await h.post("/api/client/activate", {
      body: { app_id: other.appId, app_secret: other.appSecret, code: app.code, device_fingerprint: "probe" }
    });
    const fakeCode = await h.post("/api/client/activate", {
      body: { app_id: other.appId, app_secret: other.appSecret, code: "LM-AAAAA-BBBBB-CCCCC-DDDDD", device_fingerprint: "probe" }
    });
    expect(foreignCode.status).toBe(fakeCode.status);
    expect(foreignCode.error?.code).toBe(fakeCode.error?.code);
    expect(foreignCode.error?.message).toBe(fakeCode.error?.message);
    h.close();
  });
});
