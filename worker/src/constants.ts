export const APP_STATUS = {
  ACTIVE: "active",
  DISABLED: "disabled"
} as const;

export const APP_STATUS_VALUES = [APP_STATUS.ACTIVE, APP_STATUS.DISABLED] as const;
export type AppStatus = (typeof APP_STATUS_VALUES)[number];

// Management role, stored in admin_users.user_role — the sole role axis after
// multi-tenancy removal. `admin` manages users; `staff` cannot.
export const USER_ROLE = {
  ADMIN: "admin",
  STAFF: "staff"
} as const;

export const USER_ROLE_VALUES = [USER_ROLE.ADMIN, USER_ROLE.STAFF] as const;
export type UserRole = (typeof USER_ROLE_VALUES)[number];

export function isUserRole(value: string): value is UserRole {
  return includesValue(USER_ROLE_VALUES, value);
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
  EXPIRED: "expired"
} as const;

export const CODE_LIST_STATUS_VALUES = [
  CODE_STATUS.UNUSED,
  CODE_STATUS.ACTIVE,
  CODE_DERIVED_STATUS.DISABLED,
  CODE_STATUS.DELETED,
  CODE_DERIVED_STATUS.EXPIRED
] as const;
export type CodeListStatus = (typeof CODE_LIST_STATUS_VALUES)[number];

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
  ,HEARTBEAT: "heartbeat"
  ,RENEW: "renew"
  ,SESSION_KICK: "session_kick"
  ,USER_CREATE: "user_create"
  ,USER_RESET_PASSWORD: "user_reset_password"
  ,USER_KICK: "user_kick"
  ,USER_SET_ROLE: "user_set_role"
} as const;

export const LOG_ACTION_VALUES = [
  LOG_ACTION.BATCH_GENERATE,
  LOG_ACTION.ACTIVATE,
  LOG_ACTION.VERIFY,
  LOG_ACTION.UNBIND_DEVICE,
  LOG_ACTION.MANUAL_UNBIND_DEVICE,
  LOG_ACTION.DELETE_CODE,
  LOG_ACTION.DISABLE_CODE,
  LOG_ACTION.ENABLE_CODE,
  LOG_ACTION.DISABLE_APP,
  LOG_ACTION.ENABLE_APP,
  LOG_ACTION.ROTATE_APP_SECRET
  ,LOG_ACTION.HEARTBEAT
  ,LOG_ACTION.RENEW
  ,LOG_ACTION.SESSION_KICK
  ,LOG_ACTION.USER_CREATE
  ,LOG_ACTION.USER_RESET_PASSWORD
  ,LOG_ACTION.USER_KICK
  ,LOG_ACTION.USER_SET_ROLE
] as const;
export type LogAction = (typeof LOG_ACTION_VALUES)[number];

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
  CONFLICT: "CONFLICT"
  ,SESSION_LIMIT_REACHED: "SESSION_LIMIT_REACHED"
  ,SESSION_REVOKED: "SESSION_REVOKED"
  ,SESSION_EXPIRED: "SESSION_EXPIRED"
  ,PASSWORD_CHANGE_REQUIRED: "PASSWORD_CHANGE_REQUIRED"
  ,PROTOCOL_UNSUPPORTED: "PROTOCOL_UNSUPPORTED"
  ,ACTIVATION_LIMIT_REACHED: "ACTIVATION_LIMIT_REACHED"
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
  ERROR_CODE.CONFLICT
  ,ERROR_CODE.SESSION_LIMIT_REACHED
  ,ERROR_CODE.SESSION_REVOKED
  ,ERROR_CODE.SESSION_EXPIRED
  ,ERROR_CODE.PASSWORD_CHANGE_REQUIRED
  ,ERROR_CODE.PROTOCOL_UNSUPPORTED
  ,ERROR_CODE.ACTIVATION_LIMIT_REACHED
] as const;
export type ErrorCode = (typeof ERROR_CODE_VALUES)[number];

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

export const SECURITY_REASON_CODE = {
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  PAYLOAD_TAMPERED: "PAYLOAD_TAMPERED",
  CLOCK_ROLLBACK: "CLOCK_ROLLBACK",
  KEY_ID_UNKNOWN: "KEY_ID_UNKNOWN",
  PROTOCOL_UNSUPPORTED: "PROTOCOL_UNSUPPORTED",
  REPLAY_SUSPECTED: "REPLAY_SUSPECTED",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE"
} as const;

export const SECURITY_REASON_CODE_VALUES = [
  SECURITY_REASON_CODE.SIGNATURE_INVALID,
  SECURITY_REASON_CODE.PAYLOAD_TAMPERED,
  SECURITY_REASON_CODE.CLOCK_ROLLBACK,
  SECURITY_REASON_CODE.KEY_ID_UNKNOWN,
  SECURITY_REASON_CODE.PROTOCOL_UNSUPPORTED,
  SECURITY_REASON_CODE.REPLAY_SUSPECTED,
  SECURITY_REASON_CODE.MALFORMED_RESPONSE
] as const;
export type SecurityReasonCode = (typeof SECURITY_REASON_CODE_VALUES)[number];

// Report-driven subset of SECURITY_REASON_CODE that can place a license on HOLD,
// plus the admin-initiated manual hold reason.
export const HOLD_REASON_CODE = {
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  PAYLOAD_TAMPERED: "PAYLOAD_TAMPERED",
  CLOCK_ROLLBACK: "CLOCK_ROLLBACK",
  REPLAY_SUSPECTED: "REPLAY_SUSPECTED",
  ADMIN_MANUAL: "ADMIN_MANUAL"
} as const;

export const HOLD_REASON_CODE_VALUES = [
  HOLD_REASON_CODE.SIGNATURE_INVALID,
  HOLD_REASON_CODE.PAYLOAD_TAMPERED,
  HOLD_REASON_CODE.CLOCK_ROLLBACK,
  HOLD_REASON_CODE.REPLAY_SUSPECTED,
  HOLD_REASON_CODE.ADMIN_MANUAL
] as const;
export type HoldReasonCode = (typeof HOLD_REASON_CODE_VALUES)[number];

export function isAppStatus(value: string): value is AppStatus {
  return includesValue(APP_STATUS_VALUES, value);
}

export function isCodeListStatus(value: string): value is CodeListStatus {
  return includesValue(CODE_LIST_STATUS_VALUES, value);
}

export function isCodeToggleStatus(value: string): value is CodeToggleStatus {
  return includesValue(CODE_TOGGLE_STATUS_VALUES, value);
}

export function isCodeBulkAction(value: string): value is CodeBulkAction {
  return includesValue(CODE_BULK_ACTION_VALUES, value);
}

export function isSecurityEventType(value: string): value is SecurityEventType {
  return includesValue(SECURITY_EVENT_TYPE_VALUES, value);
}

export function isSecurityReasonCode(value: string): value is SecurityReasonCode {
  return includesValue(SECURITY_REASON_CODE_VALUES, value);
}

export function isHoldReasonCode(value: string): value is HoldReasonCode {
  return includesValue(HOLD_REASON_CODE_VALUES, value);
}

function includesValue<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}
