[CmdletBinding()]
param(
  [ValidateSet("win-x64", "win-arm64")]
  [string]$RuntimeIdentifier = "win-x64",
  [ValidatePattern("^\d+\.\d+\.\d+$")]
  [string]$Version = "0.4.2",
  [string]$NsisPath,
  [string]$CertificatePath,
  [string]$CertificatePassword,
  [string]$TimestampUri = "http://timestamp.digicert.com",
  [string]$OutputRoot
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$productVersion = (Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw -Encoding utf8 | ConvertFrom-Json).version
if ($Version -ne $productVersion) { throw "Requested package version $Version does not match package.json version $productVersion." }
[xml]$buildProps = Get-Content -LiteralPath (Join-Path $repositoryRoot "Directory.Build.props") -Raw -Encoding utf8
if ([string]$buildProps.Project.PropertyGroup.Version -ne $Version) { throw "Directory.Build.props version does not match $Version." }
[xml]$windowsProject = Get-Content -LiteralPath (Join-Path $repositoryRoot "windows\src\CodexScriptLoader.Windows\CodexScriptLoader.Windows.csproj") -Raw -Encoding utf8
if ([string]$windowsProject.Project.PropertyGroup.ApplicationVersion -ne "$Version.0") { throw "Windows ApplicationVersion does not match $Version.0." }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:DOTNET_CLI_USE_MSBUILD_SERVER = "0"
$env:NUGET_PACKAGES = Join-Path $repositoryRoot ".tools\nuget"
$dotnet = Join-Path $repositoryRoot ".tools\dotnet\dotnet.exe"
if (-not (Test-Path -LiteralPath $dotnet)) {
  $dotnet = (Get-Command dotnet -ErrorAction Stop).Source
}

$architecture = if ($RuntimeIdentifier -eq "win-arm64") { "arm64" } else { "x64" }
$fileVersion = "$Version.0"
$defaultArtifactRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "build"))
$artifactRoot = if ($OutputRoot) { [IO.Path]::GetFullPath($OutputRoot) } else { $defaultArtifactRoot }
$publishRoot = Join-Path $artifactRoot "app"
$installerName = "CodexScriptLoader-$Version-windows-$architecture-setup.exe"
$archiveName = "CodexScriptLoader-$Version-windows-$architecture.zip"
$sbomName = "CodexScriptLoader-$Version-$architecture.spdx.json"
$installerPath = Join-Path $artifactRoot $installerName
$archivePath = Join-Path $artifactRoot $archiveName
$sbomPath = Join-Path $artifactRoot $sbomName

function Test-PathWithin([string]$Candidate, [string]$Parent) {
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
  return $resolvedCandidate.StartsWith($resolvedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Reset-ArtifactRoot {
  $resolvedArtifact = [IO.Path]::GetFullPath($artifactRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $allowedRoots = @($repositoryRoot, [IO.Path]::GetTempPath())
  if ($env:RUNNER_TEMP) { $allowedRoots += [IO.Path]::GetFullPath($env:RUNNER_TEMP) }
  $allowed = $false
  foreach ($root in $allowedRoots | Select-Object -Unique) {
    if (Test-PathWithin $resolvedArtifact $root) { $allowed = $true; break }
  }
  if (-not $allowed) { throw "Refusing to reset an output directory outside the repository or temporary directory: $resolvedArtifact" }
  foreach ($root in $allowedRoots | Select-Object -Unique) {
    if ($resolvedArtifact -eq [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar)) {
      throw "Refusing to reset an allowed root directory: $resolvedArtifact"
    }
  }
  if (-not (Test-Path -LiteralPath $resolvedArtifact)) {
    New-Item -ItemType Directory -Path $resolvedArtifact -Force | Out-Null
    return
  }

  foreach ($entry in Get-ChildItem -LiteralPath $resolvedArtifact -Force) {
    if ($resolvedArtifact -eq $defaultArtifactRoot -and $entry.Name -eq "README.md") { continue }
    Remove-Item -LiteralPath $entry.FullName -Recurse -Force
  }
}

function Resolve-MakeNsis {
  $candidates = @()
  if ($NsisPath) { $candidates += $NsisPath }
  $candidates += @(
    (Join-Path $repositoryRoot ".tools\nsis\makensis.exe"),
    (Join-Path $repositoryRoot ".tools\nsis\nsis-3.12\makensis.exe"),
    "C:\Program Files (x86)\NSIS\makensis.exe",
    "C:\Program Files\NSIS\makensis.exe"
  )
  $command = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return [IO.Path]::GetFullPath($candidate) }
  }
  throw "NSIS makensis.exe was not found. Install NSIS 3.12 or place its portable files under .tools\nsis."
}

function Resolve-SignTool {
  $windowsSdkRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
  $toolArchitecture = if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq [Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "x64" }
  $sdkVersion = Get-ChildItem -LiteralPath $windowsSdkRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName "$toolArchitecture\signtool.exe")) } |
    Sort-Object { [Version]$_.Name } -Descending |
    Select-Object -First 1
  if (-not $sdkVersion) { throw "A Windows SDK containing signtool.exe was not found under $windowsSdkRoot" }
  return Join-Path $sdkVersion.FullName "$toolArchitecture\signtool.exe"
}

