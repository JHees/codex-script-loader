import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  BRIDGE_GLOBAL,
  LoaderHostBridge,
  MAX_REQUEST_BYTES,
  buildBridgeClientSource,
  parseRequest,
} from "../src/loader-bridge.mjs";

const target = {
  id: "codex-page",
  type: "page",
  title: "Codex",
  url: "app://-/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex",
};

function fakeSession() {
  const commands = [];
  const listeners = new Set();
  return {
    commands,
    closed: false,
    async sendCommand(method, params = {}) {
      commands.push({ method, params });
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bridge-registration" };
      return {};
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) {
      for (const listener of listeners) listener(message);
    },
    async close() { this.closed = true; },
  };
}

test("bridge parser accepts only the Loader management command allowlist", () => {
  assert.deepEqual(parseRequest(JSON.stringify({ version: 1, id: "a", command: "get_app_status" })), {
    id: "a", command: "get_app_status", payload: {},
  });
  assert.deepEqual(parseRequest(JSON.stringify({ version: 1, id: "b", command: "reload_scripts", payload: { ignored: true } })), {
    id: "b", command: "reload_scripts", payload: { live: true },
  });
  assert.deepEqual(parseRequest(JSON.stringify({ version: 1, id: "c", command: "reload_plugins", payload: { ids: ["local.example"] } })), {
    id: "c", command: "reload_plugins", payload: { live: true, ids: ["local.example"] },
  });
  assert.deepEqual(parseRequest(JSON.stringify({ version: 1, id: "u", command: "get_update_status" })), {
    id: "u", command: "get_update_status", payload: {},
  });
  assert.throws(() => parseRequest(JSON.stringify({ version: 1, id: "c", command: "remove_script" })), /not allowed/);
  assert.throws(() => parseRequest("{"), /invalid JSON/);
  assert.throws(() => parseRequest("x".repeat(MAX_REQUEST_BYTES + 1)), /too large/);
});

test("bridge client correlates replies and times out without exposing another API", async () => {
  let outbound = null;
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    __binding(payload) { outbound = JSON.parse(payload); },
  });
  vm.runInContext(buildBridgeClientSource("__binding", { requestTimeoutMs: 20 }), context);
  assert.equal(context[BRIDGE_GLOBAL].connected, true);
  const pending = context[BRIDGE_GLOBAL].request("get_app_status", {});
  assert.equal(outbound.command, "get_app_status");
  context[BRIDGE_GLOBAL].receive({ id: outbound.id, ok: true, result: { loader: "healthy" } });
  assert.deepEqual(await pending, { loader: "healthy" });
  await assert.rejects(() => context[BRIDGE_GLOBAL].request("get_app_status", {}), /timed out/);
});

test("GitHub preview is allowlisted and gets a bounded download wait without retry", async () => {
  const payload = { url: "https://github.com/Example/plugin-repository" };
  assert.deepEqual(parseRequest(JSON.stringify({ version: 1, id: "github", command: "preview_plugin_github", payload })).payload, payload);
  const waits = [];
  const outbound = [];
  const context = vm.createContext({
    setTimeout(fn, ms) { waits.push(ms); return 1; }, clearTimeout() {},
    __binding(text) { outbound.push(JSON.parse(text)); },
  });
  vm.runInContext(buildBridgeClientSource("__binding"), context);
  const pending = context[BRIDGE_GLOBAL].request("preview_plugin_github", payload);
  assert.equal(waits[0], 150000);
  context[BRIDGE_GLOBAL].receive({ id: outbound[0].id, ok: false, error: "GitHub request failed" });
  await assert.rejects(pending, /GitHub request failed/);
  assert.equal(outbound.length, 1);
});

test("persistent bridge attaches to the exact renderer, dispatches and closes cleanly", async () => {
  const session = fakeSession();
  const dispatched = [];
  const bridge = new LoaderHostBridge({
    bindingName: "__test_loader_binding",
    targetProvider: async () => [target],
    sessionFactory: async () => session,
    dispatch: async (command, payload) => {
      dispatched.push({ command, payload });
      if (command === "reload_scripts") return { targetCount: 1, summary: [{ id: "private-script" }], safeMode: false, targets: [{ secret: "hidden" }] };
      return { loader: "healthy", targetCount: 1 };
    },
  });
  await bridge.sync();
  assert.deepEqual(session.commands.slice(0, 5).map(item => item.method), [
    "Runtime.enable",
    "Page.enable",
    "Runtime.addBinding",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate",
  ]);

  session.emit({
    method: "Runtime.bindingCalled",
    params: {
      name: "__test_loader_binding",
      executionContextId: 7,
      payload: JSON.stringify({ version: 1, id: "request-1", command: "get_app_status", payload: {} }),
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dispatched, [{ command: "get_app_status", payload: {} }]);
  const response = session.commands.at(-1);
  assert.equal(response.method, "Runtime.evaluate");
  assert.equal(response.params.contextId, 7);
  assert.match(response.params.expression, /request-1/);

  session.emit({
    method: "Runtime.bindingCalled",
    params: {
      name: "__test_loader_binding",
      executionContextId: 7,
      payload: JSON.stringify({ version: 1, id: "request-2", command: "reload_scripts", payload: {} }),
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const reloadResponse = session.commands.at(-1).params.expression;
  assert.match(reloadResponse, /scriptCount/);
  assert.doesNotMatch(reloadResponse, /private-script|hidden/);

  await bridge.close();
  assert.equal(session.closed, true);
  assert.ok(session.commands.some(item => item.method === "Runtime.removeBinding"));
  assert.ok(session.commands.some(item => item.method === "Page.removeScriptToEvaluateOnNewDocument"));
});

test("bridge rejects non-Codex targets before opening a session", async () => {
  let opened = false;
  const bridge = new LoaderHostBridge({
    targetProvider: async () => [{ ...target, url: "https://example.com" }],
    sessionFactory: async () => { opened = true; return fakeSession(); },
    dispatch: async () => ({}),
  });
  assert.deepEqual(await bridge.sync(), []);
  assert.equal(opened, false);
  await bridge.close();
});
