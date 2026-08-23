# Requirements

## Included in the current milestone

- Windows Microsoft Store Codex discovery and managed loopback CDP startup.
- macOS platform adapter kept compatible with the same runtime contract.
- `manifest.json + index.js` plugin packages.
- Deterministic start, stop, enable, disable, reload, and quarantine behavior.
- Loader-owned `Loader` runtime page followed by a separate `Tweaks` section
  inside Codex Settings.
- Bennett UI Improvements 1.4.2 as the sole bundled plugin.
- A transparent `.cmd` launcher using Node.js 22 or newer.

## Explicitly excluded

- Account switching and OAuth storage.
- Responses API providers or a local API proxy.
- MCP and Skills management.
- CC Switch import.
- Usage aggregation or automatic account routing.
- A separate external Loader control center or floating renderer buttons.
- Modifying, unpacking, copying, or re-signing the official Codex app.

## Acceptance

- Repeated injection stops the previous plugin lifecycle and creates no duplicate
  settings entry, styles, menu handlers, or observers.
- Bennett UI reports lifecycle version 1.4.2 and retains its 11 feature toggles.
- The Bennett page opens from Codex Settings under `Tweaks`.
- No Bennett or Loader floating action button is present.
- The launcher contains no PowerShell or generated executable step.
