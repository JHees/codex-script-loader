import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { assertLoopbackWebSocketEndpoint, buildTransportClientSource, MAX_TRANSPORT_CLOSED_RETENTION_MS, MAX_TRANSPORT_CLOSED_RETENTION_COUNT, MAX_TRANSPORT_DISPATCH_IN_FLIGHT, parseTransportRequest } from "../src/loopback-transport.mjs";

function fakeSession({ failMethod = null, evaluationException = false, eventSubscriptionThrows = false } = {}) {
  const commands = [];
  const listeners = new Set();
  return {
    commands,
    async sendCommand(method, params = {}) {
      commands.push({ method, params });
      if (method === failMethod) throw new Error(`fixture failure: ${method}`);
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "transport-registration" };
      if (method === "Runtime.evaluate" && evaluationException) return { exceptionDetails: { text: "fixture failure" } };
      return {};
    },
    onEvent(listener) {
      if (eventSubscriptionThrows) throw new Error("fixture event subscription failure");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) { for (const listener of listeners) listener(message); },
    listenerCount() { return listeners.size; },
    async close() {},
  };
}

function fakeWebSocket({ emitClose = true } = {}) {
  const listeners = new Map();
  const socket = {
    readyState: 0,
    sent: [],
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener));
    },
    send(data) { this.sent.push(data); },
    close() { this.readyState = 3; if (emitClose) for (const listener of listeners.get("close") || []) listener({ code: 1000 }); },
    open() { this.readyState = 1; for (const listener of listeners.get("open") || []) listener({}); },
    receive(data) { for (const listener of listeners.get("message") || []) listener({ data }); },
  };
  return socket;
}

test("loopback transport accepts only explicit IPv4 ws endpoints and bounded safe paths", () => {
  assert.equal(assertLoopbackWebSocketEndpoint("ws://127.0.0.1:53478/renderer").href, "ws://127.0.0.1:53478/renderer");
  assert.equal(assertLoopbackWebSocketEndpoint("ws://127.0.0.1:1/a_b-1").port, "1");
  for (const endpoint of [
    "ws://localhost:53478/renderer",
    "ws://127.0.0.2:53478/renderer",
    "ws://[::1]:53478/renderer",
    "wss://127.0.0.1:53478/renderer",
    "ws://127.0.0.1:53478/renderer?token=secret",
    "ws://127.0.0.1:53478/renderer#fragment",
    "ws://user:pass@127.0.0.1:53478/renderer",
    "ws://127.0.0.1:53478/devtools/page/1",
    "ws://127.0.0.1:53478/../renderer",
    "ws://127.0.0.1:53478/renderer\\x",
    "ws://127.0.0.1:0/renderer",
    "ws://127.0.0.1:65536/renderer",
  ]) {
    assert.throws(() => assertLoopbackWebSocketEndpoint(endpoint), /loopback WebSocket endpoint/);
  }
  assert.throws(() => assertLoopbackWebSocketEndpoint("ws://127.0.0.1:53478/renderer", { forbiddenPorts: [53478] }), /CDP/);
});

test("transport protocol is strict and carries plugin identity on every operation", () => {
  assert.deepEqual(parseTransportRequest(JSON.stringify({
    version: 1,
    id: "open-1",
    op: "open",
    pluginId: "bridge.example",
    endpoint: "ws://127.0.0.1:53478/renderer"
  })), {
    version: 1,
    id: "open-1",
    op: "open",
    pluginId: "bridge.example",
    endpoint: "ws://127.0.0.1:53478/renderer"
  });
  assert.throws(() => parseTransportRequest(JSON.stringify({ version: 1, id: "x", op: "poll", connectionId: "c" })), /pluginId/);
  assert.throws(() => parseTransportRequest(JSON.stringify({ version: 1, id: "x", op: "send", pluginId: "bridge.example", connectionId: "c", data: "x", extra: true })), /exact/);
  assert.throws(() => parseTransportRequest(JSON.stringify({ version: 1, id: "x", op: "open", pluginId: "bridge.example", endpoint: "ws://10.0.0.1:3/renderer" })), /loopback WebSocket endpoint/);
  assert.throws(
    () => parseTransportRequest(JSON.stringify({ version: 1, id: "x", op: "send", pluginId: "bridge.example", connectionId: "0123456789abcdef0123456789abcdef", data: 1 })),
    error => error.code === "PROTOCOL_ERROR"
  );
});

