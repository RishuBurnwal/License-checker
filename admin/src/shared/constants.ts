export const APP_STATUS = {
  ACTIVE: "active",
  DISABLED: "disabled"
} as const;

export const APP_STATUS_VALUES = [APP_STATUS.ACTIVE, APP_STATUS.DISABLED] as const;
export type AppStatus = (typeof APP_STATUS_VALUES)[number];

type Translate = (key: string) => string;

export function getAppStatusValueEnum(t: Translate) {
  return {
    [APP_STATUS.ACTIVE]: { text: t("status.appActive"), status: "Success" },
    [APP_STATUS.DISABLED]: { text: t("status.appDisabled"), status: "Warning" }
  } as const;
}

export const CODE_STATUS = {
  UNUSED: "unused",
  ACTIVE: "active",
  DELETED: "deleted"
} as const;

export const CODE_STATUS_VALUES = [CODE_STATUS.UNUSED, CODE_STATUS.ACTIVE, CODE_STATUS.DELETED] as const;
export type CodeStatus = (typeof CODE_STATUS_VALUES)[number];

export const CODE_DERIVED_STATUS = {
  DISABLED: "disabled",
  EXPIRED: "expired",
  HOLD: "hold"
} as const;

export const CODE_LIST_STATUS_VALUES = [
  CODE_STATUS.UNUSED,
  CODE_STATUS.ACTIVE,
  CODE_DERIVED_STATUS.DISABLED,
  CODE_DERIVED_STATUS.EXPIRED,
  CODE_STATUS.DELETED
] as const;
export type CodeListStatus = (typeof CODE_LIST_STATUS_VALUES)[number];

// Derives the status shown in the admin console from a code row, mirroring the
// Worker's deriveSignedStatus priority: deleted -> hold -> disabled -> unused -> expired -> active.
export type CodeDisplayStatus = CodeStatus | (typeof CODE_DERIVED_STATUS)[keyof typeof CODE_DERIVED_STATUS];

export function deriveCodeDisplayStatus(code: {
  status: CodeStatus;
  hold_at: string | null;
  disabled_at: string | null;
  expires_at: string | null;
}): CodeDisplayStatus {
  if (code.status === CODE_STATUS.DELETED) {
    return CODE_STATUS.DELETED;
  }
  if (code.hold_at) {
    return CODE_DERIVED_STATUS.HOLD;
  }
  if (code.disabled_at) {
    return CODE_DERIVED_STATUS.DISABLED;
  }
  if (code.status === CODE_STATUS.UNUSED) {
    return CODE_STATUS.UNUSED;
  }
  if (code.expires_at !== null && new Date(code.expires_at).getTime() < Date.now()) {
    return CODE_DERIVED_STATUS.EXPIRED;
  }
  return CODE_STATUS.ACTIVE;
}

export function getCodeListStatusValueEnum(t: Translate) {
  return {
    [CODE_STATUS.UNUSED]: { text: t("status.unused") },
    [CODE_STATUS.ACTIVE]: { text: t("status.active") },
    [CODE_DERIVED_STATUS.DISABLED]: { text: t("status.codeDisabled") },
    [CODE_DERIVED_STATUS.EXPIRED]: { text: t("status.expired") },
    [CODE_STATUS.DELETED]: { text: t("status.deleted") }
  } as const;
}

// Management role (mirrors worker USER_ROLE). admin manages users; staff cannot.
export const USER_ROLE = {
  ADMIN: "admin",
  STAFF: "staff"
} as const;

export const USER_ROLE_VALUES = [USER_ROLE.ADMIN, USER_ROLE.STAFF] as const;
export type UserRole = (typeof USER_ROLE_VALUES)[number];

export function getUserRoleValueEnum(t: Translate) {
  return {
    [USER_ROLE.ADMIN]: { text: t("users.roleAdmin") },
    [USER_ROLE.STAFF]: { text: t("users.roleStaff") }
  } as const;
}

export const CODE_TOGGLE_STATUS = {
  ENABLED: "enabled",
  DISABLED: "disabled"
} as const;

export const CODE_TOGGLE_STATUS_VALUES = [CODE_TOGGLE_STATUS.ENABLED, CODE_TOGGLE_STATUS.DISABLED] as const;
export type CodeToggleStatus = (typeof CODE_TOGGLE_STATUS_VALUES)[number];

export const CODE_BULK_ACTION = {
  DELETE: "delete",
  ENABLE: "enable",
  DISABLE: "disable"
} as const;

export const CODE_BULK_ACTION_VALUES = [
  CODE_BULK_ACTION.DELETE,
  CODE_BULK_ACTION.ENABLE,
  CODE_BULK_ACTION.DISABLE
] as const;
export type CodeBulkAction = (typeof CODE_BULK_ACTION_VALUES)[number];

