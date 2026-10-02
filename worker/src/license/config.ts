import { requireEnv } from "../config";
import { Bindings } from "../types";

// Centralized licensing configuration (design §6.4 / FR-13, AC-38). Keeps the
// signing key id, supported protocol versions, grace/verification intervals,
// and the auto-hold thresholds in one place instead of scattering magic
// numbers across the service. Values come from env where provided, with the
// safe defaults pinned by §6.3/§6.4.

export type AutoHoldConfig = {
  reportHoldDistinctThreshold: number;
  reportHoldWindowSeconds: number;
  singleHighSeverityReportHolds: boolean;
  repeatedFailureThreshold: number;
  repeatedFailureWindowSeconds: number;
  repeatedFailureHolds: boolean;
};

export type LicensingConfig = {
  keyId: string;
  supportedProtocolVersions: number[];
  currentProtocolVersion: number;
  defaultGraceSeconds: number;
  verificationIntervalSeconds: number;
  autoHold: AutoHoldConfig;
};

const DEFAULT_GRACE_SECONDS = 0;
const DEFAULT_VERIFICATION_INTERVAL_SECONDS = 3600;

// §6.3/§6.4 safe defaults.
const DEFAULT_AUTO_HOLD: AutoHoldConfig = {
  reportHoldDistinctThreshold: 2,
  reportHoldWindowSeconds: 86400,
  singleHighSeverityReportHolds: false,
  repeatedFailureThreshold: 10,
  repeatedFailureWindowSeconds: 600,
  repeatedFailureHolds: false
};

// Optional numeric env overrides are read defensively (they are not required
// Bindings fields); a missing or malformed value falls back to the default.
function readIntEnv(env: Bindings, key: string, fallback: number): number {
  const value = (env as unknown as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function getLicensingConfig(env: Bindings): LicensingConfig {
  return {
    keyId: requireEnv(env, "LICENSE_SIGNING_KEY_ID"),
    supportedProtocolVersions: [1],
    currentProtocolVersion: 1,
    defaultGraceSeconds: readIntEnv(env, "LICENSE_DEFAULT_GRACE_SECONDS", DEFAULT_GRACE_SECONDS),
    verificationIntervalSeconds: readIntEnv(
      env,
      "LICENSE_VERIFICATION_INTERVAL_SECONDS",
      DEFAULT_VERIFICATION_INTERVAL_SECONDS
    ),
    autoHold: { ...DEFAULT_AUTO_HOLD }
  };
}
