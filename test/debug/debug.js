/*
 * Aegis Shield — debug reporter. NOT SHIPPED.
 *
 * Only present in the build produced by test/debug/make-debug-build.mjs, and
 * deliberately absent from the real manifest so it can never reach AMO.
 *
 * It instruments the shipping code from the outside so the behaviour under test
 * is the shipped behaviour, not a re-implementation.
 *
 * IMPORTANT LESSON BAKED IN: the first version of this file wrapped the
 * StreamFilter by redefining its `ondata`/`onstop` properties with
 * Object.defineProperty. That silently prevented the shipping code's handlers
 * from ever attaching, and produced a run with zero filter events — which
 * looked like a real bug in the extension but was an artifact of the probe.
 * The wrapper now uses a Proxy, which cannot interfere with property
 * assignment on the target.
 */
(function (root) {
  "use strict";

  var ENDPOINT = "http://127.0.0.1:8787/report";
  var MAX_CAPTURE = 96;
  var OPEN_YOUTUBE = true;
  // Two tabs: the home page (app bootstrap) then a watch page (player path).
  // The watch page is what exercises the reported black-screen symptom.
  var START_URL = "https://www.youtube.com/";
  var SECOND_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

  function post(payload) {
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(function () {});
    } catch (e) {}
  }

  function bytesToHex(buf, n) {
    var b = new Uint8Array(buf, 0, Math.min(n, buf.byteLength));
    var out = [];
    for (var i = 0; i < b.length; i++) out.push(("0" + b[i].toString(16)).slice(-2));
    return out.join(" ");
  }

  function bytesToAscii(buf, n) {
    var b = new Uint8Array(buf, 0, Math.min(n, buf.byteLength));
    var s = "";
    for (var i = 0; i < b.length; i++) {
      s += b[i] >= 0x20 && b[i] < 0x7f ? String.fromCharCode(b[i]) : ".";
    }
    return s;
  }

  function compressionMagic(buf) {
    var b = new Uint8Array(buf);
    if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return "gzip";
    if (b.length >= 3 && b[0] === 0x62 && b[1] === 0x72 && b[2] === 0x6f) return "brotli";
    if (b.length >= 2 && b[0] === 0x78) return "zlib";
    return null;
  }

  post({ phase: "debug-loaded", version: 3 });

  /* ---------------------------------------------------------------- *
   * 0. Permissions
   * ---------------------------------------------------------------- */

  (async function probe() {
    var perms = {};
    try {
      perms.youtube = await browser.permissions.contains({ origins: ["*://*.youtube.com/*"] });
      perms.allUrls = await browser.permissions.contains({ origins: ["<all_urls>"] });
      perms.granted = await browser.permissions.getAll();
    } catch (e) {
      perms.error = String(e && e.message);
    }
    post({ phase: "permissions", perms: perms });
  })();

  /* ---------------------------------------------------------------- *
   * 1. Map requestId -> url, and count everything we can see.
   *    Registered before main.js, so this listener sees every request first.
   * ---------------------------------------------------------------- */

  var allRequests = 0;
  var youtubeRequests = 0;
  var urlByRequestId = {};
  var responseHeaders = {};

  browser.webRequest.onBeforeRequest.addListener(
    function (details) {
      allRequests++;
      if (details.url) urlByRequestId[details.requestId] = details.url;
      if (/youtube\.com|googlevideo\.com/.test(details.url || "")) youtubeRequests++;
      return {};
    },
    { urls: ["<all_urls>"] }
  );

  // Observe what the response headers actually are for the endpoints we filter.
  try {
    browser.webRequest.onHeadersReceived.addListener(
      function (details) {
        var hdrs = {};
        for (var i = 0; i < (details.responseHeaders || []).length; i++) {
          var h = details.responseHeaders[i];
          var n = (h.name || "").toLowerCase();
          if (n === "content-encoding" || n === "content-length" || n === "content-type" || n === "vary") {
            hdrs[n] = h.value;
          }
        }
        responseHeaders[details.requestId] = hdrs;
        return {};
      },
      { urls: ["*://*.youtube.com/youtubei/v1/*"] },
      ["responseHeaders"]
    );
  } catch (e) {
    post({ phase: "hdr-observer-FAILED", error: String(e && e.message) });
  }

  /* ---------------------------------------------------------------- *
   * 2. Wrap filterResponseData with a Proxy — cannot break assignment.
   * ---------------------------------------------------------------- */

  var filterSeq = 0;
  var filterLog = [];
  var wr = browser.webRequest;
  var origFilterResponseData = wr.filterResponseData.bind(wr);

  wr.filterResponseData = function (requestId) {
    var id = ++filterSeq;
    var url = urlByRequestId[requestId] || "(unknown)";
    var target;

    try {
      target = origFilterResponseData(requestId);
    } catch (e) {
      post({
        phase: "filter-create-FAILED",
        id: id,
        url: url,
        error: String(e && e.message ? e.message : e)
      });
      throw e;
    }

    var rec = {
      id: id,
      url: url,
      created: true,
      onstart: false,
      ondata: false,
      onstop: false,
      onerror: false,
      chunkCount: 0,
      totalBytes: 0,
      writeCalls: 0,
      closeCalls: 0,
      disconnectCalls: 0,
      firstChunkBytes: null,
      firstChunkAscii: null,
      firstChunkHex: null,
      compressionMagic: null,
      handlersSet: []
    };
    filterLog.push(rec);
    var startedAt = Date.now();

    post({
      phase: "filter-created",
      id: id,
      url: url,
      headers: responseHeaders[requestId] || null
    });

    function wrapHandler(name, fn) {
      return function (event) {
        try {
          if (name === "onstart") rec.onstart = true;
          if (name === "onerror") {
            rec.onerror = true;
            rec.errorDetail = event && event.error ? String(event.error) : "(no detail)";
          }
          if (name === "ondata") {
            rec.ondata = true;
            if (rec.chunkCount === 0 && event && event.data) {
              rec.firstChunkBytes = event.data.byteLength;
              rec.firstChunkAscii = bytesToAscii(event.data, MAX_CAPTURE);
              rec.firstChunkHex = bytesToHex(event.data, MAX_CAPTURE);
              rec.compressionMagic = compressionMagic(event.data);
            }
            rec.chunkCount++;
            rec.totalBytes += event && event.data ? event.data.byteLength : 0;
          }
          if (name === "onstop") {
            rec.onstop = true;
            rec.elapsedMs = Date.now() - startedAt;
          }
        } catch (e) {}
        var r = fn.apply(this, arguments);
        if (name === "onstop" || name === "onerror") {
          post(Object.assign({ phase: "filter-finished" }, rec));
        }
        return r;
      };
    }

    return new Proxy(target, {
      set: function (t, prop, value) {
        if (typeof prop === "string" && /^on(start|data|stop|error)$/.test(prop)) {
          if (prop === "ondata") rec.ondataAssigned = true;
          rec.handlersSet.push(prop);
          if (typeof value === "function") {
            value = wrapHandler(prop, value);
          }
        }
        t[prop] = value;
        return true;
      },
      get: function (t, prop) {
        if (prop === "__aegisRec") return rec;
        var v = t[prop];
        if (typeof v === "function") return v.bind(t);
        return v;
      }
    });
  };

  // Wrap write/close/disconnect by observing the returned proxy in intercept.js
  // is not possible, so record via the target's own methods instead.

  /* ---------------------------------------------------------------- *
   * 3. Rewriter decisions
   * ---------------------------------------------------------------- */

  var RW = root.__AEGIS_REWRITER__;
  var origCreate = RW.createRewriter;

  RW.createRewriter = function (opts) {
    var inner = origCreate(opts);
    return {
      push: function (b) {
        return inner.push(b);
      },
      get byteLength() {
        return inner.byteLength;
      },
      finish: function () {
        var res;
        try {
          res = inner.finish();
        } catch (e) {
          post({ phase: "rewriter-THREW", error: String(e && e.message ? e.message : e) });
          throw e;
        }
        post({
          phase: "rewriter-finish",
          isPlayer: !!opts.isPlayer,
          changed: res.changed,
          reason: res.reason,
          adsRemoved: res.adsRemoved,
          outBytes: res.bytes ? res.bytes.byteLength : null
        });
        return res;
      }
    };
  };

  /* ---------------------------------------------------------------- *
   * 4. Navigation and heartbeat
   * ---------------------------------------------------------------- */

  if (OPEN_YOUTUBE) {
    setTimeout(function () {
      browser.tabs
        .create({ url: START_URL, active: true })
        .then(function (tab) {
          post({ phase: "opened-tab", url: START_URL, tabId: tab && tab.id });
        })
        .catch(function (e) {
          post({ phase: "open-tab-FAILED", error: String(e && e.message) });
        });
    }, 2500);

    setTimeout(function () {
      browser.tabs
        .create({ url: SECOND_URL, active: true })
        .then(function (tab) {
          post({ phase: "opened-tab", url: SECOND_URL, tabId: tab && tab.id });
        })
        .catch(function (e) {
          post({ phase: "open-tab-FAILED", error: String(e && e.message) });
        });
    }, 22000);
  }

  var beat = 0;
  setInterval(function () {
    beat++;
    post({
      phase: "heartbeat",
      beat: beat,
      allRequests: allRequests,
      youtubeRequests: youtubeRequests,
      filters: filterLog.map(function (r) {
        return {
          id: r.id,
          url: r.url.slice(0, 90),
          handlers: r.handlersSet.join("+"),
          onstart: r.onstart,
          ondata: r.ondata,
          onstop: r.onstop,
          onerror: r.onerror,
          chunks: r.chunkCount,
          bytes: r.totalBytes,
          magic: r.compressionMagic
        };
      }),
      // Proves main.js executed to completion: __AEGIS_MAIN__ is defined by it,
      // and debug.js is injected before main.js, so this is only true if main.js
      // ran without throwing.
      mainLoaded: typeof root.__AEGIS_MAIN__ === "object",
      interceptLoaded: typeof root.__AEGIS_INTERCEPT__ === "object",
      blockLoaded: typeof root.__AEGIS_BLOCK__ === "object"
    });
  }, 5000);

  /* ---------------------------------------------------------------- *
   * 5. Relay page-state reports from the content-script probe.
   *
   * The probe cannot reach localhost itself: a content script's fetch is
   * subject to the page's CSP, and YouTube's connect-src does not allow it.
   * The background has no such restriction.
   * ---------------------------------------------------------------- */

  browser.runtime.onMessage.addListener(function (msg, sender) {
    if (msg && msg.type === "aegis:debug-report" && msg.payload) {
      var p = msg.payload;
      if (p.phase === "page-state") {
        p.tabUrl = sender && sender.tab ? (sender.tab.url || "").slice(0, 120) : null;
      }
      post(p);
    }
    return undefined;
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
