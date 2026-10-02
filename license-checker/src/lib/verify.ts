import { verifyAsync as nobleVerifyAsync } from "@noble/ed25519";
import { lookupPublicKey } from "../config/publicKeys";
import { SUPPORTED_PROTOCOL_VERSIONS } from "../types";
import type { LicensePayload } from "../types";
import { base64UrlToBytes } from "./base64url";
import { canonicalize } from "./canonical";

// All Ed25519 verification is isolated to this file (mirrors the worker keeping
// its sign/verify surface in signing.ts). crypto.subtle Ed25519 is preferred; if
// the runtime lacks it (feature-detected once at startup via a known public key)
// the @noble/ed25519 fallback is used. The checker holds PUBLIC keys only (AC-46).

const SKEW_SECONDS = 300; // §8.4 step 3 clock-skew allowance.

// A well-known public key used purely to feature-detect crypto.subtle Ed25519
// support (the dev/test public key; importing it proves nothing secret).
const FEATURE_DETECT_PUBLIC_KEY = "TOwxe9EweGiDchaoYOmHY_GuOZrgMiZAkueFVVmBxTQ";

const ED25519_ALGORITHM = { name: "Ed25519" } as const;

let subtleSupportPromise: Promise<boolean> | null = null;

/**
 * Feature-detect WebCrypto Ed25519 by importing a known raw public key. Cached so
 * the probe runs at most once. Any throw => fall back to @noble/ed25519.
 */
export function detectSubtleEd25519(): Promise<boolean> {
  if (subtleSupportPromise) {
    return subtleSupportPromise;
  }
  subtleSupportPromise = (async () => {
    try {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) {
        return false;
      }
      await subtle.importKey(
        "raw",
        base64UrlToBytes(FEATURE_DETECT_PUBLIC_KEY) as BufferSource,
        ED25519_ALGORITHM,
        false,
        ["verify"]
      );
      return true;
    } catch {
      return false;
    }
  })();
  return subtleSupportPromise;
}

/**
 * Verify a detached base64url Ed25519 signature over the given bytes with a
 * base64url raw public key. Uses crypto.subtle when available, else @noble.
 */
