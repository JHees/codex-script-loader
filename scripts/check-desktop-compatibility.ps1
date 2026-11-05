param([string]$PackagePath, [string]$ReportPath = 'compatibility-report.json')
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()

function Read-RendererEvidence([IO.Stream]$Stream, [string]$ComposerSource = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src/composer-host.mjs') -Raw)) {
    $reader = [IO.BinaryReader]::new($Stream, [Text.Encoding]::UTF8, $true)
    try {
        $null = $reader.ReadUInt32()
        $headerSize = $reader.ReadUInt32()
        $null = $reader.ReadUInt32()
        $jsonSize = $reader.ReadUInt32()
        if ($headerSize -lt 8 -or $headerSize -gt 16MB -or $jsonSize -eq 0 -or $jsonSize -gt $headerSize - 8) { throw 'Invalid ASAR header size' }
        $tree = [Text.Encoding]::UTF8.GetString($reader.ReadBytes($jsonSize)) | ConvertFrom-Json -AsHashtable
        $pending = [Collections.Generic.Stack[object]]::new()
        $pending.Push(@{ Node = $tree; Path = ''; Depth = 0 })
        $evidence = [Collections.Generic.HashSet[string]]::new()
        $markers = @('data-codex-composer', 'data-composer-footer-responsive', 'composerController', 'conversationId',
            'hostId', 'executionTargetHostId', 'isAeonThread', 'data-codex-intelligence-trigger',
            'data-composer-navigation-target', 'reasoning', 'data-settings-panel-slug')
        $files = 0; [long]$bytes = 0; $rendererEntry = $false; $assetCount = 0
        $sample = [Collections.Generic.List[string]]::new()
        while ($pending.Count) {
            $item = $pending.Pop()
            if ($item.Depth -gt 32) { throw 'ASAR nesting exceeds limit' }
            foreach ($name in $item.Node.files.Keys) {
                if ($name -in '.', '..' -or $name -match '[/\\]') { throw 'Unsafe ASAR member' }
                $entry = $item.Node.files[$name]
                $path = "$($item.Path)$name"
                if ($entry.ContainsKey('files')) {
                    $pending.Push(@{ Node = $entry; Path = "$path/"; Depth = $item.Depth + 1 }); continue
                }
                $files++
                if ($files -gt 100000) { throw 'ASAR file count exceeds limit' }
                if ($sample.Count -lt 10 -and $path -match '\.js(?:\.|$)') { $sample.Add($path) }
                if ($entry.unpacked -or $entry.link) { continue }
                [long]$offset = $entry.offset; [long]$size = $entry.size
                if ($offset -lt 0 -or $size -lt 0 -or 8 + $headerSize + $offset + $size -gt $Stream.Length) { throw 'ASAR member outside archive' }
                if ($path -notmatch '(^|/)assets/[^/]+\.js$' -and $name -ne 'index.html') { continue }
                $bytes += $size
                if ($size -gt 64MB -or $bytes -gt 256MB) { throw 'Renderer scan exceeds size limit' }
                $Stream.Position = 8 + $headerSize + $offset
                $source = [Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$size))
                if ($name -eq 'index.html') {
                    if ($source -match 'id=["'']root["'']' -and $source -match '<script\b[^>]*src=') { $rendererEntry = $true }
                } else {
                    $assetCount++
                    foreach ($marker in $markers) { if ($source.Contains($marker)) { $null = $evidence.Add($marker) } }
                }
            }
        }
        # shortcut: lexical markers do not prove mounting; use an interactive desktop runner for that assertion.
        return @{ checks = [ordered]@{
            rendererEntry = $rendererEntry
            composerEditor = $evidence.Contains('data-codex-composer') -and $evidence.Contains('data-composer-footer-responsive')
            composerController = $evidence.Contains('composerController')
            taskIdentity = $evidence.Contains('conversationId') -and ($evidence.Contains('hostId') -or ($evidence.Contains('executionTargetHostId') -and $evidence.Contains('isAeonThread')))
            modelControlAnchor = ($ComposerSource.Contains('[data-codex-intelligence-trigger]') -and $evidence.Contains('data-codex-intelligence-trigger')) -or ($ComposerSource.Contains('[data-composer-navigation-target="reasoning"]') -and $evidence.Contains('data-composer-navigation-target') -and $evidence.Contains('reasoning'))
            settingsNavigation = $evidence.Contains('data-settings-panel-slug')
        }; evidence = @{ assetsScanned = $assetCount; bytesScanned = $bytes; javascriptPaths = @($sample) } }
    } finally { $reader.Dispose() }
}

