# Changelog

All notable changes to Aegis Shield (Firefox). Version numbers track
`manifest.json`.

## 0.2.1 — 2026-10-18

Fixes the reported failure where the YouTube home page did not build its video
catalogue, search worked, and clicking a video showed a black screen for a few
seconds before playback.

- **Stopped filtering `/youtubei/v1/guide`.** It is part of the application
  bootstrap and carries no ads. Filtering it bought nothing and broke startup.
- **A failed stream no longer produces an empty response.** The error path now
  calls `disconnect()` so Firefox completes the response, instead of writing zero
  bytes and closing.
- **Removed the `Content-Encoding` rewrite.** Setting it to `identity` while
  `Content-Length` still held the compressed length made the browser read a
  truncated body. Firefox manages the encoding for a filtered stream.
- **Responses are now passed through byte-identical when nothing was removed.**
  The previous check compared re-serialised JSON against the raw wire text, so any
  escape or formatting difference looked like a change and whole documents were
  rewritten for no reason.
- **Added HTML boot-payload filtering.** Measured on a real cold watch-page load:
  192 requests to YouTube and `/youtubei/v1/player` was never among them — the
  player response was inlined in the document. The API filter alone therefore
  intercepted nothing on a cold load. `html-rewriter.js` prunes the inline
  `ytInitialPlayerResponse` / `ytInitialData` before the browser parses it.
- **Fixed an escaping bug introduced by that change.** `JSON.stringify` undid
  YouTube's `\u003c` escaping, which exists so an embedded `</script>` cannot
  terminate the script element. Output is now re-escaped for the HTML context.

Verified: 35 tests, AMO validator 0 errors, real headless Firefox, live YouTube.

## 0.2.0 — 2026-10-17

First Firefox build.

- Network-stack ad removal via `webRequest.filterResponseData()`. No MAIN-world
  content script, nothing injected into the page, and therefore nothing for
  YouTube's `error_204` tamper probe to detect.
- Blocking `webRequest` with full `RegExp` rules (available on Firefox MV3;
  removed from Chrome MV3).
- DOM layer for cosmetics, skip-button automation, unskippable fast-forward, and
  the enforcement wall — which is removed, never answered with an allowlist.
- No telemetry, no remote filter lists, no network requests of the extension's own.

## 0.1.0 — 2026-10-17

Chromium build (separate tree, `aegis-shield`).

- MV3, `declarativeNetRequest`, MAIN-world interceptor patching `fetch` and
  `XMLHttpRequest` plus an accessor on `ytInitialPlayerResponse`.
- Verified end-to-end in real Chrome on a live YouTube watch page.
