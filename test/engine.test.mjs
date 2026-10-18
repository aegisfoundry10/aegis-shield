/*
 * Aegis Shield (Firefox) — engine and rule tests.
 * Run: node --test test/
 *
 * The common/ files are classic scripts with no bundler, so they load straight
 * into a sandbox and are exercised as pure functions. Nothing here touches a
 * browser. The StreamFilter itself is browser-only; what is tested is the state
 * machine it drives, which is where the real risk lives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(rel) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(src).call(globalThis);
  return globalThis;
}

load("src/common/prune.js");
load("src/common/stream-rewriter.js");
load("src/common/rules.js");

const P = globalThis.__AEGIS_PRUNE__;
const RW = globalThis.__AEGIS_REWRITER__;
const R = globalThis.__AEGIS_RULES__;

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

function playerResponseFixture() {
  return {
    responseContext: { visitorData: "abc" },
    playabilityStatus: { status: "OK" },
    streamingData: {
      adaptiveFormats: [
        { itag: 137, url: "https://rr3---sn-abc.googlevideo.com/videoplayback?id=o1&itag=137" }
      ]
    },
    adPlacements: [{ adPlacementRenderer: { renderer: {} } }],
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
    adBreakHeartbeatParams: "Q0FBU0UtQUQ",
    videoDetails: { videoId: "dQw4w9WgXcQ", title: "café → test", lengthSeconds: "212" }
  };
}

function toChunks(bytes, sizes) {
  const out = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    out.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) out.push(bytes.slice(offset));
  return out;
}

function makeRewriter(isPlayer) {
  return RW.createRewriter({
    prunePlayer: P.prunePlayerResponse,
    pruneData: P.pruneInitialData,
    detectAds: P.detectAds,
    isPlayer
  });
}

function feed(rewriter, chunks) {
  for (const c of chunks) rewriter.push(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength));
}

/* ---------------------------------------------------------------- *
 * stream-rewriter — the heart of the Firefox port
 * ---------------------------------------------------------------- */

test("rewrites a player response delivered in one chunk", () => {
  const rw = makeRewriter(true);
  const bytes = new TextEncoder().encode(JSON.stringify(playerResponseFixture()));
  feed(rw, [bytes]);

  const res = rw.finish();
  assert.equal(res.changed, true);
  assert.ok(res.adsRemoved > 0, "should count the ad structures it removed");

  const out = JSON.parse(new TextDecoder().decode(res.bytes));
  assert.equal("adPlacements" in out, false);
  assert.equal("playerAds" in out, false);
  assert.equal("adSlots" in out, false);
  assert.equal("adBreakHeartbeatParams" in out, false);
  assert.equal(out.videoDetails.videoId, "dQw4w9WgXcQ");
  assert.equal(out.streamingData.adaptiveFormats.length, 1);
});

test("rewrites correctly across many chunk boundaries", () => {
  const bytes = new TextEncoder().encode(JSON.stringify(playerResponseFixture()));
  for (const size of [1, 2, 3, 7, 13, 64, 512]) {
    const rw = makeRewriter(true);
    feed(rw, toChunks(bytes, Array(2000).fill(size)));
    const res = rw.finish();
    assert.equal(res.changed, true, `chunk size ${size}`);
    const out = JSON.parse(new TextDecoder().decode(res.bytes));
    assert.equal("adPlacements" in out, false, `chunk size ${size}`);
  }
});

test("survives a split inside a multi-byte character", () => {
  const json = JSON.stringify(playerResponseFixture()); // contains é and →
  const bytes = new TextEncoder().encode(json);

  // Find a byte that starts a multi-byte sequence and cut one byte into it.
  let splitAt = -1;
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] >= 0xc0 && bytes[i] <= 0xf0) {
      splitAt = i + 1; // land mid-character
      break;
    }
  }
  assert.ok(splitAt > 0, "fixture must contain a multi-byte character");

  const rw = makeRewriter(true);
  feed(rw, [bytes.slice(0, splitAt), bytes.slice(splitAt)]);
  const res = rw.finish();

  assert.equal(res.changed, true);
  const out = JSON.parse(new TextDecoder().decode(res.bytes));
  assert.equal(out.videoDetails.title, "café → test", "text must survive the split");
});

test("passes through untouched when the body is not JSON", () => {
  const rw = makeRewriter(false);
  feed(rw, [new TextEncoder().encode("<html>not json at all</html>")]);
  const res = rw.finish();
  assert.equal(res.changed, false);
  assert.equal(res.bytes, null);
  assert.equal(res.reason, "not-json");
});

test("passes through untouched when the body is truncated JSON", () => {
  const bytes = new TextEncoder().encode('{"adPlacements":[{"x":1}],"play');
  const rw = makeRewriter(true);
  feed(rw, [bytes]);
  const res = rw.finish();
  assert.equal(res.changed, false, "half a JSON document must never be re-emitted");
  assert.equal(res.reason, "not-json");
});

