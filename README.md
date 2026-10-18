# Aegis Shield — Firefox build

Manifest V3, Firefox-first. Removes YouTube ads **in the network stack**, before
any page JavaScript runs.

No telemetry. No remote filter lists. No "acceptable ads" tier. The extension
makes no network requests of its own.

---

## Why the Firefox build is stronger than the Chromium one

The Chromium build works by running a content script in the page's own
JavaScript context (`world: "MAIN"`), patching `window.fetch` and
`XMLHttpRequest`, and redefining `ytInitialPlayerResponse` through an accessor.
That is the only place Chromium MV3 leaves you.

It also means the page can *see* all of it. YouTube does: Adblock Plus 4.47.0
listens on `*://*.youtube.com/error_204*` and raises its
`yt_site_context_tampering` event when the `msg` parameter contains both
`read-only` and `non-configurable` — the signature of an extension that has
installed a locked descriptor on the player object. The Chromium build has to
spend effort being inconspicuous.

Firefox removes the problem instead of mitigating it:

| | Chromium build | Firefox build |
|---|---|---|
| Where ad removal happens | page JavaScript context | **network stack** |
| How | patched `fetch`/XHR + property accessor | `webRequest.filterResponseData()` rewrites the HTTP body |
| Visible to page JS | yes | **no — nothing is injected into the page** |
| YouTube tamper probe | must be actively evaded | **nothing to detect** |
| Blocking API | `declarativeNetRequest` (declarative subset) | **blocking `webRequest` with full RegExp** |
| Rule count ceiling | static ruleset limits | none — rules are JS |
| MAIN-world content script | required | **not needed at all** |

Two API facts make this possible, both Firefox-only:

- **Firefox MV3 keeps blocking `webRequest`.** Chrome removed `webRequestBlocking`
  in MV3 except for policy-installed extensions. So rules here are real
  `RegExp` objects evaluated in JavaScript — lookarounds, alternation, `\b` — not
  Chromium's restricted `urlFilter` syntax. There is no static ruleset to ship and
  no rule ceiling.
- **`webRequest.filterResponseData()` works under MV3** on Firefox 110+, with the
  extra `webRequestFilterResponse` permission. This is the API uBlock Origin's
  `replace=` and HTML filtering depend on, and it is the reason uBO is materially
  more capable on Firefox.

The content script here (`src/content/yt-dom.js`) only does DOM work: cosmetics,
skip-button automation, unskippable fast-forward, and the enforcement wall. It
runs in the ISOLATED world. There is no MAIN-world companion.

---

## How it works

Two interception paths, both in the network stack:

**1. API responses.** `src/background/intercept.js` attaches a `StreamFilter` to
YouTube's API responses and rewrites the JSON body:

```
onBeforeRequest  → filterResponseData(requestId)
ondata           → buffer chunks
onstop           → parse JSON → prune adPlacements/playerAds/adSlots → write → close
```

Rewritten endpoints: `/youtubei/v1/player`, `next`, `browse`, `search`,
`reel/reel_item_watch`, `reel/reel_watch_sequence`.

**2. The HTML document.** Measured on a real cold watch-page load: 192 requests to
YouTube, and `/youtubei/v1/player` was **never requested** — the player response was
inlined in the document as `var ytInitialPlayerResponse = {...}`. The API path alone
therefore intercepts nothing on a cold load. `src/common/html-rewriter.js` prunes the
inline boot payloads inside the HTML before the browser parses it. Chromium cannot do
this at all: it has no `filterResponseData`.

`src/common/stream-rewriter.js` holds the chunk-buffering state machine as a pure
function so it is testable without a browser.

**Failure policy: fail open, never corrupt.** If the body is not JSON, is truncated,
exceeds the ceiling, or the pruner throws, the original bytes are written through
untouched. A response that is not actually modified is passed through **byte-identical**
— rewriting a response we did not change is pure risk, and doing exactly that is what
broke the home page in 0.2.0.

