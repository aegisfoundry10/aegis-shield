/*
 * Aegis Shield (Firefox) — background entry point (event page).
 *
 * Firefox MV3 runs the background as an event page declared with
 * background.scripts, not as a service worker. Consequence that matters here:
 * the background has a DOM and real globals, and is far less eager to terminate
 * than a Chrome service worker — but it is still non-persistent, so all state
 * below is rebuilt from storage on every start and every listener is registered
 * at top level, synchronously, as Firefox requires for event pages.
 */
(function (root) {
  "use strict";

  var INTERCEPT = root.__AEGIS_INTERCEPT__;
  var BLOCK = root.__AEGIS_BLOCK__;

  var SETTINGS_KEY = "aegis:settings";
  var DEFAULTS = { blockYouTube: true, blockNetwork: true, rewriteResponses: true };

  var settings = Object.assign({}, DEFAULTS);
  var contentStats = {}; // tabId -> { wallRemoved, adsHidden, skipped }

  var APIs = typeof browser !== "undefined" ? browser : chrome;

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */

  function enabledGroups() {
    var groups = [];
    if (settings.blockYouTube) groups.push("youtube");
    if (settings.blockNetwork) groups.push("network");
    return groups;
  }
  root.__AEGIS_MAIN__ = { enabledGroups: enabledGroups };

  function loadSettings() {
    return APIs.storage.local
      .get(SETTINGS_KEY)
      .then(function (stored) {
        settings = Object.assign({}, DEFAULTS, stored[SETTINGS_KEY] || {});
        return settings;
      })
      .catch(function () {
        return settings;
      });
  }

  function saveSettings(patch) {
    settings = Object.assign({}, settings, patch || {});
    return APIs.storage.local
      .set({ [SETTINGS_KEY]: settings })
      .then(function () {
        return settings;
      });
  }

  /* ---------------------------------------------------------------- *
   * Listener registration — top level, synchronous, before any await
   * ---------------------------------------------------------------- */

  var ALL_TYPES = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
    "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket",
    "other"
  ];

  function isRewriteEnabled() {
    return settings.rewriteResponses !== false;
  }

  function guardedIntercept(details) {
    if (!isRewriteEnabled()) return {};
    return INTERCEPT.onBeforeRequest(details);
  }

  function guardedBlock(details) {
    return BLOCK.onBeforeRequest(details);
  }

  // 1. Response rewriting. Must be a blocking listener to create a StreamFilter.
  //    Covers both the API responses (xmlhttprequest) and the top-level document,
  //    which is where the boot payload actually lives on a cold load.
  APIs.webRequest.onBeforeRequest.addListener(
    guardedIntercept,
    {
      urls: ["*://www.youtube.com/*", "*://m.youtube.com/*", "*://www.youtube-nocookie.com/*"],
      types: ["main_frame", "xmlhttprequest", "other"]
    },
    ["blocking"]
  );

  // 2. Request blocking.
  APIs.webRequest.onBeforeRequest.addListener(guardedBlock, BLOCK.URL_FILTER, ["blocking"]);

  // 3. Response headers are left alone. See the note in block.js: rewriting
  //    Content-Encoding desynchronised it from Content-Length and truncated the
  //    body. Firefox manages the encoding for a filtered stream.

  /* ---------------------------------------------------------------- *
   * Messaging and badge
   * ---------------------------------------------------------------- */

  function totalsFor(tabId) {
    var cs = contentStats[tabId] || {};
    var net = INTERCEPT.stats;
    return {
      netAdsRemoved: net.adsRemoved,
      netBlocked: BLOCK.stats.blocked,
      rewritten: net.rewritten,
      passedThrough: net.passedThrough,
      failed: net.failed,
      wallRemoved: cs.wallRemoved || 0,
      adsHidden: cs.adsHidden || 0,
      skipped: cs.skipped || 0
    };
  }

  function renderBadge(tabId) {
    var t = totalsFor(tabId);
    var n = t.wallRemoved + t.adsHidden + t.skipped + t.netAdsRemoved;
    var text = n > 0 ? (n > 999 ? "999+" : String(n)) : "";
    APIs.action.setBadgeText({ tabId: tabId, text: text }).catch(function () {});
    if (text) {
      APIs.action
        .setBadgeBackgroundColor({ tabId: tabId, color: "#1f6feb" })
        .catch(function () {});
    }
  }

  APIs.runtime.onMessage.addListener(function (msg, sender) {
    if (!msg || !msg.type) return undefined;

    if (msg.type === "aegis:net-stats") {
      var tabId = sender.tab && sender.tab.id;
      var active = null;
      // Refresh the badge for whichever tab is in front.
      APIs.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
        if (tabs && tabs[0] && typeof tabs[0].id === "number") renderBadge(tabs[0].id);
      }).catch(function () {});
      return undefined;
    }

    if (msg.type === "aegis:content-stats") {
      var id = sender.tab && sender.tab.id;
      if (typeof id === "number") {
        contentStats[id] = Object.assign({}, contentStats[id], msg.data);
        renderBadge(id);
      }
      return undefined;
    }

    if (msg.type === "aegis:getState") {
      return loadSettings().then(function (s) {
        var tabId = msg.tabId;
        return {
          settings: s,
          totals: typeof tabId === "number" ? totalsFor(tabId) : null,
          rules: {
            blockRules: root.__AEGIS_RULES__.BLOCK.length,
            interceptRules: root.__AEGIS_RULES__.INTERCEPT.length
          }
        };
      });
    }

    if (msg.type === "aegis:setSettings") {
      return saveSettings(msg.patch).then(function (s) {
        return { settings: s };
      });
    }

    return undefined;
  });

  APIs.tabs.onRemoved.addListener(function (tabId) {
    delete contentStats[tabId];
  });

  /* ---------------------------------------------------------------- *
   * Startup
   * ---------------------------------------------------------------- */

  loadSettings().catch(function () {});

  // Reset the per-tab content counters on navigation.
  APIs.webNavigation = APIs.webNavigation || null;
  if (APIs.webNavigation && APIs.webNavigation.onCommitted) {
    APIs.webNavigation.onCommitted.addListener(function (details) {
      if (details.frameId !== 0) return;
      delete contentStats[details.tabId];
      renderBadge(details.tabId);
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
