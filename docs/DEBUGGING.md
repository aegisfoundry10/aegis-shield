# Debugging the live Firefox failure (0.2.0 → 0.2.1)

**Reported:** home page loads without its video catalogue; search works; clicking a
video shows a black screen for a few seconds before playback starts; no ads shown.

**Outcome:** three real bugs found and fixed, one coverage gap closed, one security
bug found in my own fix. All verified against a real headless Firefox and real
YouTube traffic.

---

## The harness

Firefox's debugger protocol is not CDP and there is no geckodriver on this host, so
the extension was made to report its own behaviour to a local sink.

```
test/debug/sink.mjs          local HTTP sink on 127.0.0.1:8787, writes reports.jsonl
test/debug/debug.js          reporter, injected into the background by make-debug-build
test/debug/probe-page.js     content-script probe: does the page actually render?
test/debug/make-debug-build.mjs   assembles test/debug/build with the reporter added
```

Run it with:

```bash
node test/debug/make-debug-build.mjs
node test/debug/sink.mjs 200 &          # or via the agent's background runner
npx web-ext run --source-dir test/debug/build --no-reload --no-input --arg=-headless
```

`web-ext run` was used rather than `--load-extension` because Chrome-style
command-line loading is gone; `web-ext` installs a temporary add-on through
Firefox's own debugger, which is what `about:debugging` does by hand.

The reporter wraps the shipping code **from the outside** — it patches
`browser.webRequest.filterResponseData` and `__AEGIS_REWRITER__.createRewriter` —
so the behaviour under observation is the shipped behaviour, not a re-implementation.
It is absent from the real manifest and cannot reach a release package.

### Two probe bugs of my own, worth recording

Both produced runs that looked like extension failures but were artifacts:

1. **`Object.defineProperty` on the StreamFilter.** The first reporter redefined the
   filter's `ondata`/`onstop` properties to observe them. That prevented the shipping
   handlers from ever attaching, and the run showed *zero* filter events — which
   looked exactly like the reported bug. The reporter now returns a `Proxy`, which
   cannot interfere with assignment on the target.
2. **Content-script `fetch` to localhost.** The page probe tried to POST its own
   findings. A content script's `fetch` is subject to the page's CSP, and YouTube's
   `connect-src` does not allow `http://127.0.0.1`. Reports are now relayed through
   the background, which has no such restriction.

Both matter as a caution: a broken instrument looks like a broken subject.

---

## What the instrumentation established

### Verified fact: the filter receives decoded bytes

```
finished id=2  data=true stop=true ERR=false chunks=1 bytes=14954 magic=None
   first bytes: {"responseContext":{"serviceTrackingParams":[{"service":"CSI",...
```

`magic=None` with readable JSON at the head. Firefox hands the `StreamFilter`
**decompressed** data, contrary to the wire `Content-Encoding: br`. The design
assumption in the port was correct.

### Bug 1 — the `guide` response was being rewritten, and one attempt was closed empty

The `guide` endpoint is the left navigation rail — part of application bootstrap, and
it never carries ads. 0.2.0 filtered it anyway:

```
created  id=1 https://www.youtube.com/youtubei/v1/guide?prettyPrint=false
finished id=1 data=false stop=false ERR=true chunks=0 bytes=0
```

Two failures in one: an unnecessary rewrite **and** an error path that wrote nothing
and closed the stream, handing the application an empty response. A failed bootstrap
is consistent with "the home page does not build its catalogue".

**Fixed:** `guide` removed from the intercept table; the error path now calls
`filter.disconnect()` so Firefox completes the response instead of receiving an empty
body.

### Bug 2 — response headers were being rewritten, desynchronising Content-Length

0.2.0 set `Content-Encoding: identity` on filtered responses. With the header now
claiming identity while `Content-Length` still held the *compressed* length, the
browser read a truncated body.

**Fixed:** the header listener is gone entirely. Firefox manages the encoding for a
filtered stream; the code that fought it was the problem, not the solution. The
function remains, documented, returning `{}`.

### Bug 3 — responses were rewritten even when nothing was removed

```
REWRITER player=False changed=True reason=reencoded adsRemoved=0
```

The "did it change?" test compared re-serialised JSON against the raw wire text. Any
formatting or escape difference made an untouched response look changed, so 850 KB
documents were rewritten for no reason — each one an opportunity to corrupt the
stream.

**Fixed:** comparison is now between two *canonical* forms produced by the same
serializer. A response that is not actually modified is passed through byte-identical.