test("host transport binds only authorized plugins, queues text frames, and drops target state", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  const socket = fakeWebSocket();
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_binding",
    forbiddenPorts: [43127],
    webSocketFactory: () => socket,
  });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  assert.ok(session.commands.some(command => command.method === "Runtime.addBinding"));

  const state = host.sessions.get("codex-page");
  await assert.rejects(() => host.handleRequest(state, { version: 1, id: "denied", op: "open", pluginId: "other.plugin", endpoint: "ws://127.0.0.1:53478/renderer" }), /not authorized/);
  const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  socket.open();
  await opening;
  const connection = [...state.connections.values()][0];
  socket.receive("daemon-frame");
  assert.deepEqual(await host.handleRequest(state, { version: 1, id: "poll", op: "poll", pluginId: "bridge.example", connectionId: connection.id, waitMs: 0 }), { events: [{ type: "message", data: "daemon-frame" }], closed: false });
  await host.handleRequest(state, { version: 1, id: "send", op: "send", pluginId: "bridge.example", connectionId: connection.id, data: "renderer-frame" });
  assert.deepEqual(socket.sent, ["renderer-frame"]);
  await host.detachSession("codex-page");
  assert.equal(host.sessions.size, 0);
  assert.equal(socket.readyState, 3);
});

test("transport delivers a final text frame before the WebSocket close event", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  const socket = fakeWebSocket();
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_ordering",
    webSocketFactory: () => socket,
  });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const state = host.sessions.get("codex-page");
  const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  socket.open();
  await opening;
  const connection = [...state.connections.values()][0];
  socket.receive("final-frame");
  socket.close();
  assert.deepEqual(await host.handleRequest(state, { version: 1, id: "poll", op: "poll", pluginId: "bridge.example", connectionId: connection.id, waitMs: 0 }), {
    events: [{ type: "message", data: "final-frame" }, { type: "close", code: 1000 }],
    closed: true,
  });
});

test("transport keeps a closed connection until all queued frames have been polled", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  const socket = fakeWebSocket();
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_ordered_queue", webSocketFactory: () => socket });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const state = host.sessions.get("codex-page");
  const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  socket.open();
  await opening;
  const connection = [...state.connections.values()][0];
  socket.receive("a".repeat(64 * 1024));
  socket.receive("b".repeat(64 * 1024));
  socket.close();
  const first = await host.handleRequest(state, { version: 1, id: "poll-1", op: "poll", pluginId: "bridge.example", connectionId: connection.id, waitMs: 0 });
  assert.equal(first.closed, false);
  assert.equal(first.events.length, 1);
  const second = await host.handleRequest(state, { version: 1, id: "poll-2", op: "poll", pluginId: "bridge.example", connectionId: connection.id, waitMs: 0 });
  assert.equal(second.closed, true);
  assert.deepEqual(second.events.map(event => event.type), ["message", "close"]);
});

test("transport sweeps expired closed connections before enforcing the limit", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  let nextSocket;
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_sweep",
    webSocketFactory: () => (nextSocket = fakeWebSocket()),
  });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const state = host.sessions.get("codex-page");
  let disposed = 0;
  for (let index = 0; index < 32; index += 1) {
    state.connections.set(`expired-${index}`, {
      pluginId: "bridge.example",
      closed: true,
      closedAt: Date.now() - MAX_TRANSPORT_CLOSED_RETENTION_MS - 1,
      dispose() { disposed += 1; },
    });
  }
  const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  nextSocket.open();
  const result = await opening;
  assert.equal(typeof result.connectionId, "string");
  assert.equal(disposed, 32);
  assert.equal(state.connections.size, 1);
});

test("transport rejects an async open after authorization is revoked and closes the orphan socket", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  let releaseFactory;
  let rawSocket;
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_authorization_race",
    webSocketFactory: () => new Promise(resolve => {
      releaseFactory = () => {
        rawSocket = fakeWebSocket({ emitClose: false });
        resolve(rawSocket);
      };
    }),
  });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const state = host.sessions.get("codex-page");
  const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  assert.equal(typeof releaseFactory, "function");
  await host.setAuthorizedPlugins([]);
  releaseFactory();
  await assert.rejects(opening, /authorized|unavailable|disconnected|closed/);
  assert.equal(rawSocket.readyState, 3);
  assert.equal(state.connections.size, 0);
});

