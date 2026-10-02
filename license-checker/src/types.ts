import type { LicensePayload } from "./lib/canonical";

export type { LicensePayload };

// The reason-code allowlist accepted by POST /api/v1/license/report (design §6.1
// / §3.3). Kept in sync with worker/src/constants.ts SECURITY_REASON_CODE.
export const REPORT_REASON_CODES = [
  "SIGNATURE_INVALID",
  "PAYLOAD_TAMPERED",
  "CLOCK_ROLLBACK",
  "KEY_ID_UNKNOWN",
  "PROTOCOL_UNSUPPORTED",
  "REPLAY_SUSPECTED",
  "MALFORMED_RESPONSE"
] as const;
export type ReportReasonCode = (typeof REPORT_REASON_CODES)[number];

// Protocol versions this checker itself understands (AC-22/27). A signed payload
// carrying any other protocol_version is rejected.
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

/** A license entry the user has added to the checker (persisted in localStorage). */
export type StoredLicense = {
  id: string;
  label: string;
  serverBaseUrl: string;
  licenseKey: string;
  productId: string;
  installationId: string;
  appSecret: string;
  /** Highest server_time accepted so far; the freshness anchor (§8.4). */
  lastSeenServerTime: string | null;
  createdAt: string;
};

/** The success data of POST /api/v1/license/verify (design §3.1). */
export type VerifyResponseData = {
  payload: LicensePayload;
  signature: string;
  public_key_id: string;
  verification_interval_seconds: number;
};

/** The success data of POST /api/v1/license/report (design §3.3). */
export type ReportResponseData = {
  recorded: boolean;
  held: boolean;
};

/** Shared success/failure envelope returned by the worker (worker/src/http.ts). */
export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