### Coverage gap — the boot payload is in the HTML, not in an XHR

Measured on a real watch-page load:

```
BEAT 21: allRequests=492  youtubeRequests=192  filters=[]
```

192 requests to YouTube, **zero filters fired, and `/youtubei/v1/player` was never
requested.** YouTube had inlined the player response into the document itself:

```
real watch.html (1.34 MB) — ytInitialPlayerResponse=true  ytInitialData=true
   inline keys: responseContext,playabilityStatus,streamingData,playbackTracking,
                captions,videoDetails,...,adBreakHeartbeatParams,frameworkUpdates
```

A network filter on the API endpoints therefore intercepts **nothing** on a cold page
load. This is the same problem the Chromium build solves by patching the page's
JavaScript — which the page can detect.

**Fixed** with the Firefox-only capability the port was supposed to exploit:
`src/common/html-rewriter.js` prunes the inline payloads inside the document, before
the browser parses it. `filterResponseData` on `main_frame` gives us the HTML;
balanced-brace scanning (string- and escape-aware) locates `ytInitialPlayerResponse`
and `ytInitialData`; each is parsed, pruned, and re-serialised in place.

The Chromium build cannot do this. Chromium has no `webRequest.filterResponseData`.

### Bug 4 — a security bug introduced by my own fix

The first HTML-prune run rewrote a 1.85 MB document down to 1.32 MB while removing
4 ad structures. A 533 KB reduction from four small removals is not possible. Cause:
YouTube escapes `<` as `\u003c` in these inline payloads specifically so an embedded
string containing `</script>` cannot terminate the script element. `JSON.stringify`
undoes that escaping.

With an ad payload containing `</script>`, the rewriter would have emitted a literal
closing tag into the document. **Fixed** with `serializeForHtml()`, which re-escapes
`<`, `>`, `&`, U+2028 and U+2029. There are now explicit tests asserting that a
payload containing `</script><img src=x onerror=…>` cannot break out of the tag and
still round-trips byte-exactly.

The size check is what caught it, and the same check now confirms the fix:

```
0.2.0-style:  in=1853387B out=1320054B   (533 KB phantom shrink)
final:        in=1337812B out=1337776B   (36 bytes — exactly adBreakHeartbeatParams)
```

---

## Final measured behaviour (live Firefox, live YouTube)

```
created  id=1 https://www.youtube.com/
REWRITER changed=False reason=html-unchanged adsRemoved=0 out=NoneB
finished id=1 data=True stop=True ERR=False in=954784B elapsed=403ms

created  id=2 https://www.youtube.com/?themeRefresh=1
REWRITER changed=False reason=html-unchanged adsRemoved=0 out=NoneB
finished id=2 data=True stop=True ERR=False in=954410B elapsed=287ms

created  id=3 https://www.youtube.com/watch?v=jNQXAC9IVRw
finished id=3 data=False stop=False ERR=True in=0B          <- duplicate nav, disconnected safely

created  id=4 https://www.youtube.com/watch?v=jNQXAC9IVRw
REWRITER changed=True reason=html-pruned adsRemoved=1 out=1337776B
finished id=4 data=True stop=True ERR=False in=1337812B elapsed=867ms
```

Page health alongside it:

```
https://www.youtube.com/                    moviePlayer=1 video=1 wall=0 errs=0
https://www.youtube.com/watch?v=jNQXAC9IVRw moviePlayer=1 video=1 wall=0 errs=0
```

The home page is no longer touched at all. The watch page's inline boot payload is
genuinely pruned at the network layer, with the document head and tail byte-identical.

---

## What this does **not** establish

- **That the user's logged-in home feed renders.** The harness has no YouTube session;
  the feed is empty on a signed-out profile with or without the extension, so this
  environment cannot reproduce the reported baseline. What *is* established is that
  the harmful operations against the home page have stopped — the home document is now
  passed through untouched, and no error path can emit an empty response.
- **That ads no longer play in a real session.** No ad break was triggered in any run
  (headless Chrome and Firefox lack proprietary codecs, so no media plays). The
  evidence is that ad structures were present in the payload and removed.
- **The `elapsed=867ms` cost on the watch document.** The whole document is buffered
  before it is handed to the browser. That is inherent to modifying it. Whether it is
  perceptible was not measured in a real GPU-backed session; the 403/287 ms figures
  for ~950 KB home documents are the closest proxy.
- **The enforcement-wall and skip paths.** Still never executed; no wall was encountered.

The decisive test remains a real logged-in browser session.
