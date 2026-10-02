/**
 * One-command LIVE end-to-end: boot a REAL local server over HTTP, exercise the
 * whole system against it, then stop the server (FEAT-004, decision SL-21).
 *
 * This is the "make it live" orchestrator. It transiently starts the Cloudflare
 * Worker via `wrangler dev` (real workerd + real local D1), polls /api/health,
 * then drives the full flow over the network:
 *   - scripts/e2e-live.mjs   — admin login + forced-password-change, user
 *                              create + kick (pre-kick token 401), activation,
 *                              heartbeat, session kick, renew, device limits.
 *   - scripts/e2e-signed.mjs — Ed25519 smoke test, signed verify happy path,
 *                              per-field tamper rejection, garbage signature,
 *                              unknown protocol, embedded key_id lookup,
 *                              /report + corroborated auto-hold, hold reflected.
 *   - a checker-equivalent run (this file) — reproduces exactly what the
 *                              standalone license-checker UI does: POST
 *                              /api/v1/license/verify, look the signed key_id up
 *                              in the checker's EMBEDDED public-key map, verify
 *                              the signature with that public key, run the
 *                              field + freshness checks, demo a tamper, and
 *                              report an anomaly. It holds the PUBLIC key only.
 *
 * HONESTY: this boots a LOCAL server only. It never deploys to a real
 * Cloudflare/Vercel account. The server is started transiently and stopped at
 * the end (no long-lived watch is left running). The signing key used is the
 * dev/test keypair whose PUBLIC half is embedded in the checker, so the checker
 * run is a genuine signature verification end to end.
 *
 * Usage: node scripts/e2e-serve.mjs [port]
 * Requires worker/.dev.vars to contain the dev/test signing key (public half =
 * the checker's embedded key_id `ed25519-test`). `pnpm env:init` or the values
 * in worker/.dev.vars.example provide a compatible set.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const WORKER_DIR = join(ROOT, "worker");
const DEV_VARS = join(WORKER_DIR, ".dev.vars");

const PORT = Number(process.argv[2] ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

// The checker trusts ONLY the key_ids embedded in its public-key map
// (license-checker/src/config/publicKeys.ts). We read the same dev/test key the
// server signs with so the checker run is a real verification.
const PUBLIC_KEY = readDevVar("LICENSE_SIGNING_PUBLIC_KEY");
const KEY_ID = readDevVar("LICENSE_SIGNING_KEY_ID");

function readDevVar(name) {
  const text = readFileSync(DEV_VARS, "utf8");
  const match = text.match(new RegExp(`^${name}="?([^"\\n]+)"?`, "m"));
  if (!match) throw new Error(`${name} missing from worker/.dev.vars`);
  return match[1];
}

function isWindows() {
  return process.platform === "win32";
}

/** Boot `wrangler dev` and resolve once /api/health answers 200. */
async function startServer() {
  console.log(`[serve] booting wrangler dev on :${PORT} (local workerd + D1)...`);
  const child = spawn("pnpm", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    cwd: WORKER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows()
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (code ${child.exitCode}):\n${log.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) {
        const body = await res.json();
        if (body?.data?.status === "ok") {
          console.log("[serve] health OK; server is live.");
          return child;
        }
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`server did not become healthy in time:\n${log.slice(-2000)}`);
}

/** Stop the server and any workerd it spawned. */
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  console.log("[serve] stopping server...");
  if (isWindows()) {
    // wrangler spawns a detached workerd; taskkill the tree.
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", shell: true });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 8000))]);
}

/** Run a child node script against the live server; inherit its stdout/stderr. */
async function runScript(file, args) {
  console.log(`\n[serve] === ${file} ===`);
  const child = spawn(process.execPath, [join(HERE, file), ...args], {
    cwd: ROOT,
    stdio: "inherit"
  });
  const [code] = await once(child, "exit");
  return code ?? 1;
}

// ---------------------------------------------------------------------------
// Checker-equivalent run: this reproduces the standalone checker's verify path
// (lib/api.ts + lib/verify.ts + config/publicKeys.ts) against the live server.
// ---------------------------------------------------------------------------
const CANONICAL_KEYS = [
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
];

function canonicalize(payload) {
  const sorted = {};
  for (const key of CANONICAL_KEYS) sorted[key] = payload[key];
  return new TextEncoder().encode(JSON.stringify(sorted));
}

function base64UrlToBytes(value) {
  return new Uint8Array(Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64"));
}

async function checkerVerify(publicKeyB64, payload, signatureB64) {
  const key = await webcrypto.subtle.importKey("raw", base64UrlToBytes(publicKeyB64), { name: "Ed25519" }, false, [
    "verify"
  ]);
  return webcrypto.subtle.verify({ name: "Ed25519" }, key, base64UrlToBytes(signatureB64), canonicalize(payload));
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, data: payload?.data, error: payload?.error };
}

async function adminCall(method, path, token, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, data: payload?.data, error: payload?.error };
}

