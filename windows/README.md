# Codex Script Loader for Windows

Version 0.3 is a background .NET 10 WinForms application with no console and no tray icon. It launches the current user's Microsoft Store Codex package through `IApplicationActivationManager`, verifies the loopback CDP listener by package family, injects only into the exact `app://-/index.html` renderer target, and exits automatically after the managed Codex process disappears.

Starting the same executable again opens the diagnostic window through the current-user single-instance pipe. Starting it with `--reload` asks the running Loader to rebuild and inject its script plan without focusing or reloading the Codex window.

The production path does not enumerate `C:\Program Files\WindowsApps` and does not start PowerShell, cmd, Node, tasklist, netstat, a service, a scheduled task, or an updater process. The PowerShell files under `windows/scripts` are build-time tooling and are not included in the application package.

## Build and test

```powershell
.\.tools\dotnet\dotnet.exe build .\windows\CodexScriptLoader.Windows.sln -c Release --configfile .\NuGet.Config
.\.tools\dotnet\dotnet.exe run --project .\windows\tests\CodexScriptLoader.Tests\CodexScriptLoader.Tests.csproj -c Release
```

Run `tools/ActivationProbe` with Codex completely closed before validating a new Store Codex release. `ACTIVATION_PASS` is required before releasing the Loader.

Source Link is enabled when the build supplies a stable `RepositoryUrl`. It is intentionally disabled in source checkouts without a configured repository URL so local builds remain warning-free and do not publish a false provenance link.

## Package

```powershell
.\windows\scripts\package.ps1 -RuntimeIdentifier win-x64 -Publisher "CN=Your Authenticode Publisher" -ReleaseBaseUri "https://downloads.example.com/codex-script-loader"
.\windows\scripts\package.ps1 -RuntimeIdentifier win-arm64 -Publisher "CN=Your Authenticode Publisher" -ReleaseBaseUri "https://downloads.example.com/codex-script-loader"
```

The packaging command writes the complete latest build to the repository-level `bin` directory. It clears `bin` before every run, so a checkout retains only the most recently packaged runtime and version. Intermediate SDK `bin`/`obj` directories remain ignored implementation details and are not distribution outputs.

Pass `-CertificatePath` and `-CertificatePassword` only in a protected release environment. The certificate subject must match the MSIX publisher. The packaging script signs and verifies the Loader EXE and its three project DLLs before packing, then signs and verifies the MSIX and App Installer file with SHA-256 Authenticode and an RFC 3161 timestamp. Framework files retain their Microsoft provenance. An unsigned development MSIX is not a release artifact.

Each package directory also contains an SPDX 2.3 file inventory and `SHA256SUMS.txt`. The SBOM creation time is a fixed reproducible-build value rather than a claim about release time; release provenance comes from the signed timestamp and CI record.

Before signing, verify that two independent publish passes produce identical payload files:

```powershell
.\windows\scripts\verify-reproducible.ps1 -RuntimeIdentifier win-x64
.\windows\scripts\verify-reproducible.ps1 -RuntimeIdentifier win-arm64
```

`verify-package.ps1` additionally checks the MSIX manifest architecture, Windows GUI PE subsystem, required self-contained payloads, and absence of development probes, command shells, and script launchers. Use `-RequireSignature` for release packages.

The checked-in App Installer template uses a placeholder URL. Replace it with the stable HTTPS release host during packaging. Microsoft Store submission uses the same application payload with the publisher identity assigned in Partner Center.

## Release gate

- Build twice from clean source and compare every pre-sign payload hash.
- Verify the final MSIX signature and timestamp after download.
- Install, launch, reload, update, and uninstall as a standard user on Windows 11 x64 and arm64.
- Test with current Defender and Kaspersky definitions and no exclusions. Any detection blocks release pending behavior correction or vendor reanalysis.
- Confirm no WindowsApps enumeration or PowerShell/cmd/Node/tasklist/netstat child process appears in Process Monitor.
