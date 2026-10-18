/*
 * Assemble a debug build of the extension in test/debug/build/.
 *
 * Copies only what the manifest actually references, then rewrites the manifest
 * to insert debug.js immediately before main.js. The shipping manifest is never
 * touched, so the debug reporter cannot leak into a release package.
 *
 * Usage: node test/debug/make-debug-build.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD = join(ROOT, "test", "debug", "build");

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

// Insert the reporter after the modules it wraps, before the entry point that
// registers the listeners.
const scripts = manifest.background.scripts.slice();
const entryIndex = scripts.findIndex((s) => s.endsWith("main.js"));
if (entryIndex === -1) throw new Error("could not find main.js in background.scripts");
scripts.splice(entryIndex, 0, "test/debug/debug.js");
manifest.background.scripts = scripts;

manifest.name = manifest.name + " (debug)";

// Collect every file the manifest references, plus our reporter and page probe.
const files = new Set([
  ...manifest.background.scripts,
  ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ...Object.values(manifest.icons || {}),
  "manifest.json"
]);

// Attach the page-state probe to the YouTube content script entry.
for (const cs of manifest.content_scripts) {
  if (cs.matches.some((m) => m.includes("youtube")) && !cs.world) {
    cs.js = [...cs.js, "test/debug/probe-page.js"];
    files.add("test/debug/probe-page.js");
  }
}

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

for (const rel of files) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) {
    console.log("  !! missing, skipping:", rel);
    continue;
  }
  const dest = join(BUILD, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

// The reporter lives at test/debug/debug.js in the source tree but is declared
// at that path in this manifest, which is why the whole test/ subtree is copied
// only for the paths we listed. Confirm it landed.
if (!existsSync(join(BUILD, "test", "debug", "debug.js"))) {
  throw new Error("debug.js was not copied into the build");
}

writeFileSync(join(BUILD, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log("debug build ready:", BUILD);
console.log("background order:");
for (const s of manifest.background.scripts) console.log("   ", s);
