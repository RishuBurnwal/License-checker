/**
 * Test harness: a real HTTP surface over a real SQLite database.
 *
 * `app.fetch()` is the actual Worker entry point from `src/index.ts`, so every
 * call below traverses the real router, the real middleware chain, the real
 * handlers and the real SQL. Nothing is stubbed except Cloudflare's edge
 * platform (see the fidelity notes in `./d1.ts`).
 */
import { DatabaseSync } from "node:sqlite";
import app from "../../src/index";
import type { Bindings } from "../../src/types";
import { applyMigrations, createSqliteD1 } from "./d1";

export const TEST_SECRETS = {
  JWT_SECRET: "test-jwt-secret-0123456789abcdef0123456789abcdef",
  CODE_HMAC_SECRET: "test-code-hmac-secret-0123456789abcdef0123456789",
  APP_SECRET_HMAC_SECRET: "test-app-secret-hmac-0123456789abcdef0123456789",
  DEVICE_HMAC_SECRET: "test-device-hmac-secret-0123456789abcdef01234567",
  // Dev-only Ed25519 keypair for tests: PKCS8 private (48 bytes) + raw public
  // (32 bytes), base64url. Not a production secret; validateEnv requires these.
  LICENSE_SIGNING_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEIJFuo2oq6mwiwNj6jABiYJTFdTSh_tN96k2x56qlpjRL",
  LICENSE_SIGNING_PUBLIC_KEY: "TOwxe9EweGiDchaoYOmHY_GuOZrgMiZAkueFVVmBxTQ",
  LICENSE_SIGNING_KEY_ID: "ed25519-test"
} as const;

export const BOOTSTRAP_USERNAME = "bootstrap-admin";
export const BOOTSTRAP_PASSWORD = "bootstrap-password-1";
// Global admin master password seeded into every harness env. The bootstrap
// admin (user_role=admin) requires it; staff ignore it. Tests that need the
// fail-closed path override ADMIN_MASTER_PASSWORD to undefined.
export const MASTER_PASSWORD = "master-password-1";

export type Payload<T = any> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
};

export type Call = {
  status: number;
  payload: Payload;
  /** Convenience: `payload.data`, present only on success. */
  data: any;
  /** Convenience: `payload.error`, present only on failure. */
  error: { code: string; message: string } | undefined;
};

export type RequestOptions = {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  /** Send the body as a raw string instead of JSON-encoding it. */
  rawBody?: string;
};

export type Harness = {
  env: Bindings;
  raw: DatabaseSync;
  call(method: string, path: string, options?: RequestOptions): Promise<Call>;
  get(path: string, options?: RequestOptions): Promise<Call>;
  post(path: string, options?: RequestOptions): Promise<Call>;
  patch(path: string, options?: RequestOptions): Promise<Call>;
  delete(path: string, options?: RequestOptions): Promise<Call>;
  /** Run SQL directly, for assertions the public API cannot express. */
  sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[];
  login(username: string, password: string, masterPassword?: string): Promise<Call>;
  /** Bootstrap admin login, returning its bearer token. */
  loginBootstrap(): Promise<string>;
  close(): void;
};

const CTX = {
  waitUntil() {},
  passThroughOnException() {}
};

export async function createHarness(
  overrides: Record<string, unknown> = {},
  options: { wrapDb?: (db: D1Database) => D1Database } = {}
): Promise<Harness> {
  const sqlite = createSqliteD1();
  await applyMigrations(sqlite.raw);

  const env = {
    DB: options.wrapDb ? options.wrapDb(sqlite.db) : sqlite.db,
    ASSETS: {
      fetch: async () => new Response("<!doctype html><title>asset</title>", { status: 200 })
    },
    ...TEST_SECRETS,
    ADMIN_BOOTSTRAP_USERNAME: BOOTSTRAP_USERNAME,
    ADMIN_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
    ADMIN_MASTER_PASSWORD: MASTER_PASSWORD,
    ...overrides
  } as unknown as Bindings;

  async function call(method: string, path: string, options: RequestOptions = {}): Promise<Call> {
    const headers = new Headers(options.headers ?? {});
    if (options.token !== undefined) {
      headers.set("Authorization", `Bearer ${options.token}`);
    }
    let body: string | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }

    const request = new Request(`https://license.test${path}`, {
      method,
      headers,
      body
    });
    const response = await app.fetch(request, env, CTX as never);
    const text = await response.text();
    let payload: Payload = { ok: false };
    try {
      payload = text.length > 0 ? (JSON.parse(text) as Payload) : { ok: false };
    } catch {
      payload = { ok: false, error: { code: "NON_JSON", message: text } };
    }
    return {
      status: response.status,
      payload,
      data: payload.data,
      error: payload.error
    };
  }

  return {
    env,
    raw: sqlite.raw,
    call,
    get: (path, options) => call("GET", path, options),
    post: (path, options) => call("POST", path, options),
    patch: (path, options) => call("PATCH", path, options),
    delete: (path, options) => call("DELETE", path, options),
    sql: <T,>(query: string, ...params: (string | number | null)[]) =>
      sqlite.raw.prepare(query).all(...params) as T[],
    login: (username, password, masterPassword = MASTER_PASSWORD) =>
      // master_password is harmless for staff and required for admins; pass it by
      // default so existing admin logins keep working. Pass `undefined` explicitly
      // to exercise the "admin without master" path.
      call("POST", "/api/admin/login", { body: { username, password, master_password: masterPassword } }),
    loginBootstrap: async () => {
      const response = await call("POST", "/api/admin/login", {
        body: { username: BOOTSTRAP_USERNAME, password: BOOTSTRAP_PASSWORD, master_password: MASTER_PASSWORD }
      });
      if (!response.payload.ok) {
        throw new Error(`bootstrap login failed: ${response.status} ${JSON.stringify(response.payload)}`);
      }
      return response.data.token as string;
    },
    close: () => sqlite.close()
  };
}

/** Read the applied migration filenames, for assertions about the real schema. */
export async function appliedMigrationNames(): Promise<string[]> {
  const { migrationFiles } = await import("./d1");
  return migrationFiles();
}
