/**
 * Vercel Node-adapter entry (FEAT-003).
 *
 * HONESTY: Cloudflare Workers is NOT a native Vercel runtime. This handler does
 * NOT run the Worker (workerd) or Cloudflare D1. It runs the SAME Hono app from
 * `worker/src/index.ts` on Vercel's Node runtime, backed by `node:sqlite`
 * through `NodeSqliteAdapter` (see `worker/src/entry-node.ts`). It is a
 * functional parity target for generic Node/Vercel hosting, not an edge/Worker
 * deployment.
 *
 * SQLite caveat on Vercel: the serverless filesystem is read-only except
 * `/tmp`, and `/tmp` is per-instance and ephemeral. A SQLite file here is NOT
 * durable shared state across instances — fine for a demo/single-instance
 * target, but for real multi-instance hosting point `SQLITE_PATH` at a
 * persistent volume or use a networked database. The Cloudflare Worker + D1
 * remains the primary, durable deployment target.
 *
 * This file deliberately lives at the repo root `api/` dir (Vercel's function
 * convention) and reuses `worker/src/entry-node.ts` so there is a single source
 * of truth for env building, migrations and request translation.
 */
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import app from "../worker/src/index";
import { applyMigrations, buildEnv } from "../worker/src/entry-node";

// One SQLite handle per warm instance. On Vercel this lives under /tmp by
// default (see SQLITE_PATH), so it is ephemeral per instance.
let dbPromise: Promise<DatabaseSync> | null = null;

async function getDb(): Promise<DatabaseSync> {
  if (!dbPromise) {
    const file = process.env.SQLITE_PATH ?? "/tmp/license-manager.sqlite";
    dbPromise = (async () => {
      const db = new DatabaseSync(file);
      await applyMigrations(db);
      return db;
    })();
  }
  return dbPromise;
}

function toFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const protocol = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
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
    duplex: "half"
  } as RequestInit);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const env = buildEnv(db);
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const response = await app.fetch(toFetchRequest(req), env, ctx as never);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    if (response.body) {
      res.end(Buffer.from(await response.arrayBuffer()));
    } else {
      res.end();
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "CONFLICT", message: "Unexpected server error" } }));
  }
}
