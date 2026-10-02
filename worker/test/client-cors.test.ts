/**
 * CORS for the public signed-license client endpoints.
 *
 * Browser clients (the license-checker on its own origin, or a web build of a
 * customer app) call a user-supplied server URL, which is cross-origin. These
 * tests pin that /api/v1/license/* answers the preflight and exposes CORS
 * headers on success AND error envelopes, while /api/admin/* never does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { createHarness, type Harness } from "./helpers/harness";

const CTX = { waitUntil() {}, passThroughOnException() {} };

describe("client endpoint CORS", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => h.close());

  async function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
    const request = new Request(`https://license.test${path}`, { method, headers, body });
    return app.fetch(request, h.env, CTX as never);
  }

  it("answers the browser preflight for /api/v1/license/verify", async () => {
    const res = await raw("OPTIONS", "/api/v1/license/verify", {
      Origin: "http://localhost:5176",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type"
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("answers the preflight for /api/v1/license/report", async () => {
    const res = await raw("OPTIONS", "/api/v1/license/report", {
      Origin: "http://localhost:5176",
      "Access-Control-Request-Method": "POST"
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("adds CORS headers to error envelopes so the browser can read the error code", async () => {
    const res = await raw(
      "POST",
      "/api/v1/license/verify",
      { Origin: "http://localhost:5176", "content-type": "application/json" },
      JSON.stringify({ app_id: "nope", app_secret: "nope", license_key: "nope" })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const payload = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(payload.ok).toBe(false);
    expect(typeof payload.error?.code).toBe("string");
  });

  it("never adds CORS headers to admin endpoints", async () => {
    const preflight = await raw("OPTIONS", "/api/admin/login", {
      Origin: "http://evil.example",
      "Access-Control-Request-Method": "POST"
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const login = await raw(
      "POST",
      "/api/admin/login",
      { Origin: "http://evil.example", "content-type": "application/json" },
      JSON.stringify({ username: "x", password: "y" })
    );
    expect(login.headers.get("access-control-allow-origin")).toBeNull();
  });
});
