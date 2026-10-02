import { CODE_DERIVED_STATUS, CODE_STATUS } from "./constants";
import { DbAdapter } from "./db/adapter";
import {
  AdminSessionRow,
  AdminUserRow,
  AppRow,
  AppStatus,
  CodeDetailRow,
  CodeListStatus,
  CodeStatus,
  DashboardStats,
  LogAction,
  LogResult,
  LicenseSessionRow,
  PlanRow
} from "./types";

type SqlValue = string | number | null;

export type CodeListFilters = {
  query?: string;
  appId?: string;
  planCode?: string;
  status?: CodeListStatus;
  page: number;
  pageSize: number;
};

export type LogListFilters = {
  query?: string;
  appId?: string;
  action?: string;
  page: number;
  pageSize: number;
};

export type AdminUserManagementRow = Pick<
  AdminUserRow,
  "id" | "username" | "user_role" | "must_change_password" | "session_epoch" | "created_at" | "updated_at"
>;

export type ActivationCodeInsertInput = {
  batchId: number;
  appDbId: number;
  planId: number;
  codeHash: string;
  codeSuffix: string;
  createdBy: number;
};

export class Repository {
  constructor(private readonly db: DbAdapter) {}

  async getPlans(): Promise<PlanRow[]> {
    const result = await this.db
      .prepare("SELECT id, code, name, duration_days, sort_order, session_limit, grace_period_seconds, heartbeat_interval_seconds, created_at FROM plans ORDER BY sort_order ASC")
      .all<PlanRow>();
    return result.results ?? [];
  }

  async getPlanByCode(code: string): Promise<PlanRow | null> {
    return await this.db
      .prepare("SELECT id, code, name, duration_days, sort_order, session_limit, grace_period_seconds, heartbeat_interval_seconds, created_at FROM plans WHERE code = ?")
      .bind(code)
      .first<PlanRow>();
  }

  async listApps(): Promise<Array<Omit<AppRow, "app_secret_hash">>> {
    const result = await this.db
      .prepare(
        "SELECT id, app_id, name, description, purchase_url, platform, status, created_at, updated_at FROM apps ORDER BY created_at DESC"
      )
      .all<Omit<AppRow, "app_secret_hash">>();
    return result.results ?? [];
  }

  async createApp(input: {
    appId: string;
    name: string;
    description?: string;
    purchaseUrl?: string;
    platform: string;
    status: AppStatus;
    appSecretHash: string;
  }): Promise<AppRow> {
    await this.db
      .prepare(
        `INSERT INTO apps (app_id, name, description, purchase_url, platform, status, app_secret_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.appId,
        input.name,
        input.description ?? null,
        input.purchaseUrl ?? null,
        input.platform,
        input.status,
        input.appSecretHash,
        new Date().toISOString()
      )
      .run();
    const app = await this.getAppByPublicId(input.appId);
    if (!app) {
      throw new Error("Failed to create app");
    }
    return app;
  }

  async updateAppStatus(appId: string, status: AppStatus): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE apps SET status = ?, updated_at = ? WHERE app_id = ?")
      .bind(status, new Date().toISOString(), appId)
      .run();
    return result.meta.changes === 1;
  }

  async updateApp(input: {
    appId: string;
    name: string;
    description?: string;
    purchaseUrl?: string;
    platform: string;
  }): Promise<AppRow | null> {
    const result = await this.db
      .prepare("UPDATE apps SET name = ?, description = ?, purchase_url = ?, platform = ?, updated_at = ? WHERE app_id = ?")
      .bind(input.name, input.description ?? null, input.purchaseUrl ?? null, input.platform, new Date().toISOString(), input.appId)
      .run();
    if (result.meta.changes !== 1) {
      return null;
    }
    return await this.getAppByPublicId(input.appId);
  }

  async updateAppSecretHash(appId: string, appSecretHash: string): Promise<AppRow | null> {
    const result = await this.db
      .prepare("UPDATE apps SET app_secret_hash = ?, updated_at = ? WHERE app_id = ?")
      .bind(appSecretHash, new Date().toISOString(), appId)
      .run();
    if (result.meta.changes !== 1) {
      return null;
    }
    return await this.getAppByPublicId(appId);
  }

  async deleteAppIfUnreferenced(appDbId: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM apps
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM activation_batches WHERE app_id = ?)
           AND NOT EXISTS (SELECT 1 FROM activation_codes WHERE app_id = ?)
           AND NOT EXISTS (SELECT 1 FROM activation_logs WHERE app_id = ?)`
      )
      .bind(appDbId, appDbId, appDbId, appDbId)
      .run();
    return result.meta.changes === 1;
  }

  async getAppByPublicId(appId: string): Promise<AppRow | null> {
    return await this.db
      .prepare(
        `SELECT a.id, a.app_id, a.name, a.description, a.purchase_url,
                a.platform, a.status, a.app_secret_hash, a.created_at, a.updated_at
         FROM apps a
         WHERE a.app_id = ?`
      )
      .bind(appId)
      .first<AppRow>();
  }

