import test from "node:test";
import assert from "node:assert/strict";
import { PageCompanionHost } from "../src/page-companion.mjs";

function descriptor(source = "module.exports = { invoke(operation) { return { operation }; } };") {
  return {
    id: "test.companion",
    permissions: ["browser-page-companion"],
    pageCompanion: {
      id: "chat",
      origin: "https://chatgpt.com",
      operations: ["probe_chat", "send_message"],
      source,
      fingerprint: "a".repeat(64),
    },
  };
}

function session() {
  const commands = [];
  let listener = null;
  return {
    commands,
    onEvent(callback) { listener = callback; return () => { listener = null; }; },
    emit(message) { listener?.(message); },
    async sendCommand(method, params) {
      commands.push({ method, params });
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "registration-1" };
      if (method === "Runtime.evaluate" && params?.awaitPromise && String(params.expression).includes("?.invoke(")) return { result: { value: { state: "ok" } } };
      return {};
    },
    async close() {},
  };
}

test("host binds one allowlisted page, reuses injection and invokes allowlisted operations", async () => {
  const target = { id: "chat-target", type: "page", url: "https://chatgpt.com/c/example", webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/chat" };
  const cdp = session();
  const host = new PageCompanionHost({ targetProvider: async () => [target], sessionFactory: async () => cdp });
  await host.setAuthorizedPlugins([descriptor()]);
  assert.deepEqual(await host.probe("test.companion"), { available: true, candidateCount: 1, bound: false, origin: "https://chatgpt.com" });
  await host.bind("test.companion");
  await host.bind("test.companion");
  assert.equal(cdp.commands.filter(command => command.method === "Page.addScriptToEvaluateOnNewDocument").length, 1);
  assert.deepEqual(await host.invoke("test.companion", "probe_chat", {}), { state: "ok" });
  await assert.rejects(() => host.invoke("test.companion", "arbitrary_script", {}), /not allowed/);
  await host.close();
});

test("host rejects non-allowlisted and ambiguous targets", async () => {
  const wrong = { id: "wrong", type: "page", url: "https://example.com/c/1", webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/wrong" };
  const chatA = { id: "a", type: "page", url: "https://chatgpt.com/c/a", webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/a" };
  const chatB = { id: "b", type: "page", url: "https://chatgpt.com/c/b", webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/b" };
  const host = new PageCompanionHost({ targetProvider: async () => [wrong, chatA, chatB], sessionFactory: async () => session() });
  await host.setAuthorizedPlugins([descriptor()]);
  assert.deepEqual(await host.probe("test.companion"), { available: false, candidateCount: 2, bound: false, origin: "https://chatgpt.com" });
  await assert.rejects(() => host.bind("test.companion"), /AMBIGUOUS/);
});

test("any main-frame navigation clears the binding and requires reauthorization", async () => {
  const target = { id: "chat-target", type: "page", url: "https://chatgpt.com/c/example", webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/chat" };
  const cdp = session();
  const host = new PageCompanionHost({ targetProvider: async () => [target], sessionFactory: async () => cdp });
  await host.setAuthorizedPlugins([descriptor()]);
  await host.bind("test.companion");
  cdp.emit({ method: "Page.frameNavigated", params: { frame: { url: "https://chatgpt.com/c/other" } } });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => host.invoke("test.companion", "probe_chat", {}), /BINDING_UNAVAILABLE/);
});