export const LOG_ACTION = {
  BATCH_GENERATE: "batch_generate",
  ACTIVATE: "activate",
  VERIFY: "verify",
  UNBIND_DEVICE: "unbind_device",
  MANUAL_UNBIND_DEVICE: "manual_unbind_device",
  DELETE_CODE: "delete_code",
  DISABLE_CODE: "disable_code",
  ENABLE_CODE: "enable_code",
  DISABLE_APP: "disable_app",
  ENABLE_APP: "enable_app",
  ROTATE_APP_SECRET: "rotate_app_secret"
} as const;

export function getLogActionValueEnum(t: Translate) {
  return {
    [LOG_ACTION.BATCH_GENERATE]: { text: t("logs.batchGenerate") },
    [LOG_ACTION.ACTIVATE]: { text: t("logs.activate") },
    [LOG_ACTION.VERIFY]: { text: t("logs.verify") },
    [LOG_ACTION.UNBIND_DEVICE]: { text: t("logs.unbindDevice") },
    [LOG_ACTION.MANUAL_UNBIND_DEVICE]: { text: t("logs.manualUnbindDevice") },
    [LOG_ACTION.DELETE_CODE]: { text: t("logs.deleteCode") },
    [LOG_ACTION.DISABLE_CODE]: { text: t("logs.disableCode") },
    [LOG_ACTION.ENABLE_CODE]: { text: t("logs.enableCode") },
    [LOG_ACTION.DISABLE_APP]: { text: t("logs.disableApp") },
    [LOG_ACTION.ENABLE_APP]: { text: t("logs.enableApp") },
    [LOG_ACTION.ROTATE_APP_SECRET]: { text: t("logs.rotateAppSecret") }
  } as const;
}

export type LogAction = (typeof LOG_ACTION)[keyof typeof LOG_ACTION];

export const LOG_RESULT = {
  SUCCESS: "success",
  FAILURE: "failure"
} as const;

export const LOG_RESULT_VALUES = [LOG_RESULT.SUCCESS, LOG_RESULT.FAILURE] as const;
export type LogResult = (typeof LOG_RESULT_VALUES)[number];

export const MAX_CODE_BATCH_QUANTITY = 300;

export const ERROR_CODE = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  APP_DISABLED: "APP_DISABLED",
  INVALID_APP_SECRET: "INVALID_APP_SECRET",
  INVALID_CODE: "INVALID_CODE",
  CODE_DISABLED: "CODE_DISABLED",
  CODE_DELETED: "CODE_DELETED",
  CODE_EXPIRED: "CODE_EXPIRED",
  DEVICE_MISMATCH: "DEVICE_MISMATCH",
  REBINDS_EXCEEDED: "REBINDS_EXCEEDED",
  REBINDS_TOO_FREQUENT: "REBINDS_TOO_FREQUENT",
  CONFLICT: "CONFLICT",
  SESSION_LIMIT_REACHED: "SESSION_LIMIT_REACHED",
  SESSION_REVOKED: "SESSION_REVOKED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  PASSWORD_CHANGE_REQUIRED: "PASSWORD_CHANGE_REQUIRED"
} as const;

export const ERROR_CODE_VALUES = [
  ERROR_CODE.BAD_REQUEST,
  ERROR_CODE.UNAUTHORIZED,
  ERROR_CODE.FORBIDDEN,
  ERROR_CODE.NOT_FOUND,
  ERROR_CODE.APP_DISABLED,
  ERROR_CODE.INVALID_APP_SECRET,
  ERROR_CODE.INVALID_CODE,
  ERROR_CODE.CODE_DISABLED,
  ERROR_CODE.CODE_DELETED,
  ERROR_CODE.CODE_EXPIRED,
  ERROR_CODE.DEVICE_MISMATCH,
  ERROR_CODE.REBINDS_EXCEEDED,
  ERROR_CODE.REBINDS_TOO_FREQUENT,
  ERROR_CODE.CONFLICT,
  ERROR_CODE.SESSION_LIMIT_REACHED,
  ERROR_CODE.SESSION_REVOKED,
  ERROR_CODE.SESSION_EXPIRED,
  ERROR_CODE.PASSWORD_CHANGE_REQUIRED
] as const;
export type ErrorCode = (typeof ERROR_CODE_VALUES)[number];

// Security event types written by the Worker (worker/src/constants.ts SECURITY_EVENT_TYPE).
export const SECURITY_EVENT_TYPE = {
  VERIFY: "VERIFY",
  REPORT: "REPORT",
  PRODUCT_MISMATCH: "PRODUCT_MISMATCH",
  AUTO_HOLD: "AUTO_HOLD",
  ADMIN_HOLD: "ADMIN_HOLD",
  ADMIN_APPROVE: "ADMIN_APPROVE",
  LIMIT_REACHED: "LIMIT_REACHED",
  REPEATED_FAILURE: "REPEATED_FAILURE"
} as const;

