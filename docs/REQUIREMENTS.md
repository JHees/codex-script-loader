# Requirements

## Included in the current milestone

- Windows Microsoft Store Codex discovery and managed random loopback CDP startup.
- macOS platform adapter kept compatible with the renderer runtime contract.
- Compatible-v1 `manifest.json + index.js` plugin packages with documentation,
  lifecycle hooks, and an explicit settings capability.
- Deterministic start, stop, enable, disable, targeted/full reload, removal,
  quarantine, and restore behavior.
- One `Script-Loader` section in Codex Settings: Loader-owned `Settings` first,
  followed by each plugin-declared settings page.
- Plugin management from Settings: folder/ZIP install preview, enable/disable,
  status, reload, remove, quarantine restore, and managed Codex restart.
- Bennett UI Improvements as the sole bundled reference plugin.
- Native `.NET WinExe` as the Windows production host; Node.js remains the
  development and parity-validation implementation.

## Explicitly excluded

- Account switching and OAuth storage.
- Responses API providers or a local API proxy.
- MCP and Skills management.
- CC Switch import.
- Usage aggregation or automatic account routing.
- A separate external Loader control center or floating renderer buttons.
- Modifying, unpacking, copying, or re-signing the official Codex app.
- Downloading plugins from a remote marketplace.

## Acceptance

- Repeated or targeted injection stops the previous plugin lifecycle and creates
  no duplicate settings entry, styles, menu handlers, or observers.
- Reload results report the number of requested plugins and managed renderer
  targets, plus explicit success and failure IDs.
- Bennett UI retains its feature toggles and opens directly below the Loader
  Settings entry under `Script-Loader`.
- Disabling a plugin removes its live contribution while retaining a placeholder
  for a declared settings page; re-enabling starts it again.
- Built-in plugins cannot be deleted or replaced through package management.
- Folder and ZIP installation rejects traversal paths, links/reparse points,
  oversized packages, and invalid manifests before committing files.
- Restart closes and reactivates only the Codex instance managed by the Loader;
  it keeps the Loader process and settings architecture intact.
- No Bennett or Loader floating action button is present.