test("transport keeps an in-flight open across an idempotent authorization refresh", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  let releaseFactory;
  let rawSocket;
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_authorization_refresh",
    webSocketFactory: () => new Promise(resolve => {
      releaseFactory = () => {
        rawSocket = fakeWebSocket({ emitClose: false });
        resolve(rawSocket);
      };
    }),
  });
  const descriptors = [{ id: "bridge.example", permissions: ["loopback-websocket"] }];
  await host.setAuthorizedPlugins(descriptors);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const state = host.sessions.get("codex-page");
  const generation = host.authorizationGeneration;
  const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  assert.equal(typeof releaseFactory, "function");
  await host.setAuthorizedPlugins([{ ...descriptors[0] }]);
  assert.equal(host.authorizationGeneration, generation);
  releaseFactory();
  rawSocket.open();
  const result = await opening;
  assert.equal(typeof result.connectionId, "string");
  await host.close();
});

test("transport rejects a factory result after target detach or host close", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  for (const mode of ["detach", "close"]) {
    const session = fakeSession();
    let releaseFactory;
    let rawSocket;
    const host = new LoopbackTransportHost({
      bindingName: `__test_transport_stale_factory_${mode}`,
      webSocketFactory: () => new Promise(resolve => {
        releaseFactory = () => {
          rawSocket = fakeWebSocket({ emitClose: false });
          resolve(rawSocket);
        };
      }),
    });
    await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
    await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
    const state = host.sessions.get("codex-page");
    const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
    if (mode === "detach") await host.detachSession("codex-page");
    else await host.close();
    releaseFactory();
    await assert.rejects(opening, /unavailable|disconnected|closed/);
    assert.equal(rawSocket.readyState, 3);
    assert.equal(state.connections.size, 0);
  }
});

test("transport rejects a connection that finishes opening after target detach or host close", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  for (const mode of ["detach", "close"]) {
    const session = fakeSession();
    const socket = fakeWebSocket({ emitClose: false });
    const host = new LoopbackTransportHost({
      bindingName: `__test_transport_stale_connection_${mode}`,
      webSocketFactory: () => socket,
    });
    await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
    await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
    const state = host.sessions.get("codex-page");
    const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
    await new Promise(resolve => setImmediate(resolve));
    if (mode === "detach") await host.detachSession("codex-page");
    else await host.close();
    socket.open();
    await assert.rejects(opening, /unavailable|disconnected|closed/);
    assert.equal(state.connections.size, 0);
  }
});

test("transport reserves concurrent opens and enforces the per-target total across plugins", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  const pending = [];
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_concurrent_limits",
    webSocketFactory: () => new Promise(resolve => {
      const socket = fakeWebSocket();
      pending.push({ resolve, socket });
    }),
  });
  await host.setAuthorizedPlugins([
    { id: "bridge.example", permissions: ["loopback-websocket"] },
    { id: "other.plugin", permissions: ["loopback-websocket"] },
  ]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const state = host.sessions.get("codex-page");
  const openings = Array.from({ length: 9 }, (_, index) => host.handleRequest(state, {
    version: 1,
    id: `open-${index}`,
    op: "open",
    pluginId: "bridge.example",
    endpoint: "ws://127.0.0.1:53478/renderer",
  }));
  const settledOpenings = Promise.allSettled(openings);
  assert.equal(pending.length, 8);
  for (const item of pending) item.resolve(item.socket);
  await new Promise(resolve => setImmediate(resolve));
  for (const item of pending) item.socket.open();
  const results = await settledOpenings;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 8);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);

  const existing = [...state.connections.values()];
  assert.equal(existing.length, 8);
  const extraSocket = fakeWebSocket();
  host.webSocketFactory = () => extraSocket;
  await assert.rejects(() => host.handleRequest(state, {
    version: 1,
    id: "other-open",
    op: "open",
    pluginId: "other.plugin",
    endpoint: "ws://127.0.0.1:53478/renderer",
  }), /limit/);
  assert.equal(state.connections.size, 8);
});

