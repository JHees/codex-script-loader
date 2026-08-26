<div align="center">

<img src="windows/branding/CodexScriptLoader-master.png" alt="Codex Script Loader icon" width="160" />

# Codex Script Loader

**A native, no-console script loader for Microsoft Store Codex on Windows.**

[![Version](https://img.shields.io/badge/version-0.3.0-f97316)](https://github.com/JHees/codex-script-loader)
[![Windows](https://img.shields.io/badge/Windows-11-0078d4?logo=windows11)](#requirements)
[![.NET](https://img.shields.io/badge/.NET-10-512bd4?logo=dotnet)](global.json)
[![Windows Loader](https://github.com/JHees/codex-script-loader/actions/workflows/windows-loader.yml/badge.svg)](https://github.com/JHees/codex-script-loader/actions/workflows/windows-loader.yml)
[![License](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

</div>

Codex Script Loader launches the official Microsoft Store build of Codex with a random loopback Chrome DevTools Protocol (CDP) endpoint, verifies the endpoint owner, and loads explicitly installed renderer scripts. It does not modify `app.asar`, copy or re-sign Codex, enumerate `WindowsApps`, or require administrator privileges.

Version 0.3 is a background .NET 10 `WinExe`: there is no console window and no tray icon. It starts with Codex, supervises the renderer, and exits after the Codex instance it launched closes.

## Highlights

| Area | What it provides |
| --- | --- |
| Native launch | Discovers the current user's Store package and activates its real AUMID through Windows package APIs. |
| Verified CDP | Uses a random `127.0.0.1` port, verifies its PID and package family, and accepts only `app://-/index.html`. |
| Script lifecycle | Validates manifests and hashes, applies permissions, injects current/future documents, and cleans up the old lifecycle before reload. |
| Quiet background host | No console, tray icon, service, scheduled task, startup entry, or administrator prompt. |
| Built-in diagnostics | Starting a second instance opens redacted diagnostics; `--reload` requests an in-place script reload. |
| Bennett UI included | Installs the bundled Bennett UI Improvements 1.4.8 package on first run. |
| Reproducible packaging | Produces x64 or arm64 self-contained MSIX payloads, an SBOM inventory, and SHA-256 sums. |

## Requirements

- Windows 11 x64 or arm64.
- The official Codex app installed from Microsoft Store for the current user.
- A standard interactive user account; elevation is neither required nor requested.
- For source builds: .NET 10 SDK and Windows SDK 10.0.26100 or newer.

Codex must be completely closed before the Loader starts a managed instance. Once running, start Codex through the Loader rather than launching Codex separately.

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
├── CodexScriptLoader-0.3.0.0-x64.msix
├── CodexScriptLoader-x64.appinstaller
├── CodexScriptLoader-0.3.0.0-x64.spdx.json
└── SHA256SUMS.txt
```

Run `bin\app\CodexScriptLoader.exe` to use the unpackaged self-contained build. Installing a locally generated MSIX requires a trusted development certificate.

### What to expect

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

## How it works

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

## Design boundaries

- Does not patch, copy, unpack, or re-sign the official Codex application.
- Does not enumerate or write to the protected `WindowsApps` directory.
- Does not invoke PowerShell, cmd, Node.js, `tasklist`, `netstat`, temporary scripts, self-extractors, or reflection loaders in the production launch path.
- Binds CDP only to loopback at a random port and verifies ownership before injection.
- Accepts only the exact main renderer target `app://-/index.html`.
- Limits the current-user single-instance pipe to `ShowStatus` and `ReloadScripts`.
- Fails closed on unknown required manifest fields, hash mismatches, permission failures, and invalid paths.

These choices reduce false-positive risk, but no architecture or signature can guarantee acceptance by every security product. A detected release is investigated and held back rather than shipped with instructions to disable protection.

## Script packages

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

Run the development-only [`ActivationProbe`](windows/tools/ActivationProbe) only with Codex completely closed. A passing probe must discover the real application ID, activate Codex with CDP arguments, verify listener ownership, and report `ACTIVATION_PASS`.

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

## Compatibility and scope

Codex Script Loader targets the Microsoft Store build of Codex on Windows. Codex updates may require Loader or script compatibility changes. This independent project is not affiliated with OpenAI or Microsoft.

## Contributing

Issues and focused pull requests are welcome. For setup, architecture, testing, and packaging details, see [`windows/README.md`](windows/README.md).

## Credits and license

- Bundled plugin: [Bennett UI Improvements for Codex++](https://github.com/JHees/bennett-ui-improvements-for-codexplusplus), with original authorship and MIT notices preserved.
- Bennett upstream: [b-nnett/codex-plusplus-bennett-ui](https://github.com/b-nnett/codex-plusplus-bennett-ui).
- Editorial icon method: [ZzzLc0405/photo-abstract-editorial](https://github.com/ZzzLc0405/photo-abstract-editorial).

Loader code is released under the [MIT License](LICENSE). Bundled third-party code remains under its included license and notices. Adapted assets under `windows/branding` are excluded from the MIT code license and remain subject to the non-commercial restrictions documented in [`windows/branding/README.md`](windows/branding/README.md); obtain the original author's authorization before commercial distribution of those assets.