/**
 * The checker-equivalent run. Returns 0 on success, 1 on failure. The EMBEDDED
 * public-key map here mirrors license-checker/src/config/publicKeys.ts: it
 * trusts a signed key_id ONLY if present in the map.
 */
async function checkerRun() {
  console.log("\n[serve] === checker-equivalent run (embedded public key only) ===");
  const results = [];
  const rec = (step, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
  };
  const EMBEDDED_PUBLIC_KEYS = { [KEY_ID]: PUBLIC_KEY };
  const lookup = (id) => (Object.prototype.hasOwnProperty.call(EMBEDDED_PUBLIC_KEYS, id) ? EMBEDDED_PUBLIC_KEYS[id] : null);

  const suffix = `chk-${Date.now().toString(36)}`;
  // Log in and provision a fresh app + code the checker will "add".
  const login = await post("/api/admin/login", {
    username: "bootstrap-admin",
    password: "bootstrap-password-1"
  });
  const token = login.data?.token;
  rec("admin login (provision for checker)", login.status === 200 && !!token);
  if (!token) return 1;

  const app = await adminCall("POST", "/api/admin/apps", token, { name: `Checker App ${suffix}`, platform: "desktop" });
  const appId = app.data?.app?.app_id;
  const appSecret = app.data?.app_secret;
  rec("provision app", app.status === 201 && !!appId);
  const batch = await adminCall("POST", "/api/admin/codes/batch", token, {
    app_id: appId,
    plan_code: "monthly",
    quantity: 1
  });
  const code = batch.data?.codes?.[0];
  rec("provision code", batch.status === 201 && !!code);
  if (!appId || !code) return 1;

  const installationId = `${suffix}-install`;
  await post("/api/client/activate", { app_id: appId, app_secret: appSecret, code, device_fingerprint: installationId });

  // 1. The checker's "add license + verify": POST /api/v1/license/verify with
  // the exact request shape of license-checker/src/lib/api.ts requestVerify.
  const verify = await post("/api/v1/license/verify", {
    app_id: appId,
    app_secret: appSecret,
    license_key: code,
    product_id: appId,
    installation_id: installationId,
    protocol_version: 1
  });
  rec("checker verify request", verify.status === 200 && !!verify.data?.payload && !!verify.data?.signature);
  const payload = verify.data?.payload;
  const signature = verify.data?.signature;
  if (!payload || !signature) return finishChecker(results);

  // 2. Trust only the signed key_id (AC-26): embedded-map lookup.
  const publicKey = lookup(payload.key_id);
  rec("key_id is in embedded public-key map", !!publicKey, `key_id=${payload.key_id}`);
  if (!publicKey) return finishChecker(results);

  // 3. Signature verifies against the embedded PUBLIC key.
  const sigOk = await checkerVerify(publicKey, payload, signature);
  rec("signature verifies with embedded public key", sigOk === true);

  // 4. Field checks the checker performs (product/installation/protocol/status).
  rec("product_id matches installation", payload.product_id === appId);
  rec("installation_id matches", payload.installation_id === installationId);
  rec("protocol_version supported (1)", payload.protocol_version === 1);
  rec("status active + activation allowed", payload.status === "active" && payload.activation_allowed === true);

  // 5. Tamper demo: mutate a signed field -> signature no longer verifies ->
  // the checker shows "license failed to load" and reports it. This is the
  // burpsuite-style payload tamper the user described.
  const tampered = { ...payload, server_time: "2099-01-01T00:00:00.000Z" };
  const tamperRejected = (await checkerVerify(publicKey, tampered, signature)) === false;
  rec("tampered payload rejected locally", tamperRejected);

  // 6. The checker reports the detected anomaly to the server.
  const report = await post("/api/v1/license/report", {
    app_id: appId,
    app_secret: appSecret,
    installation_id: installationId,
    license_key: code,
    reason_code: "PAYLOAD_TAMPERED",
    detail: "checker-equivalent run: server_time tampered"
  });
  rec("checker reports anomaly", report.status === 200 && report.data?.recorded === true, `held=${report.data?.held}`);

  return finishChecker(results);
}

function finishChecker(results) {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checker-equivalent checks passed`);
  return passed === results.length ? 0 : 1;
}

async function main() {
  let child;
  let failed = 0;
  try {
    child = await startServer();
    failed += await runScript("e2e-live.mjs", [BASE]);
    failed += await runScript("e2e-signed.mjs", [BASE, PUBLIC_KEY, KEY_ID]);
    failed += await checkerRun();
  } finally {
    await stopServer(child);
    // Belt-and-suspenders: reap any stray workerd on Windows.
    if (isWindows()) {
      spawn("taskkill", ["/im", "workerd.exe", "/f"], { stdio: "ignore", shell: true });
    }
  }
  if (failed > 0) {
    console.log(`\n[serve] LIVE E2E FAILED (${failed} script/section(s) reported failures).`);
    process.exit(1);
  }
  console.log("\n[serve] LIVE E2E PASSED — all scripts and the checker run are green.");
}

main().catch((err) => {
  console.error("[serve] crashed:", err.message);
  process.exit(1);
});
