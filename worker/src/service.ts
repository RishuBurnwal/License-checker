import { addDaysIso, addMonthsIso, addYearsIso, isExpired, nowIso, secondsUntil } from "./time";
import { PLACEHOLDER_MASTER_PASSWORD, normalizeOptionalEnv, requireEnv } from "./config";
import {
  APP_STATUS,
  CODE_BULK_ACTION,
  CODE_STATUS,
  HOLD_REASON_CODE,
  LOG_ACTION,
  LOG_RESULT,
  SECURITY_EVENT_TYPE,
  SECURITY_REASON_CODE,
  USER_ROLE,
  isSecurityReasonCode,
  isUserRole,
  type AppStatus,
  type CodeBulkAction,
  type LogAction,
  type SecurityReasonCode,
  type UserRole
} from "./constants";
import { codeSuffix, generateActivationCode, generateRandomToken, hashPassword, hmacSha256, normalizeCode, timingSafeEqual, verifyPassword } from "./crypto";
import { Repository } from "./repository";
import { ApiError, AppRow, Bindings, CodeDetailRow } from "./types";
import { canonicalize, type LicensePayload } from "./license/canonical";
import { getLicensingConfig } from "./license/config";
import { signPayload } from "./license/signing";
import { deriveSignedStatus, SIGNED_STATUS_NOT_ACTIVATABLE } from "./license/status";

// Max printable length for a client-supplied installation_id (design §3.1, SL-23).
const MAX_INSTALLATION_ID_LENGTH = 200;
// High-severity report reason codes that count toward corroborated auto-hold (§6.3).
const HIGH_SEVERITY_REPORT_REASONS: SecurityReasonCode[] = [
  SECURITY_REASON_CODE.SIGNATURE_INVALID,
  SECURITY_REASON_CODE.PAYLOAD_TAMPERED,
  SECURITY_REASON_CODE.CLOCK_ROLLBACK
];

export const MAX_REBINDS = 3;
export const REBIND_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const READ_ONLY_ADMIN_USERNAME = "test";

// Settings rows that hold the single global admin master password (AC-B9). The
// plaintext is never stored; the salt is NOT secret and MUST be persisted.
const MASTER_PASSWORD_HASH_KEY = "master_password_hash";
const MASTER_PASSWORD_SALT_KEY = "master_password_salt";

export class LicenseService {
  constructor(
    private readonly repo: Repository,
    private readonly env: Bindings
  ) {}

