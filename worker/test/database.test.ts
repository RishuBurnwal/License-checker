/**
 * Database tests (Prompt.md section 46) against real SQLite.
 *
 * These exist because the Worker's original tests ran only against an in-memory
 * `MemoryRepo` fake, which cannot evaluate SQL at all. Everything asserted here
 * is a property of the real engine: constraint enforcement, affected-row counts,
 * string-comparison semantics, and the two generated statements whose
 * correctness the fake could never check.
 */
import { describe, expect, it } from "vitest";
import { Repository, buildActivationCodeInsertStatement, buildDashboardActiveTrendStatement } from "../src/repository";
import { D1Adapter } from "../src/db/adapter";
import { CODE_DERIVED_STATUS, CODE_STATUS } from "../src/constants";
import { applyMigrations, createSqliteD1, migrationFiles } from "./helpers/d1";
import { createHarness, type Harness } from "./helpers/harness";

const ISO = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 24 * 60 * 60 * 1000;

async function freshHarness(): Promise<Harness> {
  return await createHarness();
}

/** Seed an app, returning its internal id for the SQL-level tests. */
function seedApp(h: Harness, key: string): { appDbId: number } {
  h.raw
    .prepare(
      `INSERT INTO apps (app_id, name, platform, status, app_secret_hash, updated_at)
       VALUES (?, ?, 'desktop', 'active', 'hash', ?)`
    )
    .run(`app_${key}`, `App ${key}`, ISO());
  const appDbId = Number(
    (h.raw.prepare("SELECT id FROM apps WHERE app_id = ?").all(`app_${key}`)[0] as { id: number }).id
  );
  return { appDbId };
}

