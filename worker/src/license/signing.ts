import { requireEnv } from "../config";
import { base64UrlToBytes, bytesToBase64Url } from "../crypto";
import { Bindings } from "../types";

// All Ed25519 sign/verify surface is isolated to this one file (design §4.2).
// WebCrypto `crypto.subtle` with { name: "Ed25519" } is used (no new server
// dependency; the existing crypto.ts already uses crypto.subtle for HMAC/PBKDF2
// and a smoke test proved Ed25519 import/sign/verify works at runtime). If a
// runtime gap is ever proven, only this file swaps to @noble/ed25519, recorded
// in memory/decisions.md per RULES §8.

const ED25519_ALGORITHM = { name: "Ed25519" } as const;

// The private key is base64url of the 48-byte PKCS8 DER Ed25519 key (SL-27 /
// FEAT-001): WebCrypto cannot import an Ed25519 private key in "raw" format, so
// it must be imported as "pkcs8". The public key is a 32-byte raw key.
// Imported CryptoKeys are cached per key material, mirroring crypto.ts
// hmacKeyCache, so the per-request cost is a cheap Map lookup after the first.
const privateKeyCache = new Map<string, CryptoKey>();
const publicKeyCache = new Map<string, CryptoKey>();

async function getSigningKey(privateKeyBase64Url: string): Promise<CryptoKey> {
  const cached = privateKeyCache.get(privateKeyBase64Url);
  if (cached) {
    return cached;
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64UrlToBytes(privateKeyBase64Url) as BufferSource,
    ED25519_ALGORITHM,
    false,
    ["sign"]
  );
  privateKeyCache.set(privateKeyBase64Url, key);
  return key;
}

async function getVerifyKey(publicKeyBase64Url: string): Promise<CryptoKey> {
  const cached = publicKeyCache.get(publicKeyBase64Url);
  if (cached) {
    return cached;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(publicKeyBase64Url) as BufferSource,
    ED25519_ALGORITHM,
    false,
    ["verify"]
  );
  publicKeyCache.set(publicKeyBase64Url, key);
  return key;
}

/**
 * Sign the canonical payload bytes with the current Ed25519 private key.
 * Returns a detached signature as base64url (same -/_/no-= variant as the rest
 * of the project, via the shared crypto.ts helper).
 */
export async function signPayload(env: Bindings, payloadBytes: Uint8Array): Promise<string> {
  const privateKey = requireEnv(env, "LICENSE_SIGNING_PRIVATE_KEY");
  const key = await getSigningKey(privateKey);
  const signature = await crypto.subtle.sign(ED25519_ALGORITHM, key, payloadBytes as BufferSource);
  return bytesToBase64Url(signature);
}

export type PublicKeyMaterial = {
  keyId: string;
  publicKey: string;
  previousKeyId: string | null;
  previousPublicKey: string | null;
};

/**
 * Load the configured public-key material (current + optional previous) for
 * export/documentation tooling and for in-process verification (e.g. tests).
 */
export function loadPublicKeyMaterial(env: Bindings): PublicKeyMaterial {
  const keyId = requireEnv(env, "LICENSE_SIGNING_KEY_ID");
  const publicKey = requireEnv(env, "LICENSE_SIGNING_PUBLIC_KEY");
  const previousKeyId = normalizeOptional(env.LICENSE_SIGNING_PREVIOUS_KEY_ID);
  const previousPublicKey = normalizeOptional(env.LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY);
  return {
    keyId,
    publicKey,
    previousKeyId: previousKeyId ?? null,
    previousPublicKey: previousPublicKey ?? null
  };
}

/**
 * Verify a detached base64url Ed25519 signature over the given payload bytes
 * using a base64url raw public key. Isolated here so the crypto surface is in
 * one file; used by the signing tests (round-trip + tamper rejection).
 */
export async function verifySignature(
  publicKeyBase64Url: string,
  payloadBytes: Uint8Array,
  signatureBase64Url: string
): Promise<boolean> {
  const key = await getVerifyKey(publicKeyBase64Url);
  return crypto.subtle.verify(
    ED25519_ALGORITHM,
    key,
    base64UrlToBytes(signatureBase64Url) as BufferSource,
    payloadBytes as BufferSource
  );
}

function normalizeOptional(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
