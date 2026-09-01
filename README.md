<div align="center">

<img src="windows/branding/CodexScriptLoader-master.png" alt="Codex Script Loader icon" width="160" />

# Codex Script Loader

**Open Codex for user scripts, with automatic injection, reload, and cleanup.**

[![Version](https://img.shields.io/badge/version-0.5.8-f97316)](https://github.com/JHees/codex-script-loader)
[![Windows](https://img.shields.io/badge/Windows-11-0078d4?logo=windows11)](#requirements)
[![macOS](https://img.shields.io/badge/macOS-untested-999999?logo=apple)](#platform-support)
[![.NET](https://img.shields.io/badge/.NET-10-512bd4?logo=dotnet)](global.json)
[![Windows Loader](https://github.com/JHees/codex-script-loader/actions/workflows/windows-loader.yml/badge.svg)](https://github.com/JHees/codex-script-loader/actions/workflows/windows-loader.yml)
[![License](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

</div>

Codex Script Loader starts Codex with a local Chrome DevTools Protocol (CDP) debugging endpoint and loads user-installed renderer scripts. It manages the full script lifecycle automatically: discovery, manifest and hash validation, permission setup, injection into current and future documents, in-place reload, cleanup, and shutdown with Codex.

Windows uses the native .NET 10 background host with no console or tray icon and is the tested primary platform. macOS uses the Node.js live runtime; the implementation is available but has not yet been tested on macOS hardware.

## Highlights

| Area | What it provides |
| --- | --- |
| Debug-enabled launch | Opens Codex with a local debugging endpoint ready for renderer scripts. |
| User scripts | Loads `manifest.json + index.js` packages from the Loader data directory. |
| Automatic lifecycle | Validates, injects, reloads, replaces, and cleans up scripts across renderer documents. |
| Native Windows host | Runs quietly with Codex and exits when the Codex instance it launched closes. |
| macOS runtime | Discovers `Codex.app` and provides the same managed CDP/script flow through Node.js; currently untested. |
| Diagnostics and reload | Starting a second Windows instance opens diagnostics; `--reload` replaces scripts in place. |
| Online host updates | Checks the stable GitHub Release after startup and switches verified Loader hosts without restarting Codex. |
| Plugin release updates | Scans update-aware public GitHub plugins, then verifies and atomically reloads an opted-in update per plugin. |
| Example plugin included | Installs a small Loader-owned UI plugin that demonstrates the package contract. |
| Windows packaging | Produces per-user NSIS setup executables and portable ZIP archives for x64 and arm64. |

## Requirements

- Windows 11 x64 or arm64 with the Microsoft Store Codex app.
- macOS with `Codex.app` in `/Applications` or `~/Applications` and Node.js 22 or newer (untested).
- Windows source builds require .NET 10 SDK, Windows SDK 10.0.26100 or newer, and the Visual Studio C++ desktop build tools. Cross-publishing `win-arm64` also requires `Microsoft.VisualStudio.Component.VC.Tools.ARM64`.

Close any running Codex instance before starting the Loader. For a managed session, launch Codex through the Loader.

## Install and run

Download the matching NSIS installer from [GitHub Releases](https://github.com/JHees/codex-script-loader/releases). Its standard setup wizard lets you choose the installation folder and Start menu folder before installation begins. It creates desktop and Start menu shortcuts, installs for the current user, appears in Windows Installed apps, and requires no administrator access. A portable ZIP is published beside each installer.

Version 0.5.0 is the one-time installer migration from the older flat 0.4.x layout. Starting with 0.5.1, standard NSIS installations can update the versioned host from **Codex Settings → Script-Loader → Settings** while Codex and the current task stay open. Portable copies remain manual-update only.

Version 0.5.2 isolates update errors inside the update card and uses the Windows system `curl.exe` to resolve the latest stable GitHub Release and download its assets directly. It does not use the GitHub API or CLI credentials. The transport is restricted to HTTPS and official GitHub download hosts and remains subject to size, SHA-256, archive, manifest, and per-file verification.

Version 0.5.3 adds opt-in, per-plugin GitHub Release updates. Update-aware third-party plugins are scanned independently, downloaded through the same restricted transport, verified against a required `.sha256` asset, replaced transactionally, and reloaded in place. The Loader-owned example plugin remains bundled and is not part of the third-party update flow.

### Build from source

```powershell
git clone https://github.com/JHees/codex-script-loader.git
Set-Location .\codex-script-loader
.\windows\scripts\package.ps1 -RuntimeIdentifier win-x64
```

Use `win-arm64` instead on Windows on Arm. Packaging clears only generated files in the repository-level `build` directory and leaves the latest architecture and version there. It does not touch `bin`:

```text
build/
├── README.md
├── app/CodexScriptLoader.exe                 # stable NativeAOT launcher
├── app/active.json
├── app/previous.json
├── app/update-manifest.json
├── app/versions/0.5.8/win-x64/               # complete Loader host
├── CodexScriptLoader-0.5.8-windows-x64-setup.exe
├── CodexScriptLoader-0.5.8-windows-x64-setup.exe.sha256
├── CodexScriptLoader-0.5.8-windows-x64.zip
├── CodexScriptLoader-0.5.8-windows-x64.zip.sha256
└── CodexScriptLoader-0.5.8-x64.spdx.json
```

The setup executable at the top of `build` is the normal local installation entry. The `build\app` directory is packaging payload, not the recommended launch path. The installer keeps scripts and settings under `%LOCALAPPDATA%\CodexScriptLoader` when upgrading or uninstalling.

### macOS live runtime (untested)

```bash
git clone https://github.com/JHees/codex-script-loader.git
cd codex-script-loader
node src/cli.mjs run --live
```

The macOS runtime discovers `Codex.app`, starts it with a random loopback CDP port, loads the same script package format, and stays in the terminal while supervising the session. Its data directory is `~/Library/Application Support/codex-script-loader`.

### Windows runtime

1. The Loader validates its data directory and installed script manifests.
2. It finds the Store Codex package and actual AUMID without reading `C:\Program Files\WindowsApps`.
3. It activates Codex with a random loopback CDP port.
4. It verifies the listener PID, package family, and exact renderer URL before injection.
5. Enabled renderer plugins start through the same manifest and lifecycle contract.
6. When the managed Codex process exits, the Loader releases its connections and exits automatically.

Start the Loader executable a second time to open diagnostics. To reload installed scripts without focusing or refreshing Codex, run the same compatible executable as a second instance:

```powershell
& "$env:LOCALAPPDATA\Programs\CodexScriptLoader\CodexScriptLoader.exe" --reload
```

## Windows architecture

```text
User
  └─ CodexScriptLoader.exe (stable NativeAOT launcher)
       └─ versions/<version>/<rid>/CodexScriptLoader.exe
            ├─ Windows package APIs ──> Microsoft Store Codex
            ├─ random loopback CDP ───> verified Codex renderer
            ├─ script registry ───────> manifest / permissions / SHA-256
            └─ lifecycle supervisor ──> inject / reload / host handoff / cleanup
```

Production data lives under:

```text
%LOCALAPPDATA%\CodexScriptLoader\
├── config.json
├── update-preferences.json
├── scripts\
├── quarantine\
├── logs\
└── state\
```

Logs use UTF-8 JSON Lines. Diagnostic exports redact user-specific paths and unrelated command-line details.

The Windows host uses official package APIs to start Codex, keeps CDP on a random loopback port, and verifies the owning process and exact renderer target before injection. Codex application files remain untouched, and the launch path needs neither `WindowsApps` access nor administrator privileges.

Online updates are fixed to the stable releases of `JHees/codex-script-loader`. The Loader follows the repository's `releases/latest` redirect with the Windows system `curl.exe`, constructs only the expected versioned asset names, and never calls the GitHub API. It verifies the tag, asset name, architecture, declared response size, official HTTPS download host, the archive's matching `.sha256` asset, safe ZIP structure, update protocol, and every payload file hash before staging. This GitHub Release + SHA-256 model detects corruption and mismatched assets, but it cannot protect against a release and its checksum file being replaced together; independent signing and Authenticode remain future hardening work.

## Script packages

Installed plugins are managed under **Codex Settings → Script-Loader → Settings**. The page shows live status, supports enable/disable, targeted or full reload, local folder/ZIP installation, quarantine and restore, update checks, and a controlled Codex restart. Plugins that declare a settings page appear directly below the Settings entry.

Third-party packages may optionally declare their own public GitHub Release source. The native Windows host scans those declarations once after becoming healthy and when requested from Settings. Per-plugin automatic replacement defaults to off. Updates require a stable `vMAJOR.MINOR.PATCH` Release, a versioned ZIP, and its exact same-name `.sha256` asset. Added permissions and local package changes require confirmation; disabled plugins and enabled plugins without a renderer are never replaced. This feature does not create a marketplace or couple third-party source and release work to the Loader repository.

The complete authoring and lifecycle contract is documented in [`docs/PLUGIN_SPEC.md`](docs/PLUGIN_SPEC.md).
The versioned layout, release verification, and no-Codex-restart handoff are documented in [`docs/UPDATE_PROTOCOL.md`](docs/UPDATE_PROTOCOL.md).

A renderer package contains `manifest.json` and an entry script:

```json
{
  "schemaVersion": 1,
  "id": "local.example",
  "name": "Example",
  "version": "1.0.0",
  "main": "index.js",
  "scope": "renderer",
  "runAt": "document-end",
  "permissions": ["dom", "local-storage", "settings"]
}
```

```js
module.exports = {
  start(api) {
    const page = api.settings.registerPage({
      id: "main",
      title: "Example",
      render(root) {
        root.textContent = "Hello from Codex Script Loader";
      },
    });

    return () => page.unregister();
  },
};
```

### Optional loopback WebSocket transport

The `loopback-websocket` manifest permission is an explicit capability opt-in.
Only a package that declares it receives `api.localTransport.openWebSocket(endpoint)`;
packages without it have no `localTransport` property and keep the existing API
shape. Permissions are capability declarations for trusted local JavaScript, not
a security sandbox, so review a plugin before enabling it.

```json
{ "permissions": ["dom", "loopback-websocket"] }
```

```js
const socket = await api.localTransport.openWebSocket(
  "ws://127.0.0.1:43127/renderer",
);
socket.addEventListener("message", event => handleMessage(event.data));
socket.send("hello");
```

The host accepts only an exact `ws://127.0.0.1:<port>/<safe-path>` endpoint. It
rejects `localhost`, IPv6, LAN addresses, `wss:`, credentials, query strings,
fragments, unsafe paths, CDP paths, and the managed CDP port. The transport is
text-only and bounded to 64 KiB frames, 32 messages/256 KiB per inbound queue,
8 connections per target, 32 connections total, 32 in-flight binding dispatches,
1-second polls, and 5-second binding requests; closed connections are retained
only briefly (up to 30 seconds)
to drain terminal events. Every request carries the plugin ID and the host
re-checks the current enabled descriptor and permission. Invalid or unauthorized
requests fail closed with sanitized errors; transport content, endpoints, and
secrets are not logged and the CDP endpoint is never exposed.

The transport uses its own binding and protocol, separate from the Loader
management bridge. It does not change any existing management command or
behavior and contains no Bridge-specific ID, path, or protocol. Connections are
cleaned up on plugin stop/reload/disable, target drop or replacement, reconnect,
and Loader shutdown. Native Windows and Node.js runtimes implement the same
public seam and limits.

### Optional browser page companion

The `browser-page-companion` permission is a narrow host-owned browser seam.
The manifest fixes an allowlisted origin, a package-relative companion bundle,
and a small operation allowlist. Loader selects a unique matching page target,
injects only that installed bundle, and exposes `api.pageCompanion.probe()`,
`bind()`, `invoke(operation, payload)`, and `unbind()` to the renderer plugin.
It never exposes CDP, arbitrary targets, URLs, selectors, scripts, cookies, or
browser profiles. Any top-level navigation or reload ends the binding and
requires a fresh bind. See the [Plugin Specification](docs/PLUGIN_SPEC.md) for
the complete contract.

The bundled [Example UI Plugin](packages/example-ui-plugin) is the reference adapter for the plugin package interface. It is owned and versioned by this repository and demonstrates manifest permissions, settings registration, Loader-scoped storage, reversible DOM changes, and lifecycle cleanup.

Third-party plugins are independent projects. Their source, tests, versions, releases, and deployment instructions stay in their own repositories. Loader development never requires copying or synchronizing third-party source into this repository; install a released folder or ZIP through Settings instead.

To add a custom package on Windows, place its directory under `%LOCALAPPDATA%\CodexScriptLoader\scripts\<script-id>` and run `CodexScriptLoader.exe --reload`. With the Node.js runtime, install a package or a single `.js` file with:

```bash
node src/cli.mjs install /path/to/script --enable
```

## Development

The repository pins the .NET SDK in [`global.json`](global.json), locks NuGet dependencies, treats warnings as errors, and enables deterministic builds.

```powershell
# Native build and tests
dotnet build .\windows\CodexScriptLoader.Windows.sln -c Release --configfile .\NuGet.Config
dotnet run --project .\windows\tests\CodexScriptLoader.Tests\CodexScriptLoader.Tests.csproj -c Release

# Node compatibility and parity checks
npm run check
npm test

# Reproducible pre-sign payload verification
.\windows\scripts\verify-reproducible.ps1 -RuntimeIdentifier win-x64
.\windows\scripts\verify-reproducible.ps1 -RuntimeIdentifier win-arm64
```

Run the development-only [`ActivationProbe`](windows/tools/ActivationProbe) with Codex completely closed. A passing probe discovers the real application ID, activates Codex with CDP arguments, verifies listener ownership, and reports `ACTIVATION_PASS`.

See [`windows/README.md`](windows/README.md) for NSIS, portable ZIP, optional signing, and release-gate details.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `windows/src/CodexScriptLoader.Core` | Configuration, manifests, permissions, hashes, quarantine, and injection plans. |
| `windows/src/CodexScriptLoader.Interop` | Windows package, activation, process identity, and TCP owner APIs. |
| `windows/src/CodexScriptLoader.Launcher` | Stable NativeAOT launcher, health check, active-version selection, and fallback. |
| `windows/src/CodexScriptLoader.Windows` | WinForms background host, CDP, lifecycle supervision, diagnostics, and single instance. |
| `windows/packaging` | NSIS installer definition and Windows image assets. |
| `windows/scripts` | Build-time packaging, icon generation, validation, and reproducibility tools. |
| `packages/example-ui-plugin` | Loader-owned reference adapter for the renderer plugin package interface. |
| `src` | Legacy Node development/parity implementation; not the Windows production entry point. |

## Troubleshooting

- **“Codex is already running”** — close all Codex windows, wait for its process to exit, and start the Loader again.
- **Loader starts but no window appears** — this is expected. Start it a second time to open diagnostics.
- **A script is degraded** — inspect diagnostics and `%LOCALAPPDATA%\CodexScriptLoader\logs`, then correct the manifest, permission, or lifecycle error.
- **Setup cannot replace a running Loader** — exit the managed Codex session and Loader, then run setup again. The installer never force-terminates either process.
- **A Codex update breaks activation** — close Codex and run Activation Probe to capture the package and CDP diagnostics.

## Platform support

| Platform | Runtime | Status |
| --- | --- | --- |
| Windows 11 x64/arm64 | Native .NET 10 background host | Tested and packaged |
| macOS | Node.js 22 live runtime | Implemented, not yet tested on macOS hardware |

Codex updates may require Loader or script compatibility changes. This independent project is not affiliated with OpenAI or Microsoft.

## Contributing

Issues and focused pull requests are welcome. For setup, architecture, testing, and packaging details, see [`windows/README.md`](windows/README.md).

## Credits and license

- Editorial icon method: [ZzzLc0405/photo-abstract-editorial](https://github.com/ZzzLc0405/photo-abstract-editorial).

Loader code and the bundled example are released under the [MIT License](LICENSE). Third-party plugins retain their own licenses outside this repository. Adapted assets under `windows/branding` are excluded from the MIT code license and remain subject to the non-commercial restrictions documented in [`windows/branding/README.md`](windows/branding/README.md); obtain the original author's authorization before commercial distribution of those assets.
