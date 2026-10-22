[CmdletBinding()]
param([string]$OutputRoot)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dotnet = Join-Path $repositoryRoot '.tools\dotnet\dotnet.exe'
if (-not (Test-Path -LiteralPath $dotnet)) { $dotnet = (Get-Command dotnet -ErrorAction Stop).Source }
$env:NUGET_PACKAGES = Join-Path $repositoryRoot '.tools\nuget'
& $dotnet build (Join-Path $repositoryRoot 'windows\src\CodexScriptLoader.Accounts') -c Release --no-restore --disable-build-servers -m:1
if ($LASTEXITCODE -ne 0) { throw 'Account runtime build failed.' }
$assembly = Join-Path $repositoryRoot 'windows\src\CodexScriptLoader.Accounts\bin\Release\net10.0-windows\CodexScriptLoader.Accounts.dll'
$ui = Join-Path $repositoryRoot 'src\accounts-ui.js'
$node = (Get-Command node -ErrorAction Stop).Source
& $node --check $ui
if ($LASTEXITCODE -ne 0) { throw 'Account UI syntax check failed.' }
$assemblyHash = (Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash.ToLowerInvariant()
$uiHash = (Get-FileHash -LiteralPath $ui -Algorithm SHA256).Hash.ToLowerInvariant()
$revision = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($assemblyHash + "`n" + $uiHash))).ToLowerInvariant()
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json).version
$destination = if ($OutputRoot) { [IO.Path]::GetFullPath($OutputRoot) } else { Join-Path $repositoryRoot "build\accounts\$revision" }
if (Test-Path -LiteralPath $destination) { throw "Output already exists: $destination" }
New-Item -ItemType Directory -Path $destination | Out-Null
Copy-Item -LiteralPath $assembly -Destination (Join-Path $destination 'CodexScriptLoader.Accounts.dll')
Copy-Item -LiteralPath $ui -Destination (Join-Path $destination 'accounts-ui.js')
[ordered]@{ schemaVersion=1; workerProtocol=1; storeSchema=1; version=$version; revision=$revision; assemblySha256=$assemblyHash; uiSha256=$uiHash } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding utf8
Write-Output "ACCOUNT_PACKAGE_PASS directory=$destination revision=$revision"
