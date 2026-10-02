// Reports non-ASCII CJK text outside the places where a legacy literal is
// required. Two exemptions are intentional:
//   1. migrations/ — published migrations are immutable, so the legacy seed
//      literals they contain must stay. `0004` uses them as WHERE guards.
//   2. A line carrying the `cjk-allow` marker — used by documentation that
//      quotes a legacy value as evidence.
// Any other CJK text is a regression and fails the script.
import fs from "node:fs";
import path from "node:path";

const skip = new Set(["node_modules", ".git", "dist", ".wrangler"]);
const cjk = /[\u4e00-\u9fff]/;
const extensions = /\.(ts|tsx|md|json|sql|html|mjs|yml|yaml|toml|css|txt)$/;
const exemptDirectory = /^migrations\//;
const allowMarker = "cjk-allow";
const violations = [];
const exempt = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (extensions.test(entry.name)) {
      const relative = path.relative(process.cwd(), full).split(path.sep).join("/");
      const lines = fs
        .readFileSync(full, "utf8")
        .split(/\r?\n/)
        .filter((line) => cjk.test(line) && !line.includes(allowMarker));
      if (lines.length === 0) continue;
      const item = { count: lines.length, file: relative };
      (exemptDirectory.test(relative) ? exempt : violations).push(item);
    }
  }
}

walk(".");

function report(title, items) {
  items.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  for (const item of items) {
    console.log(String(item.count).padStart(5), item.file);
  }
  console.log(`${title}: ${items.length}`);
}

if (exempt.length > 0) {
  console.log("Immutable migrations (expected):");
  report("IMMUTABLE FILES WITH CJK", exempt);
  console.log("");
}

report("UNEXPECTED FILES WITH CJK", violations);

if (violations.length > 0) {
  console.error(
    `\nFound CJK text in ${violations.length} file(s) outside migrations. ` +
      `Translate it, or add the ${allowMarker} marker if the line deliberately quotes a legacy value.`
  );
  process.exit(1);
}
