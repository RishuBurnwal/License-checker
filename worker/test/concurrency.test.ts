/**
 * Concurrency tests (Prompt.md section 46).
 *
 * Scope and honesty note. This project runs on Cloudflare D1, where two
 * isolates can genuinely execute at the same moment. The test runtime here is a
 * single-threaded `node:sqlite` shim, so these tests cannot reproduce true
 * simultaneous execution. What they do prove is the mechanism the service
 * actually relies on: every state transition is a conditional (compare-and-set)
 * UPDATE whose predicate encodes the precondition, and the loser of a race
 * observes zero affected rows. That is what makes `activateCode`,
 * `bindUnboundDevice`, `unbindDevice` and `updateCodeDisabled` safe under
 * concurrency, and it is falsifiable here — a dropped predicate would make the
 * competing call succeed too.
 *
 * Genuine parallel execution, D1's serialisation of a single SQLite database,
 * and multi-isolate behaviour remain untested and are reported as such.
 */
import { describe, expect, it } from "vitest";
import { codeSuffix, hmacSha256 } from "../src/crypto";
import { D1Adapter } from "../src/db/adapter";
import { Repository } from "../src/repository";
import { MAX_REBINDS } from "../src/service";
import type { Harness } from "./helpers/harness";
import { TEST_SECRETS, createHarness } from "./helpers/harness";
import { createLicensedApp } from "./helpers/scenario";

const ISO = () => new Date().toISOString();

function codeIdOf(h: Harness, code: string): number {
  return h.sql<{ id: number }>("SELECT id FROM activation_codes WHERE code_suffix = ?", codeSuffix(code))[0].id;
}

type CodeState = {
  status: string;
  device_hash: string | null;
  activated_at: string | null;
  expires_at: string | null;
  rebind_count: number;
  disabled_at: string | null;
};

function stateOf(h: Harness, id: number): CodeState {
  return h
    .sql<CodeState>(
      "SELECT status, device_hash, activated_at, expires_at, rebind_count, disabled_at FROM activation_codes WHERE id = ?",
      id
    )[0];
}

