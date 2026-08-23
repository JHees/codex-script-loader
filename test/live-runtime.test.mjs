import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeScript, makeTempRoot } from "./helpers.mjs";
import { ExistingCodexInstanceError, LiveSupervisor, startWindowsLiveRuntime, waitForCdpReady } from "../src/live-runtime.mjs";
import { ScriptRegistry } from "../src/registry.mjs";

const packageInfo = {
  name: "OpenAI.Codex",
  packageFamilyName: "OpenAI.Codex_test",
  appUserModelId: "OpenAI.Codex_test!App",
  installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test",
  version: "1.0.0"
};

const target = {
  id: "codex-page",
  type: "page",
  title: "Codex",
  url: "app://-/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex"
};

test("readiness polling waits for a Codex page target", async () => {
  let attempts = 0;
  let clock = 0;
  const result = await waitForCdpReady(43127, {
    targetProvider: async () => ++attempts < 3 ? [] : [target],
    timeoutMs: 100,
    intervalMs: 10,
    now: () => clock,
    delayFn: async ms => { clock += ms; }
  });
  assert.equal(attempts, 3);
  assert.deepEqual(result, [target]);
});

test("managed launch refuses an existing official Codex instance before activation", async () => {
  let activated = false;
  await assert.rejects(() => startWindowsLiveRuntime({
    dataRoot: "C:\\loader-data",
    dependencies: {
      allowNonWindows: true,
      discoverWindowsCodex: async () => packageInfo,
      listWindowsCodexProcesses: async () => [{ processId: 100, parentProcessId: 0, name: "ChatGPT.exe" }],
      activateWindowsCodex: async () => { activated = true; }
    }
  }), error => error instanceof ExistingCodexInstanceError && error.code === "CODEX_ALREADY_RUNNING");
  assert.equal(activated, false);
});

test("managed launch activates loopback CDP, verifies ownership and injects", async () => {
  const root = await makeTempRoot();
  const events = [];
  const commands = [];
  let processChecks = 0;
  let activationArgs;
  const runtime = await startWindowsLiveRuntime({
    dataRoot: path.join(root, "data"),
    onEvent: event => events.push(event),
    dependencies: {
      allowNonWindows: true,
      discoverWindowsCodex: async () => packageInfo,
      listWindowsCodexProcesses: async () => ++processChecks === 1 ? [] : [{ processId: 4242, parentProcessId: 0, name: "ChatGPT.exe" }],
      allocateLoopbackPort: async () => 43127,
      activateWindowsCodex: async (_package, args) => { activationArgs = args; return { processId: 4242 }; },
      listTargets: async () => [target],
      listWindowsLoopbackListeners: async () => [{ address: "127.0.0.1", port: 43127, processId: 4242 }],
      connectCdpSession: async () => ({
        sendCommand: async method => {
          commands.push(method);
          return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "future-1" } : {};
        },
        onEvent: () => () => {},
        close: async () => {}
      })
    }
  });
  assert.deepEqual(activationArgs, [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=43127",
    "--remote-allow-origins=http://127.0.0.1:43127"
  ]);
  assert.deepEqual(commands, [
    "Runtime.enable",
    "Page.enable",
    "Runtime.addBinding",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate",
    "Runtime.enable",
    "Page.enable",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate"
  ]);
  assert.equal(runtime.supervisor.snapshot().phase, "healthy");
  assert.equal(runtime.supervisor.snapshot().targetCount, 1);
  assert.equal(events[0].type, "scripts-injected");
  await runtime.close();
});

test("managed launch rejects a loopback listener owned by another process", async () => {
  const root = await makeTempRoot();
  let processChecks = 0;
  await assert.rejects(() => startWindowsLiveRuntime({
    dataRoot: path.join(root, "data"),
    dependencies: {
      allowNonWindows: true,
      discoverWindowsCodex: async () => packageInfo,
      listWindowsCodexProcesses: async () => ++processChecks === 1 ? [] : [{ processId: 4242, parentProcessId: 0, name: "ChatGPT.exe" }],
      allocateLoopbackPort: async () => 43127,
      activateWindowsCodex: async () => ({ processId: 4242 }),
      listTargets: async () => [target],
      listWindowsLoopbackListeners: async () => [{ address: "127.0.0.1", port: 43127, processId: 9999 }]
    }
  }), /ownership/);
});

test("supervisor reloads external config changes and target replacements", async () => {
  const root = await makeTempRoot();
  const dataRoot = path.join(root, "data");
  const registry = await new ScriptRegistry(dataRoot).init();
  const writer = await new ScriptRegistry(dataRoot).init();
  const source = await makeScript(path.join(root, "source"), { id: "test.live" });
  await writer.install(source, { enabled: false });
  const injected = [];
  let activeTargets = [target];
  const supervisor = new LiveSupervisor({
    registry,
    targetProvider: async () => activeTargets,
    injector: { inject: async (sourceText, { targets }) => { injected.push(sourceText); return targets.map(item => ({ targetId: item.id, injected: true })); } }
  });
  assert.equal((await supervisor.tick()).changed, true);
  assert.equal((await supervisor.tick()).changed, false);

  await writer.setEnabled("test.live", true);
  assert.equal((await supervisor.tick()).changed, true);
  assert.match(injected.at(-1), /__testScriptRuns/);

  activeTargets = [{ ...target, id: "replacement", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/replacement" }];
  assert.equal((await supervisor.tick()).changed, true);
  assert.equal(supervisor.snapshot().reloadCount, 3);
});

test("supervisor reports renderer script failures as degraded without exposing source", async () => {
  const root = await makeTempRoot();
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  const source = await makeScript(path.join(root, "source"), { id: "test.failed-runtime" });
  await registry.install(source, { enabled: true });
  const supervisor = new LiveSupervisor({
    registry,
    targetProvider: async () => [target],
    injector: {
      inject: async () => [{
        targetId: target.id,
        injected: true,
        scriptStatuses: [{ id: "test.failed-runtime", version: "1.0.0", status: "failed" }]
      }]
    }
  });
  await supervisor.tick();
  const status = supervisor.snapshot();
  assert.equal(status.phase, "degraded");
  assert.equal(status.lastError, "1 renderer scripts reported a failed state");
  assert.deepEqual(status.scriptStatuses, [{ id: "test.failed-runtime", version: "1.0.0", status: "failed" }]);
  assert.equal(JSON.stringify(status).includes("__testScriptRuns"), false);
});