  async createBatch(input: {
    appDbId: number;
    planId: number;
    quantity: number;
    note?: string;
    createdBy: number;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO activation_batches (app_id, plan_id, quantity, note, created_by)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(input.appDbId, input.planId, input.quantity, input.note ?? null, input.createdBy)
      .run();
    return Number(result.meta.last_row_id);
  }

  async createActivationCode(input: {
    batchId: number;
    appDbId: number;
    planId: number;
    codeHash: string;
    codeSuffix: string;
    createdBy: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO activation_codes
           (batch_id, app_id, plan_id, code_hash, code_suffix, status, activated_at, expires_at, device_hash, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, 'unused', NULL, NULL, NULL, ?, ?)`
      )
      .bind(
        input.batchId,
        input.appDbId,
        input.planId,
        input.codeHash,
        input.codeSuffix,
        input.createdBy,
        new Date().toISOString()
      )
      .run();
  }

  async createActivationCodes(inputs: ActivationCodeInsertInput[]): Promise<void> {
    if (inputs.length === 0) {
      return;
    }
    const updatedAt = new Date().toISOString();
    const statement = buildActivationCodeInsertStatement(inputs);
    await this.db.prepare(statement.sql).bind(...statement.bindings).run();
  }

  async findCodeByHash(codeHash: string): Promise<CodeDetailRow | null> {
    return await this.db
      .prepare(
        `SELECT
           c.*,
           a.app_id AS app_public_id,
           a.name AS app_name,
           a.platform AS app_platform,
           a.status AS app_status,
           p.code AS plan_code,
           p.name AS plan_name,
           p.duration_days AS duration_days,
           p.session_limit AS session_limit,
           p.grace_period_seconds AS grace_period_seconds,
           p.heartbeat_interval_seconds AS heartbeat_interval_seconds
         FROM activation_codes c
         JOIN apps a ON a.id = c.app_id
         JOIN plans p ON p.id = c.plan_id
         WHERE c.code_hash = ?`
      )
      .bind(codeHash)
      .first<CodeDetailRow>();
  }

  async activateCode(input: {
    codeId: number;
    deviceHash: string;
    activatedAt: string;
    expiresAt: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE activation_codes
         SET status = 'active',
             activated_at = ?,
             expires_at = ?,
             device_hash = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'unused'
           AND disabled_at IS NULL
           AND activated_at IS NULL
           AND expires_at IS NULL
           AND device_hash IS NULL`
      )
      .bind(input.activatedAt, input.expiresAt, input.deviceHash, input.activatedAt, input.codeId)
      .run();
    return result.meta.changes === 1;
  }

  async bindUnboundDevice(input: {
    codeId: number;
    deviceHash: string;
    boundAt: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE activation_codes
         SET device_hash = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'active'
           AND disabled_at IS NULL
           AND device_hash IS NULL`
      )
      .bind(input.deviceHash, input.boundAt, input.codeId)
      .run();
    return result.meta.changes === 1;
  }

  async unbindDevice(input: {
    codeId: number;
    deviceHash: string;
    unboundAt: string;
    maxRebinds: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE activation_codes
         SET device_hash = NULL,
             rebind_count = rebind_count + 1,
             last_rebind_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'active'
           AND disabled_at IS NULL
           AND device_hash = ?
           AND rebind_count < ?`
      )
      .bind(input.unboundAt, input.unboundAt, input.codeId, input.deviceHash, input.maxRebinds)
      .run();
    return result.meta.changes === 1;
  }

  async manuallyUnbindDevice(input: { codeId: number; changedAt: string }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE activation_codes
         SET device_hash = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'active'
           AND disabled_at IS NULL
           AND device_hash IS NOT NULL
           AND (expires_at IS NULL OR expires_at > ?)`
      )
      .bind(input.changedAt, input.codeId, input.changedAt)
      .run();
    return result.meta.changes === 1;
  }

  async softDeleteCode(codeId: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE activation_codes SET status = 'deleted', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), codeId)
      .run();
    return result.meta.changes === 1;
  }

  async updateCodeDisabled(input: { codeId: number; disabled: boolean; changedAt: string }): Promise<boolean> {
    const disabledAt = input.disabled ? input.changedAt : null;
    const result = await this.db
      .prepare("UPDATE activation_codes SET disabled_at = ?, updated_at = ? WHERE id = ? AND status != 'deleted'")
      .bind(disabledAt, input.changedAt, input.codeId)
      .run();
    return result.meta.changes === 1;
  }

  async listCodes(filters: CodeListFilters): Promise<{ items: CodeListItem[]; total: number }> {
    const where: string[] = [];
    const bindings: SqlValue[] = [];

    if (filters.query) {
      where.push("(c.code_suffix LIKE ? OR a.app_id LIKE ? OR a.name LIKE ?)");
      const query = `%${filters.query}%`;
      bindings.push(query, query, query);
    }
    if (filters.appId) {
      where.push("a.app_id = ?");
      bindings.push(filters.appId);
    }
    if (filters.planCode) {
      where.push("p.code = ?");
      bindings.push(filters.planCode);
    }
    if (filters.status === CODE_DERIVED_STATUS.DISABLED) {
      where.push("c.disabled_at IS NOT NULL AND c.status != 'deleted'");
    } else if (filters.status === CODE_DERIVED_STATUS.EXPIRED) {
      where.push("c.status = 'active' AND c.disabled_at IS NULL AND c.expires_at IS NOT NULL AND c.expires_at <= ?");
      bindings.push(new Date().toISOString());
    } else if (filters.status === CODE_STATUS.UNUSED || filters.status === CODE_STATUS.ACTIVE) {
      where.push("c.status = ? AND c.disabled_at IS NULL");
      bindings.push(filters.status);
    } else if (filters.status) {
      where.push("c.status = ?");
      bindings.push(filters.status);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const baseFrom = `
      FROM activation_codes c
      JOIN apps a ON a.id = c.app_id
      JOIN plans p ON p.id = c.plan_id
      LEFT JOIN activation_batches b ON b.id = c.batch_id
      ${whereSql}
    `;
    const offset = (filters.page - 1) * filters.pageSize;
    const [count, result] = await Promise.all([
      this.db
        .prepare(`SELECT COUNT(*) AS total ${baseFrom}`)
        .bind(...bindings)
        .first<{ total: number }>(),
      this.db
        .prepare(
          `SELECT
             c.id,
             c.code_suffix,
             c.status,
             c.disabled_at,
             c.activated_at,
             c.expires_at,
             c.device_hash,
             c.rebind_count,
             c.last_rebind_at,
             c.hold_at,
             c.hold_reason_code,
             c.max_activations,
             c.created_at,
             a.app_id,
             a.name AS app_name,
             a.platform AS app_platform,
             p.code AS plan_code,
             p.name AS plan_name,
             p.duration_days,
             b.id AS batch_id,
             b.note AS batch_note
           ${baseFrom}
           ORDER BY c.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(...bindings, filters.pageSize, offset)
        .all<CodeListItem>()
    ]);
    return {
      items: result.results ?? [],
      total: count?.total ?? 0
    };
  }

  async listLogs(filters: LogListFilters): Promise<{ items: LogListItem[]; total: number }> {
    const where: string[] = [];
    const bindings: SqlValue[] = [];

    if (filters.query) {
      where.push("(c.code_suffix LIKE ? OR l.error_code LIKE ? OR l.message LIKE ?)");
      const query = `%${filters.query}%`;
      bindings.push(query, query, query);
    }
    if (filters.appId) {
      where.push("a.app_id = ?");
      bindings.push(filters.appId);
    }
    if (filters.action) {
      where.push("l.action = ?");
      bindings.push(filters.action);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const baseFrom = `
      FROM activation_logs l
      LEFT JOIN activation_codes c ON c.id = l.code_id
      LEFT JOIN apps a ON a.id = COALESCE(l.app_id, c.app_id)
      ${whereSql}
    `;
    const offset = (filters.page - 1) * filters.pageSize;
    const [count, result] = await Promise.all([
      this.db
        .prepare(`SELECT COUNT(*) AS total ${baseFrom}`)
        .bind(...bindings)
        .first<{ total: number }>(),
      this.db
        .prepare(
          `SELECT
             l.id,
             l.action,
             l.result,
             l.device_hash,
             l.error_code,
             l.message,
             l.created_at,
             c.code_suffix,
             a.app_id,
             a.name AS app_name
           ${baseFrom}
           ORDER BY l.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(...bindings, filters.pageSize, offset)
        .all<LogListItem>()
    ]);
    return {
      items: result.results ?? [],
      total: count?.total ?? 0
    };
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const trendStart = startOfUtcDayOffset(-6);
    const trendDates = buildLastSevenDates();
    const activeTrendStatement = buildDashboardActiveTrendStatement(trendDates);

    const [
      appOverview,
      codeOverview,
      logOverview,
      appRankingResult,
      planDistributionResult,
      trendResult,
      activatedTrendResult,
      expiredTrendResult,
      activeTrendResult
    ] = await Promise.all([
      this.db
        .prepare(
          `SELECT
             COUNT(*) AS apps_total,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS apps_active
           FROM apps`
        )
        .first<{ apps_total: number; apps_active: number | null }>(),
      this.db
        .prepare(
          `SELECT
             COUNT(*) AS codes_total,
             SUM(CASE WHEN c.status = 'unused' AND c.disabled_at IS NULL THEN 1 ELSE 0 END) AS codes_unused,
             SUM(CASE WHEN c.status = 'active' AND c.disabled_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?) THEN 1 ELSE 0 END) AS codes_active,
             SUM(CASE WHEN c.status != 'deleted' AND c.disabled_at IS NOT NULL THEN 1 ELSE 0 END) AS codes_disabled,
             SUM(CASE WHEN c.status = 'active' AND c.disabled_at IS NULL AND c.expires_at IS NOT NULL AND c.expires_at <= ? THEN 1 ELSE 0 END) AS codes_expired,
             SUM(CASE WHEN c.status = 'deleted' THEN 1 ELSE 0 END) AS codes_deleted
           FROM activation_codes c
           JOIN apps a ON a.id = c.app_id`
        )
        .bind(now, now)
        .first<{
          codes_total: number;
          codes_unused: number | null;
          codes_active: number | null;
          codes_disabled: number | null;
          codes_expired: number | null;
          codes_deleted: number | null;
        }>(),
      this.db
        .prepare(
          `SELECT
             COUNT(*) AS logs_today,
             SUM(CASE WHEN result = 'failure' AND action IN ('activate', 'verify', 'unbind_device') THEN 1 ELSE 0 END) AS client_failures_today
           FROM activation_logs l
           LEFT JOIN activation_codes c ON c.id = l.code_id
           JOIN apps a ON a.id = COALESCE(l.app_id, c.app_id)
           WHERE substr(l.created_at, 1, 10) = ?`
        )
        .bind(today)
        .first<{ logs_today: number; client_failures_today: number | null }>(),
      this.db
        .prepare(
          `SELECT
             a.app_id,
             a.name AS app_name,
             a.platform,
             COUNT(c.id) AS total,
             SUM(CASE WHEN c.status = 'active' AND c.disabled_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?) THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN c.status = 'unused' AND c.disabled_at IS NULL THEN 1 ELSE 0 END) AS unused,
             SUM(CASE WHEN c.status != 'deleted' AND c.disabled_at IS NOT NULL THEN 1 ELSE 0 END) AS disabled,
             SUM(CASE WHEN c.status = 'active' AND c.disabled_at IS NULL AND c.expires_at IS NOT NULL AND c.expires_at <= ? THEN 1 ELSE 0 END) AS expired,
             SUM(CASE WHEN c.status = 'deleted' THEN 1 ELSE 0 END) AS deleted
           FROM apps a
           LEFT JOIN activation_codes c ON c.app_id = a.id
           GROUP BY a.id
           ORDER BY total DESC, a.created_at DESC
           LIMIT 8`
        )
        .bind(now, now)
        .all<DashboardStats["app_code_ranking"][number]>(),
      this.db
        .prepare(
          `SELECT
             p.code AS plan_code,
             p.name AS plan_name,
             COUNT(c.id) AS count
           FROM plans p
           LEFT JOIN activation_codes c ON c.plan_id = p.id
           GROUP BY p.id
           ORDER BY count DESC, p.sort_order ASC`
        )
        .all<DashboardStats["plan_distribution"][number]>(),
      this.db
        .prepare(
          `SELECT
             substr(l.created_at, 1, 10) AS date,
             SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN result = 'failure' THEN 1 ELSE 0 END) AS failure
           FROM activation_logs l
           LEFT JOIN activation_codes c ON c.id = l.code_id
           JOIN apps a ON a.id = COALESCE(l.app_id, c.app_id)
           WHERE l.created_at >= ?
           GROUP BY substr(l.created_at, 1, 10)
           ORDER BY date ASC`
        )
        .bind(trendStart)
        .all<{ date: string; success: number | null; failure: number | null }>(),
      this.db
        .prepare(
          `SELECT
             substr(activated_at, 1, 10) AS date,
             COUNT(*) AS activated
           FROM activation_codes
           WHERE activation_codes.status != 'deleted'
             AND activation_codes.activated_at IS NOT NULL
             AND activation_codes.activated_at >= ?
           GROUP BY substr(activation_codes.activated_at, 1, 10)
           ORDER BY date ASC`
        )
        .bind(trendStart)
        .all<{ date: string; activated: number }>(),
      this.db
        .prepare(
          `SELECT
             substr(expires_at, 1, 10) AS date,
             COUNT(*) AS expired
           FROM activation_codes
           WHERE activation_codes.status = 'active'
             AND activation_codes.disabled_at IS NULL
             AND activation_codes.expires_at IS NOT NULL
             AND activation_codes.expires_at >= ?
             AND activation_codes.expires_at < ?
           GROUP BY substr(activation_codes.expires_at, 1, 10)
           ORDER BY date ASC`
        )
        .bind(trendStart, nextUtcDate(trendDates[trendDates.length - 1]))
        .all<{ date: string; expired: number }>(),
      this.db
        .prepare(activeTrendStatement.sql)
        .bind(...activeTrendStatement.bindings)
        .all<{ date: string; active: number }>()
    ]);

    const overview = {
      apps_total: appOverview?.apps_total ?? 0,
      apps_active: appOverview?.apps_active ?? 0,
      codes_total: codeOverview?.codes_total ?? 0,
      codes_unused: codeOverview?.codes_unused ?? 0,
      codes_active: codeOverview?.codes_active ?? 0,
      codes_disabled: codeOverview?.codes_disabled ?? 0,
      codes_expired: codeOverview?.codes_expired ?? 0,
      codes_deleted: codeOverview?.codes_deleted ?? 0,
      logs_today: logOverview?.logs_today ?? 0,
      client_failures_today: logOverview?.client_failures_today ?? 0
    };
    const trendByDate = new Map((trendResult.results ?? []).map((item) => [item.date, item]));
    const activatedTrendByDate = new Map((activatedTrendResult.results ?? []).map((item) => [item.date, item.activated]));
    const expiredTrendByDate = new Map((expiredTrendResult.results ?? []).map((item) => [item.date, item.expired]));
    const activeTrendByDate = new Map((activeTrendResult.results ?? []).map((item) => [item.date, item.active]));

    return {
      overview,
      code_status: [
        { status: CODE_STATUS.UNUSED, count: overview.codes_unused },
        { status: CODE_STATUS.ACTIVE, count: overview.codes_active },
        { status: CODE_DERIVED_STATUS.DISABLED, count: overview.codes_disabled },
        { status: CODE_DERIVED_STATUS.EXPIRED, count: overview.codes_expired },
        { status: CODE_STATUS.DELETED, count: overview.codes_deleted }
      ],
      app_code_ranking: normalizeNullableNumbers(appRankingResult.results ?? []),
      plan_distribution: normalizeNullableNumbers(planDistributionResult.results ?? []),
      log_trend: trendDates.map((date) => ({
        date,
        success: trendByDate.get(date)?.success ?? 0,
        failure: trendByDate.get(date)?.failure ?? 0
      })),
      code_trend: trendDates.map((date) => ({
        date,
        activated: activatedTrendByDate.get(date) ?? 0,
        expired: expiredTrendByDate.get(date) ?? 0,
        active: activeTrendByDate.get(date) ?? 0
      }))
    };
  }

  async createOrReuseSession(input: {
    tokenHash: string;
    codeId: number;
    appDbId: number;
    deviceHash: string;
    now: string;
    leaseExpiresAt: string;
    sessionLimit: number;
  }): Promise<LicenseSessionRow | null> {
    const existing = await this.db.prepare("SELECT * FROM license_sessions WHERE session_token_hash = ?").bind(input.tokenHash).first<LicenseSessionRow>();
    if (existing) {
      if (existing.status === "active") {
        await this.db.prepare("UPDATE license_sessions SET last_seen_at = ?, lease_expires_at = ? WHERE id = ? AND status = 'active'").bind(input.now, input.leaseExpiresAt, existing.id).run();
        return await this.db.prepare("SELECT * FROM license_sessions WHERE id = ?").bind(existing.id).first<LicenseSessionRow>();
      }
      // The token is derived deterministically from the code and device, so a
      // previously kicked or expired row keeps the same session_token_hash.
      // Reusing that row is the only non-conflicting option; inserting a second
      // row would violate the UNIQUE constraint on session_token_hash.
      await this.db.prepare(
        `UPDATE license_sessions SET status = 'active', device_hash = ?, last_seen_at = ?, lease_expires_at = ?, kicked_at = NULL
         WHERE id = ?`
      ).bind(input.deviceHash, input.now, input.leaseExpiresAt, existing.id).run();
      return await this.db.prepare("SELECT * FROM license_sessions WHERE id = ?").bind(existing.id).first<LicenseSessionRow>();
    }
    const active = await this.db.prepare("SELECT COUNT(*) AS count FROM license_sessions WHERE code_id = ? AND status = 'active' AND lease_expires_at > ?").bind(input.codeId, input.now).first<{ count: number }>();
    if ((active?.count ?? 0) >= input.sessionLimit) {
      const sameDevice = await this.db.prepare("SELECT * FROM license_sessions WHERE code_id = ? AND device_hash = ? AND status = 'active' AND lease_expires_at > ? ORDER BY id DESC LIMIT 1").bind(input.codeId, input.deviceHash, input.now).first<LicenseSessionRow>();
      return sameDevice ?? null;
    }
    await this.db.prepare(
      `INSERT INTO license_sessions (session_token_hash, code_id, app_id, device_hash, status, started_at, last_seen_at, lease_expires_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
    ).bind(input.tokenHash, input.codeId, input.appDbId, input.deviceHash, input.now, input.now, input.leaseExpiresAt).run();
    return await this.db.prepare("SELECT * FROM license_sessions WHERE session_token_hash = ?").bind(input.tokenHash).first<LicenseSessionRow>();
  }

  async getSessionByTokenHash(tokenHash: string): Promise<LicenseSessionRow | null> {
    return await this.db.prepare(
      `SELECT s.*, c.code_suffix, a.app_id AS app_public_id, a.name AS app_name
       FROM license_sessions s JOIN activation_codes c ON c.id = s.code_id JOIN apps a ON a.id = s.app_id
       WHERE s.session_token_hash = ?`
    ).bind(tokenHash).first<LicenseSessionRow>();
  }

  async heartbeatSession(input: { sessionId: number; now: string; leaseExpiresAt: string }): Promise<boolean> {
    const result = await this.db.prepare("UPDATE license_sessions SET last_seen_at = ?, lease_expires_at = ? WHERE id = ? AND status = 'active' AND lease_expires_at > ?").bind(input.now, input.leaseExpiresAt, input.sessionId, input.now).run();
    return result.meta.changes === 1;
  }

  async getActiveSessionForDevice(codeId: number, deviceHash: string): Promise<LicenseSessionRow | null> {
    return await this.db.prepare("SELECT * FROM license_sessions WHERE code_id = ? AND device_hash = ? AND status = 'active' AND lease_expires_at > ? ORDER BY id DESC LIMIT 1").bind(codeId, deviceHash, new Date().toISOString()).first<LicenseSessionRow>();
  }

  async terminateSessionsForCode(codeId: number, at: string): Promise<void> {
    await this.db.prepare("UPDATE license_sessions SET status = 'expired', lease_expires_at = ? WHERE code_id = ? AND status = 'active'").bind(at, codeId).run();
  }

  async renewCode(input: { codeId: number; deviceHash: string; expiresAt: string; now: string }): Promise<boolean> {
    const result = await this.db.prepare(
      "UPDATE activation_codes SET expires_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND disabled_at IS NULL AND device_hash = ? AND activated_at IS NOT NULL"
    ).bind(input.expiresAt, input.now, input.codeId, input.deviceHash).run();
    return result.meta.changes === 1;
  }

  async listSessions(): Promise<LicenseSessionRow[]> {
    const result = await this.db.prepare(
      `SELECT s.id, s.session_token_hash, s.code_id, s.app_id, s.device_hash, s.status, s.started_at, s.last_seen_at,
              s.lease_expires_at, s.kicked_at, s.created_at, c.code_suffix, a.app_id AS app_public_id, a.name AS app_name
       FROM license_sessions s JOIN activation_codes c ON c.id = s.code_id JOIN apps a ON a.id = s.app_id
       WHERE s.status = 'active' AND s.lease_expires_at > ? ORDER BY s.last_seen_at DESC`
    ).bind(new Date().toISOString()).all<LicenseSessionRow>();
    return result.results ?? [];
  }

  async kickSession(sessionId: number, kickedAt: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE license_sessions SET status = 'kicked', kicked_at = ?, lease_expires_at = ?
       WHERE id = ? AND status = 'active'`
    ).bind(kickedAt, kickedAt, sessionId).run();
    return result.meta.changes === 1;
  }

  async insertLog(input: {
    codeId?: number;
    appDbId?: number;
    action: LogAction;
    result: LogResult;
    deviceHash?: string;
    errorCode?: string;
    message?: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO activation_logs (code_id, app_id, action, result, device_hash, error_code, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.codeId ?? null,
        input.appDbId ?? null,
        input.action,
        input.result,
        input.deviceHash ?? null,
        input.errorCode ?? null,
        input.message ?? null
      )
      .run();
  }

  async getAdminByUsername(username: string) {
    return await this.db
      .prepare(
        `SELECT u.id, u.username, u.password_hash, u.password_salt,
                u.must_change_password, u.session_epoch, u.user_role, u.created_at, u.updated_at
         FROM admin_users u
         WHERE u.username = ?`
      )
      .bind(username)
      .first<AdminUserRow>();
  }

  async getAdminById(id: number) {
    return await this.db
      .prepare(
        `SELECT u.id, u.username, u.password_hash, u.password_salt,
                u.must_change_password, u.session_epoch, u.user_role, u.created_at, u.updated_at
         FROM admin_users u
         WHERE u.id = ?`
      )
      .bind(id)
      .first<AdminUserRow>();
  }

  async getAdminCredentialsById(id: number) {
    return await this.db
      .prepare(
        `SELECT u.id, u.username, u.password_hash, u.password_salt,
                u.must_change_password, u.session_epoch, u.user_role, u.created_at, u.updated_at
         FROM admin_users u
         WHERE u.id = ?`
      )
      .bind(id)
      .first<AdminUserRow>();
  }

  async createAdmin(input: {
    username: string;
    passwordHash: string;
    passwordSalt: string;
    mustChangePassword?: boolean;
    userRole?: AdminUserRow["user_role"];
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO admin_users (username, password_hash, password_salt, must_change_password, user_role, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.username,
        input.passwordHash,
        input.passwordSalt,
        input.mustChangePassword ? 1 : 0,
        input.userRole ?? "admin",
        new Date().toISOString()
      )
      .run();
    return result.meta.last_row_id;
  }

  async updateAdminPassword(input: { adminId: number; passwordHash: string; passwordSalt: string; clearMustChange?: boolean }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `UPDATE admin_users
         SET password_hash = ?,
             password_salt = ?,
             password_changed_at = ?,
             must_change_password = CASE WHEN ? = 1 THEN 0 ELSE must_change_password END,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(
        input.passwordHash,
        input.passwordSalt,
        now,
        input.clearMustChange ? 1 : 0,
        now,
        input.adminId
      )
      .run();
    return result.meta.changes === 1;
  }

  async setMustChangePassword(input: { adminId: number; required: boolean }): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE admin_users SET must_change_password = ?, updated_at = ? WHERE id = ?")
      .bind(input.required ? 1 : 0, new Date().toISOString(), input.adminId)
      .run();
    return result.meta.changes === 1;
  }

  // --- Global settings (key/value store, migration 0009) -------------------
  // The master-password hash + salt live here (AC-B9). This is the ONLY place
  // settings SQL exists; service/routes read and write through these two.

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row ? row.value : null;
  }

  async upsertSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(key, value, new Date().toISOString())
      .run();
  }

  // --- User management (admin/staff) ---------------------------------------
  // All bound SQL, global. Enforcement of role gates lives in middleware/
  // service; the repository only persists.

  async listUsers(): Promise<AdminUserManagementRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, username, user_role, must_change_password, session_epoch, created_at, updated_at
         FROM admin_users
         ORDER BY created_at ASC`
      )
      .all<AdminUserManagementRow>();
    return result.results ?? [];
  }

  async getUserById(id: number): Promise<AdminUserManagementRow | null> {
    return await this.db
      .prepare(
        `SELECT id, username, user_role, must_change_password, session_epoch, created_at, updated_at
         FROM admin_users
         WHERE id = ?`
      )
      .bind(id)
      .first<AdminUserManagementRow>();
  }

  async createUser(input: {
    username: string;
    passwordHash: string;
    passwordSalt: string;
    userRole: AdminUserRow["user_role"];
  }): Promise<number> {
    // The management role (admin / staff) lives in user_role, the sole role axis.
    return await this.createAdmin({
      username: input.username,
      passwordHash: input.passwordHash,
      passwordSalt: input.passwordSalt,
      userRole: input.userRole,
      mustChangePassword: true
    });
  }

  async resetUserPassword(input: {
    adminId: number;
    passwordHash: string;
    passwordSalt: string;
    forceChange: boolean;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `UPDATE admin_users
         SET password_hash = ?,
             password_salt = ?,
             password_changed_at = ?,
             must_change_password = ?,
             session_epoch = session_epoch + 1,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(input.passwordHash, input.passwordSalt, now, input.forceChange ? 1 : 0, now, input.adminId)
      .run();
    return result.meta.changes === 1;
  }

  async incrementSessionEpoch(input: { adminId: number }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE admin_users
         SET session_epoch = session_epoch + 1, updated_at = ?
         WHERE id = ?`
      )
      .bind(new Date().toISOString(), input.adminId)
      .run();
    return result.meta.changes === 1;
  }

  async setUserRole(input: { adminId: number; userRole: AdminUserRow["user_role"] }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE admin_users
         SET user_role = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(input.userRole, new Date().toISOString(), input.adminId)
      .run();
    return result.meta.changes === 1;
  }

  async insertAdminSession(input: {
    adminId: number;
    epoch: number;
    issuedAt: string;
    expiresAt: string;
    userAgent?: string | null;
    jti?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO admin_sessions (admin_id, epoch, jti, issued_at, expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.adminId,
        input.epoch,
        input.jti ?? null,
        input.issuedAt,
        input.expiresAt,
        input.userAgent ?? null
      )
      .run();
  }

  async revokeAdminSessions(input: { adminId: number }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE admin_sessions
         SET revoked_at = ?
         WHERE admin_id = ? AND revoked_at IS NULL`
      )
      .bind(new Date().toISOString(), input.adminId)
      .run();
    return result.meta.changes;
  }

  async listAdminSessions(input: { adminId: number }): Promise<AdminSessionRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, admin_id, epoch, jti, issued_at, expires_at, last_seen_at, revoked_at, user_agent, created_at
         FROM admin_sessions
         WHERE admin_id = ?
         ORDER BY issued_at DESC`
      )
      .bind(input.adminId)
      .all<AdminSessionRow>();
    return result.results ?? [];
  }

  // --- Signed-license surface (FEAT-003) -----------------------------------
  // All bound SQL; takes only HMACs / allowlisted codes / ids. The service never
  // passes a raw installation_id, license key, secret, or key material here.

  async insertSecurityEvent(input: SecurityEventInsertInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO security_events
           (app_id, code_id, event_type, reason_code, installation_hash, protocol_version, key_id, result, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.appId ?? null,
        input.codeId ?? null,
        input.eventType,
        input.reasonCode ?? null,
        input.installationHash ?? null,
        input.protocolVersion ?? null,
        input.keyId ?? null,
        input.result,
        input.message ?? null
      )
      .run();
  }

  async listSecurityEvents(filters: SecurityEventListFilters): Promise<{ items: SecurityEventListItem[]; total: number }> {
    const where: string[] = [];
    const bindings: SqlValue[] = [];
    if (filters.codeId !== undefined) {
      where.push("e.code_id = ?");
      bindings.push(filters.codeId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    // The raw installation_hash is never surfaced; a has_installation boolean
    // replaces it.
    const baseFrom = `
      FROM security_events e
      JOIN apps a ON a.id = e.app_id
      ${whereSql}
    `;
    const offset = (filters.page - 1) * filters.pageSize;
    const [count, result] = await Promise.all([
      this.db
        .prepare(`SELECT COUNT(*) AS total ${baseFrom}`)
        .bind(...bindings)
        .first<{ total: number }>(),
      this.db
        .prepare(
          `SELECT
             e.id,
             e.code_id,
             e.event_type,
             e.reason_code,
             CASE WHEN e.installation_hash IS NOT NULL THEN 1 ELSE 0 END AS has_installation,
             e.protocol_version,
             e.key_id,
             e.result,
             e.message,
             e.created_at
           ${baseFrom}
           ORDER BY e.created_at DESC, e.id DESC
           LIMIT ? OFFSET ?`
        )
        .bind(...bindings, filters.pageSize, offset)
        .all<SecurityEventListItemRaw>()
    ]);
    const items: SecurityEventListItem[] = (result.results ?? []).map((row) => ({
      id: row.id,
      code_id: row.code_id,
      event_type: row.event_type,
      reason_code: row.reason_code,
      has_installation: row.has_installation === 1,
      protocol_version: row.protocol_version,
      key_id: row.key_id,
      result: row.result,
      message: row.message,
      created_at: row.created_at
    }));
    return { items, total: count?.total ?? 0 };
  }

  async countDistinctInstallationReports(codeId: number, reasonCodes: string[], sinceIso: string): Promise<number> {
    if (reasonCodes.length === 0) {
      return 0;
    }
    const placeholders = reasonCodes.map(() => "?").join(", ");
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT installation_hash) AS count
         FROM security_events
         WHERE code_id = ?
           AND event_type = 'REPORT'
           AND reason_code IN (${placeholders})
           AND installation_hash IS NOT NULL
           AND created_at >= ?`
      )
      .bind(codeId, ...reasonCodes, sinceIso)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  /**
   * Atomic activation-slot claim (design §5.4). The `WHERE (count) < max`
   * predicate and the INSERT are a single statement, so two distinct
   * installations racing cannot both pass the bound; the ON CONFLICT branch lets
   * an already-claimed installation idempotently refresh (and un-release) its
   * slot regardless of the count. `activation_allowed` is decided by the
   * confirming SELECT, not by dialect-specific `changes` semantics.
   */
  async claimActivationSlot(input: {
    codeId: number;
    installationHash: string;
    maxActivations: number;
    now: string;
  }): Promise<boolean> {
    await this.db
      .prepare(
        `INSERT INTO code_activations (code_id, installation_hash, status, activated_at, last_seen_at)
         SELECT ?1, ?2, 'active', ?3, ?3
         WHERE (
           SELECT COUNT(*) FROM code_activations
           WHERE code_id = ?1 AND status = 'active'
         ) < ?4
         ON CONFLICT(code_id, installation_hash) DO UPDATE
           SET last_seen_at = excluded.last_seen_at,
               status       = 'active',
               released_at  = NULL`
      )
      .bind(input.codeId, input.installationHash, input.now, input.maxActivations)
      .run();
    const row = await this.db
      .prepare(
        `SELECT id FROM code_activations
         WHERE code_id = ? AND installation_hash = ? AND status = 'active'`
      )
      .bind(input.codeId, input.installationHash)
      .first<{ id: number }>();
    return row !== null;
  }

  async countActiveActivationSlots(codeId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM code_activations WHERE code_id = ? AND status = 'active'")
      .bind(codeId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async listCodeActivations(codeId: number): Promise<CodeActivationListItem[]> {
    const result = await this.db
      .prepare(
        `SELECT
           ca.id,
           ca.status,
           ca.activated_at,
           ca.last_seen_at,
           ca.released_at,
           ca.created_at
         FROM code_activations ca
         WHERE ca.code_id = ?
         ORDER BY ca.id ASC`
      )
      .bind(codeId)
      .all<CodeActivationListItem>();
    return result.results ?? [];
  }

  async holdCode(input: { codeId: number; reasonCode: string; at: string }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE activation_codes
         SET hold_at = ?, hold_reason_code = ?, updated_at = ?
         WHERE id = ?
           AND status != 'deleted'
           AND hold_at IS NULL`
      )
      .bind(input.at, input.reasonCode, input.at, input.codeId)
      .run();
    return result.meta.changes === 1;
  }

  async approveCode(input: { codeId: number; at: string }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE activation_codes
         SET hold_at = NULL, hold_reason_code = NULL, updated_at = ?
         WHERE id = ?
           AND status != 'deleted'
           AND hold_at IS NOT NULL`
      )
      .bind(input.at, input.codeId)
      .run();
    return result.meta.changes === 1;
  }

  async setCodeExpiry(input: { codeId: number; expiresAt: string; now: string }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE activation_codes
         SET expires_at = ?, updated_at = ?
         WHERE id = ?
           AND status = 'active'
           AND activated_at IS NOT NULL`
      )
      .bind(input.expiresAt, input.now, input.codeId)
      .run();
    return result.meta.changes === 1;
  }

  async setMaxActivations(input: { codeId: number; value: number | null; now: string }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE activation_codes
         SET max_activations = ?, updated_at = ?
         WHERE id = ?
           AND status != 'deleted'`
      )
      .bind(input.value, input.now, input.codeId)
      .run();
    return result.meta.changes === 1;
  }

  async findCodeById(codeId: number): Promise<CodeDetailRow | null> {
    return await this.db
      .prepare(
        `SELECT
           c.*,
           a.app_id AS app_public_id,
           a.name AS app_name,
           a.platform AS app_platform,
           a.status AS app_status,
           p.code AS plan_code,
           p.name AS plan_name,
           p.duration_days AS duration_days,
           p.session_limit AS session_limit,
           p.grace_period_seconds AS grace_period_seconds,
           p.heartbeat_interval_seconds AS heartbeat_interval_seconds
         FROM activation_codes c
         JOIN apps a ON a.id = c.app_id
         JOIN plans p ON p.id = c.plan_id
         WHERE c.id = ?`
      )
      .bind(codeId)
      .first<CodeDetailRow>();
  }
}