describe("compare-and-set write guards", () => {
  it("lets exactly one activation win", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const repo = new Repository(new D1Adapter(h.env.DB));
    const codeId = codeIdOf(h, app.code);

    const first = await repo.activateCode({
      codeId,
      deviceHash: "hash-a",
      activatedAt: ISO(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    });
    // The second call carries the same precondition, which the first just
    // invalidated, so it must not overwrite the activation.
    const second = await repo.activateCode({
      codeId,
      deviceHash: "hash-b",
      activatedAt: ISO(),
      expiresAt: new Date(Date.now() + 172_800_000).toISOString()
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(stateOf(h, codeId)).toMatchObject({ status: "active", device_hash: "hash-a" });
    h.close();
  });

  it("lets exactly one device bind win", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const repo = new Repository(new D1Adapter(h.env.DB));
    const codeId = codeIdOf(h, app.code);

    // An active-but-unbound code arises after a device unbind.
    h.raw
      .prepare("UPDATE activation_codes SET status = 'active', activated_at = ?, expires_at = ?, device_hash = NULL WHERE id = ?")
      .run(ISO(), new Date(Date.now() + 86_400_000).toISOString(), codeId);

    const winner = await repo.bindUnboundDevice({ codeId, deviceHash: "hash-first", boundAt: ISO() });
    const loser = await repo.bindUnboundDevice({ codeId, deviceHash: "hash-second", boundAt: ISO() });

    expect(winner).toBe(true);
    expect(loser).toBe(false);
    expect(stateOf(h, codeId).device_hash).toBe("hash-first");
    h.close();
  });

  it("refuses an unbind once the rebind budget is spent", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const repo = new Repository(new D1Adapter(h.env.DB));
    const codeId = codeIdOf(h, app.code);
    await repo.activateCode({
      codeId,
      deviceHash: "hash-a",
      activatedAt: ISO(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    });

    // At the budget limit the predicate `rebind_count < maxRebinds` is false.
    h.raw.prepare("UPDATE activation_codes SET rebind_count = ? WHERE id = ?").run(MAX_REBINDS, codeId);
    const refused = await repo.unbindDevice({
      codeId,
      deviceHash: "hash-a",
      unboundAt: ISO(),
      maxRebinds: MAX_REBINDS
    });
    expect(refused).toBe(false);
    expect(stateOf(h, codeId)).toMatchObject({ device_hash: "hash-a", rebind_count: MAX_REBINDS });

    // One below the limit it still succeeds, which shows the predicate is a
    // boundary and not an unconditional refusal.
    h.raw.prepare("UPDATE activation_codes SET rebind_count = ? WHERE id = ?").run(MAX_REBINDS - 1, codeId);
    const allowed = await repo.unbindDevice({
      codeId,
      deviceHash: "hash-a",
      unboundAt: ISO(),
      maxRebinds: MAX_REBINDS
    });
    expect(allowed).toBe(true);
    expect(stateOf(h, codeId)).toMatchObject({ device_hash: null, rebind_count: MAX_REBINDS });
    h.close();
  });

  it("refuses an unbind from a device that does not hold the code", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const repo = new Repository(new D1Adapter(h.env.DB));
    const codeId = codeIdOf(h, app.code);
    await repo.activateCode({
      codeId,
      deviceHash: "hash-owner",
      activatedAt: ISO(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    });

    const refused = await repo.unbindDevice({
      codeId,
      deviceHash: "hash-intruder",
      unboundAt: ISO(),
      maxRebinds: MAX_REBINDS
    });
    expect(refused).toBe(false);
    expect(stateOf(h, codeId)).toMatchObject({ device_hash: "hash-owner", rebind_count: 0 });
    h.close();
  });

  it("lets exactly one manual unbind win", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const repo = new Repository(new D1Adapter(h.env.DB));
    const codeId = codeIdOf(h, app.code);
    await repo.activateCode({
      codeId,
      deviceHash: "hash-a",
      activatedAt: ISO(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    });

    const first = await repo.manuallyUnbindDevice({ codeId, changedAt: ISO() });
    const second = await repo.manuallyUnbindDevice({ codeId, changedAt: ISO() });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(stateOf(h, codeId).device_hash).toBeNull();
    h.close();
  });

  it("disables idempotently and refuses a deleted code", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const repo = new Repository(new D1Adapter(h.env.DB));
    const codeId = codeIdOf(h, app.code);
    const at = ISO();

    // Disabling is deliberately not a compare-and-set: unlike activation, a
    // repeated disable of the same code is a no-op the operator may repeat.
    const first = await repo.updateCodeDisabled({ codeId, disabled: true, changedAt: at });
    const second = await repo.updateCodeDisabled({ codeId, disabled: true, changedAt: at });
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(stateOf(h, codeId).disabled_at).toBe(at);

    // Re-enabling clears the stamp.
    expect(await repo.updateCodeDisabled({ codeId, disabled: false, changedAt: ISO() })).toBe(true);
    expect(stateOf(h, codeId).disabled_at).toBeNull();

    // A deleted code is out of reach entirely.
    h.raw.prepare("UPDATE activation_codes SET status = 'deleted' WHERE id = ?").run(codeId);
    expect(await repo.updateCodeDisabled({ codeId, disabled: true, changedAt: ISO() })).toBe(false);
    h.close();
  });
});

