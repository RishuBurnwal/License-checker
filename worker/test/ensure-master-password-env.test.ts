/**
 * Env-seed script suite (FEAT-002, AC-B11/TS-2a).
 *
 * Proves scripts/ensure-master-password-env.mjs appends ADMIN_MASTER_PASSWORD
 * only when absent, leaves every other key byte-identical, and is a no-op on a
 * second run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMasterPasswordEnv } from "../../scripts/ensure-master-password-env.mjs";

let dir: string;
let devVars: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lm-master-env-"));
  devVars = join(dir, ".dev.vars");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureMasterPasswordEnv", () => {
  it("appends the key when absent, leaving existing keys byte-identical", () => {
    const original = 'JWT_SECRET="abc"\nCODE_HMAC_SECRET="def"\n';
    writeFileSync(devVars, original);

    const appended = ensureMasterPasswordEnv(devVars);
    expect(appended).toBe(true);

    const updated = readFileSync(devVars, "utf8");
    expect(updated.startsWith(original)).toBe(true);
    expect(updated).toContain('ADMIN_MASTER_PASSWORD="master"');
  });

  it("is a no-op on a second run (idempotent)", () => {
    writeFileSync(devVars, 'JWT_SECRET="abc"\n');
    expect(ensureMasterPasswordEnv(devVars)).toBe(true);
    const afterFirst = readFileSync(devVars, "utf8");

    expect(ensureMasterPasswordEnv(devVars)).toBe(false);
    expect(readFileSync(devVars, "utf8")).toBe(afterFirst);
  });

  it("does not duplicate a key that is already present with a custom value", () => {
    const original = 'ADMIN_MASTER_PASSWORD="already-set"\nJWT_SECRET="abc"\n';
    writeFileSync(devVars, original);
    expect(ensureMasterPasswordEnv(devVars)).toBe(false);
    expect(readFileSync(devVars, "utf8")).toBe(original);
  });

  it("adds a trailing newline before appending when the file lacks one", () => {
    writeFileSync(devVars, 'JWT_SECRET="abc"');
    expect(ensureMasterPasswordEnv(devVars)).toBe(true);
    const updated = readFileSync(devVars, "utf8");
    expect(updated).toBe('JWT_SECRET="abc"\nADMIN_MASTER_PASSWORD="master"\n');
  });
});