  async ensureBootstrapAdmin(): Promise<void> {
    const username = this.env.ADMIN_BOOTSTRAP_USERNAME;
    const password = this.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!username || !password) {
      return;
    }
    const existing = await this.repo.getAdminByUsername(username);
    if (existing) {
      return;
    }
    const passwordRecord = await hashPassword(password);
    await this.repo.createAdmin({
      username,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      userRole: "admin"
    });
  }

  async authenticateAdmin(username: string, password: string, masterPassword?: string) {
    await this.ensureBootstrapAdmin();
    const admin = await this.repo.getAdminByUsername(username);
    if (!admin) {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid username or password");
    }
    const valid = await verifyPassword(password, admin.password_salt, admin.password_hash);
    if (!valid) {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid username or password");
    }
    // The global master password is an ADDITIONAL factor required for the admin
    // role only. staff authenticate with username + password alone; a submitted
    // master value is neither read nor rejected for them (AC-B6). Authorization
    // is on the STORED user_role, not any UI dropdown hint.
    if (admin.user_role === USER_ROLE.ADMIN) {
      await this.requireMasterPassword(masterPassword ?? "");
    }
    return {
      id: admin.id,
      username: admin.username,
      user_role: admin.user_role,
      must_change_password: admin.must_change_password === 1,
      session_epoch: admin.session_epoch
    };
  }

  /**
   * Loads the stored master-password credential, seeding it once from the
   * optional ADMIN_MASTER_PASSWORD env var the first time an admin authenticates
   * on a database that has none. Returns null when neither a stored credential
   * nor a usable seed exists (fail-closed, AC-B10a).
   */
  private async loadOrSeedMasterPassword(): Promise<{ hash: string; salt: string } | null> {
    const hash = await this.repo.getSetting(MASTER_PASSWORD_HASH_KEY);
    const salt = await this.repo.getSetting(MASTER_PASSWORD_SALT_KEY);
    if (hash && salt) {
      return { hash, salt };
    }
    const seed = normalizeOptionalEnv(this.env.ADMIN_MASTER_PASSWORD);
    if (!seed || seed === PLACEHOLDER_MASTER_PASSWORD) {
      return null;
    }
    const record = await hashPassword(seed);
    await this.repo.upsertSetting(MASTER_PASSWORD_HASH_KEY, record.hash);
    await this.repo.upsertSetting(MASTER_PASSWORD_SALT_KEY, record.salt);
    return { hash: record.hash, salt: record.salt };
  }

  /**
   * Fail-closed master-password check for admin login. A missing stored value
   * with no seed, or any mismatch, throws the SAME generic 401 used for a bad
   * username/password so the master factor cannot be enumerated (AC-B4/B5).
   */
  private async requireMasterPassword(candidate: string): Promise<void> {
    const credential = await this.loadOrSeedMasterPassword();
    if (!credential) {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid username or password");
    }
    const valid = await verifyPassword(candidate, credential.salt, credential.hash);
    if (!valid) {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid username or password");
    }
  }

  /**
   * Changes the global master password (AC-B12/B13). Authorization (admin only)
   * is enforced in the route via requireUserManager BEFORE this runs. The
   * current value is verified first so a wrong current leaves the stored hash
   * untouched; the new value must be >= 8 chars and differ from the current.
   */
  async changeMasterPassword(input: { currentMasterPassword: string; newMasterPassword: string }) {
    const credential = await this.loadOrSeedMasterPassword();
    if (!credential) {
      throw new ApiError(401, "UNAUTHORIZED", "Current master password is incorrect");
    }
    const valid = await verifyPassword(input.currentMasterPassword, credential.salt, credential.hash);
    if (!valid) {
      throw new ApiError(401, "UNAUTHORIZED", "Current master password is incorrect");
    }
    validateNewPassword(input.newMasterPassword, "New master password");
    if (input.currentMasterPassword === input.newMasterPassword) {
      throw new ApiError(400, "BAD_REQUEST", "New master password must be different from current master password");
    }
    const record = await hashPassword(input.newMasterPassword);
    await this.repo.upsertSetting(MASTER_PASSWORD_HASH_KEY, record.hash);
    await this.repo.upsertSetting(MASTER_PASSWORD_SALT_KEY, record.salt);
    return { updated: true };
  }

  async changeAdminPassword(input: { adminId: number; currentPassword: string; newPassword: string }) {
    if (input.newPassword.length < 8) {
      throw new ApiError(400, "BAD_REQUEST", "New password must be at least 8 characters");
    }
    if (input.currentPassword === input.newPassword) {
      throw new ApiError(400, "BAD_REQUEST", "New password must be different from current password");
    }
    const admin = await this.repo.getAdminCredentialsById(input.adminId);
    if (!admin) {
      throw new ApiError(404, "NOT_FOUND", "Admin not found");
    }
    if (admin.username === READ_ONLY_ADMIN_USERNAME) {
      throw new ApiError(403, "FORBIDDEN", "Password changes are disabled for this account");
    }
    const valid = await verifyPassword(input.currentPassword, admin.password_salt, admin.password_hash);
    if (!valid) {
      throw new ApiError(401, "UNAUTHORIZED", "Current password is incorrect");
    }
    const passwordRecord = await hashPassword(input.newPassword);
    const updated = await this.repo.updateAdminPassword({
      adminId: input.adminId,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      // An admin changing their own password satisfies the forced-change rule.
      clearMustChange: true
    });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "Admin not found");
    }
    return {
      updated: true
    };
  }

  async resetAdminPassword(input: { username: string; recoveryPassword: string; newPassword: string }) {
    const bootstrapUsername = this.env.ADMIN_BOOTSTRAP_USERNAME;
    const bootstrapPassword = this.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!bootstrapUsername || !bootstrapPassword) {
      throw new ApiError(403, "FORBIDDEN", "Password reset is not configured");
    }
    if (input.newPassword.length < 8) {
      throw new ApiError(400, "BAD_REQUEST", "New password must be at least 8 characters");
    }
    if (input.newPassword === input.recoveryPassword) {
      throw new ApiError(400, "BAD_REQUEST", "New password must be different from recovery password");
    }
    if (input.username !== bootstrapUsername || !timingSafeEqual(input.recoveryPassword, bootstrapPassword)) {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid username or recovery password");
    }

    await this.ensureBootstrapAdmin();
    const admin = await this.repo.getAdminByUsername(input.username);
    if (!admin) {
      throw new ApiError(404, "NOT_FOUND", "Admin not found");
    }
    const passwordRecord = await hashPassword(input.newPassword);
    const updated = await this.repo.updateAdminPassword({
      adminId: admin.id,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt
    });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "Admin not found");
    }
    return {
      reset: true
    };
  }

  /**
   * Sets a known bootstrap credential and requires the operator to change it on
   * next login. Used by the recovery tooling (scripts/reset-admin.mjs) so that
   * weak credentials never persist beyond a single sign-in.
   */
  async forcePasswordReset(input: { username?: string; adminId?: number; newPassword: string; requireChange?: boolean }) {
    const target = input.adminId !== undefined
      ? await this.repo.getAdminById(input.adminId)
      : input.username
        ? await this.repo.getAdminByUsername(input.username)
        : null;
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "Admin not found");
    }
    const passwordRecord = await hashPassword(input.newPassword);
    const updated = await this.repo.updateAdminPassword({
      adminId: target.id,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      // The reset must survive until the owner proves they know the password.
      clearMustChange: false
    });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "Admin not found");
    }
    if (input.requireChange !== false) {
      await this.repo.setMustChangePassword({ adminId: target.id, required: true });
    }
    return { reset: true, must_change_password: input.requireChange !== false };
  }

  // --- User management (admin/staff) ---------------------------------------
  // Authorization (admin only; staff denied) is enforced in the route via
  // requireUserManager BEFORE these run. These methods assume the caller is
  // allowed.

  /** Records a session row + the stamped epoch at login, for the per-user listing. */
  async recordAdminSession(input: {
    adminId: number;
    epoch: number;
    ttlSeconds: number;
    userAgent?: string | null;
  }): Promise<void> {
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    await this.repo.insertAdminSession({
      adminId: input.adminId,
      epoch: input.epoch,
      issuedAt,
      expiresAt,
      userAgent: input.userAgent ?? null
    });
  }

  async listUsers() {
    const items = await this.repo.listUsers();
    return {
      items: items.map((user) => ({
        id: user.id,
        username: user.username,
        role: user.user_role,
        must_change_password: user.must_change_password === 1,
        session_epoch: user.session_epoch,
        created_at: user.created_at,
        updated_at: user.updated_at
      }))
    };
  }

  async createUser(input: {
    username: string;
    password: string;
    role: string;
    actorId: number;
  }) {
    const username = input.username.trim();
    if (username.length < 1) {
      throw new ApiError(400, "BAD_REQUEST", "Username is required");
    }
    if (!isUserRole(input.role)) {
      throw new ApiError(400, "BAD_REQUEST", "role must be admin or staff");
    }
    validateNewPassword(input.password, "Password");
    if (await this.repo.getAdminByUsername(username)) {
      throw new ApiError(409, "CONFLICT", "Username already exists");
    }
    const userRole: UserRole = input.role;
    let id: number;
    try {
      const passwordRecord = await hashPassword(input.password);
      id = await this.repo.createUser({
        username,
        passwordHash: passwordRecord.hash,
        passwordSalt: passwordRecord.salt,
        userRole
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ApiError(409, "CONFLICT", "Username already exists");
      }
      throw error;
    }
    await this.repo.insertLog({
      action: LOG_ACTION.USER_CREATE,
      result: LOG_RESULT.SUCCESS,
      message: `User ${username} created with role ${userRole}`
    });
    return { id, username, role: userRole, must_change_password: true };
  }

  async resetUserPassword(input: {
    adminId: number;
    newPassword: string;
    forceChange?: boolean;
    actorId: number;
  }) {
    validateNewPassword(input.newPassword, "New password");
    const target = await this.repo.getUserById(input.adminId);
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    // force_change defaults ON; only an explicit false opts out.
    const forceChange = input.forceChange !== false;
    const passwordRecord = await hashPassword(input.newPassword);
    const updated = await this.repo.resetUserPassword({
      adminId: input.adminId,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      forceChange
    });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    // The reset bumped session_epoch, so revoke the audit rows to match.
    await this.repo.revokeAdminSessions({ adminId: input.adminId });
    await this.repo.insertLog({
      action: LOG_ACTION.USER_RESET_PASSWORD,
      result: LOG_RESULT.SUCCESS,
      message: `Password reset for user ${target.username}`
    });
    return { updated: true, must_change_password: forceChange };
  }

  async generateUserPassword(input: {
    adminId: number;
    forceChange?: boolean;
    actorId: number;
  }) {
    const target = await this.repo.getUserById(input.adminId);
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    // force_change defaults ON; only an explicit false opts out.
    const forceChange = input.forceChange !== false;
    // 24 random bytes -> 32-char base64url. This plaintext is the SOLE exposure:
    // it is returned once below and never stored or logged.
    const password = generateRandomToken(24);
    const passwordRecord = await hashPassword(password);
    const updated = await this.repo.resetUserPassword({
      adminId: input.adminId,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      forceChange
    });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    // The reset bumped session_epoch, so revoke the audit rows to match.
    await this.repo.revokeAdminSessions({ adminId: input.adminId });
    await this.repo.insertLog({
      action: LOG_ACTION.USER_RESET_PASSWORD,
      result: LOG_RESULT.SUCCESS,
      message: `Password generated for user ${target.username}`
    });
    return { password, must_change_password: forceChange };
  }

  async kickUser(input: { adminId: number; actorId: number }) {
    const target = await this.repo.getUserById(input.adminId);
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    const bumped = await this.repo.incrementSessionEpoch({ adminId: input.adminId });
    if (!bumped) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    const revoked = await this.repo.revokeAdminSessions({ adminId: input.adminId });
    await this.repo.insertLog({
      action: LOG_ACTION.USER_KICK,
      result: LOG_RESULT.SUCCESS,
      message: `Sessions kicked for user ${target.username}`
    });
    return { kicked: true, revoked_sessions: revoked };
  }

  async setUserRole(input: { adminId: number; role: string; actorId: number }) {
    if (!isUserRole(input.role)) {
      throw new ApiError(400, "BAD_REQUEST", "role must be admin or staff");
    }
    const target = await this.repo.getUserById(input.adminId);
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    const userRole: UserRole = input.role;
    const updated = await this.repo.setUserRole({ adminId: input.adminId, userRole });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    await this.repo.insertLog({
      action: LOG_ACTION.USER_SET_ROLE,
      result: LOG_RESULT.SUCCESS,
      message: `User ${target.username} role set to ${userRole}`
    });
    return { updated: true, role: userRole };
  }

  async listUserSessions(input: { adminId: number }) {
    const target = await this.repo.getUserById(input.adminId);
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    const sessions = await this.repo.listAdminSessions({ adminId: input.adminId });
    return {
      current_epoch: target.session_epoch,
      items: sessions.map((session) => ({
        id: session.id,
        epoch: session.epoch,
        issued_at: session.issued_at,
        expires_at: session.expires_at,
        last_seen_at: session.last_seen_at,
        revoked_at: session.revoked_at,
        user_agent: session.user_agent,
        // A session is live only if it was never revoked AND still matches the
        // current epoch (a kick/reset bumps the epoch, invalidating older rows).
        active: session.revoked_at === null && session.epoch === target.session_epoch
      }))
    };
  }

  async createApp(input: { name: string; description?: string; purchaseUrl?: string; platform: string; status?: AppStatus }) {
    const appId = `app_${generateRandomToken(12)}`;
    const appSecret = `sec_${generateRandomToken(32)}`;
    const appSecretHash = await this.hashAppSecret(appSecret);
    const app = await this.repo.createApp({
      appId,
      name: input.name,
      description: input.description,
      purchaseUrl: input.purchaseUrl,
      platform: input.platform,
      status: input.status ?? APP_STATUS.ACTIVE,
      appSecretHash
    });
    return {
      app: stripAppSecret(app),
      app_secret: appSecret
    };
  }

  async updateApp(input: { appId: string; name: string; description?: string; purchaseUrl?: string; platform: string }) {
    const app = await this.repo.updateApp(input);
    if (!app) {
      throw new ApiError(404, "NOT_FOUND", "App not found");
    }
    return {
      app: stripAppSecret(app)
    };
  }

  async updateAppStatus(input: { appId: string; status: AppStatus; adminId: number }) {
    const app = await this.repo.getAppByPublicId(input.appId);
    if (!app) {
      throw new ApiError(404, "NOT_FOUND", "App not found");
    }
    const updated = await this.repo.updateAppStatus(input.appId, input.status);
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "App not found");
    }
    await this.repo.insertLog({
      appDbId: app.id,
      action: input.status === APP_STATUS.DISABLED ? LOG_ACTION.DISABLE_APP : LOG_ACTION.ENABLE_APP,
      result: LOG_RESULT.SUCCESS,
      message: `${input.status === APP_STATUS.DISABLED ? "Disabled" : "Enabled"} by admin ${input.adminId}`
    });
    return {
      updated: true
    };
  }

  async rotateAppSecret(input: { appId: string; adminId: number }) {
    const app = await this.repo.getAppByPublicId(input.appId);
    if (!app) {
      throw new ApiError(404, "NOT_FOUND", "App not found");
    }
    const appSecret = `sec_${generateRandomToken(32)}`;
    const appSecretHash = await this.hashAppSecret(appSecret);
    const updatedApp = await this.repo.updateAppSecretHash(input.appId, appSecretHash);
    if (!updatedApp) {
      throw new ApiError(404, "NOT_FOUND", "App not found");
    }
    await this.repo.insertLog({
      appDbId: app.id,
      action: LOG_ACTION.ROTATE_APP_SECRET,
      result: LOG_RESULT.SUCCESS,
      message: `Rotated app secret by admin ${input.adminId}`
    });
    return {
      app: stripAppSecret(updatedApp),
      app_secret: appSecret
    };
  }

  async deleteApp(appId: string) {
    const app = await this.repo.getAppByPublicId(appId);
    if (!app) {
      throw new ApiError(404, "NOT_FOUND", "App not found");
    }
    const deleted = await this.repo.deleteAppIfUnreferenced(app.id);
    if (!deleted) {
      throw new ApiError(409, "CONFLICT", "App has activation data and cannot be deleted");
    }
    return {
      deleted: true
    };
  }

  async generateCodes(input: {
    appId: string;
    planCode: string;
    quantity: number;
    note?: string;
    adminId: number;
  }) {
    const app = await this.repo.getAppByPublicId(input.appId);
    if (!app) {
      throw new ApiError(404, "NOT_FOUND", "App not found");
    }
    const plan = await this.repo.getPlanByCode(input.planCode);
    if (!plan) {
      throw new ApiError(404, "NOT_FOUND", "Plan not found");
    }
    const batchId = await this.repo.createBatch({
      appDbId: app.id,
      planId: plan.id,
      quantity: input.quantity,
      note: input.note,
      createdBy: input.adminId
    });

    const codes: string[] = [];
    const pending: Parameters<Repository["createActivationCodes"]>[0] = [];
    const generatedHashes = new Set<string>();
    let attempts = 0;
    while (codes.length < input.quantity) {
      attempts += 1;
      if (attempts > input.quantity * 4 + 20) {
        throw new ApiError(409, "CONFLICT", "Unable to generate unique activation codes");
      }
      const code = generateActivationCode();
      const normalized = normalizeCode(code);
      const codeHash = await this.hashCode(normalized);
      if (generatedHashes.has(codeHash)) {
        continue;
      }
      generatedHashes.add(codeHash);
      pending.push({
        batchId,
        appDbId: app.id,
        planId: plan.id,
        codeHash,
        codeSuffix: codeSuffix(normalized),
        createdBy: input.adminId
      });
      codes.push(code);
    }

    try {
      await this.repo.createActivationCodes(pending);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ApiError(409, "CONFLICT", "Generated activation code collision, please retry");
      }
      throw error;
    }

    await this.repo.insertLog({
      appDbId: app.id,
      action: LOG_ACTION.BATCH_GENERATE,
      result: LOG_RESULT.SUCCESS,
      message: `Generated ${codes.length} ${plan.name} codes`
    });

    return {
      batch_id: batchId,
      app_id: app.app_id,
      plan_code: plan.code,
      quantity: codes.length,
      codes
    };
  }

  async activate(input: { appId: string; appSecret: string; code: string; deviceFingerprint: string; sessionToken?: string }) {
    const app = await this.requireValidClientApp(input.appId, input.appSecret);
    const deviceHash = await this.hashDevice(input.deviceFingerprint);
    const codeHash = await this.hashCode(normalizeCode(input.code));
    const code = await this.requireCode(codeHash, app);

    try {
      this.assertCodeUsable(code, deviceHash);
      if (code.status === CODE_STATUS.ACTIVE) {
        if (!code.device_hash) {
          if (code.rebind_count > MAX_REBINDS) {
            throw new ApiError(403, "REBINDS_EXCEEDED", "Device unbind limit exceeded");
          }
          const reboundAt = nowIso();
          const rebound = await this.repo.bindUnboundDevice({
            codeId: code.id,
            deviceHash,
            boundAt: reboundAt
          });
          if (!rebound) {
            throw new ApiError(409, "CONFLICT", "Activation code was bound by another request");
          }
          const reboundCode = await this.requireCode(codeHash, app);
          await this.repo.insertLog({
            codeId: code.id,
            appDbId: app.id,
            action: LOG_ACTION.ACTIVATE,
            result: LOG_RESULT.SUCCESS,
            deviceHash,
            message: "Device rebound"
          });
          return await this.withSession(this.toClientLicense(reboundCode), reboundCode, app, deviceHash, input.sessionToken);
        }
        await this.repo.insertLog({
          codeId: code.id,
          appDbId: app.id,
          action: LOG_ACTION.ACTIVATE,
          result: LOG_RESULT.SUCCESS,
          deviceHash,
          message: "Already active on this device"
        });
        return await this.withSession(this.toClientLicense(code), code, app, deviceHash, input.sessionToken);
      }

      const activatedAt = nowIso();
      const expiresAt = this.calculateExpiresAt(activatedAt, code);
      const activated = await this.repo.activateCode({
        codeId: code.id,
        deviceHash,
        activatedAt,
        expiresAt
      });
      if (!activated) {
        throw new ApiError(409, "CONFLICT", "Activation code was activated by another request");
      }
      const activatedCode = await this.requireCode(codeHash, app);
      await this.repo.insertLog({
        codeId: code.id,
        appDbId: app.id,
        action: LOG_ACTION.ACTIVATE,
        result: LOG_RESULT.SUCCESS,
        deviceHash,
        message: "Activated"
      });
      return await this.withSession(this.toClientLicense(activatedCode), activatedCode, app, deviceHash, input.sessionToken);
    } catch (error) {
      await this.logClientFailure(error, code, app, LOG_ACTION.ACTIVATE, deviceHash);
      throw error;
    }
  }

  async heartbeat(input: { appId: string; appSecret: string; code: string; deviceFingerprint: string; sessionToken: string }) {
    const app = await this.requireValidClientApp(input.appId, input.appSecret);
    const deviceHash = await this.hashDevice(input.deviceFingerprint);
    const codeHash = await this.hashCode(normalizeCode(input.code));
    const code = await this.requireCode(codeHash, app);
    this.assertCodeUsable(code, deviceHash);
    const session = await this.repo.getSessionByTokenHash(await this.hashSessionToken(input.sessionToken));
    if (!session || session.code_id !== code.id || session.app_id !== app.id || !timingSafeEqual(session.device_hash, deviceHash)) {
      throw new ApiError(403, "SESSION_REVOKED", "Session is not authorized");
    }
    if (session.status === "kicked") throw new ApiError(403, "SESSION_REVOKED", "Session was kicked by an administrator");
    if (session.status !== "active" || new Date(session.lease_expires_at).getTime() <= Date.now()) {
      throw new ApiError(403, "SESSION_EXPIRED", "Session lease expired");
    }
    const now = nowIso();
    const gracePeriodSeconds = code.grace_period_seconds ?? 86400;
    const heartbeatIntervalSeconds = code.heartbeat_interval_seconds ?? 300;
    const leaseExpiresAt = new Date(Date.now() + gracePeriodSeconds * 1000).toISOString();
    if (!(await this.repo.heartbeatSession({ sessionId: session.id, now, leaseExpiresAt }))) {
      throw new ApiError(403, "SESSION_EXPIRED", "Session lease expired");
    }
    await this.repo.insertLog({ codeId: code.id, appDbId: app.id, action: LOG_ACTION.HEARTBEAT, result: LOG_RESULT.SUCCESS, deviceHash, message: "Heartbeat accepted" });
    return { ...this.toClientLicense(code), session_token: input.sessionToken, lease_expires_at: leaseExpiresAt, grace_period_seconds: gracePeriodSeconds, heartbeat_interval_seconds: heartbeatIntervalSeconds };
  }

  async renew(input: { appId: string; appSecret: string; code: string; deviceFingerprint: string; sessionToken?: string }) {
    const app = await this.requireValidClientApp(input.appId, input.appSecret);
    const deviceHash = await this.hashDevice(input.deviceFingerprint);
    const codeHash = await this.hashCode(normalizeCode(input.code));
    const code = await this.requireCode(codeHash, app);
    if (code.status === CODE_STATUS.DELETED) throw new ApiError(410, "CODE_DELETED", "Activation code was deleted");
    if (code.disabled_at) throw new ApiError(403, "CODE_DISABLED", "Activation code is disabled");
    if (code.status !== CODE_STATUS.ACTIVE || !code.device_hash || !timingSafeEqual(code.device_hash, deviceHash)) throw new ApiError(403, "DEVICE_MISMATCH", "Device fingerprint does not match");
    const base = new Date(code.expires_at && new Date(code.expires_at).getTime() > Date.now() ? code.expires_at : nowIso());
    const expiresAt = this.calculateExpiresAt(base.toISOString(), code);
    if (!(await this.repo.renewCode({ codeId: code.id, deviceHash, expiresAt, now: nowIso() }))) throw new ApiError(409, "CONFLICT", "License renewal conflict");
    const renewed = await this.requireCode(codeHash, app);
    await this.repo.insertLog({ codeId: code.id, appDbId: app.id, action: LOG_ACTION.RENEW, result: LOG_RESULT.SUCCESS, deviceHash, message: "License renewed" });
    return await this.withSession(this.toClientLicense(renewed), renewed, app, deviceHash, input.sessionToken);
  }

  async listActiveSessions() {
    const sessions = await this.repo.listSessions();
    return { items: sessions.map(({ session_token_hash: _secret, device_hash: _device, ...session }) => ({ ...session, device_bound: true })) };
  }

  async kickSession(sessionId: number, adminId: number) {
    if (!(await this.repo.kickSession(sessionId, nowIso()))) throw new ApiError(404, "NOT_FOUND", "Active session not found");
    await this.repo.insertLog({ action: LOG_ACTION.SESSION_KICK, result: LOG_RESULT.SUCCESS, message: `Session ${sessionId} kicked by admin ${adminId}` });
    return { kicked: true };
  }

  async getClientAppInfo(input: { appId: string; appSecret: string }) {
    const app = await this.requireValidClientApp(input.appId, input.appSecret);
    return toClientAppInfo(app);
  }

  async verify(input: { appId: string; appSecret: string; code: string; deviceFingerprint: string }) {
    const app = await this.requireValidClientApp(input.appId, input.appSecret);
    const deviceHash = await this.hashDevice(input.deviceFingerprint);
    const codeHash = await this.hashCode(normalizeCode(input.code));
    const code = await this.requireCode(codeHash, app);
    try {
      this.assertCodeUsable(code, deviceHash);
      if (code.status !== CODE_STATUS.ACTIVE) {
        throw new ApiError(400, "INVALID_CODE", "Activation code has not been activated");
      }
      if (!code.device_hash) {
        throw new ApiError(403, "DEVICE_MISMATCH", "Activation code is not bound to a device");
      }
      await this.repo.insertLog({
        codeId: code.id,
        appDbId: app.id,
        action: LOG_ACTION.VERIFY,
        result: LOG_RESULT.SUCCESS,
        deviceHash,
        message: "Verified"
      });
      return this.toClientLicense(code);
    } catch (error) {
      await this.logClientFailure(error, code, app, LOG_ACTION.VERIFY, deviceHash);
      throw error;
    }
  }

  // --- Signed-license surface (FEAT-003, design §5.2/§6/§7) ----------------

  async verifySigned(input: {
    appId: string;
    appSecret: string;
    licenseKey: string;
    productId: string;
    installationId: string;
    applicationVersion?: string;
    protocolVersion: number;
  }) {
    const app = await this.requireValidClientApp(input.appId, input.appSecret);
    const config = getLicensingConfig(this.env);
    const installationHash = await this.hashDevice(this.requireInstallationId(input.installationId));

    // product_id must equal the authenticated app's public id; a mismatch is an
    // unsigned 404 + PRODUCT_MISMATCH event (§3.1.1, enumeration-safe).
    if (input.productId !== app.app_id) {
      await this.repo.insertSecurityEvent({
        appId: app.id,
        eventType: SECURITY_EVENT_TYPE.PRODUCT_MISMATCH,
        installationHash,
        protocolVersion: input.protocolVersion,
        keyId: config.keyId,
        result: LOG_RESULT.FAILURE,
        message: "product_id does not match app"
      });
      throw new ApiError(404, "INVALID_CODE", "Activation code not found");
    }

    // protocol_version must be server-supported; else unsigned 400.
    if (!config.supportedProtocolVersions.includes(input.protocolVersion)) {
      throw new ApiError(400, "PROTOCOL_UNSUPPORTED", "Protocol version is not supported");
    }

    const codeHash = await this.hashCode(normalizeCode(input.licenseKey));
    let code = await this.requireCode(codeHash, app);

    // License-key-only model: the customer's first verify IS the activation.
    // An unused key (not deleted / held / disabled) is activated on this
    // installation exactly like /api/client/activate does: the license period
    // starts now (first activation), via the same atomic compare-and-set.
    if (code.status === CODE_STATUS.UNUSED && code.hold_at === null && code.disabled_at === null) {
      const activatedAt = nowIso();
      const activated = await this.repo.activateCode({
        codeId: code.id,
        deviceHash: installationHash,
        activatedAt,
        expiresAt: this.calculateExpiresAt(activatedAt, code)
      });
      if (activated) {
        await this.repo.insertLog({
          codeId: code.id,
          appDbId: app.id,
          action: LOG_ACTION.ACTIVATE,
          result: LOG_RESULT.SUCCESS,
          deviceHash: installationHash,
          message: "Activated"
        });
      }
      // Re-read either way: if a concurrent request won the race, we sign
      // whatever state it produced instead of guessing.
      code = await this.requireCode(codeHash, app);
    }

    const now = new Date();
    const activationAllowed = await this.evaluateActivationAllowed(code, installationHash, now);
    const derived = deriveSignedStatus(code, now);
    const status = derived === SIGNED_STATUS_NOT_ACTIVATABLE ? "expired" : derived;

    const serverTime = nowIso();
    const payload: LicensePayload = {
      activation_allowed: activationAllowed,
      expires_at: code.expires_at,
      grace_period_seconds: code.grace_period_seconds ?? config.defaultGraceSeconds,
      installation_id: input.installationId,
      issued_at: serverTime,
      key_id: config.keyId,
      license_id: code.id,
      plan: code.plan_code,
      product_id: app.app_id,
      protocol_version: config.currentProtocolVersion,
      server_time: serverTime,
      status
    };

    const signature = await signPayload(this.env, canonicalize(payload));

    await this.repo.insertSecurityEvent({
      appId: app.id,
      codeId: code.id,
      eventType: activationAllowed ? SECURITY_EVENT_TYPE.VERIFY : SECURITY_EVENT_TYPE.LIMIT_REACHED,
      installationHash,
      protocolVersion: input.protocolVersion,
      keyId: config.keyId,
      result: LOG_RESULT.SUCCESS,
      message: activationAllowed ? `Signed verify (${status})` : "Activation limit reached"
    });

    return {
      payload,
      signature,
      public_key_id: config.keyId,
      verification_interval_seconds: config.verificationIntervalSeconds
    };
  }

  /**
   * Decide activation_allowed for the signed payload (design §5.4). Only an
   * activatable code can be allowed. max_activations NULL/1 => single-device
   * model on activation_codes.device_hash; max_activations > 1 => atomic slot
   * claim via code_activations.
   */
  private async evaluateActivationAllowed(code: CodeDetailRow, installationHash: string, now: Date): Promise<boolean> {
    if (deriveSignedStatus(code, now) !== "active") {
      return false;
    }
    const max = code.max_activations;
    if (max === null || max <= 1) {
      // Legacy single-device path: a matching bound device is the one allowed
      // installation. An unbound or mismatched code is not auto-authorized here;
      // the client must activate via /api/client/activate first.
      return code.device_hash !== null && timingSafeEqual(code.device_hash, installationHash);
    }
    return await this.repo.claimActivationSlot({
      codeId: code.id,
      installationHash,
      maxActivations: max,
      now: nowIso()
    });
  }

  async reportEvent(input: {
    appId: string;
    appSecret: string;
    installationId: string;
    licenseKey?: string;
    licenseId?: number;
    reasonCode: string;
    detail?: string;
  }) {
    const app = await this.requireValidClientApp(input.appId, input.appSecret);
    if (!isSecurityReasonCode(input.reasonCode)) {
      throw new ApiError(400, "BAD_REQUEST", "reason_code is not allowed");
    }
    const installationHash = await this.hashDevice(this.requireInstallationId(input.installationId));

    let code: CodeDetailRow | null = null;
    if (input.licenseKey !== undefined) {
      const codeHash = await this.hashCode(normalizeCode(input.licenseKey));
      const found = await this.repo.findCodeByHash(codeHash);
      code = found && found.app_id === app.id ? found : null;
    } else if (input.licenseId !== undefined) {
      const byId = await this.repo.findCodeById(input.licenseId);
      code = byId && byId.app_id === app.id ? byId : null;
    }
    if (!code) {
      throw new ApiError(404, "INVALID_CODE", "Activation code not found");
    }

    const detail = this.normalizeDetail(input.detail);
    await this.repo.insertSecurityEvent({
      appId: app.id,
      codeId: code.id,
      eventType: SECURITY_EVENT_TYPE.REPORT,
      reasonCode: input.reasonCode,
      installationHash,
      result: LOG_RESULT.FAILURE,
      message: detail
    });

    const held = await this.maybeAutoHold(code, input.reasonCode);
    return { recorded: true, held };
  }

  /**
   * Corroborated auto-hold (§6.3). A lone high-severity report records but does
   * NOT hold; auto-hold fires only when >= reportHoldDistinctThreshold distinct
   * installations file a high-severity report within the window. Single-report
   * immediate hold is config-gated OFF by default.
   */
  private async maybeAutoHold(code: CodeDetailRow, reasonCode: SecurityReasonCode): Promise<boolean> {
    if (!HIGH_SEVERITY_REPORT_REASONS.includes(reasonCode)) {
      return false;
    }
    if (code.hold_at !== null) {
      return false; // already held; idempotent
    }
    const config = getLicensingConfig(this.env);
    const sinceIso = new Date(Date.now() - config.autoHold.reportHoldWindowSeconds * 1000).toISOString();
    const distinct = await this.repo.countDistinctInstallationReports(
      code.id,
      HIGH_SEVERITY_REPORT_REASONS,
      sinceIso
    );
    const corroborated = distinct >= config.autoHold.reportHoldDistinctThreshold;
    const shouldHold = corroborated || config.autoHold.singleHighSeverityReportHolds;
    if (!shouldHold) {
      return false;
    }
    const at = nowIso();
    const held = await this.repo.holdCode({
      codeId: code.id,
      reasonCode: this.toHoldReasonCode(reasonCode),
      at
    });
    if (held) {
      await this.repo.insertSecurityEvent({
        appId: code.app_id,
        codeId: code.id,
        eventType: SECURITY_EVENT_TYPE.AUTO_HOLD,
        reasonCode,
        result: LOG_RESULT.SUCCESS,
        message: "Auto-hold on corroborated reports"
      });
    }
    return held;
  }

  async holdCode(input: { codeId: number; adminId: number }) {
    const at = nowIso();
    const held = await this.repo.holdCode({
      codeId: input.codeId,
      reasonCode: HOLD_REASON_CODE.ADMIN_MANUAL,
      at
    });
    if (!held) {
      throw new ApiError(404, "NOT_FOUND", "Activation code not found or already on hold");
    }
    await this.repo.insertLog({
      codeId: input.codeId,
      action: LOG_ACTION.DISABLE_CODE,
      result: LOG_RESULT.SUCCESS,
      message: `Hold by admin ${input.adminId}`
    });
    await this.repo.insertSecurityEvent({
      codeId: input.codeId,
      eventType: SECURITY_EVENT_TYPE.ADMIN_HOLD,
      reasonCode: HOLD_REASON_CODE.ADMIN_MANUAL,
      result: LOG_RESULT.SUCCESS,
      message: `Hold by admin ${input.adminId}`
    });
    return { held: true };
  }

  async approveCode(input: { codeId: number; adminId: number }) {
    const at = nowIso();
    const approved = await this.repo.approveCode({ codeId: input.codeId, at });
    if (!approved) {
      throw new ApiError(404, "NOT_FOUND", "Activation code not found or not on hold");
    }
    await this.repo.insertLog({
      codeId: input.codeId,
      action: LOG_ACTION.ENABLE_CODE,
      result: LOG_RESULT.SUCCESS,
      message: `Approved by admin ${input.adminId}`
    });
    await this.repo.insertSecurityEvent({
      codeId: input.codeId,
      eventType: SECURITY_EVENT_TYPE.ADMIN_APPROVE,
      result: LOG_RESULT.SUCCESS,
      message: `Approved by admin ${input.adminId}`
    });
    return { approved: true };
  }

  async setCodeValidity(input: { codeId: number; expiresAt: string; adminId: number }) {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new ApiError(400, "BAD_REQUEST", "expires_at must be a valid ISO-8601 timestamp");
    }
    const now = nowIso();
    const updated = await this.repo.setCodeExpiry({
      codeId: input.codeId,
      expiresAt: parsed.toISOString(),
      now
    });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "Active activation code not found");
    }
    await this.repo.insertLog({
      codeId: input.codeId,
      action: LOG_ACTION.RENEW,
      result: LOG_RESULT.SUCCESS,
      message: `Validity changed by admin ${input.adminId}`
    });
    return { updated: true, expires_at: parsed.toISOString() };
  }

  async setMaxActivations(input: { codeId: number; value: number | null; adminId: number }) {
    const code = await this.repo.findCodeById(input.codeId);
    if (!code) {
      throw new ApiError(404, "NOT_FOUND", "Activation code not found");
    }
    if (input.value !== null) {
      const activeSlots = await this.repo.countActiveActivationSlots(input.codeId);
      if (input.value < activeSlots) {
        throw new ApiError(409, "ACTIVATION_LIMIT_REACHED", "New limit is below the current active-slot count");
      }
    }
    const now = nowIso();
    const updated = await this.repo.setMaxActivations({
      codeId: input.codeId,
      value: input.value,
      now
    });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "Activation code not found");
    }
    await this.repo.insertLog({
      codeId: input.codeId,
      action: LOG_ACTION.ENABLE_CODE,
      result: LOG_RESULT.SUCCESS,
      message: `Max activations set to ${input.value ?? "unlimited(single-device)"} by admin ${input.adminId}`
    });
    return { updated: true, max_activations: input.value };
  }

  async listCodeActivations(input: { codeId: number }) {
    const code = await this.repo.findCodeById(input.codeId);
    if (!code) {
      throw new ApiError(404, "NOT_FOUND", "Activation code not found");
    }
    const items = await this.repo.listCodeActivations(input.codeId);
    return {
      max_activations: code.max_activations,
      active_count: items.filter((item) => item.status === "active").length,
      items
    };
  }

  async listCodeSecurityEvents(input: { codeId: number; page: number; pageSize: number }) {
    const code = await this.repo.findCodeById(input.codeId);
    if (!code) {
      throw new ApiError(404, "NOT_FOUND", "Activation code not found");
    }
    return await this.repo.listSecurityEvents({
      codeId: input.codeId,
      page: input.page,
      pageSize: input.pageSize
    });
  }

  private requireInstallationId(installationId: string): string {
    if (installationId.length > MAX_INSTALLATION_ID_LENGTH || !/^[\x20-\x7e]+$/.test(installationId)) {
      throw new ApiError(400, "BAD_REQUEST", "installation_id must be printable and at most 200 characters");
    }
    return installationId;
  }

  private normalizeDetail(detail: string | undefined): string | null {
    if (detail === undefined) {
      return null;
    }
    return detail.slice(0, 256);
  }

  private toHoldReasonCode(reasonCode: SecurityReasonCode): string {
    switch (reasonCode) {
      case SECURITY_REASON_CODE.SIGNATURE_INVALID:
        return HOLD_REASON_CODE.SIGNATURE_INVALID;
      case SECURITY_REASON_CODE.PAYLOAD_TAMPERED:
        return HOLD_REASON_CODE.PAYLOAD_TAMPERED;
      case SECURITY_REASON_CODE.CLOCK_ROLLBACK:
        return HOLD_REASON_CODE.CLOCK_ROLLBACK;
      default:
        return HOLD_REASON_CODE.ADMIN_MANUAL;
    }
  }

  async unbindDevice(input: {
    appId: string;
    appSecret: string;
    code: string;
    deviceFingerprint: string;
  }) {
    const app = await this.requireValidClientApp(input.appId, input.appSecret);
    const deviceHash = await this.hashDevice(input.deviceFingerprint);
    const codeHash = await this.hashCode(normalizeCode(input.code));
    const code = await this.requireCode(codeHash, app);
    try {
      this.assertActiveForUnbind(code, deviceHash);
      if (code.status !== CODE_STATUS.ACTIVE) {
        throw new ApiError(400, "INVALID_CODE", "Activation code has not been activated");
      }
      if (code.rebind_count >= MAX_REBINDS) {
        throw new ApiError(403, "REBINDS_EXCEEDED", "Device unbind limit exceeded");
      }
      if (code.last_rebind_at && Date.now() - new Date(code.last_rebind_at).getTime() < REBIND_COOLDOWN_MS) {
        throw new ApiError(429, "REBINDS_TOO_FREQUENT", "Device unbind is cooling down");
      }
      const unboundAt = nowIso();
      const unbound = await this.repo.unbindDevice({
        codeId: code.id,
        deviceHash,
        unboundAt,
        maxRebinds: MAX_REBINDS
      });
      if (!unbound) {
        throw new ApiError(409, "CONFLICT", "Device unbind conflict");
      }
      const terminateSessions = (this.repo as Repository & { terminateSessionsForCode?: Repository["terminateSessionsForCode"] }).terminateSessionsForCode;
      if (terminateSessions) await terminateSessions.call(this.repo, code.id, unboundAt);
      const unboundCode = await this.requireCode(codeHash, app);
      await this.repo.insertLog({
        codeId: code.id,
        appDbId: app.id,
        action: LOG_ACTION.UNBIND_DEVICE,
        result: LOG_RESULT.SUCCESS,
        deviceHash,
        message: "Device unbound"
      });
      return this.toClientLicense(unboundCode);
    } catch (error) {
      await this.logClientFailure(error, code, app, LOG_ACTION.UNBIND_DEVICE, deviceHash);
      throw error;
    }
  }

  async deleteCode(codeId: number, adminId: number) {
    const deleted = await this.repo.softDeleteCode(codeId);
    if (!deleted) {
      throw new ApiError(404, "NOT_FOUND", "Activation code not found");
    }
    await this.repo.insertLog({
      codeId,
      action: LOG_ACTION.DELETE_CODE,
      result: LOG_RESULT.SUCCESS,
      message: `Deleted by admin ${adminId}`
    });
  }

  async updateCodeDisabled(input: { codeId: number; disabled: boolean; adminId: number }) {
    const changedAt = nowIso();
    const updated = await this.repo.updateCodeDisabled({
      codeId: input.codeId,
      disabled: input.disabled,
      changedAt
    });
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "Activation code not found");
    }
    await this.repo.insertLog({
      codeId: input.codeId,
      action: input.disabled ? LOG_ACTION.DISABLE_CODE : LOG_ACTION.ENABLE_CODE,
      result: LOG_RESULT.SUCCESS,
      message: `${input.disabled ? "Disabled" : "Enabled"} by admin ${input.adminId}`
    });
    return {
      updated: true
    };
  }

  async manuallyUnbindDevice(input: { codeId: number; adminId: number }) {
    const unbound = await this.repo.manuallyUnbindDevice({
      codeId: input.codeId,
      changedAt: nowIso()
    });
    if (!unbound) {
      throw new ApiError(404, "NOT_FOUND", "Bound activation code not found");
    }
    await this.repo.insertLog({
      codeId: input.codeId,
      action: LOG_ACTION.MANUAL_UNBIND_DEVICE,
      result: LOG_RESULT.SUCCESS,
      message: `Manually unbound device by admin ${input.adminId}`
    });
    return {
      unbound: true
    };
  }

  async bulkUpdateCodes(input: { codeIds: number[]; action: CodeBulkAction; adminId: number }) {
    let updated = 0;
    for (const codeId of input.codeIds) {
      const changed = await this.updateCodeByBulkAction(codeId, input.action);
      if (!changed) {
        continue;
      }
      updated += 1;
      await this.repo.insertLog({
        codeId,
        action: toCodeLogAction(input.action),
        result: LOG_RESULT.SUCCESS,
        message: `${toCodeLogVerb(input.action)} by admin ${input.adminId}`
      });
    }
    if (updated === 0) {
      throw new ApiError(404, "NOT_FOUND", "No activation codes were updated");
    }
    return {
      action: input.action,
      requested: input.codeIds.length,
      updated
    };
  }

  private async requireValidClientApp(appId: string, appSecret: string): Promise<AppRow> {
    const app = await this.repo.getAppByPublicId(appId);
    if (!app) {
      throw new ApiError(404, "NOT_FOUND", "App not found");
    }
    if (app.status !== APP_STATUS.ACTIVE) {
      throw new ApiError(403, "APP_DISABLED", "App is disabled");
    }
    const secretHash = await this.hashAppSecret(appSecret);
    if (!timingSafeEqual(secretHash, app.app_secret_hash)) {
      throw new ApiError(401, "INVALID_APP_SECRET", "Invalid app secret");
    }
    return app;
  }

  private async updateCodeByBulkAction(codeId: number, action: CodeBulkAction): Promise<boolean> {
    if (action === CODE_BULK_ACTION.DELETE) {
      return await this.repo.softDeleteCode(codeId);
    }
    return await this.repo.updateCodeDisabled({
      codeId,
      disabled: action === CODE_BULK_ACTION.DISABLE,
      changedAt: nowIso()
    });
  }

  private async requireCode(codeHash: string, app: AppRow): Promise<CodeDetailRow> {
    const code = await this.repo.findCodeByHash(codeHash);
    if (!code || code.app_id !== app.id) {
      throw new ApiError(404, "INVALID_CODE", "Activation code not found");
    }
    return code;
  }

  private assertCodeUsable(code: CodeDetailRow, deviceHash: string): void {
    if (code.status === CODE_STATUS.DELETED) {
      throw new ApiError(410, "CODE_DELETED", "Activation code was deleted");
    }
    if (code.disabled_at) {
      throw new ApiError(403, "CODE_DISABLED", "Activation code is disabled");
    }
    if (isExpired(code.expires_at)) {
      throw new ApiError(403, "CODE_EXPIRED", "Activation code has expired");
    }
    if (code.status === CODE_STATUS.ACTIVE && code.device_hash && !timingSafeEqual(code.device_hash, deviceHash)) {
      throw new ApiError(403, "DEVICE_MISMATCH", "Activation code is bound to another device");
    }
  }

  private assertActiveForUnbind(code: CodeDetailRow, deviceHash: string): void {
    if (code.status === CODE_STATUS.DELETED) {
      throw new ApiError(410, "CODE_DELETED", "Activation code was deleted");
    }
    if (code.disabled_at) {
      throw new ApiError(403, "CODE_DISABLED", "Activation code is disabled");
    }
    if (isExpired(code.expires_at)) {
      throw new ApiError(403, "CODE_EXPIRED", "Activation code has expired");
    }
    if (code.status !== CODE_STATUS.ACTIVE || !code.device_hash) {
      throw new ApiError(400, "INVALID_CODE", "Activation code has not been activated");
    }
    if (!timingSafeEqual(code.device_hash, deviceHash)) {
      throw new ApiError(403, "DEVICE_MISMATCH", "Device fingerprint does not match");
    }
  }

  private async withSession(license: ReturnType<LicenseService["toClientLicense"]>, code: CodeDetailRow, app: AppRow, deviceHash: string, requestedToken?: string) {
    const findSession = (this.repo as Repository & { getActiveSessionForDevice?: Repository["getActiveSessionForDevice"] }).getActiveSessionForDevice;
    if (!requestedToken && findSession) {
      const existing = await findSession.call(this.repo, code.id, deviceHash);
      if (existing) return license;
    }
    const sessionToken = requestedToken ?? await hmacSha256(requireEnv(this.env, "JWT_SECRET"), `license-session:${code.id}:${deviceHash}`);
    const now = nowIso();
    const gracePeriodSeconds = code.grace_period_seconds ?? 86400;
    const heartbeatIntervalSeconds = code.heartbeat_interval_seconds ?? 300;
    const createSession = (this.repo as Repository & { createOrReuseSession?: Repository["createOrReuseSession"] }).createOrReuseSession;
    if (!createSession) return license;
    const leaseExpiresAt = new Date(Date.now() + gracePeriodSeconds * 1000).toISOString();
    const session = await createSession.call(this.repo, {
      tokenHash: await this.hashSessionToken(sessionToken),
      codeId: code.id,
      appDbId: app.id,
      deviceHash,
      now,
      leaseExpiresAt,
      sessionLimit: code.session_limit ?? 1
    });
    if (!session) throw new ApiError(403, "SESSION_LIMIT_REACHED", "Concurrent session limit reached");
    return { ...license, session_token: sessionToken, lease_expires_at: leaseExpiresAt, grace_period_seconds: gracePeriodSeconds, heartbeat_interval_seconds: heartbeatIntervalSeconds };
  }

  private toClientLicense(code: CodeDetailRow) {
    if (!code.expires_at || !code.activated_at) {
      throw new ApiError(400, "INVALID_CODE", "Activation code has not been activated");
    }
    return {
      valid: true,
      device_bound: Boolean(code.device_hash),
      app_id: code.app_public_id,
      plan: {
        code: code.plan_code,
        name: code.plan_name,
        duration_days: code.duration_days
      },
      activated_at: code.activated_at,
      expires_at: code.expires_at,
      remaining_seconds: secondsUntil(code.expires_at),
      rebind_count: code.rebind_count,
      max_rebinds: MAX_REBINDS
    };
  }

  private calculateExpiresAt(activatedAt: string, code: CodeDetailRow): string {
    switch (code.plan_code) {
      case "monthly":
        return addMonthsIso(activatedAt, 1);
      case "quarterly":
        return addMonthsIso(activatedAt, 3);
      case "yearly":
        return addYearsIso(activatedAt, 1);
      default:
        return addDaysIso(activatedAt, code.duration_days);
    }
  }

  private async logClientFailure(
    error: unknown,
    code: CodeDetailRow,
    app: AppRow,
    action: LogAction,
    deviceHash: string
  ): Promise<void> {
    const apiError = error instanceof ApiError ? error : new ApiError(500, "CONFLICT", "Unexpected failure");
    await this.repo.insertLog({
      codeId: code.id,
      appDbId: app.id,
      action,
      result: LOG_RESULT.FAILURE,
      deviceHash,
      errorCode: apiError.code,
      message: apiError.message
    });
  }

  private async hashCode(code: string): Promise<string> {
    return await hmacSha256(requireEnv(this.env, "CODE_HMAC_SECRET"), code);
  }

  private async hashAppSecret(secret: string): Promise<string> {
    return await hmacSha256(requireEnv(this.env, "APP_SECRET_HMAC_SECRET"), secret);
  }

  private async hashDevice(deviceFingerprint: string): Promise<string> {
    return await hmacSha256(requireEnv(this.env, "DEVICE_HMAC_SECRET"), deviceFingerprint);
  }

  private async hashSessionToken(sessionToken: string): Promise<string> {
    return await hmacSha256(requireEnv(this.env, "JWT_SECRET"), sessionToken);
  }
}

function stripAppSecret(app: AppRow) {
  const { app_secret_hash: _appSecretHash, ...safeApp } = app;
  return safeApp;
}

function validateNewPassword(password: string, label: string): void {
  if (password.length < 8) {
    throw new ApiError(400, "BAD_REQUEST", `${label} must be at least 8 characters`);
  }
}

function toClientAppInfo(app: AppRow) {
  return {
    app_id: app.app_id,
    name: app.name,
    description: app.description,
    purchase_url: app.purchase_url,
    platform: app.platform,
    status: app.status
  };
}

function toCodeLogAction(action: CodeBulkAction): LogAction {
  if (action === CODE_BULK_ACTION.DELETE) {
    return LOG_ACTION.DELETE_CODE;
  }
  return action === CODE_BULK_ACTION.DISABLE ? LOG_ACTION.DISABLE_CODE : LOG_ACTION.ENABLE_CODE;
}

function toCodeLogVerb(action: CodeBulkAction): string {
  if (action === CODE_BULK_ACTION.DELETE) {
    return "Deleted";
  }
  return action === CODE_BULK_ACTION.DISABLE ? "Disabled" : "Enabled";
}