export async function verifyEd25519(
  publicKeyBase64Url: string,
  payloadBytes: Uint8Array,
  signatureBase64Url: string
): Promise<boolean> {
  const publicKeyBytes = base64UrlToBytes(publicKeyBase64Url);
  const signatureBytes = base64UrlToBytes(signatureBase64Url);

  if (await detectSubtleEd25519()) {
    try {
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        publicKeyBytes as BufferSource,
        ED25519_ALGORITHM,
        false,
        ["verify"]
      );
      return await globalThis.crypto.subtle.verify(
        ED25519_ALGORITHM,
        key,
        signatureBytes as BufferSource,
        payloadBytes as BufferSource
      );
    } catch {
      return false;
    }
  }

  try {
    return await nobleVerifyAsync(signatureBytes, payloadBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

// Machine-readable reasons a verification can fail, used to drive the UI's
// "license failed to load" state and the matching /report reason code (§8.4).
export type VerifyFailureReason =
  | "SIGNATURE_INVALID"
  | "KEY_ID_UNKNOWN"
  | "PRODUCT_MISMATCH"
  | "INSTALLATION_MISMATCH"
  | "PROTOCOL_UNSUPPORTED"
  | "CLOCK_ROLLBACK"
  | "STALE"
  | "MALFORMED_RESPONSE";

export type VerifyExpectations = {
  productId: string;
  installationId: string;
  /** Previously accepted highest server_time for this license, or null. */
  lastSeenServerTime: string | null;
  verificationIntervalSeconds: number;
  /** Override "now" (ms since epoch) for deterministic tests. */
  nowMs?: number;
};

export type VerifyOk = {
  ok: true;
  payload: LicensePayload;
  /** The value the caller should persist as the new freshness anchor (§8.4 step 5). */
  nextLastSeenServerTime: string;
};

export type VerifyFail = {
  ok: false;
  reason: VerifyFailureReason;
  message: string;
};

export type VerifyResult = VerifyOk | VerifyFail;

function parseServerTime(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The pinned §8.4 freshness / replay predicate, evaluated against the previously
 * accepted server_time. Pure and side-effect-free: on accept it returns the new
 * anchor the caller must persist; it never mutates storage itself.
 */
export type FreshnessResult = { ok: true; nextLastSeenServerTime: string } | VerifyFail;

export function evaluateFreshness(
  serverTime: string,
  lastSeenServerTime: string | null,
  verificationIntervalSeconds: number,
  nowMs: number
): FreshnessResult {
  const serverMs = parseServerTime(serverTime);
  if (serverMs === null) {
    return { ok: false, reason: "MALFORMED_RESPONSE", message: "server_time is not a valid timestamp" };
  }

  const lastSeenMs = parseServerTime(lastSeenServerTime);

  // Step 1: first-ever check for this license => accept and anchor.
  if (lastSeenMs === null) {
    return checkMaxAge(serverTime, serverMs, serverMs, verificationIntervalSeconds, nowMs);
  }

  // Step 2: clock-rollback / replay — a server_time earlier than the last one seen.
  if (serverMs < lastSeenMs) {
    return { ok: false, reason: "CLOCK_ROLLBACK", message: "server_time is older than the last accepted response" };
  }

  // Step 4: equal is an accepted idempotent re-check (handled by max(...) below).
  // Step 5: the new anchor is max(lastSeen, server_time).
  const nextMs = Math.max(lastSeenMs, serverMs);
  const nextIso = nextMs === serverMs ? serverTime : (lastSeenServerTime as string);
  return checkMaxAge(nextIso, serverMs, nextMs, verificationIntervalSeconds, nowMs);
}

function checkMaxAge(
  nextLastSeenServerTime: string,
  serverMs: number,
  _nextMs: number,
  verificationIntervalSeconds: number,
  nowMs: number
): FreshnessResult {
  // Step 3: stale / max-age — reject if the response is older than the allowed
  // window plus the fixed clock-skew allowance.
  const ageSeconds = (nowMs - serverMs) / 1000;
  if (ageSeconds > verificationIntervalSeconds + SKEW_SECONDS) {
    return { ok: false, reason: "STALE", message: "server_time is older than the freshness window" };
  }
  return { ok: true, nextLastSeenServerTime };
}

/**
 * Full checker-side verification of a /verify response payload+signature:
 * signature validity, key_id is configured, product/installation/protocol match,
 * and the §8.4 freshness predicate. Returns the accepted payload + the next
 * freshness anchor, or a specific failure reason the UI surfaces.
 */
export async function verifyLicenseResponse(
  payload: LicensePayload,
  signatureBase64Url: string,
  expectations: VerifyExpectations
): Promise<VerifyResult> {
  // Re-canonicalize locally; a non-conforming payload (fail-closed) is malformed.
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = canonicalize(payload);
  } catch {
    return { ok: false, reason: "MALFORMED_RESPONSE", message: "payload is not canonicalizable" };
  }

  // Trust only the signed key_id (AC-26): look it up in the embedded public keys.
  const publicKey = lookupPublicKey(payload.key_id);
  if (!publicKey) {
    return { ok: false, reason: "KEY_ID_UNKNOWN", message: `unknown signing key_id: ${payload.key_id}` };
  }

  if (!signatureBase64Url) {
    return { ok: false, reason: "SIGNATURE_INVALID", message: "missing signature" };
  }

  const signatureValid = await verifyEd25519(publicKey, payloadBytes, signatureBase64Url);
  if (!signatureValid) {
    return { ok: false, reason: "SIGNATURE_INVALID", message: "signature verification failed" };
  }

  // Field validation against this installation's expectations.
  if (payload.product_id !== expectations.productId) {
    return { ok: false, reason: "PRODUCT_MISMATCH", message: "product_id does not match this installation" };
  }
  if (payload.installation_id !== expectations.installationId) {
    return { ok: false, reason: "INSTALLATION_MISMATCH", message: "installation_id does not match this installation" };
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(payload.protocol_version as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])) {
    return { ok: false, reason: "PROTOCOL_UNSUPPORTED", message: `unsupported protocol_version: ${payload.protocol_version}` };
  }

  const nowMs = expectations.nowMs ?? Date.now();
  const freshness = evaluateFreshness(
    payload.server_time,
    expectations.lastSeenServerTime,
    expectations.verificationIntervalSeconds,
    nowMs
  );
  if (!freshness.ok) {
    return freshness;
  }

  return { ok: true, payload, nextLastSeenServerTime: freshness.nextLastSeenServerTime };
}
