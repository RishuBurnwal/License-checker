import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createApi, createV1Api } from "./routes";
import { fail } from "./http";
import { ApiError, Bindings, Variables } from "./types";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// CORS for the public, versioned client endpoints only. Browser-based clients
// (the license-checker, any web build of a client app) run on a different
// origin than the server URL the user types in, so without these headers the
// browser blocks every call. These endpoints use no cookies or Bearer tokens
// (they authenticate with app_id/app_secret in the body and responses are
// Ed25519-signed), so a wildcard origin without credentials is safe.
// /api/admin/* deliberately gets NO CORS headers.
const CLIENT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "600"
} as const;

app.use("/api/v1/license/*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CLIENT_CORS_HEADERS });
  }
  await next();
  // Also applies to error envelopes produced by onError, so the browser can
  // read INVALID_CODE / LICENSE_HOLD etc. instead of an opaque network error.
  const res = new Response(c.res.body, c.res);
  for (const [name, value] of Object.entries(CLIENT_CORS_HEADERS)) {
    res.headers.set(name, value);
  }
  c.res = res;
});

app.route("/api", createApi());
app.route("/api/v1", createV1Api());

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return jsonError(error.status, fail(error.code, error.message));
  }
  if (error instanceof HTTPException) {
    return jsonError(error.status, fail("BAD_REQUEST", error.message));
  }
  console.error(error);
  return jsonError(500, fail("CONFLICT", "Unexpected server error"));
});

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json(fail("NOT_FOUND", "API route not found"), 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;

function jsonError(status: number, payload: ReturnType<typeof fail>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