function Invoke-Sign([string]$Path, [string]$SignTool) {
  $arguments = @("sign", "/fd", "SHA256", "/f", [IO.Path]::GetFullPath($CertificatePath))
  if ($CertificatePassword) { $arguments += @("/p", $CertificatePassword) }
  $arguments += @("/tr", $TimestampUri, "/td", "SHA256", $Path)
  & $SignTool @arguments
  if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed for $Path" }
  & $SignTool verify /pa /all /v $Path
  if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed for $Path" }
}

Reset-ArtifactRoot
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null

& $dotnet publish (Join-Path $repositoryRoot "windows\src\CodexScriptLoader.Windows\CodexScriptLoader.Windows.csproj") `
  -c Release -r $RuntimeIdentifier --self-contained true --configfile (Join-Path $repositoryRoot "NuGet.Config") `
  -m:1 -p:BuildInParallel=false -p:UseSharedCompilation=false `
  -p:PublishSingleFile=false -p:PublishReadyToRun=false -p:DebugType=embedded -o $publishRoot
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

$signTool = $null
if ($CertificatePath) {
  if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) { throw "Signing certificate does not exist: $CertificatePath" }
  $signTool = Resolve-SignTool
  foreach ($relativePath in @("CodexScriptLoader.exe", "CodexScriptLoader.dll", "CodexScriptLoader.Core.dll", "CodexScriptLoader.Interop.dll")) {
    Invoke-Sign (Join-Path $publishRoot $relativePath) $signTool
  }
}

$payloadFiles = @(Get-ChildItem -LiteralPath $publishRoot -File -Recurse | Sort-Object FullName)
$estimatedSizeKb = [Math]::Ceiling(($payloadFiles | Measure-Object -Property Length -Sum).Sum / 1KB)
$makeNsis = Resolve-MakeNsis
$nsisScript = Join-Path $repositoryRoot "windows\packaging\CodexScriptLoader.nsi"
$iconPath = Join-Path $repositoryRoot "windows\branding\CodexScriptLoader.ico"
$nsisArguments = @(
  "/V3",
  "/INPUTCHARSET",
  "UTF8",
  "/DVERSION=$Version",
  "/DFILE_VERSION=$fileVersion",
  "/DARCHITECTURE=$architecture",
  "/DAPP_DIR=$publishRoot",
  "/DOUTPUT_FILE=$installerPath",
  "/DICON_FILE=$iconPath",
  "/DESTIMATED_SIZE_KB=$estimatedSizeKb",
  $nsisScript
)
& $makeNsis @nsisArguments
if ($LASTEXITCODE -ne 0) { throw "NSIS packaging failed" }

if ($CertificatePath) { Invoke-Sign $installerPath $signTool }

Compress-Archive -Path (Join-Path $publishRoot "*") -DestinationPath $archivePath -CompressionLevel Optimal

$payloadPrefix = [IO.Path]::GetFullPath($publishRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$sbomFiles = foreach ($file in $payloadFiles) {
  $relative = $file.FullName.Substring($payloadPrefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')
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
$sbom | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sbomPath -Encoding utf8NoBOM

$sumPaths = @($installerPath, $archivePath, $sbomPath)
$sumLines = foreach ($path in $sumPaths) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($path))"
}
Set-Content -LiteralPath (Join-Path $artifactRoot "SHA256SUMS.txt") -Value $sumLines -Encoding ascii

Write-Output "PACKAGE_PASS version=$Version runtime=$RuntimeIdentifier installer=$installerName archive=$archiveName payloadFiles=$($payloadFiles.Count)"
