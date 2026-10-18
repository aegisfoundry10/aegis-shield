/*
 * Aegis Shield (Firefox) — response-body rewriter.
 *
 * Pure state machine. No browser APIs. Buffers the chunks delivered by a
 * webRequest.StreamFilter, and on stream end returns the bytes to write back.
 *
 * This is where the ad removal actually happens: to the HTTP response body in
 * the network stack, before any page JavaScript runs. There is no MAIN-world
 * script, nothing patched on the page's own objects, and therefore nothing for
 * YouTube's tamper probe (/error_204 with msg containing "read-only" and
 * "non-configurable") to detect.
 *
 * Exposes (classic script, no bundler): globalThis.__AEGIS_REWRITER__
 */
(function (root) {
  "use strict";

  var DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

  /**
   * @param {object} opts
   * @param {(obj:any)=>any} opts.prunePlayer   player-response pruner
   * @param {(obj:any)=>any} opts.pruneData     ytInitialData pruner
   * @param {(n:any)=>number} opts.detectAds    ad counter
   * @param {boolean} opts.isPlayer             player response vs. other
   * @param {number}  [opts.maxBytes]           safety ceiling
   */
  function createRewriter(opts) {
    var chunks = [];
    var total = 0;
    var decoder = new TextDecoder("utf-8");
    var encoder = new TextEncoder();
    var maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    var overLimit = false;
    var finished = false;

    return {
      /** Feed one ArrayBuffer chunk from filter.ondata. */
      push: function (buffer) {
        if (finished) return;
        if (total + buffer.byteLength > maxBytes) {
          overLimit = true;
          return;
        }
        chunks.push(buffer);
        total += buffer.byteLength;
      },

      get byteLength() {
        return total;
      },

      /**
       * Called from filter.onstop.
       * @returns {{bytes: Uint8Array|null, changed: boolean, adsRemoved: number, reason: string}}
       *   bytes === null means "pass the original stream through untouched".
       */
      finish: function () {
        finished = true;

        if (overLimit) {
          return { bytes: null, changed: false, adsRemoved: 0, reason: "too-large" };
        }
        if (!chunks.length) {
          return { bytes: null, changed: false, adsRemoved: 0, reason: "empty" };
        }

        // Decode across chunk boundaries without corrupting multi-byte chars.
        var text;
        try {
          text = "";
          for (var i = 0; i < chunks.length; i++) {
            text += decoder.decode(chunks[i], { stream: true });
          }
          text += decoder.decode(); // flush
        } catch (e) {
          return { bytes: null, changed: false, adsRemoved: 0, reason: "decode-failed" };
        }

        // HTML mode: the document itself carries the boot payload. See
        // html-rewriter.js for why this path exists.
        if (opts.mode === "html") {
          var htmlRes;
          try {
            htmlRes = opts.rewriteHtml(text, {
              prunePlayer: opts.prunePlayer,
              pruneData: opts.pruneData,
              prunePlayerCounted: opts.prunePlayerCounted,
              pruneDataCounted: opts.pruneDataCounted,
              detectAds: opts.detectAds
            });
          } catch (e) {
            return { bytes: null, changed: false, adsRemoved: 0, reason: "html-threw" };
          }
          if (!htmlRes.changed || !htmlRes.html) {
            return {
              bytes: null,
              changed: false,
              adsRemoved: htmlRes.adsRemoved,
              reason: "html-unchanged"
            };
          }
          return {
            bytes: encoder.encode(htmlRes.html),
            changed: true,
            adsRemoved: htmlRes.adsRemoved,
            reason: "html-pruned"
          };
        }

        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          return { bytes: null, changed: false, adsRemoved: 0, reason: "not-json" };
        }

        // Decide whether anything changed from the pruner's own deletion count.
        //
        // This previously compared canonical forms, which required stringifying
        // the whole document twice more — three full serialisations per response.
        // Counting deletions is free, and it still cannot be fooled by a
        // formatting or escape difference in the wire bytes, because it never
        // looks at them.
        var removed = 0;
        try {
          removed = opts.isPlayer
            ? opts.prunePlayerCounted(data)
            : opts.pruneDataCounted(data);
        } catch (e) {
          return { bytes: null, changed: false, adsRemoved: 0, reason: "prune-threw" };
        }

        // Pass through untouched when nothing was actually removed. Rewriting a
        // response we did not change is pure risk: the rewritten length can
        // disagree with the original framing headers, and a truncated body breaks
        // the whole application (this is what broke YouTube's bootstrap `guide`
        // response in v0.2.0).
        if (removed === 0) {
          return { bytes: null, changed: false, adsRemoved: 0, reason: "unchanged" };
        }

        var out;
        try {
          out = encoder.encode(JSON.stringify(data));
        } catch (e) {
          return { bytes: null, changed: false, adsRemoved: 0, reason: "encode-failed" };
        }

        return {
          bytes: out,
          changed: true,
          adsRemoved: removed,
          reason: "pruned"
        };
      }
    };
  }

  /**
   * Escape hatch used when we decide not to touch a response: concatenate the
   * buffered chunks back into one ArrayBuffer so the caller can write the
   * original bytes through unchanged.
   */
  function concatChunks(chunks) {
    if (chunks.length === 1) return chunks[0];
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(new Uint8Array(chunks[j]), offset);
      offset += chunks[j].byteLength;
    }
    return out.buffer;
  }

  root.__AEGIS_REWRITER__ = {
    createRewriter: createRewriter,
    concatChunks: concatChunks
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
