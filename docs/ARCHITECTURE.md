# Architecture

Codex Script Loader is a small renderer-plugin sidecar. It does not modify the
Microsoft Store package, `app.asar`, Codex authentication, model providers, MCP
configuration, skills, projects, or conversations.

## Runtime

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

## Management boundary

The native host owns package installation, deletion, enable/disable state,
quarantine, reload, and managed Codex restart. Folder and ZIP installation is
staged and validated before it is committed. Built-in packages cannot be
removed or replaced from the settings UI.

The renderer bridge is private Loader infrastructure, not part of the plugin
API. It validates the command allowlist and payload shape. Results are serialized
with stable camel-case fields, including actual reload counts and failures.

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

The settings host owns navigation, active-page state, mounting, and cleanup.
Plugins own only their page contents. See [Plugin Design Specification](PLUGIN_SPEC.md)
for the complete compatible-v1 contract.

## Bundled package

The sole bundled package is Bennett UI Improvements. Its canonical source stays
in the adjacent Bennett repository and is copied mechanically into this package.
The bundled manifest and README provide the reference metadata and settings-page
declaration.

## Windows entry

The production entry is the native `.NET WinExe` under
`windows/src/CodexScriptLoader.Windows`. The Node.js loader remains a development
and parity-validation path; the legacy `.cmd` launcher is not the Windows v0.3
production entry.
