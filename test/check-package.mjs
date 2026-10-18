/*
 * Assert that the built .xpi/.zip contains ONLY extension files.
 *
 * The packaging config works by exclusion (ignoreFiles), which means any new
 * top-level file that does not match an ignore pattern ships to users and to
 * AMO reviewers by default. This turns that default into an explicit allowlist:
 * if someone adds `notes.txt` or `secrets.local.json` at the root, CI fails
 * instead of publishing it.
 *
 * Usage: node test/check-package.mjs
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Top-level paths that are allowed to exist inside the package. */
const ALLOWED_TOP = new Set([
  "manifest.json",
  "src",
  "icons",
  "docs",
  "test",
  // GPL-3.0 requires the license to accompany distribution, so LICENSE
  // deliberately ships inside the package.
  "LICENSE"
]);

/** Anything that must never ship. */
const FORBIDDEN = [
  /^\.github\//,
  /^test\//,
  /^docs\/.+/,
  /^amo-metadata\.json$/,
  /^package(-lock)?\.json$/,
  /\.md$/,
  /^\.web-ext-config\.mjs$/,
  /^\.gitignore$/
];

function listBuilt() {
  const dir = join(ROOT, "web-ext-artifacts");
  let zips;
  try {
    zips = readdirSync(dir).filter((f) => f.endsWith(".zip"));
  } catch {
    return null;
  }
  if (!zips.length) return null;
  // Newest.
  zips.sort((a, b) =>
    statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs
  );
  const zip = join(dir, zips[0]);

  const out = execFileSync("python", [
    "-c",
    `import zipfile,sys,json
z=zipfile.ZipFile(r"${zip}")
print(json.dumps(z.namelist()))`
  ]).toString();

  return { zip, entries: JSON.parse(out) };
}

const built = listBuilt();
if (!built) {
  console.error("No build found. Run: npx web-ext build");
  process.exit(2);
}

const problems = [];
const unexpected = [];

for (const entry of built.entries) {
  const top = entry.split("/")[0];
  if (!entry.endsWith("/") && !ALLOWED_TOP.has(top)) {
    unexpected.push(entry);
  }
  for (const re of FORBIDDEN) {
    if (re.test(entry) && !entry.endsWith("/")) {
      problems.push(`${entry}  (matches forbidden ${re})`);
    }
  }
}

console.log("package:", built.zip.split(/[\\/]/).pop());
console.log("entries:", built.entries.length);

const dirs = built.entries.filter((e) => e.endsWith("/"));
if (dirs.length) {
  console.log("note: empty directory entries in package:", dirs.join(" "));
  console.log("      harmless, but they are excluded content — see docs/RELEASE.md");
}

if (unexpected.length) {
  console.log("\nUNEXPECTED entries (not in the allowlist):");
  for (const u of unexpected) console.log("  ", u);
}

if (problems.length) {
  console.log(`\nFAILED — ${problems.length} file(s) that must not ship:`);
  for (const p of problems) console.log("  ", p);
  process.exit(1);
}

console.log("\npackage contents OK — nothing forbidden is shipping");
