/*
 * Aegis Shield (Firefox) — HTML boot-payload rewriter tests.
 * Run: node --test test/html-rewriter.test.mjs
 *
 * Includes tests against a REAL YouTube document captured from the live site
 * (test/fixtures/raw/watch.html, 1.34 MB). Capture it with:
 *   node test/capture-real.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(rel) {
  new Function(readFileSync(join(ROOT, rel), "utf8")).call(globalThis);
  return globalThis;
}

load("src/common/prune.js");
load("src/common/html-rewriter.js");

const P = globalThis.__AEGIS_PRUNE__;
const H = globalThis.__AEGIS_HTML__;

const opts = {
  prunePlayer: P.prunePlayerResponse,
  pruneData: P.pruneInitialData,
  prunePlayerCounted: P.prunePlayerResponseCounted,
  pruneDataCounted: P.pruneInitialDataCounted,
  detectAds: P.detectAds
};

/* ---------------------------------------------------------------- *
 * Synthetic — extractor correctness
 * ---------------------------------------------------------------- */

test("finds and bounds an inline JSON assignment", () => {
  const html = `<script>var ytInitialData = {"a":1,"b":{"c":[1,2]}};</script><p>after</p>`;
  const span = H.findJsonValue(html, "ytInitialData");
  assert.ok(span);
  assert.equal(html.slice(span.start, span.end), '{"a":1,"b":{"c":[1,2]}}');
});

