import test from "node:test";
import assert from "node:assert/strict";
import { CdpInjector, assertLoopbackEndpoint, buildCdpInjectionCommands, connectCdpSession, pickCodexTargets } from "../src/cdp.mjs";

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

test("injector tolerates a stale future-document registration after renderer reload", async () => {
  const calls = [];
  let registration = 0;
  const injector = new CdpInjector({
    targetProvider: async () => targets,
    sessionFactory: async () => ({
      sendCommand: async method => {
        calls.push(method);
        if (method === "Page.removeScriptToEvaluateOnNewDocument") throw new Error("unknown identifier");
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: `registration-${++registration}` };
        return {};
      },
      close: async () => {}
    })
  });
  await injector.inject("globalThis.__first = true;");
  const result = await injector.inject("globalThis.__second = true;", { targets });
  assert.equal(result[0].registrationId, "registration-2");
  assert.deepEqual(calls.slice(4), [
    "Page.removeScriptToEvaluateOnNewDocument",
    "Runtime.enable",
    "Page.enable",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate"
  ]);
});

test("injector removes a new future registration when current evaluation is rejected", async () => {
  const calls = [];
  let closed = false;
  const injector = new CdpInjector({
    targetProvider: async () => targets,
    sessionFactory: async () => ({
      sendCommand: async (method, params) => {
        calls.push({ method, params });
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bad-registration" };
        if (method === "Runtime.evaluate") return { exceptionDetails: { text: "syntax error" } };
        return {};
      },
      close: async () => { closed = true; }
    })
  });
  await assert.rejects(() => injector.inject("not valid source"), /rejected/);
  assert.equal(calls.at(-1).method, "Page.removeScriptToEvaluateOnNewDocument");
  assert.equal(calls.at(-1).params.identifier, "bad-registration");
  assert.equal(closed, true);
});

test("CDP session correlates WebSocket responses without a real browser", async () => {
  class FakeWebSocket {
    constructor() {
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(payload) {
      const request = JSON.parse(payload);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, result: { echoed: request.method } }) }));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const session = await connectCdpSession("ws://127.0.0.1:43127/devtools/page/codex", { WebSocketImpl: FakeWebSocket, timeoutMs: 100 });
  assert.deepEqual(await session.sendCommand("Runtime.enable"), { echoed: "Runtime.enable" });
  session.close();
});

test("CDP session times out commands and rejects non-loopback endpoints", async () => {
  class SilentWebSocket {
    constructor() {
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  await assert.rejects(() => connectCdpSession("ws://example.com/devtools/page/codex", { WebSocketImpl: SilentWebSocket }), /loopback/);
  const session = await connectCdpSession("ws://127.0.0.1:43127/devtools/page/codex", { WebSocketImpl: SilentWebSocket, timeoutMs: 10 });
  await assert.rejects(() => session.sendCommand("Runtime.enable"), /timed out/);
  session.close();
});
