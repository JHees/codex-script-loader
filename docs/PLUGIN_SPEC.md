# Script-Loader Plugin Specification

This document defines the compatible v1 contract for renderer plugins managed by Codex Script Loader. It extends the original `manifest.json + index.js` format without breaking existing v1 packages.

## Package layout

A current package contains:

```text
plugin-id/
├── manifest.json
├── index.js
├── README.md
├── LICENSE
└── NOTICE.md        # when attribution or third-party notices are required
```

`README.md` explains what the plugin changes, how to use and configure it, its permissions, known compatibility limits, and how its data is stored or removed. Legacy v1 packages without a documentation declaration remain loadable, but Script Loader marks them as using the legacy contract.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "local.example",
  "name": "Example",
  "version": "1.0.0",
  "description": "A concise user-facing description.",
  "author": "Example author",
  "main": "index.js",
  "scope": "renderer",
  "runAt": "document-start",
  "lifecycleGlobal": "__localExampleLifecycle",
  "documentation": "README.md",
  "settings": {
    "mode": "page",
    "pageId": "main",
    "title": "Example settings"
  },
  "update": {
    "provider": "github-releases",
    "repository": "owner/repository",
    "asset": "example-{version}.zip"
  },
  "permissions": ["dom", "local-storage", "settings"]
}
```

- `schemaVersion` remains `1` for compatibility.
- `id`, `name`, `version`, `main`, `scope`, and `runAt` retain their existing meaning.
- `lifecycleGlobal` is an optional JavaScript global property name for self-executing plugins. When used, the named object exposes an idempotent `stop()` method. Module-style plugins should prefer exported `start` and `stop` hooks.
- `documentation` is a safe package-relative Markdown file. Current packages use `README.md`.
- `settings.mode` is `page` or `none`. A `page` declaration requires the `settings` permission. `pageId` defaults to `main`.
- Omitting `settings` or `documentation` is accepted only as legacy compatibility behavior.
- `update` is optional host metadata. Version 1 supports only public `github.com` stable Releases through `provider: "github-releases"`. `repository` is exactly `owner/repository`, `asset` is a ZIP filename with one `{version}` placeholder, the tag is `v{version}`, and the checksum asset is `<ZIP filename>.sha256`.
- Update-aware packages use a stable three-part numeric version. A candidate must preserve the installed package ID, repository, asset template, and declared update provider. Changing the update source requires a manual installation.
- The Loader never includes `update` in renderer `api.manifest`. It is a native package-management interface, not plugin runtime authority.
- `permissions` are capabilities, not a security sandbox. Renderer plugins execute trusted local JavaScript in Codex and must be reviewed before enabling.
- The opt-in `loopback-websocket` permission adds `api.localTransport.openWebSocket(endpoint)`. A plugin that does not declare this permission has no `localTransport` property; the rest of its `api` shape is unchanged.
- The opt-in `browser-page-companion` permission requires a fixed `pageCompanion` manifest declaration and adds only `api.pageCompanion.probe|bind|invoke|unbind`. It does not expose CDP, arbitrary targets, selectors, scripts, cookies, or profiles.

## GitHub Release updates

The native Windows host scans update-aware third-party plugins once after its first `Healthy` state and on explicit user request. Scanning is independent of automatic replacement. Automatic update is stored per plugin and defaults to off; old packages without `update` continue to load but are not scanned. Bundled packages are released with the Loader and never enter this flow.

The Release must use a stable `vMAJOR.MINOR.PATCH` tag and publish the versioned ZIP plus a same-name `.sha256` file containing exactly one matching SHA-256 record. The Loader follows only official GitHub HTTPS redirects, verifies the repository and tag, bounds downloads and extraction, rejects unsafe ZIP entries, and validates the complete candidate manifest before replacement.

Replacement is transactional under the registry mutation lock. The installed version and full package fingerprint are rechecked, the old directory becomes a temporary backup, the candidate is moved atomically, and only that plugin is reloaded. Every managed renderer must report the new lifecycle as running. Failure restores and reloads the previous package; a persisted journal completes recovery after an interrupted process.

New permissions or local changes always require an expiring confirmation bound to the candidate version, ZIP hash, installed fingerprint, and permission difference. Disabled plugins and enabled plugins without a renderer only report the available version. Downloads may be cancelled, but directory replacement must finish by commit or rollback.

## Lifecycle

```js
function cleanup(context) {
  // Remove every resource created by start(). Calling cleanup repeatedly is safe.
}

