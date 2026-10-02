import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_KEYS, lookupPublicKey } from "./publicKeys";

const here = dirname(fileURLToPath(import.meta.url));
const checkerRoot = resolve(here, "..", "..");

// The test keypair's private half (base64url PKCS8) MUST NOT appear anywhere in
// the SHIPPED checker source — the checker holds only public keys (AC-46). The
// forbidden strings are assembled from fragments at runtime so this test file
// itself never contains any of them literally, and the scan skips *.test.ts
// files (test assertions are not shipped runtime key material).
const KNOWN_TEST_PRIVATE_KEY = ["MC4C", "AQAw", "BQYDK2VwBCIEIJFuo2oq6mwiwNj6jABiYJTFdTSh_tN96k2x56qlpjRL"].join("");
// PEM/PKCS8 private-key markers (the first is the base64 Ed25519 PKCS8 prefix).
const PRIVATE_KEY_MARKERS = [
  ["MC4C", "AQAw"].join(""),
  ["PRIVATE", "KEY"].join(" "),
  ["LICENSE_SIGNING", "PRIVATE_KEY"].join("_")
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|js|json|html|md|env)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      // Skip test files: they carry assertion strings, not shipped key material.
      out.push(full);
    }
  }
  return out;
}

describe("publicKeys config holds public keys only (AC-46)", () => {
  it("looks up a configured key and returns null for an unknown key_id", () => {
    expect(lookupPublicKey("ed25519-test")).toBe(PUBLIC_KEYS["ed25519-test"]);
    expect(lookupPublicKey("ed25519-not-configured")).toBeNull();
  });

  it("contains no private key material anywhere under license-checker/", () => {
    const files = listSourceFiles(checkerRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} must not contain the test private key`).not.toContain(KNOWN_TEST_PRIVATE_KEY);
      for (const marker of PRIVATE_KEY_MARKERS) {
        expect(content, `${file} must not contain private-key marker "${marker}"`).not.toContain(marker);
      }
    }
  });
});