export type SecurityEventInsertInput = {
  appId?: number | null;
  codeId?: number | null;
  eventType: string;
  reasonCode?: string | null;
  installationHash?: string | null;
  protocolVersion?: number | null;
  keyId?: string | null;
  result: LogResult;
  message?: string | null;
};

export type SecurityEventListFilters = {
  codeId?: number;
  page: number;
  pageSize: number;
};

type SecurityEventListItemRaw = {
  id: number;
  code_id: number | null;
  event_type: string;
  reason_code: string | null;
  has_installation: number;
  protocol_version: number | null;
  key_id: string | null;
  result: LogResult;
  message: string | null;
  created_at: string;
};

export type SecurityEventListItem = {
  id: number;
  code_id: number | null;
  event_type: string;
  reason_code: string | null;
  has_installation: boolean;
  protocol_version: number | null;
  key_id: string | null;
  result: LogResult;
  message: string | null;
  created_at: string;
};

export type CodeActivationListItem = {
  id: number;
  status: "active" | "released";
  activated_at: string;
  last_seen_at: string;
  released_at: string | null;
  created_at: string;
};

export type CodeListItem = {
  id: number;
  code_suffix: string;
  status: CodeStatus;
  disabled_at: string | null;
  activated_at: string | null;
  expires_at: string | null;
  device_hash: string | null;
  rebind_count: number;
  last_rebind_at: string | null;
  hold_at: string | null;
  hold_reason_code: string | null;
  max_activations: number | null;
  created_at: string;
  app_id: string;
  app_name: string;
  app_platform: string;
  plan_code: string;
  plan_name: string;
  duration_days: number;
  batch_id: number | null;
  batch_note: string | null;
};