function Test-DesktopPackage([string]$Path) {
    if ((Get-Item -LiteralPath $Path).Length -gt 2GB) { throw 'Package exceeds size limit' }
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $names = [Collections.Generic.HashSet[string]]::new()
        foreach ($entry in $archive.Entries) { if (-not $names.Add($entry.FullName)) { throw 'Duplicate package members' } }
        $manifest = $archive.GetEntry('AppxManifest.xml')
        if (-not $manifest -or $manifest.Length -gt 1MB) { throw 'Missing or oversized package manifest' }
        $xmlReader = [IO.StreamReader]::new($manifest.Open())
        try { [xml]$xml = $xmlReader.ReadToEnd() } finally { $xmlReader.Dispose() }
        $identity = $xml.SelectSingleNode('/*[local-name()="Package"]/*[local-name()="Identity"]')
        $apps = @($xml.SelectNodes('//*[local-name()="Application"]') | Where-Object { $_.Id -eq 'App' })
        $asar = @($archive.Entries | Where-Object { $_.FullName -like '*/resources/app.asar' })
        if ($asar.Count -ne 1 -or $asar[0].Length -gt 2GB) { throw 'Expected one bounded desktop ASAR' }
        $temp = [IO.Path]::GetTempFileName()
        try {
            $inputStream = $asar[0].Open(); $outputStream = [IO.File]::Create($temp)
            try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
            $stream = [IO.File]::OpenRead($temp)
            try { $renderer = Read-RendererEvidence $stream; $checks = $renderer.checks } finally { $stream.Dispose() }
        } finally { Remove-Item -LiteralPath $temp -Force }
        $checks.packageIdentity = $identity.Name -eq 'OpenAI.Codex'
        $checks.primaryApplication = $apps.Count -eq 1 -and $names.Contains($apps[0].Executable.Replace('\', '/'))
        return @{
            desktopVersion = [string]$identity.Version; architecture = [string]$identity.ProcessorArchitecture
            sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant(); checks = $checks; evidence = $renderer.evidence
        }
    } finally { $archive.Dispose() }
}

if ($MyInvocation.InvocationName -eq '.') { return }
$url = 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix'
$report = [ordered]@{
    component = 'Loader'; source = $(if ($PackagePath) { 'local-package' } else { $url })
    commit = $env:GITHUB_SHA; status = 'check-error'
    limitations = 'Static source evidence only; activation, CDP ownership, live DOM, lifecycle and third-party plugins are NOT tested.'
}
$download = $null
try {
    if (-not $PackagePath) {
        $download = [IO.Path]::GetTempFileName()
        & curl.exe --fail --location --proto '=https' --proto-redir '=https' --max-time 600 --max-filesize 2147483648 --output $download $url
        if ($LASTEXITCODE -ne 0) { throw "Official package download failed (curl exit $LASTEXITCODE)" }
        $PackagePath = $download
    }
    $result = Test-DesktopPackage $PackagePath
    foreach ($key in $result.Keys) { $report[$key] = $result[$key] }
    $report.status = if (@($result.checks.Values | Where-Object { -not $_ }).Count) { 'suspected-incompatibility' } else { 'passed-static' }
} catch { $report.error = $_.Exception.Message }
finally { if ($download) { Remove-Item -LiteralPath $download -Force } }
$json = $report | ConvertTo-Json -Depth 5
$json | Set-Content -LiteralPath $ReportPath -Encoding utf8NoBOM
Write-Output $json
if ($env:GITHUB_STEP_SUMMARY) {
    @("## Loader desktop compatibility: $($report.status)", '', $report.limitations, '', '```json', $json, '```') |
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
}
if ($report.status -ne 'passed-static') { exit 1 }