module.exports = {
  start(api, context) {
    // Create UI, observers, listeners, timers, and settings registrations.
    return () => cleanup({ reason: "cleanup" });
  },
  stop: cleanup,
};
```

The Loader owns enable, disable, and reload semantics:

- Enable evaluates fresh source and calls `start(api, { reason: "enable" })`.
- Disable calls `stop({ reason: "disable" })` and removes the runtime record.
- Reload calls `stop({ reason: "reload" })`, evaluates the latest package source, and calls `start(api, { reason: "reload" })`.
- Shutdown calls `stop({ reason: "shutdown" })` before closing the managed renderer when possible.

A separate plugin-defined reload function is intentionally not required. One Loader-owned `stop → fresh source → start` path makes reload deterministic and prevents custom reload logic from drifting away from enable/disable cleanup.

The Loader supports two adapters at this same lifecycle seam:

- A module-style entry exports `start(api, context)` and optionally `stop(context)` as shown above.
- A self-executing entry uses the injected `api` parameter directly and publishes a lifecycle object at the manifest's `lifecycleGlobal`. The object must provide `stop()`; the Loader captures and removes it during cleanup.

Plugins must not read `globalThis.__codexScriptLoader.activeApi` or other Loader runtime internals. Those properties are implementation details, while the injected `api` parameter is the supported interface.

`start` must be repeatable after `stop`. `stop` must clear timers, observers, event listeners, registered settings, inserted DOM, styles, pending asynchronous work, and exported lifecycle globals. A partial start failure must still expose enough cleanup for the Loader to remove what was created.

## Renderer API

- `api.id`, `api.version`, `api.manifest`, `api.process`, and `api.permissions`
- `api.log.info|warn|error`
- `api.storage.get|set|delete` with the `local-storage` permission
- `api.dom.ready()` and `api.dom.observe(...)` with the `dom` permission
- `api.events.on(...)`, which is automatically disposed with the plugin lifecycle
- `api.settings.registerPage(...)` and `api.settings.register(...)` with the `settings` permission

## Loopback WebSocket transport

`loopback-websocket` is a narrowly scoped local-transport capability for plugins
that need to exchange text messages with a separately running local service. It
is not a general network permission and does not expose the Loader's management
bridge or its CDP endpoint.

```js
if (api.localTransport) {
  const socket = await api.localTransport.openWebSocket("ws://127.0.0.1:43127/renderer");
  socket.addEventListener("message", event => handleMessage(event.data));
  socket.send("hello");
}
```

The endpoint is supplied by the plugin, but the host accepts only an exact
`ws://127.0.0.1:<port>/<safe-path>` URL. `localhost`, IPv6, other LAN
addresses, `wss:`, credentials, query strings, fragments, unsafe path
segments, the managed CDP port, and CDP paths such as `/devtools` and `/json`
are rejected. The transport is text-only: requests and frames are bounded to
64 KiB, inbound queues to 32 messages/256 KiB, connections to 8 per target and
32 in total, renderer binding dispatch work to 32 in-flight requests,
long-poll waits to 1 second, and binding requests to 5 seconds.
Closed connections retain their queued terminal events only briefly (up to 30
seconds) and are swept before a new connection consumes a connection slot.

Every binding request carries the plugin ID. Before opening or using a
connection, the host re-checks the current enabled descriptor and the
`loopback-websocket` permission. The transport uses a separate binding and
protocol from the management command allowlist; adding this permission does
not add management commands. Renderer content, endpoint contents, and secrets
are not written to Loader logs.

Connections and the renderer-side transport object are cleaned up on plugin
stop/reload/disable, target loss or replacement, Loader shutdown, and transport
reconnect. The native Windows host and the Node.js parity runtime implement the
same public seam and limits.

The settings host owns the Script-Loader navigation group, page shell, active state, cleanup, and unavailable/error placeholders. A plugin owns only the content it renders inside the provided root. A plugin that declares `settings.mode: "none"` must not register settings UI.

## Browser page companion

`browser-page-companion` lets a reviewed plugin ship one fixed companion bundle
for a Loader-allowlisted browser origin. The host retains target enumeration,
CDP ownership, bundle injection, and lifecycle cleanup; the renderer plugin sees
only four bounded calls.

```json
{
  "permissions": ["browser-page-companion"],
  "pageCompanion": {
    "id": "companion",
    "origin": "https://chatgpt.com",
    "main": "page-companion.js",
    "operations": ["probe", "bind", "send", "await", "unbind"]
  }
}
```

The manifest fixes the origin, package-relative bundle, and 1–16 operation
names. The current host allowlist contains only `https://chatgpt.com`. The
bundle must be a regular non-link file no larger than 512 KiB. `probe()` reports
only whether target selection is unique; `bind()` fails when zero or multiple
allowlisted targets exist; `invoke(operation, payload)` accepts only a declared
operation with a bounded serializable payload; and `unbind()` disposes the
session. Any main-frame navigation or reload, target loss/replacement, plugin
reload/disable, authorization change, or Loader shutdown ends the binding. A
fresh bind is required before another invocation.

The interface is business-neutral: plugins define their own fixed operation
names and bundle behavior, while Loader does not know their selectors, state
machines, messages, or response formats. Callers cannot provide a URL, selector,
JavaScript source, CDP method, target ID, cookie, or browser-profile path.

## Package management behavior

- Folder and ZIP installation are validated before the package enters the live registry.
- ZIP traversal paths, symbolic links, reparse points, oversized packages, unsafe entry paths, and duplicate manifests are rejected.
- New packages can be installed disabled for review or installed and enabled immediately.
- Third-party removal moves the package to quarantine so it can be restored.
- Bundled plugins can be disabled and reloaded but cannot be removed.
- A failed plugin remains visible with an error state and can be disabled, reloaded, or removed when it is not bundled.

## Acceptance checklist for plugin authors

- The manifest and documentation match the package behavior.
- `start` succeeds from a clean renderer and after a reload.
- `stop` is idempotent and leaves no duplicate DOM, styles, observers, listeners, timers, or settings entries.
- Enable, disable, targeted reload, full reload, and Loader shutdown preserve unrelated plugins.
- Settings use Codex theme tokens and remain usable with keyboard navigation, focus, light/dark themes, and Chinese/English UI where the plugin claims localization.
- Errors are logged without exposing secrets, credentials, user content, or private filesystem paths.
