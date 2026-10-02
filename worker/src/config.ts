import { base64UrlToBytes } from "./crypto";
import { ApiError, Bindings } from "./types";

const CORE_SECRET_KEYS = ["JWT_SECRET", "CODE_HMAC_SECRET", "APP_SECRET_HMAC_SECRET", "DEVICE_HMAC_SECRET"] as const;
const PLACEHOLDER_SECRET = "replace-with-a-long-random-secret";

// Required signing-key env validated with the same requireEnv + exact-placeholder
// pattern as the core secrets (design §4.3). LICENSE_SIGNING_PUBLIC_KEY is a
// Binding but is not secret, so it is not placeholder-checked here.
const SIGNING_SECRET_KEYS = ["LICENSE_SIGNING_PRIVATE_KEY", "LICENSE_SIGNING_KEY_ID"] as const;
const PLACEHOLDER_SIGNING_SECRET = "replace-with-a-signing-key";

// Example value for the optional master-password seed; configuring it verbatim
// is a misconfiguration (AC-B10). Shared with service.ts so the seed path and
// validateEnv agree on what counts as the sentinel.
export const PLACEHOLDER_MASTER_PASSWORD = "replace-with-a-master-password";

// Ed25519 private keys are imported via WebCrypto, which only accepts the PKCS8
// format for private keys (raw import is unsupported). A PKCS8-encoded Ed25519
// private key is exactly 48 bytes. signing.ts must import with "pkcs8" to match.
const ED25519_PKCS8_PRIVATE_KEY_BYTES = 48;

export function requireEnv(env: Bindings, key: keyof Bindings): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(500, "CONFLICT", `${String(key)} is not configured`);
  }
  return value.trim();
}

export function validateEnv(env: Bindings): void {
  for (const key of CORE_SECRET_KEYS) {
    const value = requireEnv(env, key);
    if (value === PLACEHOLDER_SECRET) {
      throw new ApiError(500, "CONFLICT", `${key} must not use the example placeholder value`);
    }
  }

  for (const key of SIGNING_SECRET_KEYS) {
    const value = requireEnv(env, key);
    if (value === PLACEHOLDER_SIGNING_SECRET) {
      throw new ApiError(500, "CONFLICT", `${key} must not use the example placeholder value`);
    }
  }

  // After presence/placeholder checks, assert the private key decodes to a
  // well-formed PKCS8 Ed25519 key; a malformed key fails this first request.
  const privateKeyValue = requireEnv(env, "LICENSE_SIGNING_PRIVATE_KEY");
  let privateKeyBytes: Uint8Array;
  try {
    privateKeyBytes = base64UrlToBytes(privateKeyValue);
  } catch {
    throw new ApiError(500, "CONFLICT", "LICENSE_SIGNING_PRIVATE_KEY is not valid base64url");
  }
  if (privateKeyBytes.length !== ED25519_PKCS8_PRIVATE_KEY_BYTES) {
    throw new ApiError(500, "CONFLICT", "LICENSE_SIGNING_PRIVATE_KEY is not a valid Ed25519 private key");
  }

  // Previous-key rotation vars are optional, validated together only if present.
  const previousPublicKey = normalizeOptionalEnv(env.LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY);
  const previousKeyId = normalizeOptionalEnv(env.LICENSE_SIGNING_PREVIOUS_KEY_ID);
  if ((previousPublicKey && !previousKeyId) || (!previousPublicKey && previousKeyId)) {
    throw new ApiError(
      500,
      "CONFLICT",
      "LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY and LICENSE_SIGNING_PREVIOUS_KEY_ID must be configured together"
    );
  }

  const bootstrapUsername = normalizeOptionalEnv(env.ADMIN_BOOTSTRAP_USERNAME);
  const bootstrapPassword = normalizeOptionalEnv(env.ADMIN_BOOTSTRAP_PASSWORD);
  if ((bootstrapUsername && !bootstrapPassword) || (!bootstrapUsername && bootstrapPassword)) {
    throw new ApiError(500, "CONFLICT", "ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD must be configured together");
  }
  if (bootstrapPassword === "change-me-before-use") {
    throw new ApiError(500, "CONFLICT", "ADMIN_BOOTSTRAP_PASSWORD must not use the example placeholder value");
  }

  // Standalone optional master-password seed (AC-B10/B10a): absence is fine, but
  // the literal example value is a misconfiguration we refuse to boot with.
  const masterPassword = normalizeOptionalEnv(env.ADMIN_MASTER_PASSWORD);
  if (masterPassword === PLACEHOLDER_MASTER_PASSWORD) {
    throw new ApiError(500, "CONFLICT", "ADMIN_MASTER_PASSWORD must not use the example placeholder value");
  }
}

export function normalizeOptionalEnv(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
