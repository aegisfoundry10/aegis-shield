/*
 * Aegis Shield (Firefox) — network rule table.
 *
 * Classic script; populates globalThis.__AEGIS_RULES__.
 *
 * On Firefox we have blocking webRequest, so rules are full JavaScript RegExp
 * applied to the request URL. That is materially more expressive than Chromium's
 * declarativeNetRequest urlFilter subset: lookarounds, alternation with anchors,
 * and \\d classes all work here, and the whole table can be rebuilt at runtime
 * from a downloaded filter list with no static-rule-count ceiling.
 */
(function (root) {
  "use strict";

  var YT = "youtube";

  /**
   * Blocked outright: requests whose only purpose is ad delivery, ad
   * measurement, or ad-break orchestration.
   */
  var BLOCK = [
    // YouTube ad endpoints. These four are the only network-level YouTube ad
    // rules Adblock Plus ships at all; everything else here is ours.
    { id: "yt-pagead", group: YT, re: /^https?:\/\/[\w.-]*youtube\.com\/pagead\//i },
    { id: "yt-ad-break", group: YT, re: /^https?:\/\/[\w.-]*youtube\.com\/youtubei\/v1\/player\/ad_break/i },
    { id: "yt-get-video-info-adunit", group: YT, re: /^https?:\/\/[\w.-]*youtube\.com\/get_video_info\?[^#]*\badunit=/i },

    // Ad measurement / impression beaconing. Blocking these does not remove a
    // video ad, but it does stop the view being counted.
    { id: "yt-stats-ads", group: YT, re: /^https?:\/\/[\w.-]*youtube\.com\/api\/stats\/ads/i },
    { id: "yt-stats-atr", group: YT, re: /^https?:\/\/[\w.-]*youtube\.com\/api\/stats\/atr/i },
    { id: "yt-watchtime-adunit", group: YT, re: /^https?:\/\/[\w.-]*youtube\.com\/api\/stats\/watchtime\?[^#]*\bel=adunit\b/i },
    { id: "yt-qoe-adformat", group: YT, re: /^https?:\/\/[\w.-]*youtube\.com\/api\/stats\/qoe\?[^#]*\badformat=/i },
    { id: "yt-ptracking", group: YT, re: /^https?:\/\/[\w.-]*youtube\.com\/ptracking/i },

    // Ad stream segments. The `adformat` parameter is present only on ad media;
    // ordinary playback never carries it. This is the one googlevideo rule that
    // is safe, and it is a rule Adblock Plus does not have at all.
    //
    // Written as (?:[^#]*&)?adformat= rather than [^#]*[?&]adformat= — the `?`
    // separating query from path was already consumed by videoplayback\?, so
    // requiring another ? or & before the parameter would miss the common
    // single-parameter form `?adformat=22`. Verified against real playback URLs
    // in the test suite; do not simplify this without re-running them.
    { id: "yt-googlevideo-adformat", group: YT, re: /^https?:\/\/[\w.-]*googlevideo\.com\/videoplayback\?(?:[^#]*&)?adformat=/i },

    // Third-party ad infrastructure when reached from YouTube.
    { id: "yt-doubleclick", group: YT, re: /^https?:\/\/[\w.-]*doubleclick\.net\//i, initiator: /youtube(-nocookie)?\.com$/i },
    { id: "yt-googlesyndication", group: YT, re: /^https?:\/\/[\w.-]*googlesyndication\.com\//i, initiator: /youtube(-nocookie)?\.com$/i },
    { id: "yt-googleadservices", group: YT, re: /^https?:\/\/[\w.-]*googleadservices\.com\//i, initiator: /youtube(-nocookie)?\.com$/i },

    // Generic ad networks, network-wide.
    { id: "net-doubleclick", group: "network", re: /^https?:\/\/[\w.-]*doubleclick\.net\//i },
    { id: "net-googlesyndication", group: "network", re: /^https?:\/\/[\w.-]*googlesyndication\.com\//i },
    { id: "net-googleadservices", group: "network", re: /^https?:\/\/[\w.-]*googleadservices\.com\//i },
    { id: "net-adservice-google", group: "network", re: /^https?:\/\/adservice\.google\.com\//i },
    { id: "net-amazon-adsystem", group: "network", re: /^https?:\/\/[\w.-]*amazon-adsystem\.com\//i },
    { id: "net-adsrvr", group: "network", re: /^https?:\/\/[\w.-]*adsrvr\.org\//i },
    { id: "net-criteo", group: "network", re: /^https?:\/\/([\w.-]*\.)?(criteo\.com|criteo\.net)\//i },
    { id: "net-taboola", group: "network", re: /^https?:\/\/[\w.-]*taboola\.com\//i },
    { id: "net-outbrain", group: "network", re: /^https?:\/\/[\w.-]*outbrain\.com\//i },
    { id: "net-pubmatic", group: "network", re: /^https?:\/\/[\w.-]*pubmatic\.com\//i },
    { id: "net-rubiconproject", group: "network", re: /^https?:\/\/[\w.-]*rubiconproject\.com\//i },
    { id: "net-openx", group: "network", re: /^https?:\/\/[\w.-]*openx\.net\//i },
    { id: "net-smartadserver", group: "network", re: /^https?:\/\/[\w.-]*smartadserver\.com\//i },
    { id: "net-scorecardresearch", group: "network", re: /^https?:\/\/[\w.-]*scorecardresearch\.com\//i },
    { id: "net-adnxs", group: "network", re: /^https?:\/\/[\w.-]*adnxs\.com\//i },
    { id: "net-moatads", group: "network", re: /^https?:\/\/[\w.-]*moatads\.com\//i },
    { id: "net-adform", group: "network", re: /^https?:\/\/[\w.-]*adform\.net\//i },
    { id: "net-casalemedia", group: "network", re: /^https?:\/\/[\w.-]*casalemedia\.com\//i },
    { id: "net-bidswitch", group: "network", re: /^https?:\/\/[\w.-]*bidswitch\.net\//i },
    { id: "net-turn", group: "network", re: /^https?:\/\/[\w.-]*turn\.com\//i },
    { id: "net-mathtag", group: "network", re: /^https?:\/\/[\w.-]*mathtag\.com\//i },
    { id: "net-3lift", group: "network", re: /^https?:\/\/[\w.-]*3lift\.com\//i },
    { id: "net-sharethrough", group: "network", re: /^https?:\/\/[\w.-]*sharethrough\.com\//i },
    { id: "net-teads", group: "network", re: /^https?:\/\/[\w.-]*teads\.tv\//i },
    { id: "net-yieldmo", group: "network", re: /^https?:\/\/[\w.-]*yieldmo\.com\//i },
    { id: "net-adroll", group: "network", re: /^https?:\/\/[\w.-]*adroll\.com\//i },
    { id: "net-crwdcntrl", group: "network", re: /^https?:\/\/[\w.-]*crwdcntrl\.net\//i },
    { id: "net-google-analytics", group: "network", re: /^https?:\/\/[\w.-]*google-analytics\.com\//i },
    { id: "net-googletagmanager", group: "network", re: /^https?:\/\/[\w.-]*googletagmanager\.com\/gtag\/js/i }
  ];

  /**
   * Response bodies we rewrite rather than block. Interception is keyed on URL
   * only — the player decides which pruner to use.
   *
   * `/youtubei/v1/guide` is deliberately NOT here. The guide is the left
   * navigation rail; it never carries ads, but it is part of the application's
   * bootstrap. Filtering it bought nothing and broke startup in v0.2.0.
   */
  var INTERCEPT = [
    { id: "yt-player", re: /^https?:\/\/[\w.-]*youtube\.com\/youtubei\/v1\/player(\?|$)/i, kind: "player" },
    { id: "yt-next", re: /^https?:\/\/[\w.-]*youtube\.com\/youtubei\/v1\/next(\?|$)/i, kind: "data" },
    { id: "yt-browse", re: /^https?:\/\/[\w.-]*youtube\.com\/youtubei\/v1\/browse(\?|$)/i, kind: "data" },
    { id: "yt-search", re: /^https?:\/\/[\w.-]*youtube\.com\/youtubei\/v1\/search(\?|$)/i, kind: "data" },
    { id: "yt-reel-item", re: /^https?:\/\/[\w.-]*youtube\.com\/youtubei\/v1\/reel\/reel_item_watch(\?|$)/i, kind: "data" },
    { id: "yt-reel-seq", re: /^https?:\/\/[\w.-]*youtube\.com\/youtubei\/v1\/reel\/reel_watch_sequence(\?|$)/i, kind: "data" },

    // The HTML document itself. On a measured cold watch-page load YouTube never
    // requested /youtubei/v1/player at all — the player response was inlined in
    // the document as `var ytInitialPlayerResponse = {...}`. The JSON filter
    // alone therefore intercepts nothing on a cold load. Only main_frame
    // documents are routed here; the caller checks the resource type.
    //
    // The negative lookahead keeps this rule from swallowing /youtubei/ API paths,
    // so interceptRule() stays unambiguous for non-document requests.
    { id: "yt-document", re: /^https?:\/\/(www|m)\.youtube\.com\/(?!youtubei\/)/i, kind: "html" }
  ];

  /** Hosts whose requests must never have Accept-Encoding stripped. */
  var NO_ENCODING_STRIP = [
    /^https?:\/\/[\w.-]*(googlevideo|ytimg|ggpht|gstatic)\./i
  ];

  function matchAny(table, url, initiator) {
    for (var i = 0; i < table.length; i++) {
      var rule = table[i];
      if (!rule.re.test(url)) continue;
      if (rule.initiator && !(initiator && rule.initiator.test(initiator))) continue;
      return rule;
    }
    return null;
  }

  function shouldBlock(url, initiator, enabledGroups) {
    var groups = enabledGroups || ["youtube", "network"];
    for (var i = 0; i < BLOCK.length; i++) {
      var rule = BLOCK[i];
      if (groups.indexOf(rule.group) === -1) continue;
      if (!rule.re.test(url)) continue;
      if (rule.initiator && !(initiator && rule.initiator.test(initiator))) continue;
      return rule;
    }
    return null;
  }

  function interceptRule(url) {
    return matchAny(INTERCEPT, url, null);
  }

  root.__AEGIS_RULES__ = {
    BLOCK: BLOCK,
    INTERCEPT: INTERCEPT,
    NO_ENCODING_STRIP: NO_ENCODING_STRIP,
    shouldBlock: shouldBlock,
    interceptRule: interceptRule
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
