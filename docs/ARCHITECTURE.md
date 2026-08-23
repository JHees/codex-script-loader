# Architecture

Codex Script Loader is a small renderer-plugin sidecar. It does not modify the
Microsoft Store package, `app.asar`, Codex authentication, model providers, MCP
configuration, skills, projects, or conversations.

## Runtime

1. The launcher starts the official Codex executable with a loopback-only CDP
   port.
2. The supervisor accepts only the exact `app://-/index.html` page target.
3. The registry builds an injection plan from enabled `manifest.json + index.js`
   packages.
4. The renderer runtime stops replaced plugin instances before starting their
   new version.
5. A persistent CDP binding exposes only Loader status and live script reload
   to the exact managed renderer; it does not open another listening port.
6. The settings host mounts the built-in `Loader` page first and registered
   plugin pages under a separate `Tweaks` group.

## Plugin contract

A package manifest declares `id`, `name`, `version`, `main`, and permissions.
The entry module may export `start(api)` and `stop()`.

The renderer API currently exposes:

- `api.log`
- `api.storage` for package-scoped local settings
- `api.dom.ready()` and `api.dom.observe(...)`
- `api.events.on(...)`
- `api.settings.registerPage(...)` and `api.settings.register(...)`

The settings host owns navigation, active-page state, mounting, and cleanup.
Its built-in page survives plugin reloads and safe mode. Plugins own only their
page contents. The binding is not part of the plugin API and rejects every
command except status and live script reload.

## Bundled package

The only bundled package is Bennett UI Improvements 1.4.2. Its canonical source
remains in the adjacent Bennett repository and is copied mechanically into the
loader package and development runtime.

## Windows entry

`Start Codex with Loader.cmd` runs the readable Node launcher directly. No
generated native executable, encoded PowerShell command, or dynamic C# compiler
is part of the startup path.