export type LogListItem = {
  id: number;
  action: LogAction;
  result: LogResult;
  device_hash: string | null;
  error_code: string | null;
  message: string | null;
  created_at: string;
  code_suffix: string | null;
  app_id: string | null;
  app_name: string | null;
};

function startOfUtcDayOffset(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function buildLastSevenDates(): string[] {
  return Array.from({ length: 7 }, (_, index) => startOfUtcDayOffset(index - 6).slice(0, 10));
}

function nextUtcDate(date: string): string {
  const nextDate = new Date(`${date}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return nextDate.toISOString().slice(0, 10);
}

function normalizeNullableNumbers<T extends Record<string, unknown>>(items: T[]): T[] {
  return items.map((item) => {
    const normalized = { ...item };
    for (const [key, value] of Object.entries(normalized)) {
      if (value === null) {
        normalized[key as keyof T] = 0 as T[keyof T];
      }
    }
    return normalized;
  });
}

export function buildDashboardActiveTrendStatement(dates: string[]): {
  sql: string;
  bindings: SqlValue[];
} {
  const dateRows = dates.map(() => "(?, ?)").join(", ");
  return {
    sql: `WITH trend_dates(date, next_date) AS (VALUES ${dateRows})
      SELECT
        d.date,
        COUNT(c.id) AS active
      FROM trend_dates d
      LEFT JOIN activation_codes c
        ON c.status = 'active'
       AND c.disabled_at IS NULL
       AND c.activated_at IS NOT NULL
       AND c.activated_at < d.next_date
       AND (c.expires_at IS NULL OR c.expires_at >= d.next_date)
      GROUP BY d.date
      ORDER BY d.date ASC`,
    bindings: [...dates.flatMap((date) => [date, nextUtcDate(date)])]
  };
}

export function buildActivationCodeInsertStatement(
  inputs: ActivationCodeInsertInput[],
  updatedAt = new Date().toISOString()
): {
  sql: string;
  bindings: SqlValue[];
} {
  const rows = inputs.map(() => "(?, ?, ?, ?, ?, 'unused', NULL, NULL, NULL, ?, ?)").join(", ");
  return {
    sql: `INSERT INTO activation_codes
       (batch_id, app_id, plan_id, code_hash, code_suffix, status, activated_at, expires_at, device_hash, created_by, updated_at)
     VALUES ${rows}`,
    bindings: inputs.flatMap((input) => [
      input.batchId,
      input.appDbId,
      input.planId,
      input.codeHash,
      input.codeSuffix,
      input.createdBy,
      updatedAt
    ])
  };
}
