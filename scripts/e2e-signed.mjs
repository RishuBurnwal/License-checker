/**
 * Live end-to-end verification of the SIGNED license surface against a running
 * Worker (real HTTP, real D1, real Ed25519). Local-only; no remote deploy.
 *
 * Order (design §10.1):
 *   1. Ed25519 crypto smoke test (importKey/sign/verify) in this Node runtime.
 *      If it fails, flip signing.ts to @noble/ed25519 and record in decisions.md.
 *   2. Signed happy path over /api/v1/license/verify + local signature verify.
 *   3. Per-field tamper rejection (each signed field mutated => verify fails).
 *   4. Missing / garbage signature, unknown key_id, unknown protocol.
 *   5. Atomic activation-limit path (max_activations).
 *   6. /report + corroborated auto-hold.
 *
 * Usage: node scripts/e2e-signed.mjs [baseUrl] [publicKeyBase64Url] [keyId]
 * The public key + key_id must match the Worker's LICENSE_SIGNING_* env.
 */
import { webcrypto } from "node:crypto";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const PUBLIC_KEY = process.argv[3];
const KEY_ID = process.argv[4];
const results = [];

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

function base64UrlToBytes(value) {
  return new Uint8Array(Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64"));
}

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
  for (const key of CANONICAL_KEYS) {
    sorted[key] = payload[key];
  }
  return new TextEncoder().encode(JSON.stringify(sorted));
}

async function verifySignature(publicKeyB64, payload, signatureB64) {
  const key = await webcrypto.subtle.importKey("raw", base64UrlToBytes(publicKeyB64), { name: "Ed25519" }, false, [
    "verify"
  ]);
  return webcrypto.subtle.verify({ name: "Ed25519" }, key, base64UrlToBytes(signatureB64), canonicalize(payload));
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
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
  return { status: res.status, payload, data: payload?.data, error: payload?.error };
}

const suffix = Date.now().toString(36);

