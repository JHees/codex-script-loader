[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$HostExecutable,
  [Parameter(Mandatory)][string]$DataRoot
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$package = [IO.Path]::GetFullPath($PackageRoot)
$hostPath = [IO.Path]::GetFullPath($HostExecutable)
$data = [IO.Path]::GetFullPath($DataRoot)
if (-not (Test-Path -LiteralPath (Join-Path $data 'runtime\backend.json'))) {
  throw 'The installed account backend needs its one-time hot-update bootstrap before independent updates are available.'
}
if (-not (Test-Path -LiteralPath (Join-Path $package 'manifest.json'))) { throw 'Account update manifest is missing.' }
$start = [Diagnostics.ProcessStartInfo]::new($hostPath)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
$start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$start.ArgumentList.Add('--accounts-backend')
$start.Environment.Remove('CODEX_SCRIPT_LOADER_ACCOUNTS') | Out-Null
$start.Environment.Remove('CODEX_ACCOUNT_WORKER_ASSEMBLY') | Out-Null
$start.Environment['CODEX_ACCOUNT_BACKEND_COMMAND'] = 'update'
$process = [Diagnostics.Process]::Start($start)
$errors = $process.StandardError.ReadToEndAsync()
try {
  $process.StandardInput.WriteLine((@{dataDirectory=$data; packageDirectory=$package; wait=$true} | ConvertTo-Json -Compress))
  $process.StandardInput.Close()
  while ($null -ne ($line = $process.StandardOutput.ReadLine())) { Write-Output $line }
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw 'Account runtime update failed; inspect the update state. The router is not replaced by this command.' }
  Write-Output 'ACCOUNT_UPDATE_PASS'
} finally {
  $null = $errors.GetAwaiter().GetResult()
  $process.Dispose()
}
