/*
 * Aegis Shield (Firefox) — request blocking.
 *
 * Blocking webRequest is available on Firefox MV3 (Chrome removed it). That
 * means full RegExp matching on the URL, evaluated in JavaScript, with no
 * declarative rule-count ceiling and no static ruleset to ship.
 *
 * Filtering is intentionally scoped: a single listener over <all_urls> with a
 * regex test per request is not free, so the URL filter passed to the API is
 * narrowed to the host families we actually have rules for.
 */
(function (root) {
  "use strict";

  var R = root.__AEGIS_RULES__;

  var stats = { blocked: 0, byRule: {}, byGroup: { youtube: 0, network: 0 } };

  function enabledGroups() {
    return root.__AEGIS_MAIN__ ? root.__AEGIS_MAIN__.enabledGroups() : ["youtube", "network"];
  }

  /**
   * The URL filter handed to webRequest. Match patterns, not regex — keeping the
   * listener off every request on the machine.
   */
  var URL_FILTER = {
    urls: [
      "*://*.youtube.com/*",
      "*://*.youtube-nocookie.com/*",
      "*://*.googlevideo.com/*",
      "*://*.doubleclick.net/*",
      "*://*.googlesyndication.com/*",
      "*://*.googleadservices.com/*",
      "*://*.amazon-adsystem.com/*",
      "*://*.adsrvr.org/*",
      "*://*.criteo.com/*",
      "*://*.criteo.net/*",
      "*://*.taboola.com/*",
      "*://*.outbrain.com/*",
      "*://*.pubmatic.com/*",
      "*://*.rubiconproject.com/*",
      "*://*.openx.net/*",
      "*://*.smartadserver.com/*",
      "*://*.scorecardresearch.com/*",
      "*://*.adnxs.com/*",
      "*://*.moatads.com/*",
      "*://*.adform.net/*",
      "*://*.casalemedia.com/*",
      "*://*.bidswitch.net/*",
      "*://*.turn.com/*",
      "*://*.mathtag.com/*",
      "*://*.3lift.com/*",
      "*://*.sharethrough.com/*",
      "*://*.teads.tv/*",
      "*://*.yieldmo.com/*",
      "*://*.adroll.com/*",
      "*://*.crwdcntrl.net/*",
      "*://*.google-analytics.com/*",
      "*://*.googletagmanager.com/*"
    ],
    types: [
      "main_frame",
      "sub_frame",
      "stylesheet",
      "script",
      "image",
      "font",
      "object",
      "xmlhttprequest",
      "ping",
      "csp_report",
      "media",
      "websocket",
      "other"
    ]
  };

  function onBeforeRequest(details) {
    var rule;
    try {
      rule = R.shouldBlock(details.url, details.originUrl || details.documentUrl, enabledGroups());
    } catch (e) {
      return {};
    }
    if (!rule) return {};

    stats.blocked++;
    stats.byRule[rule.id] = (stats.byRule[rule.id] || 0) + 1;
    if (stats.byGroup[rule.group] !== undefined) stats.byGroup[rule.group]++;

    return { cancel: true };
  }

  /* ---------------------------------------------------------------- *
   * Response headers
   *
   * Deliberately NOT modified.
   *
   * v0.2.0 set Content-Encoding to identity on the endpoints being rewritten,
   * on the theory that the filter output had to match the declared encoding.
   * The debug harness proved that wrong and harmful: Firefox hands the
   * StreamFilter *decoded* bytes and manages the encoding itself, so rewriting
   * the header only desynchronised it from Content-Length. The browser then read
   * a truncated body and YouTube's application failed to start.
   *
   * The correct policy is to leave the framing headers alone and let Firefox do
   * its job. Keep this function (and its registration) only if a concrete,
   * measured need appears.
   * ---------------------------------------------------------------- */

  function onHeadersReceived(details) {
    return {};
  }

  root.__AEGIS_BLOCK__ = {
    onBeforeRequest: onBeforeRequest,
    onHeadersReceived: onHeadersReceived,
    URL_FILTER: URL_FILTER,
    stats: stats
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