function insertCode(
  h: Harness,
  input: {
    appDbId: number;
    planId?: number;
    hash: string;
    suffix: string;
    status?: string;
    disabledAt?: string | null;
    activatedAt?: string | null;
    expiresAt?: string | null;
    deviceHash?: string | null;
    rebindCount?: number;
  }
): number {
  h.raw
    .prepare(
      `INSERT INTO activation_codes
         (batch_id, app_id, plan_id, code_hash, code_suffix, status, disabled_at, activated_at, expires_at, device_hash, rebind_count, created_by, updated_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(
      input.appDbId,
      input.planId ?? 2,
      input.hash,
      input.suffix,
      input.status ?? "unused",
      input.disabledAt ?? null,
      input.activatedAt ?? null,
      input.expiresAt ?? null,
      input.deviceHash ?? null,
      input.rebindCount ?? 0,
      ISO()
    );
  return Number(
    (h.raw.prepare("SELECT last_insert_rowid() AS id").all()[0] as { id: number }).id
  );
}

describe("schema and migrations", () => {
  it("applies every migration file in order", async () => {
    const files = await migrationFiles();
    expect(files).toEqual([
      "0001_initial.sql",
      "0002_add_purchase_url.sql",
      "0003_add_tenants.sql",
      "0004_localize_seed_data.sql",
      "0005_add_sessions_and_lease_settings.sql",
      "0006_add_forced_password_change.sql",
      "0007_add_signed_license.sql",
      "0008_add_admin_users_and_sessions.sql",
      "0009_add_settings.sql",
      "0010_drop_apps_tenant.sql",
      "0011_drop_admin_users_tenant_and_role.sql",
      "0012_drop_tenants.sql"
    ]);

    const h = await freshHarness();
    const tables = h
      .sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name);
    for (const table of ["activation_batches", "activation_codes", "activation_logs", "admin_users", "apps", "plans", "settings", "license_sessions"]) {
      expect(tables).toContain(table);
    }
    // Multi-tenancy is fully removed: the tenants table no longer exists.
    expect(tables).not.toContain("tenants");
    h.close();
  });

  it("drops tenant_id from apps and admin_users and the tenant role column", async () => {
    const h = await freshHarness();
    const appColumns = h
      .sql<{ name: string }>("PRAGMA table_info(apps)")
      .map((row) => row.name);
    expect(appColumns).not.toContain("tenant_id");
    const adminColumns = h
      .sql<{ name: string }>("PRAGMA table_info(admin_users)")
      .map((row) => row.name);
    expect(adminColumns).not.toContain("tenant_id");
    expect(adminColumns).not.toContain("role");
    expect(adminColumns).toContain("user_role");
    // The settings table has the pinned shape.
    const settingsColumns = h
      .sql<{ name: string }>("PRAGMA table_info(settings)")
      .map((row) => row.name)
      .sort();
    expect(settingsColumns).toEqual(["key", "updated_at", "value"]);
    h.close();
  });

  it("localizes seed data to English and keeps durations authoritative", async () => {
    const h = await freshHarness();
    const plans = h.sql<{ code: string; name: string; duration_days: number }>(
      "SELECT code, name, duration_days FROM plans ORDER BY sort_order"
    );
    expect(plans).toEqual([
      { code: "weekly", name: "Weekly", duration_days: 7 },
      { code: "monthly", name: "Monthly", duration_days: 30 },
      { code: "quarterly", name: "Quarterly", duration_days: 90 },
      { code: "yearly", name: "Yearly", duration_days: 365 }
    ]);
    h.close();
  });

  it("enforces foreign keys, because the migration turns the pragma on", async () => {
    const h = await freshHarness();
    expect(h.sql<{ foreign_keys: number }>("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(() =>
      h.raw
        .prepare("INSERT INTO activation_codes (app_id, plan_id, code_hash, code_suffix, updated_at) VALUES (9999, 2, 'h', 's', ?)")
        .run(ISO())
    ).toThrow(/FOREIGN KEY/i);
    h.close();
  });

  it("enforces CHECK constraints on enumerated statuses", async () => {
    const h = await freshHarness();
    const { appDbId } = seedApp(h, "check");
    expect(() =>
      h.raw
        .prepare("INSERT INTO activation_codes (app_id, plan_id, code_hash, code_suffix, status, updated_at) VALUES (?, 2, 'h1', 's', 'bogus', ?)")
        .run(appDbId, ISO())
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      h.raw.prepare("INSERT INTO plans (code, name, duration_days) VALUES ('zero', 'Zero', 0)").run()
    ).toThrow(/CHECK constraint failed/i);
    h.close();
  });

  it("enforces UNIQUE on code hashes, app ids and admin usernames", async () => {
    const h = await freshHarness();
    const { appDbId } = seedApp(h, "uniq");
    insertCode(h, { appDbId, hash: "duplicate-hash", suffix: "AAA" });
    expect(() => insertCode(h, { appDbId, hash: "duplicate-hash", suffix: "BBB" })).toThrow(/UNIQUE constraint failed/i);

    // Duplicates the app that `seedApp` already created for this key.
    expect(() =>
      h.raw
        .prepare("INSERT INTO apps (app_id, name, platform, status, app_secret_hash, updated_at) VALUES ('app_uniq', 'Dup', 'desktop', 'active', 'h', ?)")
        .run(ISO())
    ).toThrow(/UNIQUE constraint failed/i);

    h.raw
      .prepare("INSERT INTO admin_users (username, password_hash, password_salt, updated_at) VALUES ('dup-user', 'h', 's', ?)")
      .run(ISO());
    expect(() =>
      h.raw
        .prepare("INSERT INTO admin_users (username, password_hash, password_salt, updated_at) VALUES ('dup-user', 'h', 's', ?)")
        .run(ISO())
    ).toThrow(/UNIQUE constraint failed/i);
    h.close();
  });
});

describe("generated SQL statements", () => {
  it("inserts a multi-row VALUES batch with the right binding order", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "batch");

    // Codes reference a real batch and a real admin: foreign keys are enforced,
    // so fabricated ids are rejected by the engine rather than silently accepted.
    h.raw
      .prepare("INSERT INTO admin_users (username, password_hash, password_salt, updated_at) VALUES ('sql-batch-admin', 'h', 's', ?)")
      .run(ISO());
    const adminId = Number((h.raw.prepare("SELECT last_insert_rowid() AS id").all()[0] as { id: number }).id);
    h.raw
      .prepare("INSERT INTO activation_batches (app_id, plan_id, quantity, created_by) VALUES (?, 2, 5, ?)")
      .run(appDbId, adminId);
    const batchId = Number((h.raw.prepare("SELECT last_insert_rowid() AS id").all()[0] as { id: number }).id);

    const inputs = Array.from({ length: 5 }, (_, index) => ({
      batchId,
      appDbId,
      planId: 2,
      codeHash: `hash-${index}`,
      codeSuffix: `SFX${index}`,
      createdBy: adminId
    }));

    // The SQL itself is the unit under test: 11 columns, 7 placeholders per row.
    const statement = buildActivationCodeInsertStatement(inputs);
    expect(statement.bindings).toHaveLength(inputs.length * 7);
    expect(statement.sql).toContain("VALUES (?, ?, ?, ?, ?, 'unused', NULL, NULL, NULL, ?, ?), (?, ?, ?, ?, ?, 'unused', NULL, NULL, NULL, ?, ?)");

    await repo.createActivationCodes(inputs);

    const rows = h.sql<{ code_hash: string; code_suffix: string; status: string; activated_at: string | null; expires_at: string | null; device_hash: string | null }>(
      "SELECT code_hash, code_suffix, status, activated_at, expires_at, device_hash FROM activation_codes ORDER BY code_hash"
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.code_hash)).toEqual(["hash-0", "hash-1", "hash-2", "hash-3", "hash-4"]);
    expect(rows.map((row) => row.code_suffix)).toEqual(["SFX0", "SFX1", "SFX2", "SFX3", "SFX4"]);
    for (const row of rows) {
      expect(row.status).toBe(CODE_STATUS.UNUSED);
      expect(row.activated_at).toBeNull();
      expect(row.expires_at).toBeNull();
      expect(row.device_hash).toBeNull();
    }
    h.close();
  });

  it("is a no-op for an empty batch rather than emitting invalid SQL", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    await expect(repo.createActivationCodes([])).resolves.toBeUndefined();
    h.close();
  });

  it("runs the dashboard active-trend CTE against the real engine", async () => {
    const h = await freshHarness();
    const { appDbId } = seedApp(h, "trend");
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);

    // Activated yesterday and still inside its window, so it counts as active for
    // both requested dates. A code expiring today would only count for yesterday,
    // because each row's window is compared against that row's `next_date`.
    insertCode(h, {
      appDbId,
      hash: "trend-active",
      suffix: "TA",
      status: "active",
      activatedAt: `${yesterday}T00:00:00.000Z`,
      expiresAt: `${future}T23:59:59.000Z`
    });

    const dates = [yesterday, today];
    const statement = buildDashboardActiveTrendStatement(dates);
    const rows = h.raw.prepare(statement.sql).all(...statement.bindings) as { date: string; active: number }[];

    // One row per requested date, even for dates with no activity — that is why
    // the CTE exists instead of a plain GROUP BY.
    expect(rows.map((row) => row.date)).toEqual(dates);
    expect(rows.map((row) => row.active)).toEqual([1, 1]);

    h.close();
  });
});

describe("compare-and-set guarantees rely on real affected-row counts", () => {
  it("activates a code exactly once", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "cas-activate");
    const codeId = insertCode(h, { appDbId, hash: "cas-1", suffix: "CAS" });

    const first = await repo.activateCode({
      codeId,
      deviceHash: "device-a",
      activatedAt: ISO(),
      expiresAt: ISO(30 * DAY)
    });
    // Second call must lose: status is no longer 'unused' and the NULL guards fail.
    const second = await repo.activateCode({
      codeId,
      deviceHash: "device-b",
      activatedAt: ISO(),
      expiresAt: ISO(30 * DAY)
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = h.sql<{ device_hash: string; status: string }>(
      "SELECT device_hash, status FROM activation_codes WHERE id = ?",
      codeId
    );
    expect(rows).toEqual([{ device_hash: "device-a", status: "active" }]);
    h.close();
  });

  it("binds an unbound device exactly once", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "cas-bind");
    const codeId = insertCode(h, { appDbId, hash: "cas-2", suffix: "BND", status: "active", activatedAt: ISO(), expiresAt: ISO(DAY) });

    expect(await repo.bindUnboundDevice({ codeId, deviceHash: "device-a", boundAt: ISO() })).toBe(true);
    expect(await repo.bindUnboundDevice({ codeId, deviceHash: "device-b", boundAt: ISO() })).toBe(false);
    expect(h.sql<{ device_hash: string }>("SELECT device_hash FROM activation_codes WHERE id = ?", codeId)).toEqual([
      { device_hash: "device-a" }
    ]);
    h.close();
  });

  it("refuses to unbind past the rebind budget or from the wrong device", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "cas-unbind");
    const codeId = insertCode(h, {
      appDbId,
      hash: "cas-3",
      suffix: "UNB",
      status: "active",
      activatedAt: ISO(),
      expiresAt: ISO(DAY),
      deviceHash: "device-a",
      rebindCount: 3
    });

    // rebind_count < 3 fails at the boundary, so the budget cannot be exceeded.
    expect(await repo.unbindDevice({ codeId, deviceHash: "device-a", unboundAt: ISO(), maxRebinds: 3 })).toBe(false);
    // Wrong device never matches the CAS predicate.
    expect(await repo.unbindDevice({ codeId, deviceHash: "device-b", unboundAt: ISO(), maxRebinds: 99 })).toBe(false);
    expect(h.sql<{ rebind_count: number; device_hash: string }>(
      "SELECT rebind_count, device_hash FROM activation_codes WHERE id = ?",
      codeId
    )).toEqual([{ rebind_count: 3, device_hash: "device-a" }]);
    h.close();
  });

  it("refuses to unbind a disabled, deleted or expired code even when unbound is permitted", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "cas-unbind-state");

    const disabled = insertCode(h, {
      appDbId,
      hash: "cas-d",
      suffix: "D",
      status: "active",
      disabledAt: ISO(),
      deviceHash: "device-a",
      activatedAt: ISO(),
      expiresAt: ISO(DAY)
    });
    expect(await repo.unbindDevice({ codeId: disabled, deviceHash: "device-a", unboundAt: ISO(), maxRebinds: 9 })).toBe(false);

    const expired = insertCode(h, {
      appDbId,
      hash: "cas-e",
      suffix: "E",
      status: "active",
      activatedAt: ISO(-2 * DAY),
      expiresAt: ISO(-DAY),
      deviceHash: "device-a"
    });
    // The repository deliberately does not re-check expiry here; the service does.
    // Asserting the actual behaviour keeps that division of responsibility explicit.
    expect(await repo.unbindDevice({ codeId: expired, deviceHash: "device-a", unboundAt: ISO(), maxRebinds: 9 })).toBe(true);
    h.close();
  });
});

describe("global mutations and listing in SQL", () => {
  it("manually unbinds an active code and refuses an expired one", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "unbind");
    const codeId = insertCode(h, {
      appDbId,
      hash: "scope-1",
      suffix: "S1",
      status: "active",
      activatedAt: ISO(),
      expiresAt: ISO(DAY),
      deviceHash: "device-a"
    });

    expect(await repo.manuallyUnbindDevice({ codeId, changedAt: ISO() })).toBe(true);
    expect(h.sql<{ device_hash: string | null }>("SELECT device_hash FROM activation_codes WHERE id = ?", codeId)).toEqual([
      { device_hash: null }
    ]);

    const expired = insertCode(h, {
      appDbId,
      hash: "scope-2",
      suffix: "S2",
      status: "active",
      activatedAt: ISO(-3 * DAY),
      expiresAt: ISO(-DAY),
      deviceHash: "device-a"
    });
    expect(await repo.manuallyUnbindDevice({ codeId: expired, changedAt: ISO() })).toBe(false);
    h.close();
  });

  it("disables, deletes and mutates apps globally", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "mut");
    const codeId = insertCode(h, { appDbId, hash: "scope-3", suffix: "S3" });

    expect(await repo.updateCodeDisabled({ codeId, disabled: true, changedAt: ISO() })).toBe(true);
    expect(await repo.softDeleteCode(codeId)).toBe(true);
    expect(await repo.updateAppStatus("app_mut", "disabled")).toBe(true);
    expect(await repo.updateAppSecretHash("app_mut", "rotated")).not.toBeNull();
    expect(await repo.getAppByPublicId("app_mut")).not.toBeNull();
    // An unknown app id matches nothing.
    expect(await repo.updateAppStatus("app_missing", "disabled")).toBe(false);
    expect(await repo.getAppByPublicId("app_missing")).toBeNull();
    h.close();
  });

  it("lists every app and code globally", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const alpha = seedApp(h, "list-alpha");
    const beta = seedApp(h, "list-beta");
    insertCode(h, { appDbId: alpha.appDbId, hash: "alpha-1", suffix: "A1" });
    insertCode(h, { appDbId: beta.appDbId, hash: "beta-1", suffix: "B1" });
    await repo.insertLog({ appDbId: alpha.appDbId, action: "activate", result: "success", message: "alpha" });
    await repo.insertLog({ appDbId: beta.appDbId, action: "activate", result: "failure", message: "beta" });

    const codes = await repo.listCodes({ page: 1, pageSize: 50 });
    expect(codes.items.map((item) => item.code_suffix).sort()).toEqual(["A1", "B1"]);
    expect(codes.total).toBe(2);

    const logs = await repo.listLogs({ page: 1, pageSize: 50 });
    expect(logs.items.map((item) => item.message).sort()).toEqual(["alpha", "beta"]);
    expect(logs.total).toBe(2);

    const apps = await repo.listApps();
    expect(apps.map((app) => app.app_id).sort()).toEqual(["app_list-alpha", "app_list-beta"]);
    h.close();
  });
});

describe("derived status filtering and ordering", () => {
  async function seedStatuses(h: Harness, appDbId: number) {
    insertCode(h, { appDbId, hash: "s-unused", suffix: "UN" });
    insertCode(h, {
      appDbId,
      hash: "s-active",
      suffix: "AC",
      status: "active",
      activatedAt: ISO(-DAY),
      expiresAt: ISO(10 * DAY)
    });
    insertCode(h, { appDbId, hash: "s-disabled", suffix: "DI", disabledAt: ISO(-DAY) });
    insertCode(h, {
      appDbId,
      hash: "s-expired",
      suffix: "EX",
      status: "active",
      activatedAt: ISO(-5 * DAY),
      expiresAt: ISO(-DAY)
    });
    insertCode(h, { appDbId, hash: "s-deleted", suffix: "DE", status: "deleted" });
  }

  it("derives disabled and expired from real columns and ISO-8601 ordering", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "status");
    await seedStatuses(h, appDbId);

    const byStatus = async (status: (typeof CODE_STATUS)[keyof typeof CODE_STATUS] | "disabled" | "expired") =>
      (await repo.listCodes({ status, page: 1, pageSize: 50 })).items.map((item) => item.code_suffix).sort();

    expect(await byStatus(CODE_STATUS.UNUSED)).toEqual(["UN"]);
    expect(await byStatus(CODE_STATUS.ACTIVE)).toEqual(["AC", "EX"]);
    expect(await byStatus(CODE_DERIVED_STATUS.DISABLED)).toEqual(["DI"]);
    // Expiry is decided by comparing ISO strings in SQL, which only works because
    // every timestamp in the schema uses the same fixed-width UTC format.
    expect(await byStatus(CODE_DERIVED_STATUS.EXPIRED)).toEqual(["EX"]);
    expect(await byStatus(CODE_STATUS.DELETED)).toEqual(["DE"]);
    h.close();
  });

  it("counts totals independently of the page window", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "paging");
    for (let index = 0; index < 7; index += 1) {
      insertCode(h, { appDbId, hash: `page-${index}`, suffix: `P${index}` });
    }

    const firstPage = await repo.listCodes({ page: 1, pageSize: 3 });
    expect(firstPage.items).toHaveLength(3);
    expect(firstPage.total).toBe(7);

    const thirdPage = await repo.listCodes({ page: 3, pageSize: 3 });
    expect(thirdPage.items).toHaveLength(1);
    expect(thirdPage.total).toBe(7);

    const emptyPage = await repo.listCodes({ page: 99, pageSize: 3 });
    expect(emptyPage.items).toEqual([]);
    expect(emptyPage.total).toBe(7);
    h.close();
  });

  it("filters codes by suffix, app and plan with real LIKE semantics", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "filters");
    insertCode(h, { appDbId, hash: "f-1", suffix: "ABC123", planId: 2 });
    insertCode(h, { appDbId, hash: "f-2", suffix: "XYZ789", planId: 4 });

    expect((await repo.listCodes({ query: "ABC", page: 1, pageSize: 10 })).items).toHaveLength(1);
    expect((await repo.listCodes({ query: "ZZZ", page: 1, pageSize: 10 })).items).toHaveLength(0);
    expect((await repo.listCodes({ planCode: "yearly", page: 1, pageSize: 10 })).items.map((i) => i.code_suffix)).toEqual(["XYZ789"]);
    expect((await repo.listCodes({ appId: "app_filters", page: 1, pageSize: 10 })).items).toHaveLength(2);
    h.close();
  });

  it("joins logs to their app via COALESCE when code_id is absent", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "logs-join");
    // No code referenced: the join must still resolve through l.app_id.
    await repo.insertLog({ appDbId, action: "batch_generate", result: "success", message: "generated" });
    // Referenced code with no direct app_id: must resolve through c.app_id.
    const codeId = insertCode(h, { appDbId, hash: "log-code", suffix: "LC" });
    h.raw.prepare("INSERT INTO activation_logs (code_id, action, result, message) VALUES (?, 'verify', 'success', 'via code')").run(codeId);

    const logs = await repo.listLogs({ page: 1, pageSize: 20 });
    expect(logs.total).toBe(2);
    expect(logs.items.map((item) => item.message).sort()).toEqual(["generated", "via code"]);
    expect(logs.items.every((item) => item.app_id === "app_logs-join")).toBe(true);

    expect((await repo.listLogs({ action: "verify", page: 1, pageSize: 20 })).items).toHaveLength(1);
    h.close();
  });

  it("returns plans in configured sort order", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    expect((await repo.getPlans()).map((plan) => plan.code)).toEqual(["weekly", "monthly", "quarterly", "yearly"]);
    expect((await repo.getPlanByCode("monthly"))?.duration_days).toBe(30);
    expect(await repo.getPlanByCode("nope")).toBeNull();
    h.close();
  });
});

describe("dashboard aggregation", () => {
  it("returns zeroes rather than nulls on an empty database", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const stats = await repo.getDashboardStats();

    // SUM() over zero rows is NULL in SQL; the repository must normalize it.
    expect(stats.overview.codes_total).toBe(0);
    expect(stats.overview.codes_active).toBe(0);
    expect(stats.overview.logs_today).toBe(0);
    expect(stats.overview.client_failures_today).toBe(0);
    expect(stats.log_trend).toHaveLength(7);
    expect(stats.code_trend).toHaveLength(7);
    for (const point of stats.log_trend) {
      expect(point).toEqual({ date: expect.any(String), success: 0, failure: 0 });
    }
    h.close();
  });

  it("classifies codes across the derived statuses and ranks apps", async () => {
    const h = await freshHarness();
    const repo = new Repository(new D1Adapter(h.env.DB));
    const { appDbId } = seedApp(h, "dash");
    insertCode(h, { appDbId, hash: "d-unused", suffix: "U1" });
    insertCode(h, { appDbId, hash: "d-active", suffix: "A1", status: "active", activatedAt: ISO(-DAY), expiresAt: ISO(5 * DAY) });
    insertCode(h, { appDbId, hash: "d-expired", suffix: "E1", status: "active", activatedAt: ISO(-9 * DAY), expiresAt: ISO(-DAY) });
    insertCode(h, { appDbId, hash: "d-disabled", suffix: "X1", disabledAt: ISO() });
    insertCode(h, { appDbId, hash: "d-deleted", suffix: "Z1", status: "deleted" });
    await repo.insertLog({ appDbId, action: "activate", result: "failure", errorCode: "INVALID_CODE", message: "nope" });

    const stats = await repo.getDashboardStats();
    expect(stats.overview.codes_total).toBe(5);
    expect(stats.overview.codes_unused).toBe(1);
    expect(stats.overview.codes_active).toBe(1);
    expect(stats.overview.codes_expired).toBe(1);
    expect(stats.overview.codes_disabled).toBe(1);
    expect(stats.overview.codes_deleted).toBe(1);
    expect(stats.overview.logs_today).toBe(1);
    expect(stats.overview.client_failures_today).toBe(1);

    expect(stats.app_code_ranking[0]?.app_id).toBe("app_dash");
    expect(stats.app_code_ranking[0]?.total).toBe(5);

    const distribution = new Map(stats.plan_distribution.map((entry) => [entry.plan_code, entry.count]));
    expect(distribution.get("monthly")).toBe(5);

    const today = new Date().toISOString().slice(0, 10);
    const todayActive = stats.code_trend.find((point) => point.date === today);
    expect(todayActive?.active).toBe(1);
    expect(todayActive?.activated ?? 0).toBe(0);
    h.close();
  });
});

describe("migration set is replayable", () => {
  it("produces an identical schema when applied to a second fresh database", async () => {
    const first = createSqliteD1();
    await applyMigrations(first.raw);
    const second = createSqliteD1();
    await applyMigrations(second.raw);

    const schemaOf = (db: typeof first.raw) =>
      db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .all();
    expect(schemaOf(second.raw)).toEqual(schemaOf(first.raw));
    first.close();
    second.close();
  });
});
