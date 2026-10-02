/**
 * Node-adapter parity suite (FEAT-003).
 *
 * The whole worker suite already runs against real SQLite via the D1-shaped
 * shim in `helpers/d1.ts`. This file proves the OTHER adapter — the production
 * `NodeSqliteAdapter` from `src/db/node-sqlite.ts` used by the Node/Vercel entry
 * point — runs the SAME unchanged Hono app (`src/index.ts`) correctly. Instead
 * of the test shim, `env.DB` is a real `NodeSqliteAdapter`, so every call below
 * flows app.fetch -> router -> middleware -> `new D1Adapter(c.env.DB)` ->
 * `NodeSqliteAdapter` -> real SQL. That is exactly the chain `entry-node.ts`
 * boots, minus the HTTP transport.
 *
 * Coverage: signed verify happy path + a tamper rejection, activation-limit
 * atomicity across two distinct installations, and an admin user-management
 * flow (create user -> kick -> old token rejected 401). The existing D1-path
 * suites are untouched.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../src/index";
import { NodeSqliteAdapter } from "../src/db/node-sqlite";
import { base64UrlToBytes, signJwt } from "../src/crypto";
import { canonicalize, type LicensePayload } from "../src/license/canonical";
import { USER_ROLE } from "../src/constants";
import type { Bindings } from "../src/types";
import { applyMigrations } from "./helpers/d1";
import { BOOTSTRAP_PASSWORD, BOOTSTRAP_USERNAME, MASTER_PASSWORD, TEST_SECRETS } from "./helpers/harness";

const CTX = { waitUntil() {}, passThroughOnException() {} };
const TTL = 8 * 60 * 60;

type Payload<T = any> = { ok: boolean; data?: T; error?: { code: string; message: string } };
type Call = { status: number; data: any; error: { code: string; message: string } | undefined; payload: Payload };

/**
 * A harness identical in shape to `helpers/harness.ts`, but `env.DB` is the real
 * `NodeSqliteAdapter` (presented as the DB binding) rather than the D1 shim —
 * this is what exercises the FEAT-003 adapter.
 */
type NodeHarness = {
  raw: DatabaseSync;
  call(method: string, path: string, opts?: { body?: unknown; token?: string }): Promise<Call>;
  get(path: string, opts?: { token?: string }): Promise<Call>;
  post(path: string, opts?: { body?: unknown; token?: string }): Promise<Call>;
  sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[];
  loginBootstrap(): Promise<string>;
  close(): void;
};

async function createNodeHarness(): Promise<NodeHarness> {
  const raw = new DatabaseSync(":memory:");
  await applyMigrations(raw);
  const env = {
    DB: new NodeSqliteAdapter(raw),
    ASSETS: { fetch: async () => new Response("<!doctype html><title>asset</title>", { status: 200 }) },
    ...TEST_SECRETS,
    ADMIN_BOOTSTRAP_USERNAME: BOOTSTRAP_USERNAME,
    ADMIN_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
    ADMIN_MASTER_PASSWORD: MASTER_PASSWORD
  } as unknown as Bindings;

  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string } = {}
  ): Promise<Call> {
    const headers = new Headers();
    if (opts.token !== undefined) headers.set("Authorization", `Bearer ${opts.token}`);
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers.set("content-type", "application/json");
    }
    const response = await app.fetch(new Request(`https://license.test${path}`, { method, headers, body }), env, CTX as never);
    const text = await response.text();
    let payload: Payload = { ok: false };
    try {
      payload = text.length > 0 ? (JSON.parse(text) as Payload) : { ok: false };
    } catch {
      payload = { ok: false, error: { code: "NON_JSON", message: text } };
    }
    return { status: response.status, data: payload.data, error: payload.error, payload };
  }

  return {
    raw,
    call,
    get: (path, opts) => call("GET", path, opts),
    post: (path, opts) => call("POST", path, opts),
    sql: <T,>(query: string, ...params: (string | number | null)[]) => raw.prepare(query).all(...params) as T[],
    loginBootstrap: async () => {
      const res = await call("POST", "/api/admin/login", {
        body: {
          username: BOOTSTRAP_USERNAME,
          password: BOOTSTRAP_PASSWORD,
          master_password: MASTER_PASSWORD
        }
      });
      if (!res.payload.ok) throw new Error(`bootstrap login failed: ${res.status} ${JSON.stringify(res.payload)}`);
      return res.data.token as string;
    },
    close: () => raw.close()
  };
}

async function verifySignature(payload: LicensePayload, signatureB64: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(TEST_SECRETS.LICENSE_SIGNING_PUBLIC_KEY) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    base64UrlToBytes(signatureB64) as BufferSource,
    canonicalize(payload) as BufferSource
  );
}

/** Seed an app + a single monthly code. Returns ids + secrets. */
async function seedApp(h: NodeHarness, token: string) {
  const app = await h.post("/api/admin/apps", { token, body: { name: `App ${Math.random()}`, platform: "desktop" } });
  const appId = app.data.app.app_id as string;
  const appSecret = app.data.app_secret as string;
  const batch = await h.post("/api/admin/codes/batch", {
    token,
    body: { app_id: appId, plan_code: "monthly", quantity: 1 }
  });
  const code = batch.data.codes[0] as string;
  const codeId = h.sql<{ id: number }>(
    "SELECT id FROM activation_codes WHERE app_id = (SELECT id FROM apps WHERE app_id = ?)",
    appId
  )[0].id;
  return { appId, appSecret, code, codeId };
}

