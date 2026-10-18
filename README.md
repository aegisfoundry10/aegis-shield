# Aegis Shield

A Firefox ad blocker that removes YouTube ads **in the network stack**, before
any page JavaScript runs.

No telemetry. No remote filter lists. No "acceptable ads" tier. The extension
makes no network requests of its own.

---

## Install

**Requires Firefox 140 or newer.**

1. Download the signed **`.xpi`** from the
   [latest release](https://github.com/aegisfoundry10/aegis-shield/releases/latest).
2. Open the downloaded file in Firefox.
3. Approve the permission prompt. Firefox will ask for access to all sites — that
   is what lets the extension block advertising hosts anywhere and rewrite
   YouTube's responses.
4. Pin it from the toolbar's extensions menu, then open a YouTube video.

The package is signed by Mozilla, so it installs into a normal release build of
Firefox with no `about:config` changes. The toolbar badge counts what was removed
on the current page.

To install from a file later: `about:addons` → the gear icon next to *Manage Your
Extensions* → **Install Add-on From File…**

### Development install

Temporary, and lost on every Firefox restart:

```
about:debugging#/runtime/this-firefox → Load Temporary Add-on → pick manifest.json
```

---

## What it does

- Removes YouTube's video ads by rewriting the responses the player is handed, so
  the player never learns an ad was scheduled.
- Blocks third-party advertising and analytics hosts across the web.
- Hides the placeholder a blocked ad leaves behind.
- Skips, or fast-forwards through, anything that still reaches the player.

---

## How it works

Two interception paths, both in the network stack rather than in the page.

**1. API responses.** `src/background/intercept.js` attaches a `StreamFilter` to
YouTube's API responses and rewrites the JSON body:

```
onBeforeRequest  → filterResponseData(requestId)
ondata           → buffer chunks
onstop           → parse JSON → prune adPlacements/playerAds/adSlots → write → close
```

Rewritten endpoints: `/youtubei/v1/player`, `next`, `browse`, `search`,
`reel/reel_item_watch`, `reel/reel_watch_sequence`.

**2. The HTML document.** Measured on a real cold watch-page load: 192 requests
to YouTube, and `/youtubei/v1/player` was **never requested** — the player
response was inlined in the document as `var ytInitialPlayerResponse = {...}`.
The API path alone therefore intercepts nothing on a cold load.
`src/common/html-rewriter.js` prunes the inline boot payloads inside the HTML
before the browser parses it.

`src/common/stream-rewriter.js` holds the chunk-buffering state machine as a pure
function, so it is testable without a browser.

### Why nothing touches the page

Ad removal happens to the bytes of a response, not to the page's JavaScript.
There is no content script running in the page's own context, `fetch` is not
patched, and `ytInitialPlayerResponse` is not redefined.

That matters because YouTube actively probes for extensions that do patch those
things. It reports to its own `error_204` endpoint when a page error mentions both
`read-only` and `non-configurable` — the signature of a locked descriptor having
been installed on the player object. Nothing here installs one, so there is
nothing to find.

Two Firefox capabilities make this possible:

- **Blocking `webRequest` under Manifest V3**, which is why the rules in
  `src/common/rules.js` are real `RegExp` objects evaluated in JavaScript — with
  lookarounds, alternation and `\b` available, no static ruleset to ship, and no
  rule-count ceiling.
- **`webRequest.filterResponseData()`**, available from Firefox 110 with the
  `webRequestFilterResponse` permission. This is the API that allows a response
  body to be read and rewritten at all.

The content script (`src/content/yt-dom.js`) only does DOM work: cosmetics,
skip-button automation, unskippable fast-forward, and the enforcement wall — which
is removed rather than answered with an allowlist.

### Failure policy: fail open, never corrupt

If a body is not JSON, is truncated, exceeds the size ceiling, or the pruner
throws, the original bytes are written through untouched. A response that is not
actually modified is passed through **byte-identical**: rewriting something you
did not change is pure risk, and doing exactly that is what broke the YouTube home
page in 0.2.0.

Serialisation for the HTML path re-escapes `<`, `>`, `&` and the U+2028/2029 line
separators, because YouTube escapes them precisely so that an embedded `</script>`
cannot terminate the script element early.

See [`docs/DEBUGGING.md`](docs/DEBUGGING.md) for the full account of what 0.2.1
fixed — including an unnecessary rewrite of the application-bootstrap `guide`
response, an error path that emitted an empty body, a `Content-Encoding` /
`Content-Length` desync, and an escaping bug that would have injected `</script>`
into the document.

---

## Privacy

Nothing is collected, transmitted, or logged. No analytics, no telemetry, no crash
reporting, no remote configuration, no update ping. Declared to Firefox as
`data_collection_permissions: none`, which is what the install prompt shows.

Per-tab counters live in memory and are discarded on navigation and browser exit.
See [`docs/PRIVACY.md`](docs/PRIVACY.md) for the full statement and a
permission-by-permission justification.

---

## Development

```bash
npm test            # 35 tests, pure functions, no browser
npm run lint        # Mozilla's own AMO validator
npm run build       # produces web-ext-artifacts/aegis_shield-<version>.zip
npm run check       # lint + test + build + package-contents assertion
```

`npm run test:firefox` launches a real Firefox with the extension installed.

There is **no build step and no bundler** — the shipped `.js` is the authored
`.js`. That is deliberate: AMO requires unobfuscated source and asks for a source
archive when a package is minified or bundled, so keeping it unbundled removes one
of the main causes of long manual reviews. Reconsider before adding a bundler.

`npm run check:package` asserts the built package contains only extension files.
Packaging works by exclusion, so without it a stray root-level file would ship by
default.

---

## Layout

```
manifest.json                   MV3, event-page background
.web-ext-config.mjs             packaging: keeps test/ and docs/ out of the zip
src/common/prune.js             JSON surgery engine
src/common/stream-rewriter.js   chunk buffering + rewrite state machine
src/common/html-rewriter.js     inline boot-payload pruning
src/common/rules.js             blocking rule table (full RegExp) + intercept rules
src/background/intercept.js     StreamFilter wiring
src/background/block.js         webRequest blocking
src/background/main.js          event-page entry, stats, badge
src/content/yt-dom.js           DOM: cosmetics, skip, wall removal
src/content/cosmetic.css        cosmetic hide list
test/                           engine tests, package guard, live-browser harness
docs/                           release runbook, privacy, verification, debugging
```

## Releases

Tagging a version signs the extension through AMO and attaches the signed `.xpi`
to a GitHub Release automatically. See [`docs/RELEASE.md`](docs/RELEASE.md) for the
runbook and the required repository secrets.

---

## Notes for whoever works on this next

- **Adding a blocking rule needs two changes.** Rules are matched in JS, so a new
  host must also be added to `URL_FILTER` in `src/background/block.js`, or the
  listener will never see its requests. Easy mistake to make.
- **The `googlevideo` ad-format rule is the dangerous one.** It is the only rule
  that can break video playback if the pattern is wrong. `test/engine.test.mjs`
  has explicit negative tests for it; do not simplify that regex without
  re-running them.
- **`strict_min_version` is 140.0** because `data_collection_permissions` was
  introduced in Firefox 140. Lower it only if you also drop that key — AMO
  requires the key for new extensions.
- **The enforcement-wall path is the least exercised code.** No test run has yet
  triggered the wall, so `yt-dom.js` → `removeWall()` has never executed in
  automation.
- **YouTube moves; this will need maintenance.** When it changes how it delivers
  ads, expect a period where this needs an update — same as any ad blocker.

## License

**GPL-3.0-only.** See [`LICENSE`](LICENSE) for the full text.

Contains no code from Adblock Plus, Eyeo, or their EWE engine — this is an
independent implementation. The license is shared with that ecosystem
deliberately: it means a fork cannot be taken closed-source and turned into a paid
product built on this work.

No per-file copyright header is present yet, because that requires naming a
copyright holder. Add one before accepting outside contributions:

```
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) <year> <holder>
```
