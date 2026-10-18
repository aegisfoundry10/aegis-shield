/*
 * Benchmark: cost of deciding whether a document needs rewriting.
 *
 * NOT SHIPPED — this is a measurement harness.
 *
 * Motivation: the rewriter used to decide "did anything change?" by
 * re-serialising the whole document and comparing the resulting string. On a
 * document with no ads that meant parse + two full stringifies of every byte,
 * on every page load, to conclude "do nothing". On a large signed-in YouTube
 * document that is a visible stall.
 *
 * This measures the old path against the new one on real captured documents so
 * the improvement is a number rather than a claim.
 *
 * Run: node test/bench-decision.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function load(rel) {
  new Function(readFileSync(join(ROOT, rel), "utf8")).call(globalThis);
  return globalThis;
}

load("src/common/prune.js");
load("src/common/html-rewriter.js");

const P = globalThis.__AEGIS_PRUNE__;
const H = globalThis.__AEGIS_HTML__;

const OPTS = {
  prunePlayer: P.prunePlayerResponse,
  pruneData: P.pruneInitialData,
  prunePlayerCounted: P.prunePlayerResponseCounted,
  pruneDataCounted: P.pruneInitialDataCounted,
  detectAds: P.detectAds
};

function loadFixture(rel) {
  try {
    return readFileSync(join(HERE, rel), "utf8");
  } catch (e) {
    return null;
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function timeIt(fn, runs = 5) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return median(times);
}

/**
 * The decision the old code made, reproduced exactly: canonicalise, count,
 * prune, serialise again, and compare. Returns whether it reported a change.
 */
function oldDecision(data) {
  const canonicalBefore = H.serializeForHtml(data);
  const before = P.detectAds(data);
  P.prunePlayerResponse(data);
  const out = H.serializeForHtml(data);
  const changed = out !== canonicalBefore;
  return { changed, before };
}

/** The decision the new code makes: prune with a counter, no serialisation. */
function newDecision(data) {
  const removed = P.prunePlayerResponseCounted(data);
  return { changed: removed > 0, removed };
}

function measure(doc, label) {
  if (!doc) {
    console.log(`  ${label}: fixture missing, skipped`);
    return null;
  }

  const span = H.findJsonValue(doc, "ytInitialPlayerResponse");
  if (!span) {
    console.log(`  ${label}: no inline payload, skipped`);
    return null;
  }

  const mb = doc.length / (1024 * 1024);

  // Cost of just obtaining the parsed payload, which both paths share.
  const tParse = timeIt(() => JSON.parse(doc.slice(span.start, span.end)));

  const tOld = timeIt(() => oldDecision(JSON.parse(doc.slice(span.start, span.end))), 3);
  const tNew = timeIt(() => newDecision(JSON.parse(doc.slice(span.start, span.end))), 5);

  // End-to-end, what the extension actually calls.
  const tRewrite = timeIt(() => H.rewriteHtml(doc, OPTS), 3);

  console.log(`  ${label}  (${mb.toFixed(2)} MB)`);
  console.log(`    parse only            ${tParse.toFixed(1)} ms`);
  console.log(`    OLD decision path     ${tOld.toFixed(1)} ms   (parse + 2x serialize)`);
  console.log(`    NEW decision path     ${tNew.toFixed(1)} ms   (parse + counted prune)`);
  console.log(`    speedup               ${(tOld / Math.max(tNew, 0.01)).toFixed(2)}x`);
  console.log(`    rewriteHtml end-to-end ${tRewrite.toFixed(1)} ms`);
  console.log("");

  return { mb, tOld, tNew, tRewrite, tParse };
}

console.log("=== decision-path cost, real captured documents ===\n");

const results = [
  measure(loadFixture("fixtures/raw/watch.html"), "watch page"),
  measure(loadFixture("fixtures/raw/home.html"), "home page")
].filter(Boolean);

console.log("=== extrapolation ===\n");
console.log("  A signed-in YouTube document carries a personalised feed, watch-next");
console.log("  and subscription data, so it is substantially larger than these");
console.log("  signed-out captures. The decision cost scales with the JSON payload,");
console.log("  so the per-MB rate below is the number that matters.\n");

for (const r of results) {
  const perMbOld = r.tOld / r.mb;
  const perMbNew = r.tNew / r.mb;
  console.log(`  at ${r.mb.toFixed(2)} MB -> ${perMbNew.toFixed(1)} ms/MB new, ${perMbOld.toFixed(1)} ms/MB old`);
}
console.log("");

if (results.length) {
  const r = results[0];
  const perMbOld = r.tOld / r.mb;
  const perMbNew = r.tNew / r.mb;
  console.log("  projected decision cost on a larger document:");
  for (const size of [2, 4, 8, 12]) {
    console.log(
      `    ${String(size).padStart(2)} MB   OLD ${(perMbOld * size).toFixed(0).padStart(5)} ms` +
        `    NEW ${(perMbNew * size).toFixed(0).padStart(5)} ms` +
        `    saved ${(perMbOld * size - perMbNew * size).toFixed(0).padStart(5)} ms`
    );
  }
  console.log("");
  console.log("  Note: this is the decision only. When an ad IS present both paths");
  console.log("  serialise once for the output, which is unavoidable.");
}
