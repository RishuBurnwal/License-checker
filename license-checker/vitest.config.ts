import { defineConfig } from "vitest/config";

// The checker's crypto/canonical/freshness logic is pure and runs under Node
// (crypto.subtle Ed25519, btoa/atob, and node:fs for the no-private-key scan are
// all available in the Node test environment). UI components are not unit-tested.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