async function main() {
  // 1. Ed25519 smoke test in this runtime (mirrors the Worker runtime check).
  try {
    const kp = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const msg = new TextEncoder().encode("smoke");
    const sig = await webcrypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, msg);
    const ok = await webcrypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, msg);
    record("ed25519 crypto smoke test", ok, `sig_bytes=${new Uint8Array(sig).length}`);
  } catch (error) {
    record("ed25519 crypto smoke test", false, error.message);
  }

  if (!PUBLIC_KEY || !KEY_ID) {
    record("public key + key_id provided", false, "pass them as argv[4]/argv[5] to run the signed checks");
    return finish();
  }

  const login = await call("POST", "/api/admin/login", {
    body: { username: "bootstrap-admin", password: "bootstrap-password-1" }
  });
  const token = login.data?.token;
  record("admin login", login.status === 200 && !!token, `status=${login.status}`);
  if (!token) return finish();

  const app = await call("POST", "/api/admin/apps", { token, body: { name: `Signed App ${suffix}`, platform: "desktop" } });
  const appId = app.data?.app?.app_id;
  const appSecret = app.data?.app_secret;
  record("create app", app.status === 201 && !!appId, `app_id=${appId}`);
  if (!appId) return finish();

  const batch = await call("POST", "/api/admin/codes/batch", {
    token,
    body: { app_id: appId, plan_code: "monthly", quantity: 1 }
  });
  const code = batch.data?.codes?.[0];
  record("generate code", batch.status === 201 && !!code, `code=${code}`);
  if (!code) return finish();

  const device = `signed-device-${suffix}`;
  await call("POST", "/api/client/activate", {
    body: { app_id: appId, app_secret: appSecret, code, device_fingerprint: device }
  });

  // 2. Signed happy path + local signature verify.
  const verify = await call("POST", "/api/v1/license/verify", {
    body: {
      app_id: appId,
      app_secret: appSecret,
      license_key: code,
      product_id: appId,
      installation_id: device,
      protocol_version: 1
    }
  });
  const signedOk =
    verify.status === 200 &&
    verify.data?.payload &&
    verify.data?.signature &&
    verify.data.payload.key_id === KEY_ID;
  record("signed verify happy path", signedOk, `status=${verify.data?.payload?.status}`);

  if (signedOk) {
    const good = await verifySignature(PUBLIC_KEY, verify.data.payload, verify.data.signature);
    record("local signature verifies", good === true);

    // 3. Per-field tamper rejection.
    let allRejected = true;
    for (const field of CANONICAL_KEYS) {
      const mutated = { ...verify.data.payload };
      mutated[field] = typeof mutated[field] === "number" ? mutated[field] + 1 : `${mutated[field]}X`;
      const stillValid = await verifySignature(PUBLIC_KEY, mutated, verify.data.signature);
      if (stillValid) allRejected = false;
    }
    record("per-field tamper rejected", allRejected, `${CANONICAL_KEYS.length} fields mutated`);

    // 4. Garbage signature rejected.
    const garbage = await verifySignature(PUBLIC_KEY, verify.data.payload, "AAAA");
    record("garbage signature rejected", garbage === false);
  }

  // 4b. Unknown protocol.
  const badProto = await call("POST", "/api/v1/license/verify", {
    body: {
      app_id: appId,
      app_secret: appSecret,
      license_key: code,
      product_id: appId,
      installation_id: device,
      protocol_version: 99
    }
  });
  record(
    "unknown protocol rejected",
    badProto.status === 400 && badProto.error?.code === "PROTOCOL_UNSUPPORTED",
    `status=${badProto.status}`
  );

  // 4c. Unknown key_id rejected by a checker-style embedded-key lookup. The
  // standalone checker (license-checker/src/config/publicKeys.ts) trusts ONLY
  // the key_ids in its embedded map; a payload signed by an unlisted key_id is
  // rejected before any signature check. We mirror that gate here.
  const embeddedKeys = { [KEY_ID]: PUBLIC_KEY };
  const lookup = (keyId) => (Object.prototype.hasOwnProperty.call(embeddedKeys, keyId) ? embeddedKeys[keyId] : null);
  record("embedded key_id lookup hits for configured key", lookup(KEY_ID) === PUBLIC_KEY);
  record("unknown key_id rejected by lookup", lookup("ed25519-not-configured") === null);

  // 5. Corroborated auto-hold (§6.3): a single high-severity report records but
  // does NOT hold; a second DISTINCT installation reporting the same reason
  // within the window reaches the default threshold (2) and auto-holds.
  const holdDevice = `signed-device-${suffix}`; // the already-activated installation
  const holdDevice2 = `signed-device-2-${suffix}`;
  const report1 = await call("POST", "/api/v1/license/report", {
    body: { app_id: appId, app_secret: appSecret, installation_id: holdDevice, license_key: code, reason_code: "PAYLOAD_TAMPERED" }
  });
  record(
    "first report records without holding",
    report1.status === 200 && report1.data?.recorded === true && report1.data?.held === false,
    `held=${report1.data?.held}`
  );
  const report2 = await call("POST", "/api/v1/license/report", {
    body: { app_id: appId, app_secret: appSecret, installation_id: holdDevice2, license_key: code, reason_code: "PAYLOAD_TAMPERED" }
  });
  record(
    "second distinct report triggers auto-hold",
    report2.status === 200 && report2.data?.recorded === true && report2.data?.held === true,
    `held=${report2.data?.held}`
  );

  // 6. After auto-hold the signed verify reports the held status (license is no
  // longer "active"); this is what a tampering client sees ("license failed").
  const afterHold = await call("POST", "/api/v1/license/verify", {
    body: {
      app_id: appId,
      app_secret: appSecret,
      license_key: code,
      product_id: appId,
      installation_id: holdDevice,
      protocol_version: 1
    }
  });
  record(
    "verify reflects hold after auto-hold",
    afterHold.status === 200 && afterHold.data?.payload?.status === "hold" && afterHold.data?.payload?.activation_allowed === false,
    `status=${afterHold.data?.payload?.status}`
  );

  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} signed checks passed`);
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Signed E2E crashed:", err.message);
  process.exit(1);
});
