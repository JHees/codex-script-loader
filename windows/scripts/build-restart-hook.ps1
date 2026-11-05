[CmdletBinding()]
param(
  [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
  [Parameter(Mandatory)][string]$OutputDirectory,
  [switch]$Fixture
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Visual Studio C++ Build Tools are required for the restart registration component.' }
$environmentScript = Join-Path $installation 'VC\Auxiliary\Build\vcvarsall.bat'
$nativeArchitecture = if ($Architecture -eq 'arm64') { 'amd64_arm64' } else { 'amd64' }
$compilerEnvironment = & $env:COMSPEC /d /s /c "`"$environmentScript`" $nativeArchitecture >nul && set"
if ($LASTEXITCODE -ne 0) { throw "C++ toolchain for $Architecture is unavailable." }
foreach ($line in $compilerEnvironment) {
  $equals = $line.IndexOf('=')
  if ($equals -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $equals), $line.Substring($equals + 1), 'Process') }
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$source = if ($Fixture) { Join-Path $PSScriptRoot '..\tests\NativeRestartFixture\fixture.cpp' } else { Join-Path $PSScriptRoot '..\native\restart-registration\restart-registration.cpp' }
$name = if ($Fixture) { 'NativeRestartFixture.exe' } else { 'CodexScriptLoader.RestartHook.dll' }
$arguments = @('/nologo', '/O2', '/W4', '/WX', '/EHsc', '/MT', '/Brepro', $source, "/Fe:$output\$name", "/Fo:$output\$name.obj")
if (-not $Fixture) { $arguments += '/LD' }
$arguments += @('user32.lib', 'kernel32.lib', 'shell32.lib', '/link', '/Brepro', '/INCREMENTAL:NO', "/IMPLIB:$output\$name.lib")
& cl.exe @arguments
if ($LASTEXITCODE -ne 0) { throw 'Native restart registration build failed.' }
