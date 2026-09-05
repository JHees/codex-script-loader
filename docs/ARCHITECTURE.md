# Architecture

Codex Script Loader is a small renderer-plugin sidecar. It does not modify the
Microsoft Store package, `app.asar`, Codex authentication, model providers, MCP
configuration, existing user skills, projects, or conversations. An optional
schema-v2 package can expose its own bundled skill through a Loader-managed
entry in the current user's skill discovery directory.

## Bundled skill ownership

A native plugin package may declare one `agentSkill` with the `agent-skills`
permission. The skill source stays inside that package; a Windows directory
junction exposes it under the user's `.agents/skills` directory. There is no
second content copy or separate skill installer. Package installation, enable,
disable, update, rollback, quarantine, and restore also manage this owned entry.
An ownership ledger and exact target checks protect unrelated user content.
Startup recovery uses the existing package update journal before reconciling
links; explicit reload also reconciles effective enabled state. See
[the package contract](PLUGIN_SPEC.md#optional-bundled-agent-skill-schema-v2-native-windows).

## Runtime

GitHub URL installation is a native Settings entry into the existing package
installer, not a second registry. A fixed public GitHub Release metadata request
discovers ZIP/checksum pairs; bounded HTTPS downloads and SHA-256 verification
precede a normal pending-package preview. The manifest must match the requested
release identity. Confirmation uses the same replacement and rollback path as
local ZIP installation, including bundled skill ownership. New installations
are registered with the existing per-plugin updater without enabling automatic
updates. Node parity exposes a clear native-host requirement for this command.

1. The native Windows host discovers and activates the official Microsoft Store
   Codex package with a random loopback-only CDP port.
2. The supervisor accepts only the exact `app://-/index.html` renderer owned by
   the Codex package process it launched.
3. The registry validates enabled `manifest.json + index.js` packages and builds
   an injection plan.
4. The renderer runtime stops replaced instances with a lifecycle reason before
   starting the new instance. Targeted reload replaces only the selected plugin.
5. A persistent CDP binding exposes the allowlisted management operations to the
   exact managed renderer. It does not open another listening port.
6. The settings host mounts one `Script-Loader` group: the Loader-owned
   `Settings` page first, followed by every plugin-declared settings page.

The optional renderer loopback transport is a separate host module and binding.
It shares an already-authorized CDP session only as a carrier; it does not
reuse the management command protocol or expand `ALLOWED_COMMANDS`. A plugin
must explicitly declare the `loopback-websocket` permission before the
injected API includes `localTransport.openWebSocket(endpoint)`. The native
Windows host and Node.js parity runtime both re-check that permission against
the current enabled descriptor on every binding request.

The optional page-companion host is another independent capability module. A
plugin with `browser-page-companion` declares a fixed allowlisted origin,
package bundle, and operation allowlist. Loader alone enumerates and binds the
browser target, injects the reviewed bundle, and drops its session on every
main-frame navigation, reload, target loss, or plugin lifecycle transition.
The renderer receives no CDP endpoint and cannot submit arbitrary URLs,
selectors, scripts, methods, cookies, or profile reads.

## Management boundary

The native host owns package installation, deletion, enable/disable state,
quarantine, reload, and managed Codex restart. Folder and ZIP installation is
staged and validated before it is committed. Built-in packages cannot be
removed or replaced from the settings UI.

`PluginUpdateManager` is a deep native module behind that management boundary.
Its public surface scans plugins, stores per-plugin automatic-update preferences,
starts or confirms an update, cancels a download, and returns snapshots. GitHub
redirects, system-`curl.exe` transport, checksum and ZIP verification, package
fingerprints, permission comparison, confirmation tokens, registry locking,
transaction journals, rollback, and targeted lifecycle verification stay inside
the module. A fixture transport keeps automated tests independent of GitHub.

The renderer bridge is private Loader infrastructure, not part of the plugin
API. It validates the command allowlist and payload shape. Results are serialized
with stable camel-case fields, including actual reload counts and failures.

## Local transport boundary

`LoopbackTransportHost` validates plugin-provided endpoints as exact
`ws://127.0.0.1:<port>/<safe-path>` URLs. It rejects non-loopback hosts,
IPv6, `localhost`, `wss:`, credentials, query/fragment components, unsafe
paths, CDP paths, and the managed CDP port. The host applies bounded text
frames, queues, connections, in-flight binding dispatches, long-poll waits, and
request timeouts. It does
not expose a CDP discovery endpoint and does not log transport content or
secrets.

The binding protocol carries the plugin ID in every operation and returns only
sanitized errors. Target replacement/drop, authorization changes, plugin
disable/reload, reconnect, shutdown, and startup failure dispose connection
state and remove the independent binding. The renderer client buffers events
that arrive before a plugin installs its `onmessage`/listener callback, so an
immediate server frame cannot be lost during `openWebSocket()` setup.

## Plugin contract

A compatible package declares its documentation, settings capability, required
permissions, and entry point. The entry module exposes lifecycle hooks. The
Loader supplies `enable`, `disable`, `reload`, and `shutdown` reasons when it
starts or stops the plugin.

The renderer API currently exposes:

- `api.log`
- `api.storage` for package-scoped local settings
- `api.dom.ready()` and `api.dom.observe(...)`
- `api.events.on(...)`
- `api.settings.registerPage(...)` and `api.settings.register(...)`
- `api.localTransport.openWebSocket(...)` when `loopback-websocket` is declared
- `api.pageCompanion.probe|bind|invoke|unbind` when a fixed page companion is declared

The settings host owns navigation, active-page state, mounting, and cleanup.
Plugins own only their page contents. See [Plugin Design Specification](PLUGIN_SPEC.md)
for the complete compatible-v1 contract.

## Bundled package

The sole bundled package is the Loader-owned Example UI Plugin. It is a concrete
adapter at the renderer plugin package seam and exists only to demonstrate the
public manifest, permission, settings, storage, and lifecycle interface.

Third-party plugin repositories are independent. The Loader does not vendor,
mirror, synchronize, test, version, or release their implementations. Users
install third-party release artifacts through package management. An optional
manifest update declaration lets the native host consume a repository's own
stable GitHub Release assets without copying its source into this repository.

## Windows entry

The production entry is the native `.NET WinExe` under
`windows/src/CodexScriptLoader.Windows`. The Node.js loader remains a development
and parity-validation path; the legacy `.cmd` launcher is not the Windows v0.3
production entry.
