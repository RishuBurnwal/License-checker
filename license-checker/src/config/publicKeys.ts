// PUBLIC KEYS ONLY (design §8.4 AC-46). This file maps a signing `key_id` to the
// base64url-encoded 32-byte raw Ed25519 PUBLIC key. It must NEVER contain a
// signing secret — the checker only verifies signatures, it never produces them.
//
// Rotation (AC-37): keep both the current and the previous key here so a client
// still trusts payloads signed just before a rotation. A payload whose signed
// `key_id` is not present in this map is rejected (unknown-key_id, AC-26).
//
// The default entry below is the project's dev/test keypair public half (matches
// worker/test/helpers/harness.ts TEST_SECRETS). Replace/extend it with your
// production public keys printed by `node scripts/gen-signing-key.mjs`.

export type PublicKeyMap = Readonly<Record<string, string>>;

export const PUBLIC_KEYS: PublicKeyMap = {
  // Dev/test key (public half only). Safe to ship: a public key cannot sign.
  "ed25519-test": "TOwxe9EweGiDchaoYOmHY_GuOZrgMiZAkueFVVmBxTQ"
};

/** Look up a base64url public key by its signing key id, or null if unknown. */
export function lookupPublicKey(keyId: string): string | null {
  return Object.prototype.hasOwnProperty.call(PUBLIC_KEYS, keyId) ? PUBLIC_KEYS[keyId] : null;
}
