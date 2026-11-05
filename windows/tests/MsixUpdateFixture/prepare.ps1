param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$Root=[IO.Path]::GetFullPath($Root)
if(Get-AppxPackage -Name 'CodexScriptLoader.Test.Msix'){throw 'A prior test package exists; preserve it and inspect first'}
$payload=Join-Path $Root 'payload'
$app=Join-Path $payload 'resources/app'
New-Item -ItemType Directory -Force -Path $app | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'main.cjs') -Destination $app
'{"name":"loader-msix-fixture","version":"1.0.0","main":"main.cjs"}' | Set-Content (Join-Path $app 'package.json') -Encoding utf8NoBOM
@{reportRoot=$Root} | ConvertTo-Json | Set-Content (Join-Path $app 'settings.json') -Encoding utf8NoBOM
$vswhere='C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe'
$vs=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vc=Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
$vars=& $env:COMSPEC /d /s /c "`"$vc`" >nul && set"
foreach($line in $vars){$i=$line.IndexOf('=');if($i -gt 0){[Environment]::SetEnvironmentVariable($line.Substring(0,$i),$line.Substring($i+1),'Process')}}
& cl.exe /nologo /W4 /WX /EHsc /MT /LD (Join-Path $PSScriptRoot 'register.cpp') "/Fe:$app/register.node" "/Fo:$Root/register.obj" /link "/IMPLIB:$Root/register.lib"
if($LASTEXITCODE -ne 0){throw 'Fixture addon build failed'}
Add-Type -AssemblyName System.Drawing
$assets=Join-Path $payload 'Assets';New-Item -ItemType Directory -Force $assets | Out-Null
foreach($size in @(44,150)){$bitmap=[Drawing.Bitmap]::new($size,$size);$canvas=[Drawing.Graphics]::FromImage($bitmap);$canvas.Clear([Drawing.Color]::DarkSlateBlue);$bitmap.Save((Join-Path $assets "$size.png"));$canvas.Dispose();$bitmap.Dispose()}
$subject='CN=CodexScriptLoader MSIX Acceptance '+[guid]::NewGuid().ToString('N')
$cert=New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2)
@{thumbprint=$cert.Thumbprint;subject=$subject;packageName='CodexScriptLoader.Test.Msix'} | ConvertTo-Json | Set-Content (Join-Path $Root 'identity.json') -Encoding utf8NoBOM
Export-Certificate -Cert $cert -FilePath (Join-Path $Root 'test.cer') | Out-Null
$sdk='C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64'
foreach($version in @(1,2)){
 "$version" | Set-Content (Join-Path $app 'version.txt') -Encoding utf8NoBOM
 @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap rescap">
<Identity Name="CodexScriptLoader.Test.Msix" Publisher="$subject" Version="$version.0.0.0" ProcessorArchitecture="x64" />
<Properties><DisplayName>Loader MSIX isolated test</DisplayName><PublisherDisplayName>Loader acceptance test</PublisherDisplayName><Logo>Assets\150.png</Logo></Properties>
<Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
<Resources><Resource Language="en-us" /></Resources>
<Applications><Application Id="App" Executable="electron.exe" EntryPoint="Windows.FullTrustApplication"><uap:VisualElements DisplayName="Loader MSIX isolated test" Description="Temporary update acceptance test" BackgroundColor="transparent" Square44x44Logo="Assets\44.png" Square150x150Logo="Assets\150.png" /></Application></Applications>
<Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
"@ | Set-Content (Join-Path $payload 'AppxManifest.xml') -Encoding utf8NoBOM
 & "$sdk/makeappx.exe" pack /d $payload /p "$Root/fixture-$version.msix" /o *> "$Root/makeappx-$version.log"
 if($LASTEXITCODE -ne 0){Get-Content "$Root/makeappx-$version.log" -Tail 15;throw 'MSIX build failed'}
 & "$sdk/signtool.exe" sign /fd SHA256 /sha1 $cert.Thumbprint /s My "$Root/fixture-$version.msix" *> "$Root/sign-$version.log"
 if($LASTEXITCODE -ne 0){Get-Content "$Root/sign-$version.log";throw 'MSIX signing failed'}
}
Write-Output "MSIX_FIXTURES_PREPARED: install only after explicitly approving trust for the certificate in identity.json."
Get-Content (Join-Path $Root 'identity.json')
