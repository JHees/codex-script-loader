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
$userDataRoot = Join-Path $env:LOCALAPPDATA "CodexScriptLoader"
$userDataSentinel = Join-Path $userDataRoot "installer-migration-sentinel.txt"

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

  New-Item -ItemType Directory -Path $defaultInstallRoot -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $defaultInstallRoot "CodexScriptLoader.exe") -Value "legacy" -Encoding ascii
  Set-Content -LiteralPath (Join-Path $defaultInstallRoot "CodexScriptLoader.dll") -Value "legacy" -Encoding ascii
  Set-Content -LiteralPath (Join-Path $defaultInstallRoot "uninstall.exe") -Value "legacy" -Encoding ascii
  New-Item -ItemType Directory -Path (Join-Path $defaultInstallRoot "bundled") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $defaultInstallRoot "bundled\legacy.txt") -Value "legacy" -Encoding ascii
  New-Item -ItemType Directory -Path (Join-Path $defaultInstallRoot "zh-Hans") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $defaultInstallRoot "zh-Hans\legacy.resources.dll") -Value "legacy" -Encoding ascii
  New-Item -ItemType Directory -Path $userDataRoot -Force | Out-Null
  Set-Content -LiteralPath $userDataSentinel -Value "preserve" -Encoding ascii

  $migration = Start-Process -FilePath $setupPath -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($migration.ExitCode -ne 0) { throw "0.4.x layout migration failed with exit code $($migration.ExitCode)." }
  $migratedHost = Join-Path $defaultInstallRoot "versions\$Version\win-x64\CodexScriptLoader.exe"
  if (-not (Test-Path -LiteralPath $migratedHost -PathType Leaf)) { throw "Migrated versioned Loader host is missing." }
  if (-not (Test-Path -LiteralPath (Join-Path $defaultInstallRoot "active.json") -PathType Leaf)) { throw "Migrated active pointer is missing." }
  if (Test-Path -LiteralPath (Join-Path $defaultInstallRoot "CodexScriptLoader.dll")) { throw "Legacy flat Loader host files remain after migration." }
  if (Test-Path -LiteralPath (Join-Path $defaultInstallRoot "bundled")) { throw "Legacy flat bundled directory remains after migration." }
  if (Test-Path -LiteralPath (Join-Path $defaultInstallRoot "zh-Hans")) { throw "Legacy flat localization directories remain after migration." }

  $migratedUninstaller = Join-Path $defaultInstallRoot "uninstall.exe"
  $migrationUninstall = Start-Process -FilePath $migratedUninstaller -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($migrationUninstall.ExitCode -ne 0) { throw "Migrated installation uninstall failed with exit code $($migrationUninstall.ExitCode)." }
  Wait-Until { -not (Test-Path -LiteralPath $defaultInstallRoot) } 15 "Migrated installation was not removed."
  if (-not (Test-Path -LiteralPath $userDataSentinel -PathType Leaf)) { throw "Upgrade or uninstall removed Loader user data." }

  $oldVersionRoot = Join-Path $defaultInstallRoot "versions\0.4.9\win-x64"
  New-Item -ItemType Directory -Path $oldVersionRoot -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $defaultInstallRoot ".codex-script-loader-install") -Value "CodexScriptLoader0.4.9" -Encoding ascii
  [ordered]@{ schemaVersion = 1; version = "0.4.9"; rid = "win-x64"; entryPoint = "CodexScriptLoader.exe"; launcherProtocol = 1; handoffProtocol = 1 } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $defaultInstallRoot "active.json") -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $oldVersionRoot "CodexScriptLoader.exe") -Value "old-version" -Encoding ascii
  $versionedUpgrade = Start-Process -FilePath $setupPath -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($versionedUpgrade.ExitCode -ne 0) { throw "Versioned installer upgrade failed with exit code $($versionedUpgrade.ExitCode)." }
  $preservedPrevious = Get-Content -LiteralPath (Join-Path $defaultInstallRoot "previous.json") -Raw -Encoding utf8 | ConvertFrom-Json
  if ($preservedPrevious.version -ne "0.4.9" -or -not (Test-Path -LiteralPath $oldVersionRoot -PathType Container)) { throw "Versioned installer upgrade did not preserve the previous host." }
  $versionedUninstall = Start-Process -FilePath (Join-Path $defaultInstallRoot "uninstall.exe") -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($versionedUninstall.ExitCode -ne 0) { throw "Versioned upgrade uninstall failed with exit code $($versionedUninstall.ExitCode)." }
  Wait-Until { -not (Test-Path -LiteralPath $defaultInstallRoot) } 15 "Versioned upgrade installation was not removed."
  if (-not (Test-Path -LiteralPath $userDataSentinel -PathType Leaf)) { throw "Versioned upgrade or uninstall removed Loader user data." }

  Write-Output "NSIS_INSTALLER_TEST_PASS version=$Version migration=0.4.x-to-versioned previous=preserved userData=preserved"
}
finally {
  $uninstaller = Join-Path $testRoot "uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
  if (Test-Path -LiteralPath (Join-Path $defaultInstallRoot ".codex-script-loader-install")) {
    $defaultUninstaller = Join-Path $defaultInstallRoot "uninstall.exe"
    if (Test-Path -LiteralPath $defaultUninstaller -PathType Leaf) { Start-Process -FilePath $defaultUninstaller -ArgumentList "/S" -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue }
  }
  if (Test-Path -LiteralPath $defaultInstallRoot) { Remove-Item -LiteralPath $defaultInstallRoot -Recurse -Force }
  if (Test-Path -LiteralPath $userDataSentinel -PathType Leaf) { Remove-Item -LiteralPath $userDataSentinel -Force }
  foreach ($path in @($desktopShortcut, $startMenuRoot, $uninstallKey, $productKey)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
}
