/*
 * Aegis Shield — page-state probe. NOT SHIPPED.
 *
 * Content script, debug builds only. Measures whether YouTube's application
 * actually rendered, which is the thing the user reported as broken. Without
 * this the harness can only see network activity, not outcome.
 *
 * Reports feed item counts at several intervals so a pass can be compared
 * against a fail by number rather than by impression.
 */
(function () {
  "use strict";

  var ENDPOINT = "http://127.0.0.1:8787/report";

  // The page's own CSP (connect-src) blocks a content script from fetching
  // localhost, so reports are relayed through the background instead.
  function post(payload) {
    try {
      browser.runtime.sendMessage({ type: "aegis:debug-report", payload: payload });
    } catch (e) {
      try {
        fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(function () {});
      } catch (e2) {}
    }
  }

  function count(sel) {
    try {
      return document.querySelectorAll(sel).length;
    } catch (e) {
      return -1;
    }
  }

  function snapshot(label) {
    var s = {
      phase: "page-state",
      label: label,
      url: location.href.slice(0, 140),
      readyState: document.readyState,
      // Home feed
      richGrid: count("ytd-rich-grid-renderer"),
      richItems: count("ytd-rich-item-renderer"),
      // Search results
      videoRenderers: count("ytd-video-renderer"),
      // Shell
      app: count("ytd-app"),
      masthead: count("ytd-masthead"),
      guide: count("ytd-guide-renderer"),
      // Player
      moviePlayer: count("#movie_player"),
      video: count("video"),
      // Broken-state indicators
      adSlots: count("ytd-ad-slot-renderer"),
      enforcementWall: count("ytd-enforcement-message-view-model"),
      errorScreens: count("ytd-error-message-renderer"),
      bodyText: (document.body ? document.body.innerText : "").slice(0, 120)
    };

    // How filled is the feed container, if present?
    try {
      var grid = document.querySelector("ytd-rich-grid-renderer #contents");
      s.gridChildren = grid ? grid.children.length : -1;
    } catch (e) {
      s.gridChildren = -1;
    }

    post(s);
  }

  snapshot("document_start-ish");

  var marks = [2000, 5000, 9000, 14000, 20000];
  marks.forEach(function (ms) {
    setTimeout(function () {
      snapshot("t+" + ms);
    }, ms);
  });

  try {
    document.addEventListener("yt-navigate-finish", function () {
      setTimeout(function () {
        snapshot("navigate-finish");
      }, 1500);
    });
  } catch (e) {}
})();
