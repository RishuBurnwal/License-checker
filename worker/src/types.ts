import type { AppStatus, CodeStatus, ErrorCode, LogResult, UserRole } from "./constants";

export type { AppStatus, CodeBulkAction, CodeListStatus, CodeStatus, ErrorCode, LogAction, LogResult, UserRole } from "./constants";

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  JWT_SECRET: string;
  CODE_HMAC_SECRET: string;
  APP_SECRET_HMAC_SECRET: string;
  DEVICE_HMAC_SECRET: string;
  ADMIN_BOOTSTRAP_USERNAME?: string;
  ADMIN_BOOTSTRAP_PASSWORD?: string;
  // Optional one-time seed for the global admin master password (Group B).
  // Standalone (not paired like ADMIN_BOOTSTRAP_*); its absence must not 500.
  ADMIN_MASTER_PASSWORD?: string;
  LICENSE_SIGNING_PRIVATE_KEY: string;
  LICENSE_SIGNING_KEY_ID: string;
  LICENSE_SIGNING_PUBLIC_KEY: string;
  LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY?: string;
  LICENSE_SIGNING_PREVIOUS_KEY_ID?: string;
};

export type Variables = {
  admin: AdminPrincipal;
};

export type AdminPrincipal = {
  id: number;
  username: string;
  user_role: UserRole;
  must_change_password?: boolean;
};

export type AppRow = {
  id: number;
  app_id: string;
  name: string;
  description: string | null;
  purchase_url: string | null;
  platform: string;
  status: AppStatus;
  app_secret_hash: string;
  created_at: string;
  updated_at: string;
};

export type PlanRow = {
  id: number;
  code: string;
  name: string;
  duration_days: number;
  sort_order: number;
  session_limit?: number;
  grace_period_seconds?: number;
  heartbeat_interval_seconds?: number;
  created_at: string;
};

export type LicenseSessionRow = {
  id: number;
  session_token_hash: string;
  code_id: number;
  app_id: number;
  device_hash: string;
  status: "active" | "kicked" | "expired";
  started_at: string;
  last_seen_at: string;
  lease_expires_at: string;
  kicked_at: string | null;
  created_at: string;
  code_suffix?: string;
  app_public_id?: string;
  app_name?: string;
};

export type AdminUserRow = {
  id: number;
  username: string;
  password_hash: string;
  password_salt: string;
  must_change_password: number;
  session_epoch: number;
  user_role: UserRole;
  created_at: string;
  updated_at: string;
};

export type AdminSessionRow = {
  id: number;
  admin_id: number;
  epoch: number;
  jti: string | null;
  issued_at: string;
  expires_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  user_agent: string | null;
  created_at: string;
};

export type ActivationCodeRow = {
  id: number;
  batch_id: number | null;
  app_id: number;
  plan_id: number;
  code_hash: string;
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
  created_by: number | null;
  created_at: string;
  updated_at: string;
};

export type CodeActivationRow = {
  id: number;
  code_id: number;
  installation_hash: string;
  status: "active" | "released";
  activated_at: string;
  last_seen_at: string;
  released_at: string | null;
  created_at: string;
};

export type SecurityEventRow = {
  id: number;
  app_id: number | null;
  code_id: number | null;
  event_type: string;
  reason_code: string | null;
  installation_hash: string | null;
  protocol_version: number | null;
  key_id: string | null;
  result: LogResult;
  message: string | null;
  created_at: string;
};

export type CodeDetailRow = ActivationCodeRow & {
  app_public_id: string;
  app_name: string;
  app_platform: string;
  app_status: AppStatus;
  plan_code: string;
  plan_name: string;
  duration_days: number;
  session_limit?: number;
  grace_period_seconds?: number;
  heartbeat_interval_seconds?: number;
};

export type DashboardStats = {
  overview: {
    apps_total: number;
    apps_active: number;
    codes_total: number;
    codes_unused: number;
    codes_active: number;
    codes_disabled: number;
    codes_expired: number;
    codes_deleted: number;
    logs_today: number;
    client_failures_today: number;
  };
  code_status: Array<{ status: CodeStatus | "disabled" | "expired"; count: number }>;
  app_code_ranking: Array<{
    app_id: string;
    app_name: string;
    platform: string;
    total: number;
    active: number;
    unused: number;
    disabled: number;
    expired: number;
    deleted: number;
  }>;
  plan_distribution: Array<{ plan_code: string; plan_name: string; count: number }>;
  log_trend: Array<{ date: string; success: number; failure: number }>;
  code_trend: Array<{ date: string; activated: number; expired: number; active: number }>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiFailure = {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
  };
};
