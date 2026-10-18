/*
 * Aegis Shield (Firefox) — YouTube DOM content script.
 *
 * Runs in the ISOLATED world. Note what is absent: there is no MAIN-world
 * companion script, no patching of window.fetch, no redefinition of
 * ytInitialPlayerResponse, and no custom-event channel between worlds. The active
 * ingredient lives in src/background/intercept.js and runs in the network stack.
 *
 * What remains here is the part that is genuinely DOM-shaped: cosmetic cleanup,
 * skip-button automation, unskippable fast-forward, and the enforcement wall.
 *
 * The wall is never answered with an
 * allowlist. It is removed and playback resumes.
 */
(function () {
  "use strict";

  var AD_SELECTORS = [
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-sparkles-text-search-renderer",
    "ytd-promoted-video-renderer",
    "ytd-compact-promoted-video-renderer",
    "ytd-display-ad-renderer",
    "ytd-banner-promo-renderer",
    "ytd-video-masthead-ad-v3-renderer",
    "ytd-primetime-promo-renderer",
    "ytd-search-pyv-renderer",
    "ytd-mealbar-promo-renderer",
    "#player-ads",
    "#masthead-ad",
    ".ytp-ad-overlay-container",
    ".ytp-ad-progress-list",
    ".ytp-ad-module",
    ".ytp-ad-player-overlay",
    ".ytp-featured-product"
  ];

  var counters = { wallRemoved: 0, adsHidden: 0, skipped: 0, accelerated: 0 };
  var userMuted = false;

  function pushStats() {
    try {
      browser.runtime.sendMessage({ type: "aegis:content-stats", data: counters });
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- *
   * Enforcement wall — removed, never allowlisted
   * ---------------------------------------------------------------- */

  function removeWall() {
    var walls = document.querySelectorAll("ytd-enforcement-message-view-model");
    if (!walls.length) return false;

    var video = document.querySelector("video");
    var resumeAt = video && !video.paused ? video.currentTime : -1;

    for (var i = 0; i < walls.length; i++) {
      var host = walls[i].closest("tp-yt-paper-dialog") || walls[i].parentElement || walls[i];
      try {
        host.remove();
      } catch (e) {
        try {
          host.style.setProperty("display", "none", "important");
        } catch (e2) {}
      }
    }
    counters.wallRemoved += walls.length;

    var backdrops = document.querySelectorAll("tp-yt-iron-overlay-backdrop");
    for (var j = 0; j < backdrops.length; j++) {
      try {
        backdrops[j].remove();
      } catch (e) {}
    }

    try {
      document.documentElement.style.removeProperty("overflow");
      document.body.style.removeProperty("overflow");
      document.body.removeAttribute("scroll-lock");
    } catch (e) {}

    if (video && resumeAt >= 0) {
      setTimeout(function () {
        try {
          if (video.paused) video.play().catch(function () {});
        } catch (e) {}
      }, 60);
    }

    pushStats();
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Skip / accelerate
   * ---------------------------------------------------------------- */

  function clickSkip() {
    var buttons = document.querySelectorAll(
      ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button"
    );
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b && b.offsetParent !== null) {
        try {
          b.click();
          counters.skipped++;
          pushStats();
        } catch (e) {}
      }
    }
  }

  function isAdShowing() {
    var player = document.querySelector("#movie_player");
    return !!(player && player.classList.contains("ad-showing"));
  }

  function accelerate() {
    if (!isAdShowing()) return;
    var v = document.querySelector("video");
    if (!v) return;
    try {
      if (v.playbackRate !== 16) v.playbackRate = 16;
      v.muted = true;
      if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
      counters.accelerated++;
    } catch (e) {}
  }

  function restoreAfterAd() {
    if (isAdShowing()) return;
    var v = document.querySelector("video");
    if (!v) return;
    try {
      if (v.playbackRate === 16) v.playbackRate = 1;
      if (v.muted && !userMuted) v.muted = false;
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- *
   * Cosmetic sweep
   * ---------------------------------------------------------------- */

  function sweep() {
    var removed = 0;
    for (var i = 0; i < AD_SELECTORS.length; i++) {
      var nodes;
      try {
        nodes = document.querySelectorAll(AD_SELECTORS[i]);
      } catch (e) {
        continue;
      }
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.__aegisHidden) continue;
        n.__aegisHidden = true;
        try {
          n.remove();
        } catch (e) {
          try {
            n.style.setProperty("display", "none", "important");
          } catch (e2) {}
        }
        removed++;
      }
    }
    if (removed) {
      counters.adsHidden += removed;
      pushStats();
    }
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      removeWall();
      sweep();
      clickSkip();
      accelerate();
      restoreAfterAd();
    });
  }

  document.addEventListener(
    "volumechange",
    function (ev) {
      var t = ev.target;
      if (!t || t.tagName !== "VIDEO") return;
      if (isAdShowing()) return;
      userMuted = t.muted;
    },
    true
  );

  function install() {
    schedule();
    try {
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"]
      });
    } catch (e) {
      try {
        new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
      } catch (e2) {}
    }

    setInterval(function () {
      if (isAdShowing()) schedule();
    }, 700);

    document.addEventListener("yt-navigate-finish", schedule, true);
    window.addEventListener("load", schedule, { once: true });
  }

  if (document.documentElement) install();
  else document.addEventListener("readystatechange", install, { once: true });
})();
