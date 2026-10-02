import { randomBytes, webcrypto } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(rootDir, "worker", ".dev.vars");
const force = process.argv.includes("--force");

if (existsSync(envPath) && !force) {
  console.error("worker/.dev.vars already exists. Use `pnpm env:init -- --force` to replace it.");
  process.exit(1);
}

const signingKey = await generateSigningKey();

const vars = {
  JWT_SECRET: randomSecret(),
  CODE_HMAC_SECRET: randomSecret(),
  APP_SECRET_HMAC_SECRET: randomSecret(),
  DEVICE_HMAC_SECRET: randomSecret(),
  ADMIN_BOOTSTRAP_PASSWORD: randomSecret(),
  // Dev literal so a fresh local admin can log in; change it from the Settings
  // page. The reset-admin tool seeds the matching hash into the settings table.
  ADMIN_MASTER_PASSWORD: "master",
  LICENSE_SIGNING_PRIVATE_KEY: signingKey.privateKey,
  LICENSE_SIGNING_PUBLIC_KEY: signingKey.publicKey,
  LICENSE_SIGNING_KEY_ID: signingKey.keyId
};

const contents = Object.entries(vars)
  .map(([key, value]) => `${key}="${value}"`)
  .join("\n");

writeFileSync(envPath, `${contents}\n`, { mode: 0o600 });
console.log(`Generated ${envPath}`);

function randomSecret() {
  return randomBytes(32).toString("hex");
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function generateSigningKey() {
  const keyPair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privatePkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
  const now = new Date();
  const keyId = `ed25519-dev-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    privateKey: bytesToBase64Url(privatePkcs8),
    publicKey: bytesToBase64Url(publicRaw),
    keyId
  };
}
