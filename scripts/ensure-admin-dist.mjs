import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// wrangler.toml points [assets] at ../admin/dist, and `wrangler dev` fails when
// that directory does not exist yet. Creating it here keeps `pnpm dev` working
// on Windows, where `mkdir -p` is not a valid command.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(repoRoot, "admin", "dist");

fs.mkdirSync(assetsDir, { recursive: true });
