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
$resolvedArtifacts = [IO.Path]::GetFullPath($ArtifactRoot)
$setupPath = Join-Path $resolvedArtifacts "CodexScriptLoader-$Version-windows-x64-setup.exe"
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw "x64 NSIS installer is missing: $setupPath" }

$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexScriptLoader"
$productKey = "HKCU:\Software\CodexScriptLoader"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Codex Script Loader.lnk"
$startMenuRoot = Join-Path ([Environment]::GetFolderPath("Programs")) "Codex Script Loader"
$startMenuShortcut = Join-Path $startMenuRoot "Codex Script Loader.lnk"
$defaultInstallRoot = Join-Path $env:LOCALAPPDATA "Programs\CodexScriptLoader"
$testRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "CodexScriptLoaderInstallerTest")).TrimEnd([IO.Path]::DirectorySeparatorChar)

$preexisting = @($uninstallKey, $productKey, $desktopShortcut, $startMenuRoot, $defaultInstallRoot, $testRoot) | Where-Object { Test-Path -LiteralPath $_ }
if ($preexisting) { throw "Refusing installer test because Codex Script Loader is already installed: $($preexisting -join ', ')" }
$preexistingLoaderIds = @(Get-Process CodexScriptLoader -ErrorAction SilentlyContinue | ForEach-Object Id)

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$Failure) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $Failure
}

try {
  $install = Start-Process -FilePath $setupPath -ArgumentList "/S /D=$testRoot" -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw "Silent installation failed with exit code $($install.ExitCode)." }

  $uninstaller = Join-Path $testRoot "uninstall.exe"
  Wait-Until { (Test-Path -LiteralPath $uninstaller -PathType Leaf) -and (Test-Path -LiteralPath $uninstallKey) } 15 "Installer did not finish writing its files and uninstall registration."
  if (-not (Test-Path -LiteralPath (Join-Path $testRoot "CodexScriptLoader.exe") -PathType Leaf)) { throw "Installed Loader executable is missing." }
  if (-not (Test-Path -LiteralPath (Join-Path $testRoot ".codex-script-loader-install") -PathType Leaf)) { throw "Installation safety marker is missing." }
  if (-not (Test-Path -LiteralPath $desktopShortcut -PathType Leaf)) { throw "Desktop shortcut is missing." }
  if (-not (Test-Path -LiteralPath $startMenuShortcut -PathType Leaf)) { throw "Start menu shortcut is missing." }
  if ((Get-ItemPropertyValue -LiteralPath $uninstallKey -Name InstallLocation) -ne $testRoot) { throw "Uninstall registration has the wrong install directory." }
  if ((Get-ItemPropertyValue -LiteralPath $uninstallKey -Name DisplayVersion) -ne $Version) { throw "Uninstall registration has the wrong version." }
  $unexpectedLoaderIds = @(Get-Process CodexScriptLoader -ErrorAction SilentlyContinue |
    Where-Object { $preexistingLoaderIds -notcontains $_.Id } |
    ForEach-Object Id)
  if ($unexpectedLoaderIds) { throw "Silent installation unexpectedly launched Loader process(es): $($unexpectedLoaderIds -join ', ')." }

  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($uninstall.ExitCode -ne 0) { throw "Silent uninstall failed with exit code $($uninstall.ExitCode)." }
  Wait-Until { -not (Test-Path -LiteralPath $testRoot) } 15 "Silent uninstall did not remove the application directory."
  foreach ($path in @($uninstallKey, $productKey, $desktopShortcut, $startMenuRoot)) {
    if (Test-Path -LiteralPath $path) { throw "Silent uninstall left package state behind: $path" }
  }

  Write-Output "NSIS_INSTALLER_TEST_PASS version=$Version"
}
finally {
  $uninstaller = Join-Path $testRoot "uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
  foreach ($path in @($desktopShortcut, $startMenuRoot, $uninstallKey, $productKey)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
}
