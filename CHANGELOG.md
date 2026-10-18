# Changelog

All notable changes to Aegis Shield (Firefox). Version numbers track
`manifest.json`.

## 0.2.2 — 2026-10-18

Follow-up to 0.2.1. **The shipped extension had no defect.** A reported
regression — erratic multi-second black screens before playback — was traced to a
temporary test build that had been left loaded in the browser, not to anything in
this package. That build drove tabs on a timer and reported to a local sink that
was not running, so it was fighting the user's own navigation. The harness can no
longer do that, but none of it is part of what ships here.

- **Cheaper change detection.** The rewriter decided whether a response needed
  rewriting by re-serialising the whole document and comparing the resulting
  strings. On an ad-free page that meant a parse plus two full stringifies to
  conclude "change nothing", and three on the JSON path. It now counts the
  structures the pruner actually deletes, so a no-op pass never serialises at
  all. Measured against a real captured watch document: decision path 2.3 ms to
  1.3 ms, whole rewrite 18.3 ms.

  This is a real saving and a real simplification, but it is single-digit
  milliseconds. It is **not** a latency fix and should not be read as one.
- **Removed the `browser`/`chrome` namespace fallback** in the background entry
  point. It existed only for a Chromium build that will not ship, so it was dead
  code in a Firefox-only extension. Verified in live Firefox that the background
  still loads to completion.
- **README rewritten.** Installation steps now come first, and the comparison
  against the abandoned Chromium build is gone — the design rationale is stated
  as a property of this extension instead of as a contrast with another one.

Verified: 40 tests, AMO validator 0 errors, real headless Firefox, live YouTube.

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
- Blocking `webRequest` with full `RegExp` rules, which Firefox MV3 supports.
- DOM layer for cosmetics, skip-button automation, unskippable fast-forward, and
  the enforcement wall — which is removed, never answered with an allowlist.
- No telemetry, no remote filter lists, no network requests of the extension's own.
