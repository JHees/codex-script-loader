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
- Optional public GitHub Release discovery for update-aware third-party plugins,
  with per-plugin automatic replacement disabled by default, mandatory ZIP
  checksum verification, explicit permission/local-change confirmation, atomic
  replacement, targeted lifecycle verification, and crash recovery.
- A Loader-owned example UI plugin as the sole bundled reference adapter.
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
- Remote marketplace discovery, catalog browsing, private repositories, tokens,
  GitHub Enterprise, prereleases, drafts, and ordinary Git tags.

## Acceptance

- Repeated or targeted injection stops the previous plugin lifecycle and creates
  no duplicate settings entry, styles, menu handlers, or observers.
- Reload results report the number of requested plugins and managed renderer
  targets, plus explicit success and failure IDs.
- Plugin-declared settings pages open below the Loader Settings entry under
  `Script-Loader` without any plugin-specific Loader code.
- Disabling a plugin removes its live contribution while retaining a placeholder
  for a declared settings page; re-enabling starts it again.
- Built-in plugins cannot be deleted or replaced through package management.
- Folder and ZIP installation rejects traversal paths, links/reparse points,
  oversized packages, and invalid manifests before committing files.
- Plugin update failures stay isolated to the affected plugin. Replacement
  failure restores and reloads the previous package; only a failed recovery may
  degrade the Loader.
- Restart closes and reactivates only the Codex instance managed by the Loader;
  it keeps the Loader process and settings architecture intact.
- The Loader itself adds no floating action button; the example badge remains
  disabled unless a user explicitly enables it from the example settings page.
