/**
 * Minimal ESM resolve hook so `node --experimental-strip-types` can run the
 * Node/Vercel entry (`src/entry-node.ts`) WITHOUT changing the codebase's
 * extensionless import convention (tsconfig uses `moduleResolution: Bundler`,
 * which permits `import x from "./y"`; bare Node does not resolve those).
 *
 * It only kicks in for relative specifiers that have no extension and resolves
 * them to the matching `.ts` (or `.ts` index) file. No transformation, no new
 * dependency — pairs with Node 22's built-in `--experimental-strip-types`.
 *
 * Usage (see worker/package.json "node:serve"):
 *   node --experimental-transform-types --experimental-sqlite \
 *        --import ./scripts/ts-resolve-loader.mjs src/entry-node.ts
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";

// Register this module as a resolve hook for the current process.
register(import.meta.url, pathToFileURL("./"));

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier);
  if (isRelative && !hasExtension && context.parentURL) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const base = resolvePath(parentDir, specifier);
    const candidates = [`${base}.ts`, `${base}/index.ts`];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
