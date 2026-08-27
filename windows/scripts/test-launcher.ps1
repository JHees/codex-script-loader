[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$ArtifactRoot,
  [Parameter(Mandatory)]
  [ValidatePattern("^\d+\.\d+\.\d+$")]
  [string]$Version
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$artifactRoot = [IO.Path]::GetFullPath($ArtifactRoot)
$launcher = Join-Path $artifactRoot "app\CodexScriptLoader.exe"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Packaged launcher is missing: $launcher" }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "codex-loader-launcher-probe-test"
$probePublish = Join-Path $testRoot "probe"
$layoutRoot = Join-Path $testRoot "layout"
$dotnet = Join-Path $repositoryRoot ".tools\dotnet\dotnet.exe"
if (-not (Test-Path -LiteralPath $dotnet)) { $dotnet = (Get-Command dotnet -ErrorAction Stop).Source }
$parsedVersion = [Version]$Version
$candidateVersion = "$($parsedVersion.Major).$($parsedVersion.Minor).$($parsedVersion.Build + 1)"

function Write-Pointer([string]$Path, [string]$PointerVersion, [string]$EntryPoint) {
  [ordered]@{ schemaVersion = 1; version = $PointerVersion; rid = "win-x64"; entryPoint = $EntryPoint; launcherProtocol = 1; handoffProtocol = 1 } |
    ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}

try {
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $probePublish,$layoutRoot -Force | Out-Null
  & $dotnet publish (Join-Path $repositoryRoot "windows\tools\LauncherProbeHost\LauncherProbeHost.csproj") -c Release -r win-x64 --self-contained false --configfile (Join-Path $repositoryRoot "NuGet.Config") -o $probePublish
  if ($LASTEXITCODE -ne 0) { throw "Launcher probe host publish failed." }
  Copy-Item -LiteralPath $launcher -Destination (Join-Path $layoutRoot "CodexScriptLoader.exe")
  foreach ($probeVersion in @($Version, $candidateVersion)) {
    $versionRoot = Join-Path $layoutRoot "versions\$probeVersion\win-x64"
    New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $probePublish "*") -Destination $versionRoot -Recurse -Force
  }

  $activePath = Join-Path $layoutRoot "active.json"
  $previousPath = Join-Path $layoutRoot "previous.json"
  $marker = Join-Path $testRoot "marker.txt"
  Write-Pointer $activePath $candidateVersion "LauncherProbeHost.exe"
  Write-Pointer $previousPath $Version "LauncherProbeHost.exe"
  $fallback = Start-Process -FilePath (Join-Path $layoutRoot "CodexScriptLoader.exe") -ArgumentList @("--fail-version", $candidateVersion, "--marker", $marker) -Wait -PassThru -WindowStyle Hidden
  if ($fallback.ExitCode -ne 0 -or (Get-Content -LiteralPath $marker -Raw) -ne $Version) { throw "Launcher did not fall back after a candidate missed its health signal." }
  if ((Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json).version -ne $Version) { throw "Launcher did not atomically restore the previous pointer." }

  Set-Content -LiteralPath $activePath -Value "{" -Encoding ascii
  Remove-Item -LiteralPath $marker -Force
  $corrupt = Start-Process -FilePath (Join-Path $layoutRoot "CodexScriptLoader.exe") -ArgumentList @("--marker", $marker) -Wait -PassThru -WindowStyle Hidden
  if ($corrupt.ExitCode -ne 0 -or (Get-Content -LiteralPath $marker -Raw) -ne $Version) { throw "Launcher did not recover from a corrupt active pointer." }
  Write-Output "LAUNCHER_TEST_PASS version=$Version fallback=health-timeout corrupt-pointer=recovered"
}
finally {
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