function verifyBody(appId: string, appSecret: string, code: string, installationId: string) {
  return {
    app_id: appId,
    app_secret: appSecret,
    license_key: code,
    product_id: appId,
    installation_id: installationId,
    protocol_version: 1
  };
}

describe("NodeSqliteAdapter: signed verify over the real app", () => {
  let h: NodeHarness | null = null;
  afterEach(() => h?.close());

  it("returns a signed, verifiable active payload and rejects a tampered copy", async () => {
    h = await createNodeHarness();
    const token = await h.loginBootstrap();
    const { appId, appSecret, code } = await seedApp(h, token);
    const device = `device-${Math.random()}`;
    await h.post("/api/client/activate", { body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device } });

    const res = await h.post("/api/v1/license/verify", { body: verifyBody(appId, appSecret, code, device) });
    expect(res.status).toBe(200);
    const payload = res.data.payload as LicensePayload;
    expect(payload.status).toBe("active");
    expect(payload.activation_allowed).toBe(true);
    // Signature is genuine over the Node adapter's data.
    expect(await verifySignature(payload, res.data.signature)).toBe(true);
    // Tamper rejection: mutating any signed field breaks verification.
    const tampered = { ...payload, expires_at: "2099-01-01T00:00:00.000Z" };
    expect(await verifySignature(tampered, res.data.signature)).toBe(false);
  });
});

describe("NodeSqliteAdapter: activation-limit atomicity", () => {
  let h: NodeHarness | null = null;
  afterEach(() => h?.close());

  it("never fills more than max_activations slots across distinct installations", async () => {
    h = await createNodeHarness();
    const token = await h.loginBootstrap();
    const { appId, appSecret, code, codeId } = await seedApp(h, token);

    // Activate once so the code status becomes 'active' (verify only claims
    // slots for an active code).
    const activated = await h.post("/api/client/activate", {
      body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: "install-A" }
    });
    expect(activated.status).toBe(200);

    // max_activations > 1 switches the server to the atomic slot-claim path
    // (claimActivationSlot: one INSERT...SELECT...WHERE(count)<max...ON CONFLICT
    // statement). This is the property FEAT-003 must prove is portable to the
    // Node adapter.
    const setMax = await h.call("PATCH", `/api/admin/codes/${codeId}/max-activations`, {
      token,
      body: { max_activations: 2 }
    });
    expect(setMax.status).toBe(200);

    // Three distinct installations verify; the slot claim runs inside verify.
    const results: boolean[] = [];
    for (const install of ["install-A", "install-B", "install-C"]) {
      const res = await h.post("/api/v1/license/verify", { body: verifyBody(appId, appSecret, code, install) });
      expect(res.status).toBe(200);
      results.push(res.data.payload.activation_allowed as boolean);
    }

    // At most 2 installations may be allowed; the atomic statement must never
    // let the active slot count exceed max_activations.
    expect(results.filter(Boolean).length).toBe(2);
    const active = h.sql<{ n: number }>(
      "SELECT COUNT(*) AS n FROM code_activations WHERE status = 'active' AND code_id = ?",
      codeId
    )[0].n;
    expect(active).toBe(2);
  });
});

describe("NodeSqliteAdapter: admin user-management flow", () => {
  let h: NodeHarness | null = null;
  afterEach(() => h?.close());

  it("creates a user, kicks them, and rejects the pre-kick token 401", async () => {
    h = await createNodeHarness();
    const token = await h.loginBootstrap();

    const created = await h.post("/api/admin/users", {
      token,
      body: { username: "node-ops", password: "password-123", role: USER_ROLE.ADMIN }
    });
    expect(created.status).toBe(201);
    const userId = created.data.id as number;

    // Mint a token for the new user at its current (pre-kick) epoch, mirroring
    // the login route's signJwt call.
    const beforeEpoch = h.sql<{ session_epoch: number }>("SELECT session_epoch FROM admin_users WHERE id = ?", userId)[0]
      .session_epoch;
    const userToken = await signJwt(TEST_SECRETS.JWT_SECRET, { sub: String(userId), username: "node-ops", epoch: beforeEpoch }, TTL);

    // The token works before the kick (hits an authenticated endpoint).
    const okBefore = await h.get("/api/admin/me", { token: userToken });
    expect(okBefore.status).toBe(200);

    // Kick increments session_epoch; the old token must now be rejected 401.
    const kick = await h.post(`/api/admin/users/${userId}/kick`, { token });
    expect(kick.status).toBe(200);
    const afterEpoch = h.sql<{ session_epoch: number }>("SELECT session_epoch FROM admin_users WHERE id = ?", userId)[0]
      .session_epoch;
    expect(afterEpoch).toBeGreaterThan(beforeEpoch);

    const rejected = await h.get("/api/admin/me", { token: userToken });
    expect(rejected.status).toBe(401);
  });
});