test("transport reserves the global concurrent connection limit across targets", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const pending = [];
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_global_concurrent_limit",
    webSocketFactory: () => new Promise(resolve => {
      const socket = fakeWebSocket();
      pending.push({ resolve, socket });
    }),
  });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  const states = [];
  for (let targetIndex = 0; targetIndex < 5; targetIndex += 1) {
    const session = fakeSession();
    await host.attachToSession({ id: `codex-page-${targetIndex}`, webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
    states.push(host.sessions.get(`codex-page-${targetIndex}`));
  }
  const openings = [];
  for (let index = 0; index < 33; index += 1) {
    const state = states[index < 32 ? Math.floor(index / 8) : 4];
    openings.push(host.handleRequest(state, {
      version: 1,
      id: `global-open-${index}`,
      op: "open",
      pluginId: "bridge.example",
      endpoint: "ws://127.0.0.1:53478/renderer",
    }));
  }
  const settledOpenings = Promise.allSettled(openings);
  assert.equal(pending.length, 32);
  for (const item of pending) item.resolve(item.socket);
  await new Promise(resolve => setImmediate(resolve));
  for (const item of pending) item.socket.open();
  const results = await settledOpenings;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 32);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(states.reduce((total, state) => total + state.connections.size, 0), 32);
  await host.close();
});

test("transport binding rollback removes the binding when future-script registration fails", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession({ failMethod: "Page.addScriptToEvaluateOnNewDocument" });
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_rollback_script" });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await assert.rejects(() => host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session), /fixture failure/);
  assert.ok(session.commands.some(command => command.method === "Runtime.removeBinding"));
  assert.equal(session.commands.some(command => command.method === "Page.removeScriptToEvaluateOnNewDocument"), false);
  assert.equal(session.listenerCount(), 0);
});

test("transport binding rollback attempts to remove a binding after add failure", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession({ failMethod: "Runtime.addBinding" });
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_rollback_binding" });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await assert.rejects(() => host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session), /fixture failure/);
  assert.ok(session.commands.some(command => command.method === "Runtime.removeBinding"));
  assert.equal(session.commands.some(command => command.method === "Page.removeScriptToEvaluateOnNewDocument"), false);
  assert.equal(session.listenerCount(), 0);
});

test("transport binding rollback removes binding and future script when event subscription fails", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession({ eventSubscriptionThrows: true });
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_rollback_subscription" });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await assert.rejects(() => host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session), /subscription/);
  assert.ok(session.commands.some(command => command.method === "Runtime.removeBinding"));
  assert.ok(session.commands.some(command => command.method === "Page.removeScriptToEvaluateOnNewDocument"));
  assert.equal(session.listenerCount(), 0);
});

test("transport binding rollback removes binding and future script when renderer evaluation fails", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession({ evaluationException: true });
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_rollback_evaluation" });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await assert.rejects(() => host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session), /rejected/);
  assert.ok(session.commands.some(command => command.method === "Runtime.removeBinding"));
  assert.ok(session.commands.some(command => command.method === "Page.removeScriptToEvaluateOnNewDocument"));
  assert.equal(session.listenerCount(), 0);
});

test("renderer local socket buffers an immediate daemon frame until listeners are installed", async () => {
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    TextEncoder,
    Date,
    __transportBinding(payload) {
      const request = JSON.parse(payload);
      if (request.op === "open") context.__codexScriptLoaderLocalTransport.receive({ id: request.id, ok: true, result: { connectionId: "a".repeat(32) } });
      if (request.op === "poll") context.__codexScriptLoaderLocalTransport.receive({ id: request.id, ok: true, result: { events: [{ type: "message", data: JSON.stringify({ type: "session_challenge" }) }], closed: true } });
    }
  });
  vm.runInContext(buildTransportClientSource("__transportBinding", { requestTimeoutMs: 100 }), context);
  const socket = await context.__codexScriptLoaderLocalTransport.openWebSocket("bridge.example", "ws://127.0.0.1:53478/renderer");
  const received = [];
  socket.onmessage = event => received.push(event.data);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [JSON.stringify({ type: "session_challenge" })]);
});

