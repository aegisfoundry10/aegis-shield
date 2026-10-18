# Verification record — Firefox build

`EXECUTED` unless stated otherwise.

| | |
|---|---|
| Host | Windows 11 |
| Firefox | `C:/Program Files/Mozilla Firefox/firefox.exe` |
| Node | v26.7.0 |
| web-ext | via `npx web-ext@latest` |
| Date | 2026-10-17 |

---

## 1. Unit tests — `npm test`

17 tests, 17 pass. Run against the pure modules; no browser involved.

```
✔ rewrites a player response delivered in one chunk
✔ rewrites correctly across many chunk boundaries
✔ survives a split inside a multi-byte character
✔ passes through untouched when the body is not JSON
✔ passes through untouched when the body is truncated JSON
✔ refuses to buffer beyond the ceiling
✔ empty body is a no-op, not an error
✔ a pruner that throws cannot corrupt the response
✔ finish() is idempotent
✔ blocks the YouTube ad endpoints
✔ does NOT block the actual video pages or the player API
✔ the googlevideo rule fires on ad media and never on playback
✔ third-party ad hosts are blocked only from YouTube when scoped
✔ enabled groups are respected
✔ intercept rules match the API endpoints and not the ad-break path
✔ prune engine still detects and strips, non-destructively on detect
✔ prune engine never throws on hostile input
ℹ tests 17  ℹ pass 17  ℹ fail 0
```

**A real bug was found and fixed by these tests.** The first run failed
`the googlevideo rule fires on ad media and never on playback`:

```
AssertionError: should block ad stream:
  https://rr3---sn-abc.googlevideo.com/videoplayback?adformat=22&id=o1
```

The rule was written `videoplayback\?[^#]*[?&]adformat=`, which requires a `?` or
`&` *before* `adformat` — but the `?` separating path from query had already been
consumed, so the common single-parameter form `?adformat=22` never matched. Fixed
to `videoplayback\?(?:[^#]*&)?adformat=`. A second failure was a wrong assertion in
the test itself (a group-scoping expectation that contradicted the correct
behaviour); the test was corrected, not the code.

---

## 2. Mozilla's own validator — `npx web-ext lint`

This is the AMO submission validator, not a local lint.

```
"summary": { "errors": 0, "notices": 0, "warnings": 1 }
"metadata": {
  "id": "aegis-shield@aegisfoundry.dev",
  "manifestVersion": 3,
  "name": "Aegis Shield",
  "version": "0.2.0",
  "firefoxMinVersion": "140.0",
  "totalScannedFileSize": 43952,
  "emptyFiles": [],
  "jsLibs": {},
  "unknownMinifiedFiles": []
}
```

**0 errors.** Two warnings were raised on the first pass and both were addressed
rather than ignored:

- `MISSING_DATA_COLLECTION_PERMISSIONS` — this key is **required for all new
  Firefox extensions**. Added `browser_specific_settings.gecko.data_collection_permissions`
  with `required: ["none"]`, which is accurate: the extension collects nothing.
- `DANGEROUS_EVAL` in `test/engine.test.mjs` — the test harness loads the
  extension's classic scripts with `new Function`. That is a test-only construct
  and must not ship, so `.web-ext-config.mjs` excludes `test/**` and `docs/**`
  from the package. The scanned size dropped 55,817 → 43,952 bytes, confirming the
  exclusion took effect.

The one remaining warning is `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`:
the `data_collection_permissions` key needs Firefox for Android 142 while
`strict_min_version` says 140. This build targets desktop only and declares no
Android settings, so the warning is not actionable. **`UNKNOWN`:** whether AMO
review treats it as noise.

---

## 3. Package — `npx web-ext build`

```
Building web extension from .
Your web extension is ready:
  web-ext-artifacts/aegis_shield-0.2.0.zip
```

19,708-byte zip from a 43,952-byte source tree — the test and docs directories are
excluded as configured.

---

## 4. Runtime install — `npx web-ext run`

Launched a real Firefox (headless, throwaway profile) and installed the extension
through the debugger:

```
installTemporaryAddon: {"addon":{"id":"aegis-shield@aegisfoundry.dev", ...}}
Installed C:\Users\ggrad\rea-work\aegis-shield-firefox as a temporary add-on
```

**Firefox accepted the extension at runtime, with the correct add-on id, and
registered all five permissions including `webRequestFilterResponse`.** No
add-on loading errors were reported.

The `[ERROR shell_windows::taskbar...]` and `[GFX1-]` lines in the run log are
Windows headless-mode shell/GPU noise. They are unrelated to the extension —
note that they appear alongside `*** You are running in headless mode.`

---

## What is NOT verified

Stated plainly, because these are the things that matter:

- **That ad removal actually works on a live YouTube page in Firefox.** No test
  run has loaded YouTube with this build active. Everything above proves the
  extension installs, the manifest is valid, the rules are correct, and the
  rewrite state machine is correct. It does **not** prove the end-to-end path.
  That evidence was not available for this build.
- **The `StreamFilter` encoding assumption.** Firefox is documented to hand the
  filter decompressed bytes, and for a known content type the `Content-Encoding`
  header is meant to be transparent. This was not observed on a live response.
  This is the single highest-risk unverified assumption in the build. Diagnostic:
  if `stats.passedThrough` climbs while `stats.rewritten` stays flat, the filter
  is receiving something the rewriter cannot parse.
- **`webRequestFilterResponse` at runtime.** The permission loaded, but whether
  `filterResponseData()` is actually granted (rather than throwing and incrementing
  `stats.failed`) was not observed.
- **The enforcement-wall path.** `yt-dom.js` → `removeWall()` has never executed;
  no wall was encountered.
- **Skip and fast-forward paths.** No ad state was reached.
- **Generic network blocking.** Rule matching is unit-tested; no site has been
  browsed against it.
- **AMO signing and review.** Not attempted. The extension is unsigned.

### To close the main gap

Load the extension via `about:debugging#/runtime/this-firefox`, open a YouTube
video, and check the toolbar badge. The badge counts network-side removals plus
DOM work. If it stays at zero, the diagnostic is the `stats` object on
`intercept.js` — `passedThrough` versus `rewritten`.
