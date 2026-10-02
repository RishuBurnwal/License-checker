import type { AppPlatform, AppStatus, CodeStatus, ErrorCode, LogAction, LogResult } from "./shared/constants";

export type { AppPlatform, AppStatus, CodeBulkAction, CodeListStatus, CodeStatus, CodeToggleStatus, ErrorCode, LogAction, LogResult } from "./shared/constants";

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

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export type UserRole = "admin" | "staff";

export type AdminUser = {
  id: number;
  username: string;
  user_role: UserRole;
  must_change_password?: boolean;
};

export type UserItem = {
  id: number;
  username: string;
  role: UserRole;
  must_change_password: boolean;
  session_epoch: number;
  created_at: string;
  updated_at: string;
};

export type GeneratedPassword = {
  password: string;
  must_change_password: boolean;
};

export type UserSessionItem = {
  id: number;
  epoch: number;
  issued_at: string;
  expires_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  user_agent: string | null;
  active: boolean;
};

export type UserSessionList = {
  current_epoch: number;
  items: UserSessionItem[];
};

export type AppItem = {
  id: number;
  app_id: string;
  name: string;
  description: string | null;
  purchase_url: string | null;
  platform: AppPlatform;
  status: AppStatus;
  created_at: string;
  updated_at: string;
};

export type PlanItem = {
  id: number;
  code: string;
  name: string;
  duration_days: number;
  sort_order: number;
  created_at: string;
};

export type CodeItem = {
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

export type CodeActivationItem = {
  id: number;
  status: "active" | "released";
  activated_at: string;
  last_seen_at: string;
  released_at: string | null;
  created_at: string;
};

export type CodeActivationList = {
  max_activations: number | null;
  active_count: number;
  items: CodeActivationItem[];
};

export type SecurityEventItem = {
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

export type LogItem = {
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