Serialisation for the HTML path re-escapes `<`, `>`, `&` and the U+2028/2029 line
separators, because YouTube escapes them precisely so an embedded `</script>` cannot
terminate the script element early.

**What 0.2.1 fixed.** See [`docs/DEBUGGING.md`](docs/DEBUGGING.md) for the full
account: an unnecessary rewrite of the application-bootstrap `guide` response, an
error path that emitted an empty body, a `Content-Encoding`/`Content-Length` desync,
needless rewrites of unchanged responses, and an escaping bug in the HTML writer that
would have injected `</script>` into the document.

---

## Install (development)

```
about:debugging#/runtime/this-firefox → Load Temporary Add-on → pick manifest.json
```

Temporary add-ons are lost on restart. For a persistent install the extension has
to be signed — see `docs/VERIFICATION.md` for the `web-ext` commands, including
the config that keeps the test harness out of the package.

## Verify

```bash
npm test                    # 17 tests, pure functions, no browser
npx web-ext lint            # Mozilla's own AMO validator
npx web-ext build           # produces web-ext-artifacts/aegis_shield-0.2.0.zip
```

`npm run test:firefox` launches a real Firefox with the extension installed.

---

## Layout

```
manifest.json              MV3, event-page background, Firefox-only keys
.web-ext-config.mjs        AMO packaging: keeps test/ and docs/ out of the zip
src/common/prune.js        JSON surgery engine (identical to the Chromium build)
src/common/stream-rewriter.js   chunk buffering + rewrite state machine
src/common/rules.js        blocking rule table (full RegExp) + intercept rules
src/background/intercept.js     StreamFilter wiring
src/background/block.js         webRequest blocking + header normalisation
src/background/main.js          event-page entry, stats, badge
src/content/yt-dom.js      DOM: cosmetics, skip, wall removal
src/content/cosmetic.css   cosmetic hide list
test/                      engine tests + Firefox launch test
```

No build step. Load the directory as-is.

---

## Notes for whoever works on this next

- **The one thing to verify by hand** is that the `StreamFilter` receives bytes
  the rewriter can actually parse. Firefox is documented to hand the filter
  *decompressed* data, and for a known type like `application/json` the
  `Content-Encoding` header is meant to be transparent. If live YouTube returns
  anything the rewriter cannot parse, the counters in
  `intercept.js` → `stats.passedThrough` will climb and `stats.rewritten` will
  stay flat. That is the diagnostic. If it happens, `block.js` →`onHeadersReceived`
  is the hook that normalises `Content-Encoding` to `identity`.
- **The content script's wall-removal path has never executed** on this build.
  No test run has encountered the enforcement wall.
- **Rules are evaluated per request in JS.** The `urls` filter in
  `block.js` → `URL_FILTER` deliberately narrows the listener to the host
  families that have rules, so this is not a per-request cost on every site.
  Adding a rule for a new host means adding that host to `URL_FILTER` too, or it
  will never be evaluated. This is an easy mistake to make.
- **`strict_min_version` is 140.0** because `data_collection_permissions` was
  introduced in Firefox 140. Lower it only if you also drop that key — AMO
  requires the key for new extensions.
- **The `googlevideo` ad-format rule is the dangerous one.** It is the only rule
  that can break video playback if the pattern is wrong. There are explicit
  negative tests for it in `test/engine.test.mjs`; do not simplify that regex
  without re-running them.

## License

**GPL-3.0-only.** See [`LICENSE`](LICENSE) for the full text.

Contains no code from Adblock Plus, Eyeo, or their EWE engine — this is an
independent implementation. The license is shared with that ecosystem
deliberately: it means a fork cannot be taken closed-source and turned into a
paid product built on this work.

No per-file copyright header is present yet, because that requires naming a
copyright holder. Add one before accepting outside contributions, in the form:

```
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) <year> <holder>
```
