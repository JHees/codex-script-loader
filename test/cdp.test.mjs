import test from "node:test";
import assert from "node:assert/strict";
import { CdpInjector, assertLoopbackEndpoint, buildCdpInjectionCommands, pickCodexTargets } from "../src/cdp.mjs";

const targets = [
  { id: "codex-page", type: "page", title: "Codex", url: "app://codex", webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/codex" },
  { id: "other-page", type: "page", title: "Other", url: "https://example.com", webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/other" },
  { id: "worker", type: "worker", title: "Codex worker", url: "app://codex", webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/worker" }
];

test("target selection only accepts Codex page targets", () => {
  assert.deepEqual(pickCodexTargets(targets).map(target => target.id), ["codex-page"]);
  assert.doesNotThrow(() => assertLoopbackEndpoint("ws://127.0.0.1:9229/devtools/page/codex"));
  assert.doesNotThrow(() => assertLoopbackEndpoint("ws://[::1]:9229/devtools/page/codex"));
  assert.throws(() => assertLoopbackEndpoint("ws://192.168.1.4:9229/devtools/page/codex"), /loopback/);
  assert.throws(() => assertLoopbackEndpoint("ws://user:pass@127.0.0.1:9229/devtools/page/codex"), /loopback/);
});

test("injection command plan covers current and future documents", () => {
  const commands = buildCdpInjectionCommands("globalThis.__loader = true;");
  assert.deepEqual(commands.map(command => command.method), ["Runtime.enable", "Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate"]);
  assert.equal(commands[2].params.source, commands[3].params.expression);
});

test("fake CDP session receives safe injection commands without connecting to Codex", async () => {
  const calls = [];
  const injector = new CdpInjector({
    targetProvider: async () => targets,
    sessionFactory: async () => ({
      sendCommand: async (method, params) => { calls.push({ method, params }); return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "registration-1" } : {}; },
      close: async () => {}
    })
  });
  const result = await injector.inject("globalThis.__test = true;");
  assert.deepEqual(result, [{ targetId: "codex-page", injected: true, registrationId: "registration-1" }]);
  assert.deepEqual(calls.map(call => call.method), ["Runtime.enable", "Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate"]);
});
