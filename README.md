<div align="center">

<img src="windows/branding/CodexScriptLoader-master.png" alt="Codex Script Loader icon" width="160" />

# Codex Script Loader

**Open Codex for user scripts, with automatic injection, reload, and cleanup.**

[![Version](https://img.shields.io/badge/version-0.4.1-f97316)](https://github.com/JHees/codex-script-loader)
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
| Bennett UI included | Installs the bundled Bennett UI Improvements 1.4.10 package on first run. |
| Windows packaging | Produces x64 or arm64 self-contained builds and MSIX packages. |

## Requirements

- Windows 11 x64 or arm64 with the Microsoft Store Codex app.
- macOS with `Codex.app` in `/Applications` or `~/Applications` and Node.js 22 or newer (untested).
- Windows source builds require .NET 10 SDK and Windows SDK 10.0.26100 or newer.

Close any running Codex instance before starting the Loader. For a managed session, launch Codex through the Loader.

## Install and run

The repository currently ships source builds. Signed per-user MSIX and `.appinstaller` packages will be published on [GitHub Releases](https://github.com/JHees/codex-script-loader/releases).

### Build from source

```powershell
git clone https://github.com/JHees/codex-script-loader.git
Set-Location .\codex-script-loader
.\windows\scripts\package.ps1 -RuntimeIdentifier win-x64
```

Use `win-arm64` instead on Windows on Arm. Packaging clears the repository-level `bin` directory first and leaves only the latest architecture and version:

```text
bin/
├── app/CodexScriptLoader.exe
├── layout/
├── CodexScriptLoader-0.4.1.0-x64.msix
├── CodexScriptLoader-x64.appinstaller
├── CodexScriptLoader-0.4.1.0-x64.spdx.json
└── SHA256SUMS.txt
```

Run `bin\app\CodexScriptLoader.exe` to use the unpackaged self-contained build. Installing a locally generated MSIX requires a trusted development certificate.

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
5. Bennett UI and other enabled scripts start inside the renderer.
6. When the managed Codex process exits, the Loader releases its connections and exits automatically.

Start the Loader executable a second time to open diagnostics. To reload installed scripts without focusing or refreshing Codex, run the same compatible executable as a second instance:

```powershell
& .\bin\app\CodexScriptLoader.exe --reload
```

## Windows architecture

```text
User
  └─ CodexScriptLoader.exe (WinExe, single instance)
       ├─ Windows package APIs ──> Microsoft Store Codex
       ├─ random loopback CDP ───> verified Codex renderer
       ├─ script registry ───────> manifest / permissions / SHA-256
       └─ lifecycle supervisor ──> inject / reload / cleanup / exit
```

Production data lives under:

```text
%LOCALAPPDATA%\CodexScriptLoader\
├── config.json
├── scripts\
├── quarantine\
├── logs\
└── state\
```

Logs use UTF-8 JSON Lines. Diagnostic exports redact user-specific paths and unrelated command-line details.

The Windows host uses official package APIs to start Codex, keeps CDP on a random loopback port, and verifies the owning process and exact renderer target before injection. Codex application files remain untouched, and the launch path needs neither `WindowsApps` access nor administrator privileges.

## Script packages

Installed plugins are managed under **Codex Settings → Script-Loader → Settings**. The page shows live status, supports enable/disable, targeted or full reload, local folder/ZIP installation, quarantine and restore, and a controlled Codex restart. Plugins that declare a settings page appear directly below the Settings entry.

The complete authoring and lifecycle contract is documented in [`docs/PLUGIN_SPEC.md`](docs/PLUGIN_SPEC.md).

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

The bundled [Bennett UI Improvements](packages/bennett-ui-improvements) package is the reference implementation. Its manifest, permission, SHA-256, attribution, and lifecycle semantics are preserved.

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

See [`windows/README.md`](windows/README.md) for signing, MSIX, App Installer, and release-gate details.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `windows/src/CodexScriptLoader.Core` | Configuration, manifests, permissions, hashes, quarantine, and injection plans. |
| `windows/src/CodexScriptLoader.Interop` | Windows package, activation, process identity, and TCP owner APIs. |
| `windows/src/CodexScriptLoader.Windows` | WinForms background host, CDP, lifecycle supervision, diagnostics, and single instance. |
| `windows/packaging` | MSIX and App Installer templates and image assets. |
| `windows/scripts` | Build-time packaging, icon generation, validation, and reproducibility tools. |
| `packages/bennett-ui-improvements` | Bundled, attributed Bennett UI package. |
| `src` | Legacy Node development/parity implementation; not the Windows production entry point. |

## Troubleshooting

- **“Codex is already running”** — close all Codex windows, wait for its process to exit, and start the Loader again.
- **Loader starts but no window appears** — this is expected. Start it a second time to open diagnostics.
- **A script is degraded** — inspect diagnostics and `%LOCALAPPDATA%\CodexScriptLoader\logs`, then correct the manifest, permission, or lifecycle error.
- **A local MSIX will not install** — install the development certificate or run the unpackaged build from `bin\app`.
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

- Bundled plugin: [Better UI Improvements for Codex](https://github.com/JHees/better-ui-improvements-for-codex), with the Bennett package identity, original authorship, and MIT notices preserved. Codex++ support ended at the market-published `1.2.4`; current builds target this Loader.
- Bennett upstream: [b-nnett/codex-plusplus-bennett-ui](https://github.com/b-nnett/codex-plusplus-bennett-ui).
- Editorial icon method: [ZzzLc0405/photo-abstract-editorial](https://github.com/ZzzLc0405/photo-abstract-editorial).

Loader code is released under the [MIT License](LICENSE). Bundled third-party code remains under its included license and notices. Adapted assets under `windows/branding` are excluded from the MIT code license and remain subject to the non-commercial restrictions documented in [`windows/branding/README.md`](windows/branding/README.md); obtain the original author's authorization before commercial distribution of those assets.
