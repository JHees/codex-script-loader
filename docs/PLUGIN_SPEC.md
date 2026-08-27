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
  "documentation": "README.md",
  "settings": {
    "mode": "page",
    "pageId": "main",
    "title": "Example settings"
  },
  "permissions": ["dom", "local-storage", "settings"]
}
```

- `schemaVersion` remains `1` for compatibility.
- `id`, `name`, `version`, `main`, `scope`, and `runAt` retain their existing meaning.
- `documentation` is a safe package-relative Markdown file. Current packages use `README.md`.
- `settings.mode` is `page` or `none`. A `page` declaration requires the `settings` permission. `pageId` defaults to `main`.
- Omitting `settings` or `documentation` is accepted only as legacy compatibility behavior.
- `permissions` are capabilities, not a security sandbox. Renderer plugins execute trusted local JavaScript in Codex and must be reviewed before enabling.

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

`start` must be repeatable after `stop`. `stop` must clear timers, observers, event listeners, registered settings, inserted DOM, styles, pending asynchronous work, and exported lifecycle globals. A partial start failure must still expose enough cleanup for the Loader to remove what was created.

## Renderer API

- `api.id`, `api.version`, `api.manifest`, `api.process`, and `api.permissions`
- `api.log.info|warn|error`
- `api.storage.get|set|delete` with the `local-storage` permission
- `api.dom.ready()` and `api.dom.observe(...)` with the `dom` permission
- `api.events.on(...)`, which is automatically disposed with the plugin lifecycle
- `api.settings.registerPage(...)` and `api.settings.register(...)` with the `settings` permission

The settings host owns the Script-Loader navigation group, page shell, active state, cleanup, and unavailable/error placeholders. A plugin owns only the content it renders inside the provided root. A plugin that declares `settings.mode: "none"` must not register settings UI.

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
