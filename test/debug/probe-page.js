/*
 * Aegis Shield — page-state probe. NOT SHIPPED.
 *
 * Content script, debug builds only. Measures the thing the user actually
 * notices: how long until the video player appears on a watch page.
 *
 * An earlier version sampled at 2s/5s/9s/14s/20s, which is far too coarse to see
 * a multi-second stall and cannot attribute one. This samples every 250ms and
 * reports the moment the player first exists, so an A/B can compare
 * time-to-player with numbers rather than by impression.
 */
(function () {
  "use strict";

  function post(payload) {
    try {
      browser.runtime.sendMessage({ type: "aegis:debug-report", payload: payload });
    } catch (e) {}
  }

  function count(sel) {
    try {
      return document.querySelectorAll(sel).length;
    } catch (e) {
      return -1;
    }
  }

  var START = Date.now();
  var firstPlayerAt = null;
  var firstVideoAt = null;
  var firstPlayAt = null;
  var navigatedAt = null;

  var samples = [];
  var done = false;

  var timer = setInterval(function () {
    if (done) return;
    var ms = Date.now() - START;
    var mp = count("#movie_player");
    var v = count("video");

    if (mp > 0 && firstPlayerAt === null) firstPlayerAt = ms;
    if (v > 0 && firstVideoAt === null) firstVideoAt = ms;

    // Actual playback, not just the element existing. This is what the
    // "black screen for a few seconds" symptom is really about.
    var vid = document.querySelector("video");
    if (vid && firstPlayAt === null && vid.currentTime > 0.1 && !vid.paused) {
      firstPlayAt = ms;
    }

    samples.push({ t: ms, player: mp, video: v, ready: document.readyState });

    var settled = firstPlayAt !== null && ms - firstPlayAt > 2000;
    if (ms > 20000 || settled) {
      done = true;
      clearInterval(timer);
      post({
        phase: "timing",
        url: location.href.slice(0, 120),
        firstPlayerMs: firstPlayerAt,
        firstVideoMs: firstVideoAt,
        firstPlayMs: firstPlayAt,
        navigatedMs: navigatedAt,
        sampleCount: samples.length,
        timeline: samples.filter(function (s, i) {
          if (i === 0) return true;
          var p = samples[i - 1];
          return s.player !== p.player || s.video !== p.video || s.ready !== p.ready;
        })
      });
    }
  }, 250);

  try {
    document.addEventListener("yt-navigate-finish", function () {
      navigatedAt = Date.now() - START;
    });
  } catch (e) {}

  window.addEventListener("load", function () {
    post({ phase: "probe-load", ms: Date.now() - START, url: location.href.slice(0, 120) });
  });
})();