describe("interleaved requests", () => {
  it("settles two identical activations without double-writing", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const body = { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device };

    const [first, second] = await Promise.all([
      h.post("/api/client/activate", { body }),
      h.post("/api/client/activate", { body })
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Expiry is derived from `activated_at`, which is written once, so neither
    // response may show a drifted window.
    expect(second.data.expires_at).toBe(first.data.expires_at);
    expect(first.data.rebind_count).toBe(0);
    expect(second.data.rebind_count).toBe(0);
    expect(stateOf(h, codeIdOf(h, app.code)).rebind_count).toBe(0);
    h.close();
  });

  it("lets exactly one of two racing devices hold the code", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });

    const [alpha, beta] = await Promise.all([
      h.post("/api/client/activate", {
        body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: "device-alpha" }
      }),
      h.post("/api/client/activate", {
        body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: "device-beta" }
      })
    ]);

    const winner = [alpha, beta].filter((response) => response.status === 200);
    const loser = [alpha, beta].filter((response) => response.status !== 200);
    expect(winner).toHaveLength(1);
    expect(loser).toHaveLength(1);
    expect(loser[0].error?.code).toBe("DEVICE_MISMATCH");

    // The stored binding is the winning device's hash and nothing else.
    const hashAlpha = await hmacSha256(TEST_SECRETS.DEVICE_HMAC_SECRET, "device-alpha");
    const hashBeta = await hmacSha256(TEST_SECRETS.DEVICE_HMAC_SECRET, "device-beta");
    const stored = stateOf(h, codeIdOf(h, app.code)).device_hash;
    expect([hashAlpha, hashBeta]).toContain(stored);
    h.close();
  });

  it("does not resurrect a code that a concurrent disable removed", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const codeId = codeIdOf(h, app.code);

    const [activate, disable] = await Promise.all([
      h.post("/api/client/activate", {
        body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
      }),
      h.patch(`/api/admin/codes/${codeId}/status`, { token: app.token, body: { status: "disabled" } })
    ]);

    expect(disable.status).toBe(200);
    // Whichever order the two land in, an activation may never succeed after the
    // disable is visible, and the final state must be disabled.
    expect([200, 403]).toContain(activate.status);
    if (activate.status === 403) {
      expect(activate.error?.code).toBe("CODE_DISABLED");
    }
    expect(stateOf(h, codeId).disabled_at).not.toBeNull();

    // And a later activation is refused outright.
    const after = await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: "device-late" }
    });
    expect(after.status).toBe(403);
    expect(after.error?.code).toBe("CODE_DISABLED");
    h.close();
  });

  it("counts a single rebind when two unbinds race", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const codeId = codeIdOf(h, app.code);

    await h.post("/api/client/activate", {
      body: { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device }
    });

    const body = { app_id: app.appId, app_secret: app.appSecret, code: app.code, device_fingerprint: app.device };
    const [first, second] = await Promise.all([
      h.post("/api/client/unbind-device", { body }),
      h.post("/api/client/unbind-device", { body })
    ]);

    const succeeded = [first, second].filter((response) => response.status === 200);
    expect(succeeded).toHaveLength(1);
    // The loser is refused by the cooldown or by the now-null device binding;
    // either way the budget is charged exactly once.
    expect(stateOf(h, codeId).rebind_count).toBe(1);
    expect(stateOf(h, codeId).device_hash).toBeNull();
    h.close();
  });

  it("generates disjoint codes across concurrent batches", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });

    const [first, second] = await Promise.all([
      h.post("/api/admin/codes/batch", {
        token: app.token,
        body: { app_id: app.appId, plan_code: "monthly", quantity: 5 }
      }),
      h.post("/api/admin/codes/batch", {
        token: app.token,
        body: { app_id: app.appId, plan_code: "monthly", quantity: 5 }
      })
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const all = [...first.data.codes, ...second.data.codes];
    expect(new Set(all).size).toBe(10);

    const rows = h.sql<{ code_hash: string }>("SELECT code_hash FROM activation_codes");
    expect(rows).toHaveLength(11); // 10 new plus the one from the helper
    expect(new Set(rows.map((row) => row.code_hash)).size).toBe(11);
    h.close();
  });

  it("creates exactly one user when two identical creations race", async () => {
    const h = await createHarness();
    const token = await h.loginBootstrap();

    const [first, second] = await Promise.all([
      h.post("/api/admin/users", {
        token,
        body: { username: "race-user", password: "race-password-1", role: "admin" }
      }),
      h.post("/api/admin/users", {
        token,
        body: { username: "race-user", password: "race-password-2", role: "staff" }
      })
    ]);

    const created = [first, second].filter((response) => response.status === 201);
    const refused = [first, second].filter((response) => response.status === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);

    // The UNIQUE username constraint keeps exactly one row.
    const rows = h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM admin_users WHERE username = 'race-user'");
    expect(rows[0].count).toBe(1);
    h.close();
  });

  it("rejects a duplicate code hash at the storage layer", async () => {
    const h = await createHarness();
    const app = await createLicensedApp(h, { quantity: 1 });
    const repo = new Repository(new D1Adapter(h.env.DB));
    const batchId = h.sql<{ id: number }>("SELECT id FROM activation_batches")[0].id;
    const appDbId = h.sql<{ id: number }>("SELECT id FROM apps")[0].id;
    const existing = h.sql<{ code_hash: string }>("SELECT code_hash FROM activation_codes")[0].code_hash;
    const adminId = h.sql<{ id: number }>("SELECT id FROM admin_users ORDER BY id LIMIT 1")[0].id;

    // The UNIQUE index is the last line of defence if two writers ever got past
    // the application layer.
    expect(existing).toBeTruthy();
    await expect(
      repo.createActivationCodes([
        {
          batchId,
          appDbId,
          planId: 2,
          codeHash: existing,
          codeSuffix: "DUPE01",
          createdBy: adminId
        }
      ])
    ).rejects.toThrow(/UNIQUE/i);

    expect(h.sql<{ count: number }>("SELECT COUNT(*) AS count FROM activation_codes")[0].count).toBe(1);
    h.close();
  });
});
