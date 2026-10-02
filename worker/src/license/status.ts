import { CODE_STATUS } from "../constants";
import { isExpired } from "../time";
import { ActivationCodeRow } from "../types";

// Signed-status derivation (design §5.1 / FR-5, AC-6..10). Maps the persisted
// four-dimension model (status / disabled_at / hold_at / expires_at) to the
// signed vocabulary at response time; it never mutates the stored status.

export const SIGNED_STATUS = {
  ACTIVE: "active",
  EXPIRED: "expired",
  REVOKED: "revoked",
  SUSPENDED: "suspended",
  HOLD: "hold"
} as const;

export const SIGNED_STATUS_VALUES = [
  SIGNED_STATUS.ACTIVE,
  SIGNED_STATUS.EXPIRED,
  SIGNED_STATUS.REVOKED,
  SIGNED_STATUS.SUSPENDED,
  SIGNED_STATUS.HOLD
] as const;
export type SignedStatus = (typeof SIGNED_STATUS_VALUES)[number];

// Sentinel for the sixth (unused / not-yet-activatable) branch. The caller maps
// this to a signed refusal / INVALID_CODE; it is never a valid signed status
// and never reported as `active`.
export const SIGNED_STATUS_NOT_ACTIVATABLE = "not_activatable" as const;

export type DerivedSignedStatus = SignedStatus | typeof SIGNED_STATUS_NOT_ACTIVATABLE;

type DeriveInput = Pick<ActivationCodeRow, "status" | "hold_at" | "disabled_at" | "expires_at">;

/**
 * Derive the signed status from the persisted code row and the current time.
 * Priority order (§5.1): deleted => revoked; hold => hold; disabled =>
 * suspended; active+expired => expired; active => active; otherwise the
 * not-activatable sentinel.
 */
export function deriveSignedStatus(code: DeriveInput, now: Date = new Date()): DerivedSignedStatus {
  if (code.status === CODE_STATUS.DELETED) {
    return SIGNED_STATUS.REVOKED;
  }
  if (code.hold_at !== null) {
    return SIGNED_STATUS.HOLD;
  }
  if (code.disabled_at !== null) {
    return SIGNED_STATUS.SUSPENDED;
  }
  if (code.status === CODE_STATUS.ACTIVE && isExpired(code.expires_at, now)) {
    return SIGNED_STATUS.EXPIRED;
  }
  if (code.status === CODE_STATUS.ACTIVE) {
    return SIGNED_STATUS.ACTIVE;
  }
  return SIGNED_STATUS_NOT_ACTIVATABLE;
}
