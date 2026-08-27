[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$ArtifactRoot,
  [Parameter(Mandatory)]
  [ValidatePattern("^\d+\.\d+\.\d+$")]
  [string]$Version,
  [Parameter(Mandatory)]
  [ValidateSet("x64", "arm64")]
  [string]$Architecture,
  [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$resolvedRoot = [IO.Path]::GetFullPath($ArtifactRoot)
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) { throw "Artifact directory does not exist: $resolvedRoot" }

$installerName = "CodexScriptLoader-$Version-windows-$Architecture-setup.exe"
$archiveName = "CodexScriptLoader-$Version-windows-$Architecture.zip"
$sbomName = "CodexScriptLoader-$Version-$Architecture.spdx.json"
$installerPath = Join-Path $resolvedRoot $installerName
$archivePath = Join-Path $resolvedRoot $archiveName
$sbomPath = Join-Path $resolvedRoot $sbomName
$sumsPath = Join-Path $resolvedRoot "SHA256SUMS.txt"
$appRoot = Join-Path $resolvedRoot "app"

foreach ($requiredPath in @($installerPath, $archivePath, $sbomPath, $sumsPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Required package artifact is missing: $requiredPath" }
}
if (-not (Test-Path -LiteralPath $appRoot -PathType Container)) { throw "Published application directory is missing: $appRoot" }

function Get-StreamSha256([IO.Stream]$Stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [Convert]::ToHexString($sha.ComputeHash($Stream)).ToLowerInvariant() } finally { $sha.Dispose() }
}

function Test-LoaderPe([byte[]]$Bytes) {
  if ($Bytes.Length -lt 256 -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a) { throw "Loader executable is not a valid PE image." }
  $peOffset = [BitConverter]::ToInt32($Bytes, 0x3c)
  $machine = [BitConverter]::ToUInt16($Bytes, $peOffset + 4)
  $subsystem = [BitConverter]::ToUInt16($Bytes, $peOffset + 4 + 20 + 68)
  if ($subsystem -ne 2) { throw "Loader PE subsystem is $subsystem, expected Windows GUI (2)." }
  $expectedMachine = if ($Architecture -eq "arm64") { 0xaa64 } else { 0x8664 }
  if ($machine -ne $expectedMachine) { throw "Loader PE machine is 0x$($machine.ToString('x4')), expected 0x$($expectedMachine.ToString('x4'))." }
}

$appFiles = @(Get-ChildItem -LiteralPath $appRoot -File -Recurse | Sort-Object FullName)
$appPrefix = [IO.Path]::GetFullPath($appRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$appHashes = [ordered]@{}
foreach ($file in $appFiles) {
  $relative = $file.FullName.Substring($appPrefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')
  $appHashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
}

$forbidden = @($appHashes.Keys | Where-Object {
  $_ -match '(?i)(^|/)(ActivationProbe|RendererProbe)(/|$)' -or
  $_ -match '(?i)\.(cmd|bat|ps1|vbs|jscript)$' -or
  $_ -match '(?i)(^|/)(node|powershell|pwsh|cmd|tasklist|netstat)\.exe$'
})
if ($forbidden) { throw "Forbidden development or shell payloads were packaged: $($forbidden -join ', ')" }

foreach ($required in @(
  "CodexScriptLoader.exe",
  "CodexScriptLoader.dll",
  "CodexScriptLoader.Core.dll",
  "CodexScriptLoader.Interop.dll",
  "coreclr.dll",
  "bundled/bennett-ui-improvements/index.js",
  "bundled/bennett-ui-improvements/manifest.json",
  "bundled/settings-host.mjs"
)) {
  if (-not $appHashes.Contains($required)) { throw "Required application payload is missing: $required" }
}

[byte[]]$loaderBytes = [IO.File]::ReadAllBytes((Join-Path $appRoot "CodexScriptLoader.exe"))
Test-LoaderPe $loaderBytes

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $zipEntries = @($archive.Entries | Where-Object { $_.Name -ne "" })
  $zipNames = @($zipEntries | ForEach-Object { $_.FullName.Replace('\', '/') })
  $duplicates = @($zipNames | Group-Object | Where-Object Count -gt 1 | ForEach-Object Name)
  if ($duplicates) { throw "Portable archive has duplicate entries: $($duplicates -join ', ')" }
  if ($zipNames.Count -ne $appHashes.Count) { throw "Portable archive contains $($zipNames.Count) files, expected $($appHashes.Count)." }
  foreach ($entry in $zipEntries) {
    $relative = $entry.FullName.Replace('\', '/')
    if (-not $appHashes.Contains($relative)) { throw "Portable archive contains an unexpected file: $relative" }
    $stream = $entry.Open()
    try { $entryHash = Get-StreamSha256 $stream } finally { $stream.Dispose() }
    if ($entryHash -ne $appHashes[$relative]) { throw "Portable archive file hash differs from app payload: $relative" }
  }
} finally {
  $archive.Dispose()
}

$installerBytes = [IO.File]::ReadAllBytes($installerPath)
if ($installerBytes.Length -lt 1MB -or $installerBytes[0] -ne 0x4d -or $installerBytes[1] -ne 0x5a) {
  throw "NSIS installer is not a valid PE installer or is unexpectedly small."
}
$installerVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($installerPath)
if ($installerVersion.ProductName -ne "Codex Script Loader" -or $installerVersion.ProductVersion -ne $Version) {
  throw "Installer version metadata is not synchronized: product=$($installerVersion.ProductName) version=$($installerVersion.ProductVersion)"
}

$sbom = Get-Content -LiteralPath $sbomPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($sbom.spdxVersion -ne "SPDX-2.3" -or @($sbom.files).Count -ne $appHashes.Count) {
  throw "SPDX inventory does not match the published application payload."
}

$expectedSums = [ordered]@{}
foreach ($path in @($installerPath, $archivePath, $sbomPath)) {
  $expectedSums[[IO.Path]::GetFileName($path)] = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}
$actualSums = [ordered]@{}
foreach ($line in Get-Content -LiteralPath $sumsPath -Encoding ascii) {
  if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw "Malformed SHA256SUMS line: $line" }
  $actualSums[$Matches[2]] = $Matches[1].ToLowerInvariant()
}
if ($actualSums.Count -ne $expectedSums.Count) { throw "SHA256SUMS.txt contains an unexpected number of entries." }
foreach ($name in $expectedSums.Keys) {
  if ($actualSums[$name] -ne $expectedSums[$name]) { throw "SHA-256 mismatch for $name" }
}

if ($RequireSignature) {
  foreach ($path in @(
    $installerPath,
    (Join-Path $appRoot "CodexScriptLoader.exe"),
    (Join-Path $appRoot "CodexScriptLoader.dll"),
    (Join-Path $appRoot "CodexScriptLoader.Core.dll"),
    (Join-Path $appRoot "CodexScriptLoader.Interop.dll")
  )) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) { throw "Signature is not valid for ${path}: $($signature.Status)" }
    if (-not $signature.TimeStamperCertificate) { throw "Timestamp is missing for $path" }
  }
}

Write-Output "PACKAGE_VERIFY_PASS version=$Version architecture=$Architecture files=$($appHashes.Count) installer=$installerName archive=$archiveName"
