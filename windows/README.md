# Codex Script Loader for Windows

The Windows Loader uses a small stable NativeAOT launcher plus a versioned .NET 10 WinForms background host. The host launches the current user's Microsoft Store Codex package through `IApplicationActivationManager`, verifies the loopback CDP listener by package family, injects only into the exact `app://-/index.html` renderer target, and exits automatically after the managed Codex process disappears.

Starting the same executable again opens the diagnostic window through the current-user single-instance pipe. Starting it with `--reload` asks the running Loader to rebuild and inject its script plan without focusing or reloading the Codex window.

The production path does not enumerate `C:\Program Files\WindowsApps` and does not start PowerShell, cmd, Node, tasklist, netstat, a service, a scheduled task, or an updater process. PowerShell files under `windows/scripts` are build-time tooling and are not included in the application package.

## Build and test

The stable launcher is NativeAOT, so Windows source builds also require the Visual Studio C++ desktop toolchain. Cross-publishing `win-arm64` from an x64 machine requires the `Microsoft.VisualStudio.Component.VC.Tools.ARM64` component in addition to the x64/x86 tools and Windows SDK. GitHub's `windows-2025` image already includes that component; local builds fail early instead of silently producing a wrong-architecture launcher when it is absent.

```powershell
.\.tools\dotnet\dotnet.exe build .\windows\CodexScriptLoader.Windows.sln -c Release --configfile .\NuGet.Config
.\.tools\dotnet\dotnet.exe run --project .\windows\tests\CodexScriptLoader.Tests\CodexScriptLoader.Tests.csproj -c Release
```

Run `tools/ActivationProbe` with Codex completely closed before validating a new Store Codex release. `ACTIVATION_PASS` is required before releasing the Loader.

Source Link is enabled when the build supplies a stable `RepositoryUrl`. It is disabled in source checkouts without a configured repository URL so local builds do not publish a false provenance link.

## Package

Packaging requires NSIS 3.12.0. Install it normally, or extract the portable NSIS distribution to `.tools\nsis`.

```powershell
.\windows\scripts\package.ps1 -RuntimeIdentifier win-x64 -Version 0.5.9
.\windows\scripts\package.ps1 -RuntimeIdentifier win-arm64 -Version 0.5.9
```

The command clears only previously generated files in the repository-level `build` directory, preserves its `README.md`, and leaves the latest runtime and version there. It never cleans or overwrites `bin`:

```text
build/
├── README.md
├── app/CodexScriptLoader.exe
├── app/active.json
├── app/previous.json
├── app/update-manifest.json
├── app/versions/0.5.9/win-x64/
├── CodexScriptLoader-0.5.9-windows-x64-setup.exe
├── CodexScriptLoader-0.5.9-windows-x64-setup.exe.sha256
├── CodexScriptLoader-0.5.9-windows-x64.zip
├── CodexScriptLoader-0.5.9-windows-x64.zip.sha256
└── CodexScriptLoader-0.5.9-x64.spdx.json
```

The setup executable at the top of `build` is the local installation entry. `build\app` is retained only so package verification can compare the installer, portable ZIP, SBOM, and published payload; do not use it as the normal installed runtime.

The NSIS installer:

- installs per user to `%LOCALAPPDATA%\Programs\CodexScriptLoader`;
- provides standard welcome, installation directory, Start menu folder, progress, and finish pages;
- requests no administrator access;
- creates desktop and Start menu shortcuts after the user confirms the locations;
- registers an uninstaller in Windows Installed apps;
- does not start a shell or force-terminate Codex or the Loader;
- leaves `%LOCALAPPDATA%\CodexScriptLoader` scripts, settings, quarantine, and logs untouched on upgrade and uninstall.

NSIS silent installation uses `/S`, making the same setup executable suitable for a future WinGet manifest. Interactive installation accepts a custom directory only when it is empty or already contains the Loader installation marker. The former fixed default directory is also accepted when the complete legacy Loader layout is present, allowing the new installer to add the marker during an in-place transition. Uninstall requires that marker before removing the selected application directory, while silent CI tests use `/D=<test-directory>` to exercise the custom-directory path.

The portable ZIP contains the same self-contained application payload as `build\app`, rooted directly at `CodexScriptLoader.exe`. It does not create shortcuts or registry entries.

The root executable is the stable launcher. `active.json` and `previous.json` select complete hosts under `versions/<version>/<rid>`. Standard installations can stage a newer version directory, verify its update manifest, transfer the current-user file lock and exact CDP identity to the candidate host, and atomically commit the pointer without restarting Codex. Portable copies do not self-update.

Pass `-CertificatePath` and `-CertificatePassword` only when an Authenticode certificate is available. The script then signs and verifies the Loader-owned EXE and DLLs before packing and signs the setup executable afterward with SHA-256 and an RFC 3161 timestamp. Signing is optional and is not required for GitHub Actions to publish a release.

Each local/CI package also includes an SPDX 2.3 inventory and a separate `.sha256` file beside each installer and portable ZIP. The SPDX inventory is retained as short-lived CI metadata for supply-chain review, but it is not published as an end-user GitHub Release asset. Verify two independent application payloads before release:

```powershell
.\windows\scripts\verify-reproducible.ps1 -RuntimeIdentifier win-x64 -Version 0.5.9
.\windows\scripts\verify-reproducible.ps1 -RuntimeIdentifier win-arm64 -Version 0.5.9
```

`verify-package.ps1` checks the installer metadata, portable archive contents and hashes, Windows GUI PE subsystem, target architecture, required self-contained files, SBOM, checksums, and absence of development probes, command shells, and script launchers. Use `-RequireSignature` only for a signed release. `test-installer.ps1` performs an x64 silent install/uninstall test and verifies shortcuts plus the HKCU uninstall entry. It refuses to overwrite an existing installed copy, but a separately running development copy no longer blocks the test and is left untouched.

## GitHub Actions release

The [`Windows Loader`](../.github/workflows/windows-loader.yml) workflow uses pinned NSIS 3.12.0. Pushes and pull requests build, test, verify reproducibility, and package x64 and arm64. Each job uploads its setup executable and portable ZIP as the public-package Actions artifact; the SBOM is retained separately as 30-day internal CI metadata.

A semantic version tag such as `v0.5.9` must match `package.json`, `Directory.Build.props`, and both Windows `ApplicationVersion` fields. After both architectures pass, the workflow creates or updates the matching GitHub Release with:

- x64 and arm64 NSIS setup executables;
- x64 and arm64 portable ZIP archives;
- four matching `.sha256` files, one for each published package.

The release notes repeat all four SHA-256 digests in a verification table. SPDX inventories remain available in the corresponding workflow run instead of appearing beside end-user downloads.

No signing secret is required. If signing is added later, it must sign the application payload before NSIS compilation and the finished setup executable afterward; the signed artifacts must then pass `verify-package.ps1 -RequireSignature`.

## Release gate

- Build twice from clean source and compare every application payload hash.
- Verify setup metadata, ZIP parity, SPDX inventory, and published SHA-256 hashes after download.
- Install, upgrade, launch, reload, uninstall, and reinstall as a standard user on Windows 11 x64 and arm64.
- Confirm the desktop shortcut, Start menu shortcut, Installed apps entry, and silent `/S` flow.
- Confirm uninstall preserves `%LOCALAPPDATA%\CodexScriptLoader` user data.
- Test with current Defender and Kaspersky definitions and no exclusions. Any detection blocks release pending behavior correction or vendor reanalysis.
- Confirm the installer and Loader do not create PowerShell/cmd/Node/taskkill/tasklist/netstat child processes and the Loader does not enumerate WindowsApps.
