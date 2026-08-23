import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  activateWindowsCodex,
  discoverWindowsCodex,
  listWindowsCodexProcesses,
  listWindowsLoopbackListeners,
  validateWindowsPackage
} from "../src/windows-platform.mjs";

const packageRecord = {
  packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
  installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0",
  executable: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
  version: "26.727.6591.0"
};

test("Windows package discovery uses transparent filesystem inspection", async () => {
  const root = "C:\\Program Files\\WindowsApps";
  const names = [
    "OpenAI.Codex_26.700.1.0_x64__2p2nqsd0c76g0",
    "OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0",
    "Other.App_1.0.0.0_x64__other"
  ];
  const discovered = await discoverWindowsCodex({
    windowsAppsRoot: root,
    readDirectory: async () => names.map(name => ({ name, isDirectory: () => true })),
    accessFile: async executable => {
      if (!executable.endsWith(path.win32.join(names[1], "app", "ChatGPT.exe"))) throw new Error("missing");
    }
  });
  assert.equal(discovered.version, "26.727.6591.0");
  assert.equal(discovered.appUserModelId, "OpenAI.Codex_2p2nqsd0c76g0!App");
  assert.throws(() => validateWindowsPackage({ ...packageRecord, packageFamilyName: "Other.App_test" }), /family/);
  assert.throws(() => validateWindowsPackage({ ...packageRecord, installLocation: "C:\\Temp\\Codex" }), /location/);
});

test("Windows process inspection parses tasklist without PowerShell", async () => {
  let invocation;
  const processes = await listWindowsCodexProcesses(packageRecord, { execFileFn: async (file, args) => {
    invocation = { file, args };
    return { stdout: '"ChatGPT.exe","11","Console","1","100 K"\n"codex.exe","12","Console","1","90 K"\n"other.exe","13","Console","1","50 K"\n' };
  } });
  assert.deepEqual(invocation, { file: "tasklist.exe", args: ["/FO", "CSV", "/NH"] });
  assert.deepEqual(processes, [
    { processId: 11, parentProcessId: 0, name: "ChatGPT.exe" },
    { processId: 12, parentProcessId: 0, name: "codex.exe" }
  ]);
});

test("Windows activation directly spawns the validated Store executable", async () => {
  let invocation;
  const child = { pid: 4242, unrefCalled: false, unref() { this.unrefCalled = true; } };
  const args = ["--remote-debugging-port=43127", "--label=two words"];
  const result = await activateWindowsCodex(packageRecord, args, { spawn: (file, actualArgs, options) => {
    invocation = { file, args: actualArgs, options };
    return child;
  } });
  assert.equal(result.processId, 4242);
  assert.deepEqual(result.arguments, args);
  assert.equal(invocation.file, packageRecord.executable);
  assert.deepEqual(invocation.args, args);
  assert.equal(invocation.options.detached, true);
  assert.equal(child.unrefCalled, true);
});

test("Windows listener inspection accepts only the requested loopback port", async () => {
  let invocation;
  const listeners = await listWindowsLoopbackListeners(43127, { execFileFn: async (file, args) => {
    invocation = { file, args };
    return { stdout: [
      "  TCP    127.0.0.1:43127      0.0.0.0:0      LISTENING       101",
      "  TCP    [::1]:43127          [::]:0         LISTENING       102",
      "  TCP    0.0.0.0:43127        0.0.0.0:0      LISTENING       103",
      "  TCP    127.0.0.1:43128      0.0.0.0:0      LISTENING       104"
    ].join("\n") };
  } });
  assert.deepEqual(invocation, { file: "netstat.exe", args: ["-ano", "-p", "tcp"] });
  assert.deepEqual(listeners, [
    { address: "127.0.0.1", port: 43127, processId: 101 },
    { address: "::1", port: 43127, processId: 102 }
  ]);
});
