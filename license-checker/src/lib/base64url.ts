// Byte-identical copy of the worker's crypto.ts base64url variant (design §8.2,
// SL-16): the -/_/no-padding ("base64url") alphabet. The checker must decode the
// signature and public keys exactly as the worker encoded them, so this logic is
// kept character-for-character in sync with worker/src/crypto.ts. A fixture test
// (lib/base64url.test.ts) guards against drift.

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
