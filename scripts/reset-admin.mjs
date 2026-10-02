/**
 * Reset an administrator credential and require a change on next login.
 *
 * This is an operator tool, not an API: it talks to the local D1 database
 * through Wrangler, so no weak default ever lives in application code or the
 * repository. Passwords are hashed with the same PBKDF2 parameters the Worker
 * uses, so the result is indistinguishable from a password set through the UI.
 *
 * Usage:
 *   node scripts/reset-admin.mjs                       # admin -> admin (local)
 *   node scripts/reset-admin.mjs --username alice --password s3cret
 *   node scripts/reset-admin.mjs --remote              # production database
 *   node scripts/reset-admin.mjs --no-force-change     # skip the forced change
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync, randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(ROOT, "worker");

// Must match worker/src/constants.ts so hashes verify identically.
const PASSWORD_PBKDF2_ITERATIONS = 100_000;
const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "admin";
// Dev literal for the global admin master password (AC-B14). Seeded directly
// into the settings table, bypassing the console's >= 8-char change rule.
const DEFAULT_MASTER_PASSWORD = "master";

function parseArgs(argv) {
  const args = {
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
    remote: false,
    forceChange: true,
    allowWeak: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--username") args.username = argv[++i];
    else if (arg === "--password") args.password = argv[++i];
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--no-force-change") args.forceChange = false;
    else if (arg === "--allow-weak") args.allowWeak = true;
  }
  return args;
}

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mirrors hashPassword() in worker/src/crypto.ts (base64url of the raw bits). */
function hashPassword(password) {
  const salt = base64Url(randomBytes(16));
  const bits = pbkdf2Sync(password, salt, PASSWORD_PBKDF2_ITERATIONS, 32, "sha256");
  return { hash: base64Url(bits), salt };
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSql(sql, remote) {
  const dir = mkdtempSync(join(tmpdir(), "lm-reset-"));
  const file = join(dir, "reset.sql");
  writeFileSync(file, sql, "utf8");
  try {
    const flags = ["d1", "execute", "license_manager", "--file", file, "--yes"];
    if (remote) {
      flags.push("--remote", "--config", "wrangler.production.toml", "--env", "production");
    } else {
      flags.push("--local");
    }
    return execFileSync("npx", ["wrangler", ...flags], {
      cwd: WORKER_DIR,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.password.length < MIN_PASSWORD_LENGTH && !args.allowWeak) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    console.error("Pass --allow-weak to set a short bootstrap credential that must be replaced at first login.");
    process.exit(1);
  }
  if (args.password.length < MIN_PASSWORD_LENGTH && !args.forceChange) {
    console.error("Refusing to set a weak password with --no-force-change: it would persist indefinitely.");
    process.exit(1);
  }
  if (args.allowWeak && args.password.length < MIN_PASSWORD_LENGTH) {
    console.warn("WARNING: setting a short bootstrap password. The forced change is what makes this safe.");
  }

  const { hash, salt } = hashPassword(args.password);
  const now = new Date().toISOString();
  const mustChange = args.forceChange ? 1 : 0;

  // Seed the global admin master password to the dev literal 'master'. The
  // >= 8-char rule only governs the console change flow; writing the hash
  // directly here is deliberate so a fresh local setup can log in as admin.
  const master = hashPassword(DEFAULT_MASTER_PASSWORD);
  const masterSql = `INSERT INTO settings (key, value, updated_at) VALUES
('master_password_hash', ${sqlString(master.hash)}, ${sqlString(now)}),
('master_password_salt', ${sqlString(master.salt)}, ${sqlString(now)})
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`;

  // The account is created if absent, then updated, so this works on a fresh
  // database as well as an existing one. The sole role axis is user_role; the
  // reset account is seeded as an 'admin' manager.
  const insertSql = `INSERT INTO admin_users (username, password_hash, password_salt, must_change_password, password_changed_at, user_role, updated_at)
SELECT ${sqlString(args.username)}, ${sqlString(hash)}, ${sqlString(salt)}, ${mustChange}, ${sqlString(now)}, 'admin', ${sqlString(now)}
WHERE NOT EXISTS (SELECT 1 FROM admin_users WHERE username = ${sqlString(args.username)});`;

  const updateSql = `UPDATE admin_users
SET password_hash = ${sqlString(hash)},
    password_salt = ${sqlString(salt)},
    must_change_password = ${mustChange},
    password_changed_at = ${sqlString(now)},
    updated_at = ${sqlString(now)}
WHERE username = ${sqlString(args.username)};`;

  runSql(`${insertSql}\n${updateSql}\n${masterSql}`, args.remote);

  console.log(`Reset '${args.username}' on the ${args.remote ? "remote (production)" : "local"} database.`);
  console.log(`  password            : ${args.password}`);
  console.log(`  master password     : ${DEFAULT_MASTER_PASSWORD} (required for admin login)`);
  console.log(`  forced change       : ${args.forceChange ? "yes (must set a new password after login)" : "no"}`);
  console.log("");
  console.log("Admin console: http://localhost:8787/console");
  if (args.forceChange) {
    console.log("Every API call except the password change is refused until the password is changed.");
  }
  console.log("");
  console.log("Reminder: verify the reset against the live database, e.g.");
  console.log("  curl -s -X POST http://localhost:8787/api/admin/login -H 'content-type: application/json' \\");
  console.log(`    -d '{"username":"${args.username}","password":"${args.password}"}'`);
}

main();
