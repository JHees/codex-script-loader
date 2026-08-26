[CmdletBinding()]
param(
  [ValidateSet("win-x64", "win-arm64")]
  [string]$RuntimeIdentifier = "win-x64",
  [ValidatePattern("^\d+\.\d+\.\d+\.\d+$")]
  [string]$Version = "0.3.0.0",
  [string]$PackageName = "CodexScriptLoader.Windows",
  [string]$Publisher = "CN=Codex Script Loader Development",
  [ValidatePattern("^https://")]
  [string]$ReleaseBaseUri = "https://example.invalid/codex-script-loader",
  [string]$CertificatePath,
  [string]$CertificatePassword,
  [string]$TimestampUri = "http://timestamp.digicert.com",
  [string]$OutputRoot
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:NUGET_PACKAGES = Join-Path $repositoryRoot ".tools\nuget"
$dotnet = Join-Path $repositoryRoot ".tools\dotnet\dotnet.exe"
if (-not (Test-Path -LiteralPath $dotnet)) {
  $dotnetCommand = Get-Command dotnet -ErrorAction Stop
  $dotnet = $dotnetCommand.Source
}

$architecture = if ($RuntimeIdentifier -eq "win-arm64") { "arm64" } else { "x64" }
$artifactRoot = if ($OutputRoot) {
  [IO.Path]::GetFullPath($OutputRoot)
} else {
  Join-Path $repositoryRoot "bin"
}
$publishRoot = Join-Path $artifactRoot "app"
$layoutRoot = Join-Path $artifactRoot "layout"

function Reset-ArtifactRoot {
  $resolvedRepository = [IO.Path]::GetFullPath($repositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $repositoryPrefix = $resolvedRepository + [IO.Path]::DirectorySeparatorChar
  $resolvedArtifact = [IO.Path]::GetFullPath($artifactRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (-not $resolvedArtifact.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset an output directory outside the repository: $resolvedArtifact"
  }
  if ($resolvedArtifact -eq $resolvedRepository) {
    throw "Refusing to reset the repository root."
  }
  if (Test-Path -LiteralPath $resolvedArtifact) {
    Remove-Item -LiteralPath $resolvedArtifact -Recurse -Force
  }
  New-Item -ItemType Directory -Path $resolvedArtifact -Force | Out-Null
}

Reset-ArtifactRoot
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null
New-Item -ItemType Directory -Path $layoutRoot -Force | Out-Null

& $dotnet publish (Join-Path $repositoryRoot "windows\src\CodexScriptLoader.Windows\CodexScriptLoader.Windows.csproj") `
  -c Release -r $RuntimeIdentifier --self-contained true --configfile (Join-Path $repositoryRoot "NuGet.Config") `
  -p:PublishSingleFile=false -p:PublishReadyToRun=false -p:DebugType=embedded -o $publishRoot
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

Copy-Item -Path (Join-Path $publishRoot "*") -Destination $layoutRoot -Recurse -Force
$assetTarget = Join-Path $layoutRoot "Assets"
New-Item -ItemType Directory -Path $assetTarget -Force | Out-Null
Copy-Item -Path (Join-Path $repositoryRoot "windows\packaging\Assets\*") -Destination $assetTarget -Force

$manifestTemplate = Get-Content -LiteralPath (Join-Path $repositoryRoot "windows\packaging\Package.appxmanifest.template") -Raw
$manifest = $manifestTemplate.Replace("__PACKAGE_NAME__", $PackageName).Replace("__PUBLISHER__", $Publisher).Replace("__VERSION__", $Version).Replace("__ARCHITECTURE__", $architecture)
Set-Content -LiteralPath (Join-Path $layoutRoot "AppxManifest.xml") -Value $manifest -Encoding utf8NoBOM

$windowsSdkRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
$toolArchitecture = if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq [Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "x64" }
$windowsSdkVersion = Get-ChildItem -LiteralPath $windowsSdkRoot -Directory |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName "$toolArchitecture\makeappx.exe")) } |
  Sort-Object { [Version]$_.Name } -Descending |
  Select-Object -First 1