test("renderer local socket bounds buffered events when a plugin has no listener yet", async () => {
  let pollCount = 0;
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    TextEncoder,
    Date,
    __transportBinding(payload) {
      const request = JSON.parse(payload);
      if (request.op === "open") context.__codexScriptLoaderLocalTransport.receive({ id: request.id, ok: true, result: { connectionId: "b".repeat(32) } });
      if (request.op === "poll" && pollCount++ === 0) {
        context.__codexScriptLoaderLocalTransport.receive({
          id: request.id,
          ok: true,
          result: { events: Array.from({ length: 40 }, (_, index) => ({ type: "message", data: `frame-${index}` })), closed: true }
        });
      }
    }
  });
  vm.runInContext(buildTransportClientSource("__transportBinding", { requestTimeoutMs: 100 }), context);
  const socket = await context.__codexScriptLoaderLocalTransport.openWebSocket("bridge.example", "ws://127.0.0.1:53478/renderer");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(socket.eventBuffer.length <= 32);
});

test("transport rejects duplicate JSON keys instead of accepting the last value", () => {
  const duplicate = '{"version":1,"id":"duplicate","op":"open","pluginId":"bridge.example","endpoint":"ws://127.0.0.1:53478/renderer","endpoint":"ws://127.0.0.1:53479/renderer"}';
  assert.throws(() => parseTransportRequest(duplicate), error => error.code === "PROTOCOL_ERROR");
});

test("transport rejects decoded path controls and backslashes with the same fail-closed rule", () => {
  for (const endpoint of [
    "ws://127.0.0.1:53478/renderer%5Cx",
    "ws://127.0.0.1:53478/renderer%00x",
    "ws://127.0.0.1:53478/renderer%1fx",
    "ws://127.0.0.1:53478/renderer%7fx",
  ]) {
    assert.throws(() => assertLoopbackWebSocketEndpoint(endpoint), /loopback WebSocket endpoint/);
  }
});

test("transport makes concurrent attach attempts for one renderer idempotent", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const firstSession = fakeSession();
  const secondSession = fakeSession();
  let releaseFirstBinding;
  let firstBindingStarted;
  const firstStarted = new Promise(resolve => { firstBindingStarted = resolve; });
  const firstSendCommand = firstSession.sendCommand.bind(firstSession);
  firstSession.sendCommand = async (method, params = {}) => {
    if (method === "Runtime.addBinding") {
      firstBindingStarted();
      await new Promise(resolve => { releaseFirstBinding = resolve; });
    }
    return firstSendCommand(method, params);
  };
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_attach_race" });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  const target = { id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" };
  const firstAttach = host.attachToSession(target, firstSession);
  await firstStarted;
  const secondAttach = host.attachToSession(target, secondSession);
  releaseFirstBinding();
  const attachResults = await Promise.allSettled([firstAttach, secondAttach]);
  assert.equal(attachResults[0].status, "fulfilled");
  assert.equal(attachResults[1].status, "fulfilled");
  assert.equal(host.sessions.get(target.id)?.session, firstSession);
  assert.equal(secondSession.listenerCount(), 0);
  await host.close();
});

test("transport lets a queued same-target attach recover when the first attach fails", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const firstSession = fakeSession({ failMethod: "Runtime.addBinding" });
  const secondSession = fakeSession();
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_attach_recovery" });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  const target = { id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" };
  const firstAttach = host.attachToSession(target, firstSession);
  const secondAttach = host.attachToSession(target, secondSession);
  const results = await Promise.allSettled([firstAttach, secondAttach]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(host.sessions.get(target.id)?.session, secondSession);
  await host.close();
});

test("transport disposes connections when target sync no longer contains the renderer", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  const socket = fakeWebSocket();
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_target_destroy", webSocketFactory: () => socket });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const state = host.sessions.get("codex-page");
  const opening = host.handleRequest(state, { version: 1, id: "open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  socket.open();
  await opening;
  assert.equal(state.connections.size, 1);
  await host.sync({ targets: [] });
  assert.equal(host.sessions.size, 0);
  assert.equal(socket.readyState, 3);
});

test("transport closes connections owned by a destroyed renderer context", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  const socket = fakeWebSocket();
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_context_destroy", webSocketFactory: () => socket });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const payload = JSON.stringify({ version: 1, id: "context-open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  const opening = host.handleBindingCall("codex-page", { payload, executionContextId: 17 });
  socket.open();
  await opening;
  const state = host.sessions.get("codex-page");
  assert.equal(state.connections.size, 1);
  session.emit({ method: "Runtime.executionContextDestroyed", params: { executionContextId: 17 } });
  assert.equal(state.connections.size, 0);
  assert.equal(socket.readyState, 3);
  await host.close();
});

