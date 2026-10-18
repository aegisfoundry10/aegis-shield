# Privacy policy — Aegis Shield

**Last updated: 2026-10-18**

## Summary

Aegis Shield collects nothing, transmits nothing, and contacts no server of its
own. There is no analytics, no telemetry, no crash reporting, no remote
configuration, and no remote filter list. This is not a policy promise layered on
top of a data pipeline — there is no code that makes a network request.

## Data collection

Declared in the manifest as:

```json
"browser_specific_settings": {
  "gecko": {
    "data_collection_permissions": { "required": ["none"] }
  }
}
```

Firefox renders this at install time. The `none` declaration is accurate:

| Category | Collected |
|---|---|
| Personally identifying information | No |
| Health | No |
| Financial and payment | No |
| Authentication | No |
| Personal communications | No |
| Location | No |
| Web browsing activity | No |
| Website content | No |
| Technical and interaction data | No |

## What the extension does with page data

The extension reads the content of network responses in order to remove
advertising from them, and inspects the page DOM to hide advertising elements.
This processing happens **entirely in your browser**. Nothing is logged to disk,
nothing leaves the machine, and nothing is retained after the tab closes.

Per-tab counters (how many ads were removed on the current page) live in memory
in the extension's background page and are discarded on navigation and on
browser exit.

## Permissions and why each is needed

| Permission | Why |
|---|---|
| `webRequest` | Observe requests in order to pick out the ones to modify |
| `webRequestBlocking` | Cancel requests to advertising endpoints |
| `webRequestFilterResponse` | Read and rewrite response bodies (the ad removal itself) |
| `host_permissions: <all_urls>` | Block advertising hosts on any site, and rewrite YouTube's responses |
| `storage` | Remember your on/off preferences |
| `tabs` | Attribute blocked counts to the right tab for the toolbar badge |

No permission is requested that is not used.

## Third-party services

None. There are no third-party SDKs, no bundled analytics, no external filter
list subscriptions, and no update ping. The extension works fully offline once
installed; it simply blocks less on sites it has no rules for.

## Contact

Open an issue on the project repository.