if (-not $windowsSdkVersion) { throw "A Windows SDK containing makeappx.exe was not found under $windowsSdkRoot" }
$windowsSdkBin = Join-Path $windowsSdkVersion.FullName $toolArchitecture
$makeAppx = Join-Path $windowsSdkBin "makeappx.exe"
$signTool = Join-Path $windowsSdkBin "signtool.exe"
if (-not (Test-Path -LiteralPath $makeAppx)) { throw "MakeAppx was not found at $makeAppx" }

function Invoke-Sign([string]$Path) {
  $arguments = @("sign", "/fd", "SHA256", "/f", [IO.Path]::GetFullPath($CertificatePath))
  if ($CertificatePassword) { $arguments += @("/p", $CertificatePassword) }
  $arguments += @("/tr", $TimestampUri, "/td", "SHA256", $Path)
  & $signTool @arguments
  if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed for $Path" }
  & $signTool verify /pa /all /v $Path
  if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed for $Path" }
}

if ($CertificatePath) {
  if (-not (Test-Path -LiteralPath $signTool)) { throw "SignTool was not found at $signTool" }
  foreach ($relativePath in @("CodexScriptLoader.exe", "CodexScriptLoader.dll", "CodexScriptLoader.Core.dll", "CodexScriptLoader.Interop.dll")) {
    Invoke-Sign (Join-Path $layoutRoot $relativePath)
  }
}

$packageFileName = "CodexScriptLoader-$Version-$architecture.msix"
$packagePath = Join-Path $artifactRoot $packageFileName
& $makeAppx pack /o /d $layoutRoot /p $packagePath
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed" }

$baseUri = $ReleaseBaseUri.TrimEnd('/')
$appInstallerName = "CodexScriptLoader-$architecture.appinstaller"
$appInstallerPath = Join-Path $artifactRoot $appInstallerName
$appInstallerTemplate = Get-Content -LiteralPath (Join-Path $repositoryRoot "windows\packaging\CodexScriptLoader.appinstaller.template") -Raw
$appInstaller = $appInstallerTemplate.Replace("__APPINSTALLER_URI__", "$baseUri/$appInstallerName").Replace("__PACKAGE_URI__", "$baseUri/$packageFileName").Replace("__PACKAGE_NAME__", $PackageName).Replace("__PUBLISHER__", $Publisher).Replace("__VERSION__", $Version).Replace("__ARCHITECTURE__", $architecture)
Set-Content -LiteralPath $appInstallerPath -Value $appInstaller -Encoding utf8NoBOM

if ($CertificatePath) {
  Invoke-Sign $packagePath
  Invoke-Sign $appInstallerPath
}

$sbomFiles = foreach ($file in Get-ChildItem -LiteralPath $layoutRoot -File -Recurse | Sort-Object FullName) {
  $layoutPrefix = [IO.Path]::GetFullPath($layoutRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $relative = $file.FullName.Substring($layoutPrefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')
  [ordered]@{
    SPDXID = "SPDXRef-File-$([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($relative))).Substring(0, 16))"
    fileName = "./$relative"
    checksums = @([ordered]@{ algorithm = "SHA256"; checksumValue = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant() })
  }
}
$sbom = [ordered]@{
  spdxVersion = "SPDX-2.3"
  dataLicense = "CC0-1.0"
  SPDXID = "SPDXRef-DOCUMENT"
  name = "CodexScriptLoader-$Version-$architecture"
  documentNamespace = "https://codex-script-loader.invalid/spdx/$Version/$architecture"
  creationInfo = [ordered]@{ created = "2000-01-01T00:00:00Z"; creators = @("Tool: windows/scripts/package.ps1") }
  files = @($sbomFiles)
}
$sbomPath = Join-Path $artifactRoot "CodexScriptLoader-$Version-$architecture.spdx.json"
$sbom | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sbomPath -Encoding utf8NoBOM

$sumPaths = @($packagePath, $appInstallerPath, $sbomPath)
$sumLines = foreach ($path in $sumPaths) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($path))"
}
Set-Content -LiteralPath (Join-Path $artifactRoot "SHA256SUMS.txt") -Value $sumLines -Encoding ascii

Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath | Format-List
