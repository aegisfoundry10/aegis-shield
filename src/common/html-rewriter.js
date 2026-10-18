/*
 * Aegis Shield (Firefox) — HTML boot-payload rewriter.
 *
 * Pure functions; no browser APIs. Exposes globalThis.__AEGIS_HTML__.
 *
 * WHY THIS EXISTS
 * ---------------
 * The network-layer JSON filter only sees XHR responses. Measured on a real
 * watch-page load: 192 requests to youtube.com, and `/youtubei/v1/player` was
 * never among them — YouTube had already inlined the player response into the
 * HTML document as `var ytInitialPlayerResponse = {...}`. A response filter on
 * the API endpoints therefore intercepts nothing on a cold page load.
 *
 * So the boot payload has to be pruned inside the HTML, before the browser
 * parses it. This is the "HTML filtering" capability uBlock Origin has on
 * Firefox, which depends on webRequest.filterResponseData().
 *
 * The alternative — patching the page's own JavaScript to intercept the
 * assignment — is detectable by the page. Here it is done to the bytes, before
 * any page script exists.
 */
(function (root) {
  "use strict";

  var MAX_HTML = 16 * 1024 * 1024;

  /**
   * Locate the JSON value assigned to `name` in an HTML/JS source string.
   * Handles `var name = {`, `name = {`, `window["name"] = {`.
   * Returns inclusive start / exclusive end offsets of the JSON text, or null.
   */
  function findJsonValue(source, name) {
    var needles = [
      "var " + name + " = ",
      "var " + name + "=",
      name + " = ",
      name + "="
    ];

    var at = -1;
    for (var i = 0; i < needles.length && at === -1; i++) {
      var idx = source.indexOf(needles[i]);
      // Prefer an occurrence that is followed by a brace, since the same
      // identifier appears in unrelated contexts.
      while (idx !== -1) {
        var probe = idx + needles[i].length;
        while (probe < source.length && /\s/.test(source[probe])) probe++;
        if (source[probe] === "{") {
          at = probe;
          break;
        }
        idx = source.indexOf(needles[i], idx + 1);
      }
    }
    if (at === -1) return null;

    // Balanced-brace scan, string- and escape-aware.
    var depth = 0;
    var inStr = false;
    var quote = "";
    var escaped = false;

    for (var p = at; p < source.length; p++) {
      var c = source[p];
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (c === "\\") {
          escaped = true;
        } else if (c === quote) {
          inStr = false;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        quote = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return { start: at, end: p + 1 };
      }
    }
    return null; // unterminated — refuse to guess
  }

  /**
   * Serialise for embedding inside an HTML <script> block.
   *
   * YouTube escapes `<` as \u003c in these inline payloads precisely so that a
   * string containing `</script>` cannot terminate the script element early.
   * Emitting plain JSON.stringify output would undo that, so the HTML-significant
   * characters are re-escaped. JSON syntax itself contains none of them, so a
   * blanket replace only ever touches string contents.
   */
  function serializeForHtml(value) {
    return JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  /**
   * Rewrite the inline boot payloads inside a YouTube HTML document.
   *
   * @returns {{html: string|null, changed: boolean, adsRemoved: number, detail: object}}
   *   html === null means "leave the document untouched".
   */
  function rewriteHtml(html, opts) {
    if (typeof html !== "string" || html.length > MAX_HTML) {
      return { html: null, changed: false, adsRemoved: 0, detail: { reason: "skip-size-or-type" } };
    }

    var targets = [
      { name: "ytInitialPlayerResponse", pruneCounted: opts.prunePlayerCounted },
      { name: "ytInitialData", pruneCounted: opts.pruneDataCounted }
    ];

    // Collect replacements first, then apply back-to-front so offsets stay valid.
    var edits = [];
    var totalAds = 0;
    var detail = {};

    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var span = findJsonValue(html, t.name);
      if (!span) {
        detail[t.name] = "not-found";
        continue;
      }

      var jsonText = html.slice(span.start, span.end);
      var data;
      try {
        data = JSON.parse(jsonText);
      } catch (e) {
        detail[t.name] = "unparseable";
        continue;
      }

      // Decide whether anything changed from the pruner's own deletion count.
      //
      // This used to be decided by serialising the payload twice and comparing the
      // resulting strings. That cost a full parse plus two stringifies of a
      // multi-megabyte document on every intercepted page load, including pages
      // with no ad at all — real latency, scaling with document size. Counting
      // deletions is effectively free, and the only serialisation left is the one
      // we actually ship.
      var removed = 0;
      try {
        removed = t.pruneCounted(data);
      } catch (e) {
        detail[t.name] = "prune-threw";
        continue;
      }

      if (removed === 0) {
        detail[t.name] = "unchanged";
        continue;
      }

      var out;
      try {
        out = serializeForHtml(data);
      } catch (e) {
        detail[t.name] = "unserialisable";
        continue;
      }

      edits.push({ start: span.start, end: span.end, text: out });
      totalAds += removed;
      detail[t.name] = "pruned(" + removed + ")";
    }

    if (!edits.length) {
      return { html: null, changed: false, adsRemoved: totalAds, detail: detail };
    }

    edits.sort(function (a, b) {
      return b.start - a.start;
    });

    var result = html;
    for (var e = 0; e < edits.length; e++) {
      result = result.slice(0, edits[e].start) + edits[e].text + result.slice(edits[e].end);
    }

    return { html: result, changed: true, adsRemoved: totalAds, detail: detail };
  }

  root.__AEGIS_HTML__ = {
    findJsonValue: findJsonValue,
    rewriteHtml: rewriteHtml,
    serializeForHtml: serializeForHtml,
    MAX_HTML: MAX_HTML
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
