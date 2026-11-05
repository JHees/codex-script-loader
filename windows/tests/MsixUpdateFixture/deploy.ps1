param([Parameter(Mandatory)][string]$PackagePath,[Parameter(Mandatory)][string]$Family)
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
if(-not $Family.StartsWith('CodexScriptLoader.Test.Msix_')) {throw 'Only the isolated test family may be updated'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($PackagePath)
try { $reader=[IO.StreamReader]::new($zip.GetEntry('AppxManifest.xml').Open()); try{[xml]$manifest=$reader.ReadToEnd()}finally{$reader.Dispose()} }finally{$zip.Dispose()}
$installed=Get-AppxPackage -Name 'CodexScriptLoader.Test.Msix'
if($installed.PackageFamilyName -ne $Family -or $manifest.Package.Identity.Name -ne 'CodexScriptLoader.Test.Msix' -or $manifest.Package.Identity.Publisher -ne $installed.Publisher){throw 'Test package identity mismatch'}
Add-AppxPackage -Path $PackagePath -ForceTargetApplicationShutdown
(Get-AppxPackage -Name 'CodexScriptLoader.Test.Msix').Version.ToString()
