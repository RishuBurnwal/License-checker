import { ApiError } from "../types";

// Canonicalization for the signed license payload (design §4.1 / AC-2, AC-3,
// AC-16..23). The payload is a flat JSON object whose values are only string,
// integer number, boolean, or null. Both the worker (producer) and the checker
// (consumer) must emit byte-identical canonical bytes, so this spec is pinned:
//
//  1. Keys are emitted in the fixed lexicographic order below (the 12 v1 keys).
//  2. The object is rebuilt by inserting keys in that order, then serialized
//     with JSON.stringify (scalars only => deterministic, no whitespace).
//  3. The resulting string is UTF-8 encoded via TextEncoder; those bytes are
//     the message that is signed and verified.
//
// Integer fields are guarded to JS safe integers and the builder throws BEFORE
// returning (fail-closed), so a non-conforming payload is never signed.

const encoder = new TextEncoder();

// The fixed, lexicographically-sorted v1 key order (§4.1 step 2).
export const CANONICAL_KEYS = [
  "activation_allowed",
  "expires_at",
  "grace_period_seconds",
  "installation_id",
  "issued_at",
  "key_id",
  "license_id",
  "plan",
  "product_id",
  "protocol_version",
  "server_time",
  "status"
] as const;

type CanonicalKey = (typeof CANONICAL_KEYS)[number];

// Integer fields that must pass the safe-integer guard (§4.1 step 6).
const INTEGER_KEYS: readonly CanonicalKey[] = ["grace_period_seconds", "license_id", "protocol_version"];

export type LicensePayload = {
  activation_allowed: boolean;
  expires_at: string | null;
  grace_period_seconds: number;
  installation_id: string;
  issued_at: string;
  key_id: string;
  license_id: number;
  plan: string;
  product_id: string;
  protocol_version: number;
  server_time: string;
  status: string;
};

function isSafeInteger(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/**
 * Produce the canonical UTF-8 byte encoding of a signed license payload.
 *
 * Fails closed: an integer field that is not a JS safe integer (a float, NaN,
 * or magnitude >= 2^53) throws a 500 CONFLICT ApiError BEFORE any bytes are
 * returned, so the caller can never sign a non-conforming payload.
 */
export function canonicalize(payload: LicensePayload): Uint8Array {
  for (const key of INTEGER_KEYS) {
    const value = payload[key];
    if (typeof value !== "number" || !isSafeInteger(value)) {
      throw new ApiError(500, "CONFLICT", `canonical payload field ${key} is not a safe integer`);
    }
  }

  const sorted: Record<string, unknown> = {};
  for (const key of CANONICAL_KEYS) {
    sorted[key] = payload[key];
  }

  return encoder.encode(JSON.stringify(sorted));
}
