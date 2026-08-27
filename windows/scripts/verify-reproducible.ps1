[CmdletBinding()]
param(
  [ValidateSet("win-x64", "win-arm64")]
  [string]$RuntimeIdentifier = "win-x64",
  [ValidatePattern("^\d+\.\d+\.\d+\.\d+$")]
  [string]$Version = "0.4.1.0",
  [string]$Publisher = "CN=Codex Script Loader Development",
  [ValidatePattern("^https://")]
  [string]$ReleaseBaseUri = "https://example.invalid/codex-script-loader"
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$verificationRoot = Join-Path $repositoryRoot ".tools\reproducibility\$RuntimeIdentifier"
$firstRoot = Join-Path $verificationRoot "first"
$secondRoot = Join-Path $verificationRoot "second"

function Get-PayloadHashes([string]$Root) {
  $layout = Join-Path $Root "layout"
  $prefix = [IO.Path]::GetFullPath($layout).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $hashes = [ordered]@{}
  foreach ($file in Get-ChildItem -LiteralPath $layout -File -Recurse | Sort-Object FullName) {
    $relative = $file.FullName.Substring($prefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')
    $hashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
  }
  return $hashes
}

try {
  & (Join-Path $PSScriptRoot "package.ps1") -RuntimeIdentifier $RuntimeIdentifier -Version $Version `
    -Publisher $Publisher -ReleaseBaseUri $ReleaseBaseUri -OutputRoot $firstRoot | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "First packaging pass failed." }

  & (Join-Path $PSScriptRoot "package.ps1") -RuntimeIdentifier $RuntimeIdentifier -Version $Version `
    -Publisher $Publisher -ReleaseBaseUri $ReleaseBaseUri -OutputRoot $secondRoot | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Second packaging pass failed." }

  $first = Get-PayloadHashes $firstRoot
  $second = Get-PayloadHashes $secondRoot
  $allPaths = @($first.Keys) + @($second.Keys) | Sort-Object -Unique
  $differences = foreach ($path in $allPaths) {
    if ($first[$path] -ne $second[$path]) {
      [pscustomobject]@{ Path = $path; First = $first[$path]; Second = $second[$path] }
    }
  }

  if ($differences) {
    $differences | Format-Table -AutoSize
    throw "Pre-sign payloads are not reproducible."
  }

  Write-Output "REPRODUCIBLE_PAYLOAD_PASS files=$($first.Count) runtime=$RuntimeIdentifier"
}
finally {
  if (Test-Path -LiteralPath $verificationRoot) {
    Remove-Item -LiteralPath $verificationRoot -Recurse -Force
  }
  $verificationParent = Split-Path -Path $verificationRoot -Parent
  if ((Test-Path -LiteralPath $verificationParent) -and -not (Get-ChildItem -LiteralPath $verificationParent -Force)) {
    Remove-Item -LiteralPath $verificationParent -Force
  }
}