test("transport rejects an open that completes after its renderer context is destroyed", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  let releaseFactory;
  let factoryStarted;
  const started = new Promise(resolve => { factoryStarted = resolve; });
  let rawSocket;
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_context_open_race",
    webSocketFactory: () => new Promise(resolve => {
      factoryStarted();
      releaseFactory = () => {
        rawSocket = fakeWebSocket({ emitClose: false });
        resolve(rawSocket);
      };
    }),
  });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const payload = JSON.stringify({ version: 1, id: "context-race", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  const bindingCall = host.handleBindingCall("codex-page", { payload, executionContextId: 23 });
  await started;
  session.emit({ method: "Runtime.executionContextDestroyed", params: { executionContextId: 23 } });
  const commandCountAfterDestroy = session.commands.length;
  releaseFactory();
  await bindingCall;
  assert.equal(rawSocket.readyState, 3);
  assert.equal(session.commands.slice(commandCountAfterDestroy).some(command => command.method === "Runtime.evaluate" && String(command.params?.expression).includes("context-race")), false);
});

test("transport closes connections on top-level renderer navigation and target detach", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  for (const event of [
    { method: "Page.frameNavigated", params: { frame: { id: "main-frame" } } },
    { method: "Target.detachedFromTarget", params: { targetId: "codex-page" } },
  ]) {
    const session = fakeSession();
    const socket = fakeWebSocket();
    const host = new LoopbackTransportHost({ bindingName: `__test_transport_${event.method}`, webSocketFactory: () => socket });
    await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
    await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
    const state = host.sessions.get("codex-page");
    const opening = host.handleRequest(state, { version: 1, id: "event-open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
    socket.open();
    await opening;
    session.emit(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(socket.readyState, 3);
    if (event.method === "Target.detachedFromTarget") assert.equal(host.sessions.size, 0);
    else assert.equal(state.connections.size, 0);
    await host.close();
  }
});

test("transport cancels a pending target attach when sync no longer sees that target", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  let releaseFactory;
  let factoryStarted;
  const started = new Promise(resolve => { factoryStarted = resolve; });
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_pending_attach_cancel",
    sessionFactory: () => new Promise(resolve => {
      factoryStarted();
      releaseFactory = () => resolve(session);
    }),
  });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  const target = { id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" };
  const attaching = host.attach(target);
  await started;
  await host.sync({ targets: [] });
  releaseFactory();
  await assert.rejects(attaching, /unavailable/);
  assert.equal(host.sessions.size, 0);
  assert.equal(session.commands.length, 0);
});

test("transport does not answer an in-flight request after its renderer owner is detached", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  let releaseFactory;
  let factoryStarted;
  const started = new Promise(resolve => { factoryStarted = resolve; });
  let rawSocket;
  const host = new LoopbackTransportHost({
    bindingName: "__test_transport_owner_cancellation",
    webSocketFactory: () => {
      factoryStarted();
      return new Promise(resolve => {
        releaseFactory = () => {
          rawSocket = fakeWebSocket({ emitClose: false });
          resolve(rawSocket);
        };
      });
    },
  });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const payload = JSON.stringify({ version: 1, id: "owner-open", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" });
  const bindingCall = host.handleBindingCall("codex-page", { payload, executionContextId: 7 });
  await started;
  const detach = host.detachSession("codex-page");
  await detach;
  const commandCountAfterDetach = session.commands.length;
  releaseFactory();
  await bindingCall;
  assert.equal(rawSocket.readyState, 3);
  assert.equal(session.commands.slice(commandCountAfterDetach).some(command => command.method === "Runtime.evaluate" && String(command.params?.expression).includes("owner-open")), false);
});

test("renderer local transport bounds pending binding requests and rejects overflow deterministically", async () => {
  const requests = [];
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    TextEncoder,
    Date,
    __transportBinding(payload) { requests.push(JSON.parse(payload)); },
  });
  vm.runInContext(buildTransportClientSource("__transportBinding", { requestTimeoutMs: 30 }), context);
  const opens = Array.from({ length: 40 }, () => context.__codexScriptLoaderLocalTransport.openWebSocket("bridge.example", "ws://127.0.0.1:53478/renderer"));
  const settled = Promise.allSettled(opens);
  await new Promise(resolve => setImmediate(resolve));
  context.__codexScriptLoaderLocalTransport.dispose("owner disposed");
  const results = await settled;
  assert.equal(requests.length, MAX_TRANSPORT_DISPATCH_IN_FLIGHT);
  assert.ok(results.some(result => result.status === "rejected" && result.reason?.message === "Loader local transport request limit reached"));
});

