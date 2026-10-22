param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repository ('artifacts\host-transport-probe-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a new output directory; existing probe runs are preserved.' }
$backends = @(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object { $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' })
if ($backends.Count -ne 1) { throw 'Expected one running official local app-server for baseline capture.' }
$signature = Get-AuthenticodeSignature -LiteralPath $backends[0].ExecutablePath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenAI') { throw 'The current backend does not have a valid OpenAI signature.' }
$dotnet = Join-Path $repository '.tools\dotnet\dotnet.exe'
$project = Join-Path $PSScriptRoot 'HostTransportProbe.csproj'
$appDirectory = Join-Path $OutputDirectory 'app'
& $dotnet publish $project -c Release -r win-x64 --self-contained true -o $appDirectory --configfile (Join-Path $repository 'NuGet.Config')
if ($LASTEXITCODE -ne 0) { throw 'Probe publish failed.' }
$baselineDirectory = Join-Path $OutputDirectory 'baseline'
New-Item -ItemType Directory -Path $baselineDirectory | Out-Null
$probeConfig = Join-Path $baselineDirectory 'config.json'
$captureError = Join-Path $OutputDirectory 'capture-error.txt'
$probeProcess = Start-Process -FilePath (Join-Path $appDirectory 'CodexScriptLoader.HostTransportProbe.exe') `
    -ArgumentList @('--capture', [string]$backends[0].ProcessId, ('"' + $probeConfig + '"')) `
    -WindowStyle Hidden -PassThru -RedirectStandardError $captureError
$probeProcess.WaitForExit()
$probeProcess.Refresh()
if ($probeProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $probeConfig)) {
    Get-Content -LiteralPath $captureError | Write-Host
    throw 'Read-only baseline capture failed. No activation was attempted.'
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Run-Probe.ps1') -Destination $OutputDirectory
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $OutputDirectory 'README.md')
Get-FileHash -LiteralPath (Join-Path $appDirectory 'CodexScriptLoader.HostTransportProbe.exe') -Algorithm SHA256 | Format-List
Write-Host ('Prepared only; no activation attempted: ' + (Join-Path $OutputDirectory 'Run-Probe.ps1'))
