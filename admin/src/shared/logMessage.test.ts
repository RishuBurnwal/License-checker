import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dictionaries } from "../i18n/messages.ts";
import { ADMIN_ACTION_KEYS, EXACT_MESSAGE_KEYS, formatLogMessage } from "./logMessage.ts";

// Every failure message thrown inside the try blocks of
// `worker/src/service.ts` reaches `logClientFailure` and is persisted to
// `activation_logs.message`. Keep this list in sync when adding an ApiError there.
const LOGGED_CLIENT_FAILURE_MESSAGES = [
  "Activation code was deleted",
  "Activation code is disabled",
  "Activation code has expired",
  "Activation code is bound to another device",
  "Activation code is not bound to a device",
  "Activation code has not been activated",
  "Device fingerprint does not match",
  "Device unbind limit exceeded",
  "Device unbind is cooling down",
  "Device unbind conflict",
  "Activation code was bound by another request",
  "Activation code was activated by another request"
];

const enLogs = (dictionaries.en as { logs: Record<string, string> }).logs;

const t = (key: string, values: Record<string, string | number> = {}) => {
  const templates: Record<string, string> = {
    "logs.alreadyActive": "Already active on this device",
    "logs.activated": "Activated",
    "logs.verified": "Verified",
    "logs.deviceRebound": "Device rebound",
    "logs.deviceUnbound": "Device unbound",
    "logs.codeDeleted": "Activation code was deleted",
    "logs.unbindLimit": "Device unbind limit exceeded",
    "logs.generatedMessage": "Generated {count} {plan} activation codes",
    "logs.deletedByAdmin": "Deleted by admin {adminId}",
    "logs.disabledByAdmin": "Disabled by admin {adminId}",
    "logs.enabledByAdmin": "Enabled by admin {adminId}",
    "logs.rotatedAppSecretByAdmin": "Rotated app secret by admin {adminId}",
    "logs.manuallyUnboundByAdmin": "Manually unbound device by admin {adminId}"
  };
  const template = templates[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    values[name] === undefined ? match : String(values[name])
  );
};

describe("log message formatting", () => {
  it("renders an empty message as a placeholder", () => {
    assert.equal(formatLogMessage({ message: null }, t), "-");
  });

  it("maps exact Worker messages to translation keys", () => {
    assert.equal(formatLogMessage({ message: "Device unbound" }, t), "Device unbound");
    assert.equal(formatLogMessage({ message: "Activation code was deleted" }, t), "Activation code was deleted");
    assert.equal(formatLogMessage({ message: "Device unbind limit exceeded" }, t), "Device unbind limit exceeded");
  });

  it("interpolates the batch generation message", () => {
    assert.equal(
      formatLogMessage({ message: "Generated 3 Monthly codes" }, t),
      "Generated 3 Monthly activation codes"
    );
  });

  it("interpolates every admin action message emitted by the Worker", () => {
    assert.equal(formatLogMessage({ message: "Deleted by admin 99" }, t), "Deleted by admin 99");
    assert.equal(formatLogMessage({ message: "Disabled by admin 99" }, t), "Disabled by admin 99");
    assert.equal(formatLogMessage({ message: "Enabled by admin 99" }, t), "Enabled by admin 99");
    assert.equal(
      formatLogMessage({ message: "Rotated app secret by admin 99" }, t),
      "Rotated app secret by admin 99"
    );
    assert.equal(
      formatLogMessage({ message: "Manually unbound device by admin 99" }, t),
      "Manually unbound device by admin 99"
    );
  });

  it("passes unknown messages through unchanged", () => {
    assert.equal(formatLogMessage({ message: "Something unexpected" }, t), "Something unexpected");
    assert.equal(formatLogMessage({ message: "Queried by admin abc" }, t), "Queried by admin abc");
  });

  it("maps every failure message the Worker persists to a real translation key", () => {
    for (const message of LOGGED_CLIENT_FAILURE_MESSAGES) {
      const key = EXACT_MESSAGE_KEYS[message];
      assert.ok(key, `missing translation mapping for stored message: ${message}`);
      assert.ok(enLogs[key.slice("logs.".length)], `missing dictionary entry for ${key}`);
    }
  });

  it("maps every admin action message the Worker persists to a real translation key", () => {
    for (const verb of ["Deleted", "Disabled", "Enabled", "Rotated app secret", "Manually unbound device"]) {
      const key = ADMIN_ACTION_KEYS[verb];
      assert.ok(key, `missing admin action mapping for: ${verb}`);
      assert.ok(enLogs[key.slice("logs.".length)], `missing dictionary entry for ${key}`);
    }
  });
});
