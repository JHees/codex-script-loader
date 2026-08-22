import test from "node:test";
import assert from "node:assert/strict";
import {
  activateWindowsCodex,
  buildWindowsArgumentString,
  discoverWindowsCodex,
  listWindowsCodexProcesses,
  listWindowsLoopbackListeners,
  quoteWindowsArgument,
  validateWindowsPackage
} from "../src/windows-platform.mjs";

const packageRecord = {
  packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
  installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0",
  version: "26.727.6591.0"
};

test("Windows package discovery validates Codex identity and location", async () => {
  const discovered = await discoverWindowsCodex({ runPowerShell: async script => {
    assert.match(script, /Get-AppxPackage/u);
    assert.match(script, /Get-AppxPackageManifest/u);
    return packageRecord;
  } });
  assert.equal(discovered.appUserModelId, "OpenAI.Codex_2p2nqsd0c76g0!App");
  const alternate = validateWindowsPackage({ ...packageRecord, appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!Desktop" });
  assert.equal(alternate.appUserModelId, "OpenAI.Codex_2p2nqsd0c76g0!Desktop");
  assert.equal(discovered.version, packageRecord.version);
  assert.throws(() => validateWindowsPackage({ ...packageRecord, packageFamilyName: "Other.App_test" }), /family/);
  assert.throws(() => validateWindowsPackage({ ...packageRecord, installLocation: "C:\\Temp\\Codex" }), /location/);
});

test("Windows argument quoting preserves spaces, quotes, and trailing slashes", () => {
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument(""), '""');
  assert.equal(quoteWindowsArgument("two words"), '"two words"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument("C:\\with space\\"), '"C:\\with space\\\\"');
  assert.equal(buildWindowsArgumentString(["--flag", "two words"]), '--flag "two words"');
  assert.throws(() => buildWindowsArgumentString(["ok", "bad\narg"]), /control/);
});

test("Windows process inspection returns only normalized Codex package processes", async () => {
  const processes = await listWindowsCodexProcesses(packageRecord, { runPowerShell: async script => {
    assert.match(script, /Get-CimInstance/u);
    return [
      { ProcessId: 11, ParentProcessId: 1, Name: "ChatGPT.exe" },
      { processId: 12, parentProcessId: 11, name: "codex.exe" },
      { processId: 13, name: "other.exe" }
    ];
  } });
  assert.deepEqual(processes, [
    { processId: 11, parentProcessId: 1, name: "ChatGPT.exe" },
    { processId: 12, parentProcessId: 11, name: "codex.exe" }
  ]);
});

test("Windows packaged activation passes an encoded payload and returns pid", async () => {
  let scriptText = "";
  const result = await activateWindowsCodex(packageRecord, ["--remote-debugging-port=43127", "--label=two words"], {
    runPowerShell: async script => {
      scriptText = script;
      return { processId: 4242 };
    }
  });
  assert.equal(result.processId, 4242);
  assert.equal(result.arguments, '--remote-debugging-port=43127 "--label=two words"');
  assert.match(scriptText, /Add-Type -TypeDefinition/u);
  assert.doesNotMatch(scriptText, /--label=two words/u);
});

test("Windows listener inspection only returns the requested loopback port", async () => {
  const listeners = await listWindowsLoopbackListeners(43127, {
    runPowerShell: async () => [
      { address: "127.0.0.1", port: 43127, processId: 101 },
      { address: "::1", port: 43127, processId: 102 },
      { address: "0.0.0.0", port: 43127, processId: 103 },
      { address: "127.0.0.1", port: 43128, processId: 104 }
    ]
  });
  assert.deepEqual(listeners, [
    { address: "127.0.0.1", port: 43127, processId: 101 },
    { address: "::1", port: 43127, processId: 102 }
  ]);
});