test("renderer local transport closes a connection returned after its owner was disposed", async () => {
  const requests = [];
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    TextEncoder,
    Date,
    __transportBinding(payload) { requests.push(JSON.parse(payload)); },
  });
  vm.runInContext(buildTransportClientSource("__transportBinding", { requestTimeoutMs: 1000 }), context);
  const opening = context.__codexScriptLoaderLocalTransport.openWebSocket("bridge.example", "ws://127.0.0.1:53478/renderer");
  await new Promise(resolve => setImmediate(resolve));
  const openRequest = requests.find(request => request.op === "open");
  context.__codexScriptLoaderLocalTransport.dispose("owner disposed");
  context.__codexScriptLoaderLocalTransport.receive({ id: openRequest.id, ok: true, result: { connectionId: "c".repeat(32) } });
  await assert.rejects(opening, /owner disposed|disconnected/);
  assert.ok(requests.some(request => request.op === "close" && request.connectionId === "c".repeat(32)));
});

test("renderer local transport closes owned connections when a renderer context is replaced", async () => {
  const requests = [];
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    TextEncoder,
    Date,
    __transportBinding(payload) { requests.push(JSON.parse(payload)); },
  });
  vm.runInContext(buildTransportClientSource("__transportBinding", { requestTimeoutMs: 1000 }), context);
  const opening = context.__codexScriptLoaderLocalTransport.openWebSocket("bridge.example", "ws://127.0.0.1:53478/renderer");
  await new Promise(resolve => setImmediate(resolve));
  const openRequest = requests.find(request => request.op === "open");
  context.__codexScriptLoaderLocalTransport.receive({ id: openRequest.id, ok: true, result: { connectionId: "d".repeat(32) } });
  await opening;
  context.__codexScriptLoaderLocalTransport.dispose("renderer navigated");
  assert.ok(requests.some(request => request.op === "close" && request.connectionId === "d".repeat(32)));
});

test("transport returns a bounded error when renderer dispatch is saturated", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_dispatch_limit" });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  host.dispatchInFlight = MAX_TRANSPORT_DISPATCH_IN_FLIGHT;
  await host.handleBindingCall("codex-page", {
    payload: JSON.stringify({ version: 1, id: "dispatch-limit", op: "open", pluginId: "bridge.example", endpoint: "ws://127.0.0.1:53478/renderer" }),
    executionContextId: 9,
  });
  const response = session.commands.at(-1);
  assert.equal(response.method, "Runtime.evaluate");
  assert.match(response.params.expression, /"id":"dispatch-limit"/);
  assert.match(response.params.expression, /"errorCode":"DISPATCH_LIMIT"/);
  assert.match(response.params.expression, /renderer dispatch limit reached/);
});

test("transport bounds recently closed connection retention by count", async () => {
  const { LoopbackTransportHost } = await import("../src/loopback-transport.mjs");
  const session = fakeSession();
  const host = new LoopbackTransportHost({ bindingName: "__test_transport_closed_budget" });
  await host.setAuthorizedPlugins([{ id: "bridge.example", permissions: ["loopback-websocket"] }]);
  await host.attachToSession({ id: "codex-page", webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/page/codex" }, session);
  const state = host.sessions.get("codex-page");
  let disposed = 0;
  for (let index = 0; index < MAX_TRANSPORT_CLOSED_RETENTION_COUNT + 7; index += 1) {
    state.connections.set(`${index.toString(16).padStart(31, "0")}${index.toString(16).slice(-1)}`, {
      pluginId: "bridge.example",
      closed: true,
      closedAt: Date.now(),
      dispose() { disposed += 1; },
    });
  }
  host.sweepExpiredClosedConnections();
  const closedCount = [...state.connections.values()].filter(connection => connection.closed).length;
  assert.ok(closedCount <= MAX_TRANSPORT_CLOSED_RETENTION_COUNT);
  assert.equal(disposed, 7);
});
