# Release runbook

Everything needed to get Aegis Shield installed on someone else's Firefox.

## Why signing is unavoidable

Release and Beta Firefox install **only** extensions signed by Mozilla. There is
no preference to override it in those builds — `xpinstall.signatures.required`
works only in Developer Edition, Nightly, and ESR. So the first step of any
distribution path is a Mozilla signature.

The `/about:debugging` → *Load Temporary Add-on* route used during development is
not a distribution method: it drops the extension on every browser restart.

## One-time setup

1. Create a free account at <https://addons.mozilla.org>. Registration is free.
2. Go to **Tools → Manage API Keys → Generate new credentials**.
   - The **key** looks like `user:12345:67` and is the JWT issuer.
   - The **secret** is displayed **once**. If you lose it, revoke the pair and
     generate a new one.
3. Store both. Locally as environment variables; in CI as repository secrets.

```bash
export AMO_JWT_ISSUER='user:12345:67'
export AMO_JWT_SECRET='...'
```

Never commit these.

## Per-release steps

```bash
# 1. Bump the version in manifest.json and record it in CHANGELOG.md

# 2. Pre-flight — both must be clean
npx web-ext lint          # AMO's own validator; must report 0 errors
npm test                  # 35 tests

# 3. Build
npx web-ext build
```

### Path A — self-distributed (unlisted). Minutes.

Mozilla signs the package but it never appears in the public catalogue. You host
the `.xpi` yourself.

```bash
npx web-ext sign \
  --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

The signed `.xpi` lands in `web-ext-artifacts/`. Unlisted submissions are
normally auto-reviewed, so this returns in minutes.

Attach the `.xpi` to a GitHub Release. Users install it by:

- `about:addons` → gear icon next to *Manage Your Extensions* →
  **Install Add-on From File…** → pick the `.xpi`, or
- opening the `.xpi` in Firefox directly (they get a permission prompt).

Both install permanently, with no `about:config` changes.

**Auto-updates are not automatic on this path.** You must add an update manifest
and point the extension at it:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "aegis-shield@aegisfoundry.dev",
    "update_url": "https://raw.githubusercontent.com/<owner>/<repo>/main/updates.json"
  }
}
```

```json
{
  "addons": {
    "aegis-shield@aegisfoundry.dev": {
      "updates": [
        { "version": "0.2.2",
          "update_link": "https://github.com/<owner>/<repo>/releases/download/v0.2.2/aegis_shield-0.2.2.xpi" }
      ]
    }
  }
}
```

Firefox polls that URL. Miss this and users stay on the version they installed.

### Path B — public AMO listing. Days to weeks.

Gives you an AMO page, searchability in the Add-ons Manager, and automatic
updates handled by Mozilla.

```bash
npx web-ext sign \
  --channel=listed \
  --amo-metadata=amo-metadata.json \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

The first listed submission requires metadata — see `amo-metadata.json`, which
needs updating with real screenshots before it will be accepted.

Review is automated first, then human: content review of the listing, technical
review of the code, then a basic functionality test. Reported times for
non-minified extensions cluster around a few days; manual review can run longer.

### You do NOT need to submit source code

AMO requires unobfuscated source and will ask for it if the package is minified
or bundled. This project has **no build step and no bundler** — the shipped `.js`
is the authored `.js`. That means no source zip, and it removes one of the main
causes of long manual reviews. Do not introduce a bundler without reading this
paragraph again.

## What reviewers will look at

- **Every permission is used and justified.** The `<all_urls>` host permission is
  the one to explain up front: it is required for a general ad blocker, and the
  response-rewriting path needs it for YouTube specifically.
- **No data collection** — declared as `required: ["none"]`, which is true.
- **No obfuscated code.**
- **The extension does what the listing says it does.** The listing must not
  overclaim. It should say "removes ads, including on YouTube" and not
  "blocks all ads everywhere" — see the honest limits in `docs/VERIFICATION.md`.

Note that even self-distributed add-ons can be manually reviewed at any time
after submission, and signing can be revoked. The same honesty applies on both
paths.

## Post-release

- Verify the signed artifact installs on a clean Firefox profile. An unsigned or
  corrupt package fails silently at the install prompt.
- Confirm the version the browser reports matches `manifest.json`.
