# Aegis Shield (Firefox)

MV3 ad blocker that removes YouTube ads in the network stack, before any page JavaScript runs.
Zero telemetry, no remote filter lists, no network requests of its own. Firefox 140+. GPL-3.0-only.
**No bundler** — the shipped `.js` is the authored `.js`.

## Memory (shared second brain)

Vault: `E:\SecondBrain` — a git repo shared by Claude Code, Hermes and ChatGPT.

- Follow `E:\SecondBrain\_system\AGENT-RULES.md`.
- Start of every task: follow `E:\SecondBrain\_system\procedures\start.md`
  (read `E:\SecondBrain\01-Projects\aegis-shield\NOW.md` first).
- End of every task that changed code or made a decision: follow
  `E:\SecondBrain\_system\procedures\finish.md`. That is the only handoff — do not create
  tool-specific handoff files.
- Fixed a tricky bug: follow `E:\SecondBrain\_system\procedures\log-bug.md`.
- Never write secret values to the vault. Names only.
- Prefer the vault's `codebase-map.md` and `architecture.md` over re-reading `src/`.

## Commands

- test: `npm test` — node --test, pure functions, no browser
- lint: `npm run lint` — Mozilla's AMO validator; must report 0 errors
- build: `npm run build` — web-ext build
- check: `npm run check` — lint + test + build + check:package. Run before tagging.
- live: `npm run test:firefox` — real Firefox; the binary path is pinned in `.web-ext-config.mjs`

## Hard rules

1. **A new blocking rule takes two edits.** Add it to `src/common/rules.js` **and** to `URL_FILTER` in
   `src/background/block.js`, or the listener never sees the request. The rule will look correct and
   simply never fire.
2. **Do not simplify the `googlevideo` `adformat` regex** without re-running its explicit negative
   tests in `test/engine.test.mjs`. It is the only rule that can break video playback, and it was
   already written wrong once.
3. **Do not add a bundler or minifier.** AMO requires unobfuscated source and adds a manual review step
   for bundled packages.
4. **Fail open.** A body that is not JSON, is truncated, exceeds the byte ceiling, or whose pruner
   throws must pass through **byte-identical** — and no error path may ever emit an empty body.
5. **Anything re-serialised into a `<script>` context goes through `serializeForHtml()`** (`<`, `>`,
   `&`, U+2028, U+2029). `JSON.stringify` alone undoes YouTube's escaping and can inject `</script>`.
6. **Do not touch the page.** No MAIN-world script, no patching `fetch` or the player object — YouTube
   probes for exactly that through its `/error_204` endpoint. Ad removal happens to response bytes only.
7. **`npm run check:package` is not optional.** Packaging works by **exclusion**, so without it a stray
   root-level file ships by default.
8. `strict_min_version: 140.0` is tied to `data_collection_permissions`. Lower it only if you also drop
   that key.

## Repo docs — read before big changes

- `docs/DEBUGGING.md` — the 0.2.0 → 0.2.1 post-mortem with raw harness evidence. **Read before touching
  the rewriter.**
- `docs/RELEASE.md` — release runbook (AMO signing, the CI secrets).
- `docs/VERIFICATION.md` — point-in-time test record (dated 2026-10-17; not current state).
- `docs/PRIVACY.md` — privacy statement and per-permission justification.
- `CHANGELOG.md` — version history. Version numbers track `manifest.json`.