test("brace scanning is string-aware", () => {
  // Braces and escaped quotes inside strings must not terminate the scan.
  const payload = { t: "} not the end {", q: 'he said "hi"', nested: { deep: true } };
  const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify(payload)};</script>`;
  const span = H.findJsonValue(html, "ytInitialPlayerResponse");
  assert.ok(span);
  assert.deepEqual(JSON.parse(html.slice(span.start, span.end)), payload);
});

test("resists a decoy identifier that is not the assignment", () => {
  const html = `<script>log("ytInitialData"); var ytInitialData = {"ok":true};</script>`;
  const span = H.findJsonValue(html, "ytInitialData");
  assert.ok(span);
  assert.equal(html.slice(span.start, span.end), '{"ok":true}');
});

test("refuses to guess on an unterminated value", () => {
  assert.equal(H.findJsonValue(`var ytInitialData = {"a":1`, "ytInitialData"), null);
});

test("reports not-found rather than throwing", () => {
  const res = H.rewriteHtml("<html>nothing here</html>", opts);
  assert.equal(res.changed, false);
  assert.equal(res.html, null);
  assert.equal(res.detail.ytInitialPlayerResponse, "not-found");
});

test("prunes an inline payload and leaves the rest of the document alone", () => {
  const payload = {
    playabilityStatus: { status: "OK" },
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
    adBreakHeartbeatParams: "X"
  };
  const before = `<html><head></head><body><script>var ytInitialPlayerResponse = ${JSON.stringify(
    payload
  )};</script><footer>UNCHANGED-TAIL</footer></body></html>`;

  const res = H.rewriteHtml(before, opts);
  assert.equal(res.changed, true);
  assert.ok(res.html.includes("UNCHANGED-TAIL"), "surrounding document must be intact");
  assert.ok(res.html.includes("<footer>"), "markup must be intact");

  const span = H.findJsonValue(res.html, "ytInitialPlayerResponse");
  const out = JSON.parse(res.html.slice(span.start, span.end));
  assert.equal("adPlacements" in out, false);
  assert.equal("playerAds" in out, false);
  assert.equal("adSlots" in out, false);
  assert.equal("adBreakHeartbeatParams" in out, false);
  assert.equal(out.playabilityStatus.status, "OK");
});

test("an ad-free document is left byte-identical", () => {
  const payload = { playabilityStatus: { status: "OK" }, videoDetails: { videoId: "x" } };
  const before = `<script>var ytInitialPlayerResponse = ${JSON.stringify(payload)};</script>`;
  const res = H.rewriteHtml(before, opts);
  assert.equal(res.changed, false, "must not rewrite a document it did not change");
  assert.equal(res.html, null);
});

test("a formatting or escape difference is NOT treated as a change", () => {
  // Regression: YouTube inlines these payloads with \u003c-style escapes and
  // arbitrary whitespace. Comparing the re-serialised JSON against the raw
  // substring made every document look "changed", so an 850 KB home page was
  // rewritten having removed nothing.
  const payload = { playabilityStatus: { status: "OK" }, title: "a<b>c" };
  const escaped = JSON.stringify(payload).replace(/</g, "\\u003c");

  const before = `<script>var ytInitialPlayerResponse = ${escaped};</script>`;
  assert.notEqual(escaped, JSON.stringify(payload), "fixture must differ textually");

  const res = H.rewriteHtml(before, opts);
  assert.equal(res.changed, false, "textual difference alone must not trigger a rewrite");
  assert.equal(res.html, null);
  assert.equal(res.detail.ytInitialPlayerResponse, "unchanged");
});

test("escaping does not mask a real change", () => {
  const payload = { adPlacements: [{ x: 1 }], title: "a<b>c" };
  const escaped = JSON.stringify(payload).replace(/</g, "\\u003c");
  const before = `<script>var ytInitialPlayerResponse = ${escaped};</script>`;

  const res = H.rewriteHtml(before, opts);
  assert.equal(res.changed, true, "a real removal must still trigger a rewrite");
  const span = H.findJsonValue(res.html, "ytInitialPlayerResponse");
  assert.equal("adPlacements" in JSON.parse(res.html.slice(span.start, span.end)), false);
});

test("a payload containing </script> cannot break out of the tag", () => {
  // YouTube escapes `<` as \u003c in these inline payloads so that embedded
  // strings cannot terminate the script element early. Re-serialising with plain
  // JSON.stringify would undo that and inject a literal </script>.
  const payload = {
    adPlacements: [{ x: 1 }],
    malicious: "</script><img src=x onerror=alert(1)><script>",
    amp: "a & b",
    line: "sep\u2028arator"
  };
  const before = `<script>var ytInitialPlayerResponse = ${H.serializeForHtml(
    payload
  )};</script>`;

  const res = H.rewriteHtml(before, opts);
  assert.equal(res.changed, true);

  const out = res.html;
  // Count script boundaries: exactly the two we started with.
  const opens = (out.match(/<script>/g) || []).length;
  const closes = (out.match(/<\/script>/g) || []).length;
  assert.equal(opens, 1, "no injected <script> may appear");
  assert.equal(closes, 1, "no injected </script> may appear");

  assert.ok(out.includes("\\u003c"), "HTML-significant characters must be re-escaped");
  assert.ok(!/<\/script><img/.test(out), "the payload must not escape the tag");

  // And the value must still round-trip exactly.
  const span = H.findJsonValue(out, "ytInitialPlayerResponse");
  const parsed = JSON.parse(out.slice(span.start, span.end));
  assert.equal(parsed.malicious, payload.malicious);
  assert.equal(parsed.amp, payload.amp);
  assert.equal(parsed.line, payload.line);
  assert.equal("adPlacements" in parsed, false);
});

test("serializeForHtml escapes everything dangerous", () => {
  const s = H.serializeForHtml({ a: "<x>", b: "&", c: "\u2028", d: "\u2029" });
  assert.ok(!/[<>&]/.test(s), "raw < > & must not survive: " + s);
  assert.ok(!/[\u2028\u2029]/.test(s), "line separators must be escaped");
  assert.deepEqual(JSON.parse(s), { a: "<x>", b: "&", c: "\u2028", d: "\u2029" });
});

test("handles both payloads in one document, back to front", () => {
  const before =
    `<script>var ytInitialPlayerResponse = {"adPlacements":[{}],"keep":1};</script>` +
    `<div>middle</div>` +
    `<script>var ytInitialData = {"adSlots":[{}],"keep":2};</script>`;

  const res = H.rewriteHtml(before, opts);
  assert.equal(res.changed, true);
  assert.ok(res.html.includes("<div>middle</div>"), "the offset between edits must survive");

  const a = H.findJsonValue(res.html, "ytInitialPlayerResponse");
  const b = H.findJsonValue(res.html, "ytInitialData");
  assert.equal("adPlacements" in JSON.parse(res.html.slice(a.start, a.end)), false);
  assert.equal("adSlots" in JSON.parse(res.html.slice(b.start, b.end)), false);
  assert.equal(JSON.parse(res.html.slice(a.start, a.end)).keep, 1);
  assert.equal(JSON.parse(res.html.slice(b.start, b.end)).keep, 2);
});

test("refuses documents beyond the size ceiling", () => {
  const res = H.rewriteHtml("x".repeat(H.MAX_HTML + 1), opts);
  assert.equal(res.changed, false);
  assert.equal(res.detail.reason, "skip-size-or-type");
});

/* ---------------------------------------------------------------- *
 * Real document
 * ---------------------------------------------------------------- */

const WATCH = join(ROOT, "test", "fixtures", "raw", "watch.html");
const haveWatch = existsSync(WATCH);

test("real YouTube watch document: finds the inline boot payload", { skip: !haveWatch }, () => {
  const html = readFileSync(WATCH, "utf8");
  assert.ok(html.length > 100000, "fixture should be a full document");

  const span = H.findJsonValue(html, "ytInitialPlayerResponse");
  assert.ok(span, "the fixture must contain an inline ytInitialPlayerResponse");

  const parsed = JSON.parse(html.slice(span.start, span.end));
  assert.ok(parsed.responseContext || parsed.playabilityStatus, "should be a real player response");
  console.log(
    "        inline keys:",
    Object.keys(parsed).join(","),
    "| has adPlacements:",
    "adPlacements" in parsed
  );
});

test("real YouTube watch document: round-trip is safe", { skip: !haveWatch }, () => {
  const html = readFileSync(WATCH, "utf8");
  const res = H.rewriteHtml(html, opts);

  if (!res.changed) {
    // The signed-out cold fetch usually serves no ads, so an unchanged document
    // is the expected outcome and must stay byte-identical.
    assert.equal(res.html, null);
    console.log("        (no ads in this fixture — pass-through verified)");
    return;
  }

  // If it did rewrite, the document must still be structurally sound and the
  // surrounding markup must be untouched.
  assert.ok(res.html.endsWith(html.slice(-200)), "document tail must be unchanged");
  assert.ok(res.html.startsWith(html.slice(0, 200)), "document head must be unchanged");
  assert.ok(res.html.includes("</html>"), "document must remain closed");

  const span = H.findJsonValue(res.html, "ytInitialPlayerResponse");
  assert.ok(span, "the payload must still be locatable after rewrite");
  assert.doesNotThrow(() => JSON.parse(res.html.slice(span.start, span.end)));
  console.log("        rewritten, adsRemoved:", res.adsRemoved, JSON.stringify(res.detail));
});
