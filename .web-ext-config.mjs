/**
 * web-ext configuration.
 *
 * Two purposes:
 *  1. Keep the development tree (tests, docs, package.json) out of the package
 *     submitted to addons.mozilla.org. The test harness loads the extension's
 *     classic scripts with `new Function`, which AMO's linter correctly flags as
 *     eval — it is a test-only construct and must not ship.
 *  2. Provide a stable `run` target for the live smoke test.
 */
export default {
  sourceDir: ".",
  ignoreFiles: [
    "test/**",
    "docs/**",
    ".github/**",
    "amo-metadata.json",
    "updates.json",
    "package.json",
    "package-lock.json",
    ".web-ext-config.mjs",
    ".gitignore",
    "*.md"
  ],
  build: {
    overwriteDest: true
  },
  run: {
    // Firefox must be pointed at explicitly on this host; there is no geckodriver
    // and no PATH entry for the binary. Other run flags are passed on the CLI,
    // because web-ext rejects unknown keys in this config with a UsageError.
    firefox: "C:/Program Files/Mozilla Firefox/firefox.exe"
  }
};
