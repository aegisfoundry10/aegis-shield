/*
 * Capture real YouTube InnerTube responses, then run the extension's own
 * rewriter over them. This is the debugging harness for the live Firefox
 * failure: "home feed does not load, search works, playback delayed".
 *
 * Requires outbound network. Writes raw fixtures to test/fixtures/raw/.
 *
 * Usage: node test/capture-real.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { gunzipSync, brotliDecompressSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "test", "fixtures", "raw");
mkdirSync(RAW, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

function load(rel) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  new Function(src).call(globalThis);
}

function magic(buf) {
  const b = Buffer.from(buf);
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return "gzip";
  if (b.length >= 3 && b[0] === 0x62 && b[1] === 0x72 && b[2] === 0x6f) return "brotli";
  if (b.length >= 2 && b[0] === 0x78) return "zlib/deflate";
  const head = b.slice(0, 40).toString("utf8");
  if (/^[\s]*[{[]/.test(head)) return "plain-json";
  return "unknown(" + head.replace(/[^\x20-\x7e]/g, ".") + ")";
}

async function main() {
  console.log("=== 1. fetch the YouTube watch/home HTML to learn the API key ===");
  const htmlRes = await fetch("https://www.youtube.com/", {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }
  });
  const html = await htmlRes.text();
  console.log("  html status:", htmlRes.status, "bytes:", html.length);

  const keyMatch =
    html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) ||
    html.match(/INNERTUBE_API_KEY"?\s*:\s*"([^"]+)"/);
  const verMatch =
    html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) ||
    html.match(/INNERTUBE_CLIENT_VERSION"?\s*:\s*"([^"]+)"/);

  const apiKey = keyMatch && keyMatch[1];
  const clientVersion = verMatch && verMatch[1];

  console.log("  INNERTUBE_API_KEY:", apiKey ? apiKey.slice(0, 12) + "…" : "NOT FOUND");
  console.log("  INNERTUBE_CLIENT_VERSION:", clientVersion || "NOT FOUND");

  if (!apiKey || !clientVersion) {
    console.log("\nCould not extract the InnerTube credentials; aborting.");
    process.exit(1);
  }

  const context = {
    client: {
      hl: "en",
      gl: "US",
      clientName: "WEB",
      clientVersion,
      userAgent: UA
    }
  };

  const endpoints = [
    { name: "browse-home", path: "/youtubei/v1/browse", body: { browseId: "FEwhat_to_watch", context } },
    { name: "search", path: "/youtubei/v1/search", body: { query: "test", context } },
    { name: "player", path: "/youtubei/v1/player", body: { videoId: "jNQXAC9IVRw", context, contentCheckOk: true, racyCheckOk: true } }
  ];

  const results = {};

  for (const ep of endpoints) {
    const url =
      "https://www.youtube.com" +
      ep.path +
      "?key=" +
      apiKey +
      "&prettyPrint=false";
    console.log("\n=== 2. POST " + ep.path + " ===");
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": UA,
          "accept-language": "en-US,en;q=0.9",
          origin: "https://www.youtube.com",
          "x-youtube-client-name": "1",
          "x-youtube-client-version": clientVersion
        },
        body: JSON.stringify(ep.body)
      });
    } catch (e) {
      console.log("  request failed:", e.message);
      continue;
    }

    console.log("  status:", res.status);
    console.log("  content-encoding:", res.headers.get("content-encoding") || "(none)");
    console.log("  content-type:", res.headers.get("content-type"));
    console.log("  content-length:", res.headers.get("content-length") || "(absent)");
    console.log("  transfer-encoding:", res.headers.get("transfer-encoding") || "(absent)");

    const raw = Buffer.from(await res.arrayBuffer());
    console.log("  raw bytes:", raw.length);
    console.log("  raw magic:", magic(raw));

    // What the StreamFilter would hand us, per Firefox docs: DECODED bytes.
    let decoded = raw;
    const enc = (res.headers.get("content-encoding") || "").toLowerCase();
    try {
      if (enc.includes("br")) decoded = brotliDecompressSync(raw);
      else if (enc.includes("gzip")) decoded = gunzipSync(raw);
    } catch (e) {
      console.log("  !! could not decompress despite header saying", enc, "—", e.message);
    }
    console.log("  decoded bytes:", decoded.length);
    console.log("  decoded magic:", magic(decoded));

    writeFileSync(join(RAW, ep.name + ".raw"), raw);
    writeFileSync(join(RAW, ep.name + ".decoded"), decoded);

    let parsed = null;
    try {
      parsed = JSON.parse(decoded.toString("utf8"));
    } catch (e) {
      console.log("  decoded is NOT valid JSON:", e.message);
    }

    results[ep.name] = {
      encoding: res.headers.get("content-encoding"),
      rawLen: raw.length,
      decodedLen: decoded.length,
      rawMagic: magic(raw),
      decodedMagic: magic(decoded),
      parsed: !!parsed
    };

    if (parsed) {
      // What does the extension's own pruner do to the real payload?
      load("src/common/prune.js");
      const P = globalThis.__AEGIS_PRUNE__;

      const title = (o) => {
        try {
          return o.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content
            .richGridRenderer.contents.length;
        } catch (e) {
          return "n/a";
        }
      };
      const before = title(parsed);
      const adCount = P.detectAds(parsed);
      const copy = JSON.parse(JSON.stringify(parsed));
      P.pruneInitialData(copy);
      const after = title(copy);

      console.log("  detectAds:", adCount);
      console.log("  home feed items before:", before, "after:", after);
      console.log("  top-level keys before:", Object.keys(parsed).join(","));
      console.log("  top-level keys after :", Object.keys(copy).join(","));
      const gone = Object.keys(parsed).filter((k) => !(k in copy));
      const added = Object.keys(copy).filter((k) => !(k in parsed));
      console.log("  keys removed:", JSON.stringify(gone));
      console.log("  keys added  :", JSON.stringify(added));
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("capture failed:", e);
  process.exit(1);
});
