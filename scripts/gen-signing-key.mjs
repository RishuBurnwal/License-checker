/**
 * Generate an Ed25519 signing keypair for the signed-license surface.
 *
 * Prints the base64url (-/_/no-=) PKCS8 private key, the raw public key, and a
 * suggested key_id to stdout for the operator to paste into `.dev.vars` (local)
 * or `wrangler secret put` (Cloudflare prod). The private key is NEVER written
 * to a committed file. The private key length matches config.ts's expected
 * 48-byte PKCS8 encoding; the public key is 32 bytes raw.
 *
 * Usage: node scripts/gen-signing-key.mjs
 */
import { webcrypto } from "node:crypto";

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function suggestedKeyId() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `ed25519-${year}-${month}`;
}

async function main() {
  const keyPair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privatePkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));

  const privateKey = bytesToBase64Url(privatePkcs8);
  const publicKey = bytesToBase64Url(publicRaw);
  const keyId = suggestedKeyId();

  console.log("# Ed25519 signing key — paste the private key into a secret store, never commit it.");
  console.log(`LICENSE_SIGNING_PRIVATE_KEY="${privateKey}"`);
  console.log(`LICENSE_SIGNING_PUBLIC_KEY="${publicKey}"`);
  console.log(`LICENSE_SIGNING_KEY_ID="${keyId}"`);
  console.log("");
  console.log(`# private key bytes: ${privatePkcs8.length} (expected 48), public key bytes: ${publicRaw.length} (expected 32)`);
}

main().catch((error) => {
  console.error("Failed to generate signing key:", error.message);
  process.exit(1);
});
