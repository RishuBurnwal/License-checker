import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Standalone license-checker (design §8). Mirrors admin/ conventions. The dev
// proxy is a convenience for pointing the UI at a locally-running Worker; the
// real server base URL is always entered by the user in the Add-License form
// (AC-39, nothing is hardcoded).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    proxy: {
      "/api": "http://localhost:8787"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