export const SECURITY_EVENT_TYPE_VALUES = [
  SECURITY_EVENT_TYPE.VERIFY,
  SECURITY_EVENT_TYPE.REPORT,
  SECURITY_EVENT_TYPE.PRODUCT_MISMATCH,
  SECURITY_EVENT_TYPE.AUTO_HOLD,
  SECURITY_EVENT_TYPE.ADMIN_HOLD,
  SECURITY_EVENT_TYPE.ADMIN_APPROVE,
  SECURITY_EVENT_TYPE.LIMIT_REACHED,
  SECURITY_EVENT_TYPE.REPEATED_FAILURE
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPE_VALUES)[number];

export function getSecurityEventTypeLabel(value: string, t: Translate): string {
  const key = SECURITY_EVENT_TYPE_LABEL_KEYS[value as SecurityEventType];
  return key ? t(key) : value;
}

const SECURITY_EVENT_TYPE_LABEL_KEYS: Record<SecurityEventType, string> = {
  [SECURITY_EVENT_TYPE.VERIFY]: "security.eventVerify",
  [SECURITY_EVENT_TYPE.REPORT]: "security.eventReport",
  [SECURITY_EVENT_TYPE.PRODUCT_MISMATCH]: "security.eventProductMismatch",
  [SECURITY_EVENT_TYPE.AUTO_HOLD]: "security.eventAutoHold",
  [SECURITY_EVENT_TYPE.ADMIN_HOLD]: "security.eventAdminHold",
  [SECURITY_EVENT_TYPE.ADMIN_APPROVE]: "security.eventAdminApprove",
  [SECURITY_EVENT_TYPE.LIMIT_REACHED]: "security.eventLimitReached",
  [SECURITY_EVENT_TYPE.REPEATED_FAILURE]: "security.eventRepeatedFailure"
};

// Security reason codes written by the Worker (worker/src/constants.ts SECURITY_REASON_CODE + ADMIN_MANUAL hold reason).
export const SECURITY_REASON_CODE = {
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  PAYLOAD_TAMPERED: "PAYLOAD_TAMPERED",
  CLOCK_ROLLBACK: "CLOCK_ROLLBACK",
  KEY_ID_UNKNOWN: "KEY_ID_UNKNOWN",
  PROTOCOL_UNSUPPORTED: "PROTOCOL_UNSUPPORTED",
  REPLAY_SUSPECTED: "REPLAY_SUSPECTED",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  ADMIN_MANUAL: "ADMIN_MANUAL"
} as const;

export type SecurityReasonCode = (typeof SECURITY_REASON_CODE)[keyof typeof SECURITY_REASON_CODE];

export function getSecurityReasonCodeLabel(value: string, t: Translate): string {
  const key = SECURITY_REASON_CODE_LABEL_KEYS[value as SecurityReasonCode];
  return key ? t(key) : value;
}

const SECURITY_REASON_CODE_LABEL_KEYS: Record<SecurityReasonCode, string> = {
  [SECURITY_REASON_CODE.SIGNATURE_INVALID]: "security.reasonSignatureInvalid",
  [SECURITY_REASON_CODE.PAYLOAD_TAMPERED]: "security.reasonPayloadTampered",
  [SECURITY_REASON_CODE.CLOCK_ROLLBACK]: "security.reasonClockRollback",
  [SECURITY_REASON_CODE.KEY_ID_UNKNOWN]: "security.reasonKeyIdUnknown",
  [SECURITY_REASON_CODE.PROTOCOL_UNSUPPORTED]: "security.reasonProtocolUnsupported",
  [SECURITY_REASON_CODE.REPLAY_SUSPECTED]: "security.reasonReplaySuspected",
  [SECURITY_REASON_CODE.MALFORMED_RESPONSE]: "security.reasonMalformedResponse",
  [SECURITY_REASON_CODE.ADMIN_MANUAL]: "security.reasonAdminManual"
};

export const APP_PLATFORM_OPTIONS = [
  { value: "mobile", label: "Mobile" },
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
  { value: "desktop", label: "Desktop" },
  { value: "windows", label: "Windows" },
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "web", label: "Web" },
  { value: "h5", label: "H5" },
  { value: "wechat_mini_program", label: "WeChat Mini Program" },
  { value: "plugin", label: "Plugin" },
  { value: "browser_extension", label: "Browser Extension" },
  { value: "server", label: "Server" },
  { value: "api", label: "API" },
  { value: "cli", label: "CLI" }
] as const;

export type AppPlatform = (typeof APP_PLATFORM_OPTIONS)[number]["value"];
