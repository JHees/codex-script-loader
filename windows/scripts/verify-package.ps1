[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$PackagePath,
  [ValidateSet("x64", "arm64")]
  [string]$Architecture,
  [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$resolvedPackage = [IO.Path]::GetFullPath($PackagePath)
if (-not (Test-Path -LiteralPath $resolvedPackage -PathType Leaf)) { throw "MSIX does not exist: $resolvedPackage" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($resolvedPackage)
try {
  $names = @($archive.Entries | ForEach-Object FullName)
  $forbidden = @($names | Where-Object {
    $_ -match '(?i)(^|/)(ActivationProbe|RendererProbe)(/|$)' -or
    $_ -match '(?i)\.(cmd|bat|ps1|vbs|jscript)$' -or
    $_ -match '(?i)(^|/)(node|powershell|pwsh|cmd|tasklist|netstat)\.exe$'
  })
  if ($forbidden) { throw "Forbidden development or shell payloads were packaged: $($forbidden -join ', ')" }

  foreach ($required in @(
    "AppxManifest.xml",
    "CodexScriptLoader.exe",
    "CodexScriptLoader.dll",
    "CodexScriptLoader.Core.dll",
    "CodexScriptLoader.Interop.dll",
    "coreclr.dll",
    "bundled/bennett-ui-improvements/index.js",
    "bundled/bennett-ui-improvements/manifest.json",
    "bundled/settings-host.mjs"
  )) {
    if ($names -notcontains $required) { throw "Required package payload is missing: $required" }
  }

  $manifestEntry = $archive.GetEntry("AppxManifest.xml") ?? (throw "AppxManifest.xml is missing.")
  $reader = [IO.StreamReader]::new($manifestEntry.Open(), [Text.UTF8Encoding]::new($false), $true)
  try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
  $identity = $manifest.Package.Identity
  if ($Architecture -and $identity.ProcessorArchitecture -ne $Architecture) {
    throw "Manifest architecture is $($identity.ProcessorArchitecture), expected $Architecture."
  }
  if ($identity.Publisher -eq "") { throw "Manifest publisher is empty." }

  $exeEntry = $archive.GetEntry("CodexScriptLoader.exe") ?? (throw "CodexScriptLoader.exe is missing.")
  $memory = [IO.MemoryStream]::new()
  try {
    $stream = $exeEntry.Open()
    try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
    $bytes = $memory.ToArray()
  } finally { $memory.Dispose() }
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw "Loader executable is not a valid PE image." }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
  $subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 4 + 20 + 68)
  if ($subsystem -ne 2) { throw "Loader PE subsystem is $subsystem, expected Windows GUI (2)." }
  $expectedMachine = if (($Architecture ?? $identity.ProcessorArchitecture) -eq "arm64") { 0xaa64 } else { 0x8664 }
  if ($machine -ne $expectedMachine) { throw "Loader PE machine is 0x$($machine.ToString('x4')), expected 0x$($expectedMachine.ToString('x4'))." }
}
finally {
  $archive.Dispose()
}

if ($RequireSignature) {
  $sdkRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
  $toolArchitecture = if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq [Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "x64" }
  $sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName "$toolArchitecture\signtool.exe")) } |
    Sort-Object { [Version]$_.Name } -Descending | Select-Object -First 1
  if (-not $sdk) { throw "SignTool was not found." }
  & (Join-Path $sdk.FullName "$toolArchitecture\signtool.exe") verify /pa /all /v $resolvedPackage
  if ($LASTEXITCODE -ne 0) { throw "MSIX signature verification failed." }
}

Write-Output "PACKAGE_STRUCTURE_PASS architecture=$($Architecture ?? $identity.ProcessorArchitecture) files=$($names.Count)"