test("refuses to buffer beyond the ceiling", () => {
  const rw = RW.createRewriter({
    prunePlayer: P.prunePlayerResponse,
    pruneData: P.pruneInitialData,
    detectAds: P.detectAds,
    isPlayer: true,
    maxBytes: 32
  });
  feed(rw, [new TextEncoder().encode("x".repeat(64))]);
  const res = rw.finish();
  assert.equal(res.changed, false);
  assert.equal(res.reason, "too-large");
});

test("empty body is a no-op, not an error", () => {
  const rw = makeRewriter(false);
  const res = rw.finish();
  assert.equal(res.changed, false);
  assert.equal(res.reason, "empty");
});

test("a pruner that throws cannot corrupt the response", () => {
  const rw = RW.createRewriter({
    prunePlayer: () => {
      throw new Error("boom");
    },
    pruneData: () => {},
    detectAds: () => 0,
    isPlayer: true
  });
  feed(rw, [new TextEncoder().encode('{"adPlacements":[]}')]);
  const res = rw.finish();
  assert.equal(res.changed, false);
  assert.equal(res.reason, "prune-threw");
});

test("finish() is idempotent", () => {
  const rw = makeRewriter(true);
  feed(rw, [new TextEncoder().encode(JSON.stringify(playerResponseFixture()))]);
  const first = rw.finish();
  const second = rw.finish();
  assert.equal(first.changed, true);
  assert.equal(second.changed, true, "a second finish must not throw or blank the stream");
});

test("a body with no ads is passed through byte-identically", () => {
  // Regression: v0.2.0 rewrote every intercepted response, even when it removed
  // nothing. Re-serialising a response we did not change desynchronised the body
  // from Content-Length and truncated it, which broke YouTube's application
  // bootstrap (the guide response) and took the whole home feed down.
  const noAds = {
    responseContext: { visitorData: "abc" },
    items: [
      { guideEntryRenderer: { title: "Home" } },
      { guideEntryRenderer: { title: "Shorts" } }
    ],
    trackingParams: "xyz"
  };
  const rw = makeRewriter(false);
  feed(rw, [new TextEncoder().encode(JSON.stringify(noAds))]);
  const res = rw.finish();

  assert.equal(res.changed, false, "must not rewrite a response it did not change");
  assert.equal(res.bytes, null, "caller must write the original bytes back");
  assert.equal(res.reason, "unchanged");
});

test("a body with ads IS rewritten, and the output really differs", () => {
  const withAds = {
    responseContext: { visitorData: "abc" },
    adSlots: [{ adSlotRenderer: { adSlotMetadata: { adSlotId: "1" } } }],
    contents: { itemSectionRenderer: { contents: [{ videoRenderer: { videoId: "keep" } }] } }
  };
  const rw = makeRewriter(false);
  feed(rw, [new TextEncoder().encode(JSON.stringify(withAds))]);
  const res = rw.finish();

  assert.equal(res.changed, true);
  assert.ok(res.bytes, "must produce bytes when it changed something");
  assert.ok(res.adsRemoved > 0);
  const out = JSON.parse(new TextDecoder().decode(res.bytes));
  assert.equal("adSlots" in out, false);
  assert.equal(out.contents.itemSectionRenderer.contents.length, 1);
});

test("pass-through still holds when the JSON key order round-trips exactly", () => {
  // JSON.parse/stringify is order-preserving for string keys, so an untouched
  // document must compare equal. If this ever fails, the pass-through guard is
  // silently disabled and every response gets rewritten again.
  const doc = {
    z: 1,
    a: { nested: [1, 2, { deep: true }], s: "café → ok" },
    m: [{ videoRenderer: { videoId: "x" } }]
  };
  const text = JSON.stringify(doc);
  assert.equal(JSON.stringify(JSON.parse(text)), text);

  const rw = makeRewriter(false);
  feed(rw, [new TextEncoder().encode(text)]);
  const res = rw.finish();
  assert.equal(res.changed, false);
  assert.equal(res.reason, "unchanged");
});

/* ---------------------------------------------------------------- *
 * rules — blocking correctness, and the false positive that matters
 * ---------------------------------------------------------------- */

test("blocks the YouTube ad endpoints", () => {
  const should = [
    "https://www.youtube.com/pagead/x.js",
    "https://www.youtube.com/youtubei/v1/player/ad_break",
    "https://www.youtube.com/api/stats/ads?x=1",
    "https://www.youtube.com/api/stats/atr?x=1",
    "https://www.youtube.com/ptracking?x=1",
    "https://www.youtube.com/get_video_info?video_id=1&adunit=abc"
  ];
  for (const url of should) {
    assert.ok(R.shouldBlock(url, "https://www.youtube.com"), `should block ${url}`);
  }
});

test("does NOT block the actual video pages or the player API", () => {
  const shouldNot = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/youtubei/v1/player?key=AIza&prettyPrint=false",
    "https://www.youtube.com/youtubei/v1/next?key=AIza",
    "https://www.youtube.com/api/stats/qoe?cpn=abc&cver=2.0",
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
  ];
  for (const url of shouldNot) {
    assert.equal(R.shouldBlock(url, "https://www.youtube.com"), null, `must not block ${url}`);
  }
});

