import type {
  ApiEnvelope,
  ReportReasonCode,
  ReportResponseData,
  VerifyResponseData
} from "../types";
import { SUPPORTED_PROTOCOL_VERSIONS } from "../types";

// Thin fetch wrapper over the versioned client API (design §3). The server base
// URL is always supplied by the caller (AC-39); the checker appends the fixed
// /api/v1/... paths. The checker understands protocol version 1.
const CLIENT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export class ApiCallError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}${path}`;
}

async function postEnvelope<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(joinUrl(baseUrl, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new ApiCallError(
      error instanceof Error ? error.message : "network request failed",
      "NETWORK_ERROR",
      0
    );
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiCallError("server returned a non-JSON response", "MALFORMED_RESPONSE", response.status);
  }

  if (!envelope.ok) {
    throw new ApiCallError(envelope.error.message, envelope.error.code, response.status);
  }
  return envelope.data;
}

export type VerifyRequest = {
  serverBaseUrl: string;
  appId: string;
  appSecret: string;
  licenseKey: string;
  productId: string;
  installationId: string;
  applicationVersion?: string;
};

/** POST {base}/api/v1/license/verify. */
export function requestVerify(input: VerifyRequest): Promise<VerifyResponseData> {
  const body: Record<string, unknown> = {
    app_id: input.appId,
    app_secret: input.appSecret,
    license_key: input.licenseKey,
    product_id: input.productId,
    installation_id: input.installationId,
    protocol_version: CLIENT_PROTOCOL_VERSION
  };
  if (input.applicationVersion) {
    body.application_version = input.applicationVersion;
  }
  return postEnvelope<VerifyResponseData>(input.serverBaseUrl, "/api/v1/license/verify", body);
}

export type ReportRequest = {
  serverBaseUrl: string;
  appId: string;
  appSecret: string;
  installationId: string;
  licenseKey: string;
  reasonCode: ReportReasonCode;
  detail?: string;
};

/** POST {base}/api/v1/license/report. */
export function requestReport(input: ReportRequest): Promise<ReportResponseData> {
  const body: Record<string, unknown> = {
    app_id: input.appId,
    app_secret: input.appSecret,
    installation_id: input.installationId,
    license_key: input.licenseKey,
    reason_code: input.reasonCode
  };
  if (input.detail) {
    body.detail = input.detail;
  }
  return postEnvelope<ReportResponseData>(input.serverBaseUrl, "/api/v1/license/report", body);
}
