/*
 * Aegis Shield — pruning engine (MAIN world, classic script, no bundler).
 *
 * Pure data functions. No DOM, no browser APIs, no side effects at load time,
 * so this file is directly unit-testable under Node (see test/prune.test.mjs).
 *
 * Exposes: globalThis.__AEGIS_PRUNE__
 */
(function (root) {
  "use strict";

  var MAX_DEPTH = 64;
  var MAX_VISITED = 400000;

  /* ---------------------------------------------------------------- *
   * Key blocklists
   * ---------------------------------------------------------------- */

  // Keys deleted from a YouTube /youtubei/v1/player response, or from the
  // inline `ytInitialPlayerResponse` object. Removing these means the player
  // never learns an ad exists, so no ad is requested, scheduled or rendered.
  var PLAYER_AD_KEYS = [
    "adPlacements",
    "playerAds",
    "adSlots",
    "adBreakHeartbeatParams",
    "playerLegacyDesktopWatchAdsRenderer",
    "playerAdParams",
    "adParams",
    "adTrackingParams",
    "adSlotLoggingData",
    "importantForAds"
  ];

  // Single-key renderer objects that mean "this list item is an ad".
  // Matching any one of these causes the whole array entry to be dropped.
  var AD_RENDERER_KEYS = [
    "adSlotRenderer",
    "adLayoutRenderer",
    "adSlotAndLayoutMetadata",
    "displayAdRenderer",
    "promotedSparklesWebRenderer",
    "promotedSparklesTextSearchRenderer",
    "promotedSparklesTextRenderer",
    "promotedVideoRenderer",
    "compactPromotedVideoRenderer",
    "compactPromotedItemRenderer",
    "searchPyvRenderer",
    "inFeedAdLayoutRenderer",
    "adPromoRenderer",
    "primetimePromoRenderer",
    "brandVideoShelfRenderer",
    "brandVideoSingletonRenderer",
    "videoMastheadAdV3Renderer",
    "adsEngagementPanelContentRenderer",
    "playerAdOverlayRenderer",
    "adDurationRemaining",
    "merchandiseShelfRenderer",
    "ticketShelfRenderer"
  ];

  // Keys whose *value* is an ad-related object we should strip anywhere.
  var UNIVERSAL_AD_KEYS = ["adPlacements", "adSlots", "adBreakHeartbeatParams"];

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  function isObject(v) {
    return v !== null && typeof v === "object";
  }

  function isPlainObject(v) {
    if (!isObject(v) || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  /**
   * True when an array element is an ad container. We are deliberately
   * conservative: an element is only dropped when one of its own top-level
   * keys is a known ad renderer, or when every one of its keys is ad-related.
   */
  function isAdContainer(node) {
    if (!isPlainObject(node)) return false;
    var keys = Object.keys(node);
    if (keys.length === 0 || keys.length > 6) return false;
    for (var i = 0; i < keys.length; i++) {
      if (AD_RENDERER_KEYS.indexOf(keys[i]) !== -1) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Core deep walk
   * ---------------------------------------------------------------- */

  /**
   * Walk `node` and remove blocked keys / ad containers.
   * Mutates in place and returns the same reference.
   *
   * @param {*} node
   * @param {{keys: string[], dropAdContainers: boolean}} opts
   */
  function pruneDeep(node, opts, depth, seen, counter) {
    if (!isObject(node)) return node;
    if (depth > MAX_DEPTH) return node;
    if (seen.has(node)) return node;
    seen.add(node);

    counter.n++;
    if (counter.n > MAX_VISITED) return node;

    if (Array.isArray(node)) {
      if (opts.dropAdContainers) {
        for (var i = node.length - 1; i >= 0; i--) {
          if (isAdContainer(node[i])) {
            node.splice(i, 1);
            counter.deleted++;
          }
        }
      }
      for (var j = 0; j < node.length; j++) {
        pruneDeep(node[j], opts, depth + 1, seen, counter);
      }
      return node;
    }

    // Plain object: delete blocked keys first, then recurse into survivors.
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (opts.keys.indexOf(key) !== -1) {
        try {
          delete node[key];
          counter.deleted++;
        } catch (e) {
          /* frozen object — leave it alone */
        }
      }
    }

    var remaining = Object.keys(node);
    for (var m = 0; m < remaining.length; m++) {
      pruneDeep(node[remaining[m]], opts, depth + 1, seen, counter);
    }
    return node;
  }

  function run(node, opts) {
    if (!isObject(node)) return node;
    try {
      pruneDeep(node, opts, 0, new WeakSet(), { n: 0, deleted: 0 });
    } catch (e) {
      /* never throw into page scope */
    }
    return node;
  }

  /**
   * Prune and report how many structures were actually removed.
   *
   * Callers use the count to decide whether anything changed. That decision used
   * to be made by re-serialising the whole document and comparing strings, which
   * meant parsing and stringifying a multi-megabyte payload two or three times
   * per response even when nothing changed — measurable latency on every page
   * load. Counting deletions is free by comparison.
   */
  function runCounted(node, opts) {
    if (!isObject(node)) return 0;
    var counter = { n: 0, deleted: 0 };
    try {
      pruneDeep(node, opts, 0, new WeakSet(), counter);
    } catch (e) {
      /* never throw into page scope */
    }
    return counter.deleted;
  }

  /* ---------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------- */

  /** Strip ads from a player response (live or inline). */
  function prunePlayerResponse(node) {
    return run(node, { keys: PLAYER_AD_KEYS, dropAdContainers: true });
  }

  /** As prunePlayerResponse, but returns how many structures were removed. */
  function prunePlayerResponseCounted(node) {
    return runCounted(node, { keys: PLAYER_AD_KEYS, dropAdContainers: true });
  }

  /** Strip ads from ytInitialData (browse / search / watch-next surfaces). */
  function pruneInitialData(node) {
    return run(node, {
      keys: UNIVERSAL_AD_KEYS.slice(),
      dropAdContainers: true
    });
  }

  /** As pruneInitialData, but returns how many structures were removed. */
  function pruneInitialDataCounted(node) {
    return runCounted(node, {
      keys: UNIVERSAL_AD_KEYS.slice(),
      dropAdContainers: true
    });
  }

  /** Generic: drop an arbitrary key list anywhere in the tree. */
  function pruneKeys(node, keys) {
    return run(node, { keys: keys || [], dropAdContainers: false });
  }

  /**
   * Count ad-bearing structures without mutating anything.
   * Used for per-tab reporting to the service worker.
   */
  function countAds(node, depth, seen, counter) {
    if (!isObject(node)) return counter.n;
    if (depth > MAX_DEPTH) return counter.n;
    if (seen.has(node)) return counter.n;
    seen.add(node);

    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        if (isAdContainer(node[i])) counter.n++;
        countAds(node[i], depth + 1, seen, counter);
      }
      return counter.n;
    }
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      if (PLAYER_AD_KEYS.indexOf(keys[k]) !== -1 && node[keys[k]]) counter.n++;
      countAds(node[keys[k]], depth + 1, seen, counter);
    }
    return counter.n;
  }

  function detectAds(node) {
    if (!isObject(node)) return 0;
    try {
      return countAds(node, 0, new WeakSet(), { n: 0 });
    } catch (e) {
      return 0;
    }
  }

  /**
   * Deep clone that preserves everything except the ad structures.
   * Used when we must return a new Response body rather than mutate.
   */
  function clonePruned(node, opts, depth, seen) {
    if (!isObject(node)) return node;
    if (depth > MAX_DEPTH) return node;

    if (seen.has(node)) return seen.get(node);

    if (Array.isArray(node)) {
      var outArr = [];
      seen.set(node, outArr);
      for (var i = 0; i < node.length; i++) {
        if (opts.dropAdContainers && isAdContainer(node[i])) continue;
        outArr.push(clonePruned(node[i], opts, depth + 1, seen));
      }
      return outArr;
    }

    if (!isPlainObject(node)) return node;

    var out = {};
    seen.set(node, out);
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (opts.keys.indexOf(key) !== -1) continue;
      out[key] = clonePruned(node[key], opts, depth + 1, seen);
    }
    return out;
  }

  function clonePrunedPlayer(node) {
    var opts = { keys: PLAYER_AD_KEYS, dropAdContainers: true };
    try {
      return clonePruned(node, opts, 0, new WeakMap());
    } catch (e) {
      return node;
    }
  }

  root.__AEGIS_PRUNE__ = {
    PLAYER_AD_KEYS: PLAYER_AD_KEYS,
    AD_RENDERER_KEYS: AD_RENDERER_KEYS,
    UNIVERSAL_AD_KEYS: UNIVERSAL_AD_KEYS,
    isAdContainer: isAdContainer,
    prunePlayerResponse: prunePlayerResponse,
    prunePlayerResponseCounted: prunePlayerResponseCounted,
    pruneInitialData: pruneInitialData,
    pruneInitialDataCounted: pruneInitialDataCounted,
    pruneKeys: pruneKeys,
    clonePrunedPlayer: clonePrunedPlayer,
    detectAds: detectAds
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
