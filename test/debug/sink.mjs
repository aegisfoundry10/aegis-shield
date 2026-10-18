/*
 * Local diagnostic sink.
 *
 * Receives POSTs from test/debug/debug.js while a real Firefox runs against
 * YouTube. Prints each report as it arrives and writes the full JSONL to
 * test/debug/reports.jsonl.
 *
 * Usage: node test/debug/sink.mjs [seconds]
 */

import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "test", "debug", "reports.jsonl");
// Overridable, because a previous run's sink may still hold the default port and
// a silent bind failure is very confusing: the run appears to produce no reports
// when in fact the sink never started.
const PORT = Number(process.env.AEGIS_SINK_PORT || 8787);

// NOTE: truncation happens in the listen callback below, not here. Truncating
// before binding means a failed bind destroys the previous run's reports.

const seen = [];
let filterCount = 0;
let rewriterCount = 0;

const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(204);
    res.end();

    let msg = null;
    try {
      msg = JSON.parse(body);
    } catch {
      console.log("  [raw]", body.slice(0, 200));
      return;
    }

    seen.push(msg);
    appendFileSync(OUT, JSON.stringify(msg) + "\n");

    if (msg.phase === "debug-loaded") {
      console.log("  *** debug reporter is alive ***");
      return;
    }

    if (msg.phase === "filter-create-FAILED") {
      console.log(`  !! filterResponseData THREW: ${msg.error}`);
      return;
    }

    if (msg.phase === "filter") {
      filterCount++;
      const comp = msg.compressionMagic ? `COMPRESSED(${msg.compressionMagic})` : "plain";
      console.log(
        `  [filter ${msg.id}] chunks=${msg.chunkCount} bytes=${msg.totalBytes} ` +
          `first=${msg.firstChunkBytes}B ${comp} elapsed=${msg.elapsedMs}ms`
      );
      console.log(`      first bytes: ${msg.firstChunkAscii}`);
      console.log(`      hex        : ${msg.firstChunkHex}`);
      return;
    }

    if (msg.phase === "rewriter-finish") {
      rewriterCount++;
      console.log(
        `  [rewriter] player=${msg.isPlayer} changed=${msg.changed} ` +
          `reason=${msg.reason} adsRemoved=${msg.adsRemoved} out=${msg.outBytes}B`
      );
      return;
    }

    console.log("  [" + msg.phase + "]", JSON.stringify(msg).slice(0, 200));
  });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `FATAL: port ${PORT} is already in use — another sink is probably still running.`
    );
    console.error(`Kill it, or re-run with AEGIS_SINK_PORT=<other port>.`);
    console.error(
      `NOTE: the extension reports to a hard-coded 127.0.0.1:8787, so a different`
    );
    console.error(`port also requires changing ENDPOINT in test/debug/debug.js.`);
    process.exit(2);
  }
  console.error("FATAL: sink server error:", err && err.message);
  process.exit(2);
});

server.listen(PORT, "127.0.0.1", () => {
  // Truncate only once we actually own the port.
  writeFileSync(OUT, "");
  console.log(`sink listening on http://127.0.0.1:${PORT}`);
  console.log(`writing ${OUT}`);
});

const seconds = Number(process.argv[2] || 100);
setTimeout(() => {
  console.log("\n================ SUMMARY ================");
  console.log(`reports received      : ${seen.length}`);
  console.log(`filters created       : ${filterCount}`);
  console.log(`rewriter.finish calls : ${rewriterCount}`);

  const filters = seen.filter((m) => m.phase === "filter");
  if (filters.length) {
    const compressed = filters.filter((m) => m.compressionMagic).length;
    console.log(`filters whose first chunk looked COMPRESSED: ${compressed} / ${filters.length}`);
    const reasons = {};
    for (const m of seen.filter((x) => x.phase === "rewriter-finish")) {
      reasons[m.reason] = (reasons[m.reason] || 0) + 1;
    }
    console.log("rewriter outcomes:", JSON.stringify(reasons));
  } else {
    console.log("NO filters were ever created — interception never engaged.");
  }

  const failed = seen.filter((m) => m.phase === "filter-create-FAILED");
  if (failed.length) {
    console.log(`filterResponseData threw ${failed.length} time(s). First error: ${failed[0].error}`);
  }

  server.close();
  process.exit(0);
}, seconds * 1000);
