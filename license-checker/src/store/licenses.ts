import type { StoredLicense } from "../types";

// localStorage-backed multi-license list (design §8.2 / §8.4). Each entry keeps
// its own `lastSeenServerTime` freshness anchor. The App Secret is kept here
// because the checker is the user's own tool running on their own machine; it is
// never committed and never leaves the browser except in a verify/report call to
// the user-configured server.

const STORAGE_KEY = "license-checker.licenses.v1";

function readStorage(): StoredLicense[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredLicense[]) : [];
  } catch {
    return [];
  }
}

function writeStorage(licenses: StoredLicense[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(licenses));
  } catch {
    // Non-fatal: a storage write failure (quota/private mode) leaves the list
    // in memory only; the UI still works for the current session.
  }
}

export function listLicenses(): StoredLicense[] {
  return readStorage();
}

export type NewLicenseInput = {
  label: string;
  serverBaseUrl: string;
  licenseKey: string;
  productId: string;
  installationId: string;
  appSecret: string;
};

function newId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function addLicense(input: NewLicenseInput): StoredLicense {
  const license: StoredLicense = {
    id: newId(),
    label: input.label,
    serverBaseUrl: input.serverBaseUrl,
    licenseKey: input.licenseKey,
    productId: input.productId,
    installationId: input.installationId,
    appSecret: input.appSecret,
    lastSeenServerTime: null,
    createdAt: new Date().toISOString()
  };
  const licenses = readStorage();
  licenses.push(license);
  writeStorage(licenses);
  return license;
}

export function removeLicense(id: string): void {
  writeStorage(readStorage().filter((license) => license.id !== id));
}

/** Advance a license's freshness anchor after an accepted verification (§8.4 step 5). */
export function updateLastSeenServerTime(id: string, lastSeenServerTime: string): void {
  const licenses = readStorage();
  const index = licenses.findIndex((license) => license.id === id);
  if (index === -1) {
    return;
  }
  licenses[index] = { ...licenses[index], lastSeenServerTime };
  writeStorage(licenses);
}

/** Generate a stable-looking installation id suggestion for the Add form. */
export function suggestInstallationId(): string {
  return `install-${newId()}`;
}
