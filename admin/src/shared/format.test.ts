import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CODE_DERIVED_STATUS,
  CODE_STATUS,
  deriveCodeDisplayStatus,
  getSecurityEventTypeLabel,
  getSecurityReasonCodeLabel
} from "./constants.ts";

type CodeRow = Parameters<typeof deriveCodeDisplayStatus>[0];

function row(overrides: Partial<CodeRow> = {}): CodeRow {
  return {
    status: CODE_STATUS.ACTIVE,
    hold_at: null,
    disabled_at: null,
    expires_at: null,
    ...overrides
  };
}

describe("deriveCodeDisplayStatus", () => {
  it("ranks deleted above every other state", () => {
    assert.equal(
      deriveCodeDisplayStatus(row({ status: CODE_STATUS.DELETED, hold_at: "2026-01-01T00:00:00Z", disabled_at: "2026-01-01T00:00:00Z" })),
      CODE_STATUS.DELETED
    );
  });

  it("reports the hold state above disabled, unused, and expired", () => {
    assert.equal(
      deriveCodeDisplayStatus(row({ hold_at: "2026-01-01T00:00:00Z", disabled_at: "2026-01-01T00:00:00Z" })),
      CODE_DERIVED_STATUS.HOLD
    );
  });

  it("reports disabled when there is no hold", () => {
    assert.equal(deriveCodeDisplayStatus(row({ disabled_at: "2026-01-01T00:00:00Z" })), CODE_DERIVED_STATUS.DISABLED);
  });

  it("reports unused for a never-activated code", () => {
    assert.equal(deriveCodeDisplayStatus(row({ status: CODE_STATUS.UNUSED })), CODE_STATUS.UNUSED);
  });

  it("reports expired for a past expiry", () => {
    assert.equal(deriveCodeDisplayStatus(row({ expires_at: "2000-01-01T00:00:00Z" })), CODE_DERIVED_STATUS.EXPIRED);
  });

  it("reports active for a future expiry", () => {
    assert.equal(deriveCodeDisplayStatus(row({ expires_at: "2999-01-01T00:00:00Z" })), CODE_STATUS.ACTIVE);
  });
});

describe("security label helpers", () => {
  const t = (key: string) => key;

  it("maps known event types to translation keys", () => {
    assert.equal(getSecurityEventTypeLabel("ADMIN_HOLD", t), "security.eventAdminHold");
    assert.equal(getSecurityEventTypeLabel("AUTO_HOLD", t), "security.eventAutoHold");
  });

  it("maps known reason codes to translation keys", () => {
    assert.equal(getSecurityReasonCodeLabel("SIGNATURE_INVALID", t), "security.reasonSignatureInvalid");
    assert.equal(getSecurityReasonCodeLabel("ADMIN_MANUAL", t), "security.reasonAdminManual");
  });

  it("passes unknown values through unchanged", () => {
    assert.equal(getSecurityEventTypeLabel("SOMETHING_NEW", t), "SOMETHING_NEW");
    assert.equal(getSecurityReasonCodeLabel("SOMETHING_NEW", t), "SOMETHING_NEW");
  });
});
