import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers/harness";
import { createLicensedApp } from "./helpers/scenario";

describe("session, heartbeat, kick, renewal, and grace lease", () => {
  it("registers a session, refreshes heartbeat, lists it, and propagates an admin kick", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const activated = await h.post("/api/client/activate", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device } });
    expect(activated.status).toBe(200);
    expect(activated.data.session_token).toEqual(expect.any(String));
    expect(activated.data.grace_period_seconds).toBe(86400);

    const heartbeat = await h.post("/api/client/heartbeat", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device, session_token: activated.data.session_token } });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.data.lease_expires_at).toEqual(expect.any(String));

    const sessions = await h.get("/api/admin/sessions", { token: app.token });
    expect(sessions.status).toBe(200);
    expect(sessions.data.items).toHaveLength(1);
    expect(sessions.data.items[0]).toMatchObject({ code_suffix: expect.any(String), device_bound: true });
    expect(sessions.data.items[0].device_hash).toBeUndefined();

    const kicked = await h.post(`/api/admin/sessions/${sessions.data.items[0].id}/kick`, { token: app.token });
    expect(kicked.status).toBe(200);
    const afterKick = await h.post("/api/client/heartbeat", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device, session_token: activated.data.session_token } });
    expect(afterKick.status).toBe(403);
    expect(afterKick.error?.code).toBe("SESSION_REVOKED");
    h.close();
  });

  it("renews an expired license from server time without changing activation time", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h);
    const activated = await h.post("/api/client/activate", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device } });
    const before = activated.data.activated_at;
    h.raw.prepare("UPDATE activation_codes SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    const renewed = await h.post("/api/client/renew", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device } });
    expect(renewed.status).toBe(200);
    expect(renewed.data.activated_at).toBe(before);
    expect(new Date(renewed.data.expires_at).getTime()).toBeGreaterThan(Date.now());
    h.close();
  });

  it("enforces one active session per plan atomically", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 2 });
    const first = await h.post("/api/client/activate", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.codes[0], device_fingerprint: "device-1" } });
    const second = await h.post("/api/client/activate", { body: { app_id: app.appId, app_secret: app.appSecret, code: app.codes[1], device_fingerprint: "device-2" } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const sessions = h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM license_sessions WHERE status = 'active'");
    expect(sessions[0].count).toBe(2);
    h.close();
  });
});
