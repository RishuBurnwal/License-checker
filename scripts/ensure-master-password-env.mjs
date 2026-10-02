/**
 * Ensure worker/.dev.vars carries a local ADMIN_MASTER_PASSWORD (AC-B11).
 *
 * The launcher runs this on every start so a fresh local setup has a working
 * admin master password ("master") without regenerating .dev.vars. It is
 * deliberately minimal and non-destructive:
 *   - if the ADMIN_MASTER_PASSWORD= key is absent, append it;
 *   - if it is already present (any value), do nothing;
 *   - never touch, reorder, or rewrite any other key.
 *
 * Usage:
 *   node scripts/ensure-master-password-env.mjs
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MASTER_PASSWORD = "master";
const KEY = "ADMIN_MASTER_PASSWORD";

/**
 * Appends ADMIN_MASTER_PASSWORD="master" to the given .dev.vars file when the
 * key is absent. Returns true when a line was appended, false on a no-op.
 * Missing files are left untouched (env:init generates them separately).
 */
export function ensureMasterPasswordEnv(devVarsPath) {
  if (!existsSync(devVarsPath)) {
    return false;
  }
  const contents = readFileSync(devVarsPath, "utf8");
  // Match the key at the start of any line (optionally after whitespace),
  // ignoring commented-out lines.
  const present = contents.split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("#") && new RegExp(`^${KEY}\\s*=`).test(trimmed);
  });
  if (present) {
    return false;
  }
  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  appendFileSync(devVarsPath, `${prefix}${KEY}="${DEFAULT_MASTER_PASSWORD}"\n`);
  return true;
}

function defaultDevVarsPath() {
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  return join(rootDir, "worker", ".dev.vars");
}

// Only run when invoked directly, so tests can import the function above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = defaultDevVarsPath();
  if (!existsSync(path)) {
    console.log(`worker/.dev.vars not found; skipping ${KEY} seed (run env:init first).`);
  } else if (ensureMasterPasswordEnv(path)) {
    console.log(`Added ${KEY} to worker/.dev.vars.`);
  } else {
    console.log(`${KEY} already present in worker/.dev.vars; no change.`);
  }
}