test("the googlevideo rule fires on ad media and never on playback", () => {
  // This is the single most dangerous rule in the table: get it wrong and
  // YouTube video stops working entirely.
  const playback = [
    "https://rr3---sn-abc.googlevideo.com/videoplayback?id=o1&itag=137&mime=video%2Fmp4",
    "https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&ei=x&ip=1",
    "https://r2---sn-5hne6nsk.googlevideo.com/videoplayback?source=youtube&mn=sn-5hne6nsk"
  ];
  for (const url of playback) {
    assert.equal(
      R.shouldBlock(url, "https://www.youtube.com"),
      null,
      `MUST NOT block normal playback: ${url}`
    );
  }

  const ads = [
    "https://rr3---sn-abc.googlevideo.com/videoplayback?adformat=22&id=o1",
    "https://rr3---sn-abc.googlevideo.com/videoplayback?id=o1&adformat=22&itag=137"
  ];
  for (const url of ads) {
    assert.ok(R.shouldBlock(url, "https://www.youtube.com"), `should block ad stream: ${url}`);
  }
});

test("third-party ad hosts are blocked only from YouTube when scoped", () => {
  const dc = R.shouldBlock("https://static.doubleclick.net/a.js", "https://www.youtube.com");
  assert.ok(dc, "doubleclick from youtube should block");
  assert.equal(dc.id, "yt-doubleclick", "the YouTube-scoped rule should win");

  const generic = R.shouldBlock("https://static.doubleclick.net/a.js", "https://example.com");
  assert.ok(generic, "doubleclick from elsewhere should still block via the network group");
  assert.equal(generic.id, "net-doubleclick");

  const ytOnly = R.shouldBlock(
    "https://static.doubleclick.net/a.js",
    "https://example.com",
    ["youtube"]
  );
  assert.equal(
    ytOnly,
    null,
    "with only the youtube group enabled, a non-YouTube initiator must not match the youtube-scoped rule"
  );
});

test("enabled groups are respected", () => {
  const withNetworkOnly = ["network"];
  assert.equal(
    R.shouldBlock("https://www.youtube.com/pagead/x.js", "https://www.youtube.com", withNetworkOnly),
    null,
    "youtube rules must not fire when the youtube group is disabled"
  );
  assert.ok(
    R.shouldBlock("https://static.doubleclick.net/a.js", "https://example.com", withNetworkOnly),
    "network rules must still fire"
  );
  assert.equal(R.shouldBlock("https://x.test/a.js", "https://x.test", []), null);
});

test("intercept rules match the API endpoints and not the ad-break path", () => {
  const hit = [
    ["https://www.youtube.com/youtubei/v1/player?key=AIza", "player"],
    ["https://www.youtube.com/youtubei/v1/next?key=AIza", "data"],
    ["https://www.youtube.com/youtubei/v1/browse?key=AIza", "data"],
    ["https://www.youtube.com/youtubei/v1/search?key=AIza", "data"]
  ];
  for (const [url, kind] of hit) {
    const rule = R.interceptRule(url);
    assert.ok(rule, `should intercept ${url}`);
    assert.equal(rule.kind, kind, `wrong kind for ${url}`);
  }

  assert.equal(
    R.interceptRule("https://www.youtube.com/youtubei/v1/player/ad_break"),
    null,
    "ad_break is blocked, never rewritten"
  );
  assert.equal(
    R.interceptRule("https://www.youtube.com/youtubei/v1/guide?prettyPrint=false"),
    null,
    "guide is application bootstrap, carries no ads, and must not be filtered"
  );

  // A watch page IS intercepted now, as a document — that is where the boot
  // payload lives on a cold load.
  const doc = R.interceptRule("https://www.youtube.com/watch?v=1");
  assert.ok(doc, "watch pages must be intercepted as documents");
  assert.equal(doc.kind, "html");

  // ...but never as an API path.
  assert.equal(R.interceptRule("https://www.youtube.com/youtubei/v1/player/ad_break"), null);
});

/* ---------------------------------------------------------------- *
 * prune.js regression — same engine as the Chromium build
 * ---------------------------------------------------------------- */

test("prune engine still detects and strips, non-destructively on detect", () => {
  const pr = playerResponseFixture();
  const snapshot = JSON.stringify(pr);
  assert.ok(P.detectAds(pr) > 0);
  assert.equal(JSON.stringify(pr), snapshot, "detectAds must not mutate");
  P.prunePlayerResponse(pr);
  assert.equal("adPlacements" in pr, false);
});

test("prune engine never throws on hostile input", () => {
  for (const bad of [null, undefined, 0, "str", [], () => {}, Symbol("s")]) {
    assert.doesNotThrow(() => P.prunePlayerResponse(bad));
    assert.doesNotThrow(() => P.detectAds(bad));
  }
});
