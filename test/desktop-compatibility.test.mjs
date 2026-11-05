import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./helpers.mjs";

function asar(source) {
  const html = Buffer.from('<div id="root"></div><script src="./assets/123.abc.js"></script>');
  const body = Buffer.from(source);
  const header = Buffer.from(JSON.stringify({ files: { webview: { files: {
    "index.html": { offset: "0", size: html.length },
    assets: { files: { async: { files: { "123.abc.js": { offset: String(html.length), size: body.length } } } } },
  } } } }));
  const padding = Buffer.alloc((4 - header.length % 4) % 4);
  const prefix = Buffer.alloc(16);
  [4, 8 + header.length + padding.length, 4 + header.length + padding.length, header.length]
    .forEach((n, index) => prefix.writeUInt32LE(n, index * 4));
  return Buffer.concat([prefix, header, padding, html, body]);
}

test("offline desktop probe detects removed composer anchors and malformed archives", { skip: process.platform !== "win32" }, async () => {
  const root = await makeTempRoot();
  try {
    const common = 'data-codex-composer data-composer-footer-responsive composerController conversationId executionTargetHostId isAeonThread data-settings-panel-slug';
    await writeFile(path.join(root, "new.asar"), asar(common + ' data-composer-navigation-target reasoning'));
    await writeFile(path.join(root, "old.asar"), asar(common + ' data-codex-intelligence-trigger'));
    await writeFile(path.join(root, "missing.asar"), asar(common));
    await writeFile(path.join(root, "broken.asar"), asar(common).subarray(0, 20));
    const script = `
      $ErrorActionPreference='Stop'
      . ./scripts/check-desktop-compatibility.ps1
      $results=@{}
      foreach($name in @('new','old','missing','broken')) {
        $stream=[IO.File]::OpenRead((Join-Path $env:PROBE_FIXTURES "$name.asar"))
        try { $results[$name]=(Read-RendererEvidence $stream '[data-codex-intelligence-trigger] [data-composer-navigation-target="reasoning"]').checks }
        catch { $results[$name]=@{error=$true} }
        finally {$stream.Dispose()}
      }
      $stream=[IO.File]::OpenRead((Join-Path $env:PROBE_FIXTURES 'new.asar'))
      try { $results.oldHost=(Read-RendererEvidence $stream '[data-codex-intelligence-trigger]').checks }
      finally {$stream.Dispose()}
      $zip=Join-Path $env:PROBE_FIXTURES 'sample.msix'
      $archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
      try {
        $manifest=$archive.CreateEntry('AppxManifest.xml').Open()
        $writer=[IO.StreamWriter]::new($manifest)
        $writer.Write('<Package xmlns="urn:test"><Identity Name="OpenAI.Codex" Version="1.2.3.4" ProcessorArchitecture="x64"/><Applications><Application Id="App" Executable="app\\ChatGPT.exe"/></Applications></Package>')
        $writer.Dispose()
        $archive.CreateEntry('app/ChatGPT.exe') | Out-Null
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $env:PROBE_FIXTURES 'old.asar'),'app/resources/app.asar') | Out-Null
      } finally {$archive.Dispose()}
      $results.package=Test-DesktopPackage $zip
      $results | ConvertTo-Json -Depth 5 -Compress
    `;
    const result = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-Command", script], {
      encoding: "utf8", env: { ...process.env, PROBE_FIXTURES: root }, timeout: 30_000,
    }));
    assert.ok(Object.values(result.new).every(Boolean));
    assert.ok(Object.values(result.old).every(Boolean));
    assert.equal(result.missing.modelControlAnchor, false);
    assert.equal(result.oldHost.modelControlAnchor, false);
    assert.equal(result.broken.error, true);
    assert.equal(result.package.desktopVersion, "1.2.3.4");
    assert.equal(result.package.sha256.length, 64);
    assert.ok(Object.values(result.package.checks).every(Boolean));
    const reportPath = path.join(root, "error.json");
    assert.throws(() => execFileSync("pwsh", ["-NoProfile", "-File", "scripts/check-desktop-compatibility.ps1",
      "-PackagePath", path.join(root, "absent.msix"), "-ReportPath", reportPath], { stdio: "pipe", timeout: 30_000 }));
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).status, "check-error");
  } finally { await rm(root, { recursive: true, force: true }); }
});
