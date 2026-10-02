/**
 * Node / Vercel entry point (decision SL-20, design §15.4, FEAT-003).
 *
 * This boots the SAME Hono app exported from `./index.ts` on a plain Node
 * runtime, backed by `node:sqlite` through {@link NodeSqliteAdapter}. The app,
 * router, middleware, service and repository code are 100% UNCHANGED — only the
 * host (Cloudflare Workers vs. Node) and the database driver (D1 vs.
 * `node:sqlite`) differ.
 *
 * HONESTY: this is NOT the Cloudflare Workers runtime. There is no workerd, no
 * real D1, and no edge network here. It runs the Node adapter + a local SQLite
 * file, which is faithful at the SQL-engine level but does not reproduce
 * Cloudflare-platform behaviour (D1 query limits/error codes, edge geography,
 * replication). Use this for the Vercel / generic-Node target; use `wrangler`
 * for the real Worker.
 *
 * The injection point: `routes.ts`/`middleware.ts` build
 * `new Repository(new D1Adapter(c.env.DB))`. `D1Adapter` only forwards
 * `prepare/batch/exec`, which `NodeSqliteAdapter` implements with identical
 * return shapes, so putting a `NodeSqliteAdapter` on `env.DB` lets the UNCHANGED
 * route code run verbatim on Node. `index.ts` is never edited.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import app from "./index";
import type { Bindings } from "./types";
import { NodeSqliteAdapter } from "./db/node-sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "migrations");
const ADMIN_DIST_DIR = join(HERE, "..", "..", "admin", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

/** Applies every `migrations/*.sql` in filename order, exactly as wrangler does. */
export async function applyMigrations(db: DatabaseSync): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    db.exec(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return files;
}

/**
 * Builds the `Bindings` env from `process.env`. `DB` is a `NodeSqliteAdapter`
 * presented as the `DB` binding; `ASSETS` serves the checked-in `admin/dist`
 * build from disk (the Worker uses the Cloudflare ASSETS binding for the same
 * files).
 */
export function buildEnv(db: DatabaseSync): Bindings {
  const assets: Pick<Fetcher, "fetch"> = {
    fetch: async (input: RequestInfo | URL) => serveAsset(input)
  };
  const env = {
    DB: new NodeSqliteAdapter(db),
    ASSETS: assets,
    JWT_SECRET: process.env.JWT_SECRET,
    CODE_HMAC_SECRET: process.env.CODE_HMAC_SECRET,
    APP_SECRET_HMAC_SECRET: process.env.APP_SECRET_HMAC_SECRET,
    DEVICE_HMAC_SECRET: process.env.DEVICE_HMAC_SECRET,
    ADMIN_BOOTSTRAP_USERNAME: process.env.ADMIN_BOOTSTRAP_USERNAME,
    ADMIN_BOOTSTRAP_PASSWORD: process.env.ADMIN_BOOTSTRAP_PASSWORD,
    LICENSE_SIGNING_PRIVATE_KEY: process.env.LICENSE_SIGNING_PRIVATE_KEY,
    LICENSE_SIGNING_KEY_ID: process.env.LICENSE_SIGNING_KEY_ID,
    LICENSE_SIGNING_PUBLIC_KEY: process.env.LICENSE_SIGNING_PUBLIC_KEY,
    LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY: process.env.LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY,
    LICENSE_SIGNING_PREVIOUS_KEY_ID: process.env.LICENSE_SIGNING_PREVIOUS_KEY_ID
    // Note: `NodeSqliteAdapter`/the asset shim satisfy the `DB`/`ASSETS` bindings
    // at runtime; the cast reconciles that with the Cloudflare-typed `Bindings`.
  } as unknown as Bindings;
  return env;
}

/** Serves a file from `admin/dist`, falling back to `index.html` (SPA). */
async function serveAsset(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const requested = decodeURIComponent(url.pathname);
  const safePath = normalize(join(ADMIN_DIST_DIR, requested)).replace(/\\/g, "/");
  // Prevent path traversal outside admin/dist.
  const rootPrefix = ADMIN_DIST_DIR.replace(/\\/g, "/");
  let filePath =
    safePath.startsWith(rootPrefix) && existsSync(safePath) && statSync(safePath).isFile()
      ? safePath
      : join(ADMIN_DIST_DIR, "index.html");
  if (!existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }
  const body = await readFile(filePath);
  const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": type }
  });
}

/** Opens the configured SQLite file and applies all migrations. */
export async function openDatabase(): Promise<DatabaseSync> {
  const file = process.env.SQLITE_PATH ?? join(process.cwd(), "license-manager.sqlite");
  const db = new DatabaseSync(file);
  await applyMigrations(db);
  return db;
}

/** Converts a Node request into a WHATWG `Request` for `app.fetch()`. */
function toFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const protocol = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const url = `${protocol}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (req as unknown as ReadableStream) : undefined,
    // Required by undici when streaming a Node request as the body.
    duplex: "half"
  } as RequestInit);
}

/** Writes a WHATWG `Response` back onto the Node response. */
async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } else {
    res.end();
  }
}

/** Builds and starts the Node HTTP server. Returns the live server + env. */
export async function startServer(port = Number(process.env.PORT ?? 8787)) {
  const db = await openDatabase();
  const env = buildEnv(db);
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const response = await app.fetch(toFetchRequest(req), env, ctx as never);
        await writeFetchResponse(res, response);
      } catch (error) {
        // Mirror the Worker's generic 500 shape; never leak the raw error.
        console.error(error);
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: { code: "CONFLICT", message: "Unexpected server error" } }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return { server, env, db, port };
}

// `createReadStream` is imported for parity with potential streaming asset
// serving; keep the reference so lint does not drop the import in future edits.
void createReadStream;

// Boot immediately when run directly (`node dist/entry-node.js` /
// `tsx src/entry-node.ts`), but NOT when imported (e.g. by the Vercel handler).
const isDirectRun = process.argv[1] ? fileURLToPath(import.meta.url) === normalize(process.argv[1]) : false;
if (isDirectRun) {
  startServer()
    .then(({ port }) => {
      console.log(`license-manager (Node adapter + SQLite) listening on http://localhost:${port}`);
      console.log("NOTE: this is the Node/Vercel target, NOT the Cloudflare Workers runtime.");
    })
    .catch((error) => {
      console.error("Failed to start Node server:", error);
      process.exit(1);
    });
}
