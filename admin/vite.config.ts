import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    // Bind to 0.0.0.0 so the dev server is reachable from other devices on
    // the same network via this machine's LAN IP, not only localhost.
    host: true,
    proxy: {
      "/api": "http://localhost:8787"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
