import type { LogItem } from "../types";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export const EXACT_MESSAGE_KEYS: Record<string, string> = {
  "Already active on this device": "logs.alreadyActive",
  Activated: "logs.activated",
  Verified: "logs.verified",
  "Device rebound": "logs.deviceRebound",
  "Device unbound": "logs.deviceUnbound",
  "App is disabled": "logs.appDisabled",
  "Invalid app secret": "logs.invalidAppSecret",
  "Activation code not found": "logs.codeNotFound",
  "Activation code has not been activated": "logs.codeNotActivated",
  "Activation code was deleted": "logs.codeDeleted",
  "Activation code is disabled": "logs.codeDisabled",
  "Activation code has expired": "logs.codeExpired",
  "Activation code is bound to another device": "logs.codeBoundOther",
  "Activation code is not bound to a device": "logs.codeNotActivated",
  "Old device fingerprint does not match": "logs.oldFingerprintMismatch",
  "Device fingerprint does not match": "logs.fingerprintMismatch",
  "Device rebind limit exceeded": "logs.unbindLimit",
  "Device unbind limit exceeded": "logs.unbindLimit",
  "Device rebind is cooling down": "logs.unbindCooldown",
  "Device unbind is cooling down": "logs.unbindCooldown",
  "Device unbind conflict": "logs.unbindConflict",
  "Activation code was bound by another request": "logs.codeBoundByOtherRequest",
  "Activation code was activated by another request": "logs.codeActivatedByOtherRequest"
};

export const ADMIN_ACTION_KEYS: Record<string, string> = {
  Deleted: "logs.deletedByAdmin",
  Disabled: "logs.disabledByAdmin",
  Enabled: "logs.enabledByAdmin",
  "Rotated app secret": "logs.rotatedAppSecretByAdmin",
  "Manually unbound device": "logs.manuallyUnboundByAdmin"
};

/**
 * Renders a stored `activation_logs.message` value for display.
 *
 * The Worker stores messages as stable English templates (see `worker/src/service.ts`).
 * Translating them here keeps historical rows readable without storing per-language text.
 */
export function formatLogMessage(row: Pick<LogItem, "message">, t: Translate): string {
  const message = row.message;
  if (!message) {
    return "-";
  }

  const exactKey = EXACT_MESSAGE_KEYS[message];
  if (exactKey) {
    return t(exactKey);
  }

  const generatedMatch = message.match(/^Generated (\d+) (.+) codes$/);
  if (generatedMatch) {
    return t("logs.generatedMessage", { count: generatedMatch[1], plan: generatedMatch[2] });
  }

  const adminActionMatch = message.match(/^(.+) by admin (\d+)$/);
  if (adminActionMatch) {
    const [, verb, adminId] = adminActionMatch;
    const adminActionKey = ADMIN_ACTION_KEYS[verb];
    return adminActionKey ? t(adminActionKey, { adminId }) : message;
  }

  return message;
}
