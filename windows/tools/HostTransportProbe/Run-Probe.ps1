param([switch]$Cleanup)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$probeExecutable = Join-Path $PSScriptRoot 'app\CodexScriptLoader.HostTransportProbe.exe'
$probeConfig = Join-Path $PSScriptRoot 'baseline\config.json'
$mode = if ($Cleanup) { '--cleanup' } else { '--run' }
$outputFile = Join-Path $PSScriptRoot 'probe-output.txt'
$errorFile = Join-Path $PSScriptRoot 'probe-error.txt'
Write-Host 'This probe does not close or restart a running Codex instance.'
if (-not $Cleanup) { Write-Host 'Close Codex first. A new official window will be opened for this one test.' }
$probeProcess = Start-Process -FilePath $probeExecutable -ArgumentList @($mode, ('"' + $probeConfig + '"')) `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $outputFile -RedirectStandardError $errorFile
$probeProcess.WaitForExit()
$probeProcess.Refresh()
if (Test-Path -LiteralPath $errorFile) { Get-Content -LiteralPath $errorFile | Write-Host }
$reportFile = Join-Path $PSScriptRoot ('baseline\' + $(if ($Cleanup) { 'cleanup.json' } else { 'activation.json' }))
if (Test-Path -LiteralPath $reportFile) { Get-Content -LiteralPath $reportFile | Write-Host }
Write-Host ('Reports: ' + (Join-Path $PSScriptRoot 'baseline'))
if ($probeProcess.ExitCode -ne 0) { throw 'Probe failed. Return with the reports; do not repeat activation or change your login.' }
if (-not $Cleanup) {
    Write-Host 'Startup passed. Verify your account, history, a small local task, approval/cancel, and built-in tools.'
    Write-Host 'This test window does not inject Loader plugins. Close it normally after testing, then use your normal Loader shortcut.'
}
