/*
 * Aegis Shield (Firefox) — response interception.
 *
 * Attaches a webRequest.StreamFilter to the YouTube API responses and rewrites
 * the JSON body before the browser hands it to the page.
 *
 * Why the page is never touched
 * -----------------------------
 * Nothing runs in the page's own context: window.fetch and XMLHttpRequest are not
 * patched, and ytInitialPlayerResponse is not redefined. That matters because all
 * of those would be observable from page JavaScript — the page could see the
 * patched functions, probe the descriptors, and beacon the result. YouTube's own
 * error endpoint
 * (/error_204) reports "read-only" + "non-configurable" for exactly that class
 * of extension.
 *
 * Here there is nothing on the page. The bytes are edited in the network stack,
 * so by the time any YouTube script runs, adPlacements was never in the payload.
 *
 * Failure policy: fail open, never corrupt. If the body cannot be parsed or the
 * pruner throws, the original bytes are written through untouched. YouTube keeps
 * working; we just lose the block for that response.
 */
(function (root) {
  "use strict";

  var P = root.__AEGIS_PRUNE__;
  var R = root.__AEGIS_RULES__;
  var RW = root.__AEGIS_REWRITER__;

  var MAX_BYTES = 32 * 1024 * 1024;

  var stats = { intercepted: 0, rewritten: 0, adsRemoved: 0, passedThrough: 0, failed: 0 };

  /**
   * webRequest.onBeforeRequest, blocking.
   * Creating the filter here is the documented entry point; the filter becomes
   * active after the onHeadersReceived stage.
   */
  function onBeforeRequest(details) {
    var rule;
    try {
      rule = R.interceptRule(details.url);
    } catch (e) {
      return {};
    }
    if (!rule) return {};

    // The document rule matches every youtube.com URL; only route actual
    // top-level document loads to the HTML path.
    if (rule.kind === "html" && details.type !== "main_frame") return {};

    var filter;
    try {
      filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
      // Permission missing, non-http(s), media-sniffed document, or the
      // optimised byte cache for script requests. Not fatal.
      stats.failed++;
      return {};
    }

    stats.intercepted++;

    var isPlayer = rule.kind === "player";
    var rewriter;
    try {
      rewriter = RW.createRewriter({
        prunePlayer: P.prunePlayerResponse,
        pruneData: P.pruneInitialData,
        // Counted variants. The rewriter decides "did anything change" from these
        // rather than by re-serialising the document and comparing strings, which
        // is the difference between a cheap pass-through and a full parse plus two
        // stringifies of the whole document on every page load.
        prunePlayerCounted: P.prunePlayerResponseCounted,
        pruneDataCounted: P.pruneInitialDataCounted,
        detectAds: P.detectAds,
        isPlayer: isPlayer,
        mode: rule.kind === "html" ? "html" : "json",
        rewriteHtml: root.__AEGIS_HTML__ ? root.__AEGIS_HTML__.rewriteHtml : null,
        maxBytes: rule.kind === "html" ? 16 * 1024 * 1024 : MAX_BYTES
      });
    } catch (e) {
      stats.failed++;
      try {
        filter.close();
      } catch (e2) {}
      return {};
    }

    // Keep our own copy so we can pass the original bytes through unchanged if
    // the rewrite is not applicable.
    var original = [];
    var closed = false;

    function finish() {
      if (closed) return;
      closed = true;

      var result = null;
      try {
        result = rewriter.finish();
      } catch (e) {
        result = null;
      }

      try {
        if (result && result.bytes) {
          filter.write(result.bytes);
          stats.rewritten++;
          stats.adsRemoved += result.adsRemoved || 0;
        } else {
          for (var i = 0; i < original.length; i++) {
            filter.write(original[i]);
          }
          stats.passedThrough++;
        }
      } catch (e) {
        stats.failed++;
      }

      try {
        filter.close();
      } catch (e) {}

      try {
        notifyStats();
      } catch (e) {}
    }

    filter.ondata = function (event) {
      try {
        original.push(event.data);
        rewriter.push(event.data);
      } catch (e) {
        // On any internal error, stop buffering and dump what we have.
        finish();
      }
    };

    filter.onstop = finish;

    filter.onerror = function () {
      // The stream failed. Do NOT write a partial body and close — that yields
      // an empty response and breaks the caller (this is what broke YouTube's
      // bootstrap guide request in v0.2.0). disconnect() hands the remainder
      // back to Firefox so the response completes normally.
      closed = true;
      stats.failed++;
      try {
        filter.disconnect();
      } catch (e) {}
    };

    // Returning nothing is correct here: we are not cancelling the request.
    return {};
  }

  /* ---------------------------------------------------------------- *
   * Stats fan-out
   * ---------------------------------------------------------------- */

  var pending = null;

  function notifyStats() {
    if (pending) return;
    pending = setTimeout(function () {
      pending = null;
      try {
        browser.runtime.sendMessage({
          type: "aegis:net-stats",
          stats: {
            intercepted: stats.intercepted,
            rewritten: stats.rewritten,
            adsRemoved: stats.adsRemoved,
            passedThrough: stats.passedThrough,
            failed: stats.failed
          }
        }).catch(function () {});
      } catch (e) {}
    }, 500);
  }

  root.__AEGIS_INTERCEPT__ = {
    onBeforeRequest: onBeforeRequest,
    stats: stats,
    MAX_BYTES: MAX_BYTES
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
