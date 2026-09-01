import { randomBytes } from "node:crypto";
import { assertLoopbackEndpoint, pickCodexTargets } from "./cdp.mjs";

export const LOOPBACK_TRANSPORT_PERMISSION = "loopback-websocket";
export const TRANSPORT_PROTOCOL_VERSION = 1;
export const TRANSPORT_GLOBAL = "__codexScriptLoaderLocalTransport";
export const MAX_TRANSPORT_REQUEST_BYTES = 16 * 1024;
export const MAX_TRANSPORT_RESPONSE_BYTES = 128 * 1024;
export const MAX_TRANSPORT_FRAME_BYTES = 64 * 1024;
export const MAX_TRANSPORT_QUEUE_BYTES = 256 * 1024;
export const MAX_TRANSPORT_QUEUE_MESSAGES = 32;
export const MAX_TRANSPORT_CONNECTIONS_PER_TARGET = 8;
export const MAX_TRANSPORT_CONNECTIONS_TOTAL = 32;
export const MAX_TRANSPORT_POLL_MS = 1000;
export const MAX_TRANSPORT_REQUEST_TIMEOUT_MS = 5000;
export const MAX_TRANSPORT_CLOSED_RETENTION_MS = 30_000;
export const MAX_TRANSPORT_CLOSED_RETENTION_COUNT = MAX_TRANSPORT_CONNECTIONS_TOTAL;
export const MAX_TRANSPORT_DISPATCH_IN_FLIGHT = 32;
export const MAX_TRANSPORT_PENDING_REQUESTS = MAX_TRANSPORT_DISPATCH_IN_FLIGHT;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const CONNECTION_ID_PATTERN = /^[a-f0-9]{32}$/u;
const ENDPOINT_PATTERN = /^ws:\/\/127\.0\.0\.1:(\d{1,5})(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)$/u;

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function transportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function requiredText(value, name, pattern, message = `${name} is invalid`) {
  if (typeof value !== "string" || !pattern.test(value)) throw transportError("PROTOCOL_ERROR", message);
  return value;
}

function skipJsonWhitespace(payload, index) {
  while (index < payload.length && /\s/u.test(payload[index])) index += 1;
  return index;
}

function scanJsonString(payload, start) {
  if (payload[start] !== '"') throw new Error("invalid JSON string");
  let index = start + 1;
  while (index < payload.length) {
    const code = payload.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code === 0x5c) {
      index += 1;
      if (index >= payload.length) throw new Error("invalid JSON escape");
      const escape = payload[index];
      if (escape === "u") {
        if (!/^[0-9A-Fa-f]{4}$/u.test(payload.slice(index + 1, index + 5))) throw new Error("invalid JSON escape");
        index += 5;
      } else if ('"\\/bfnrt'.includes(escape)) {
        index += 1;
      } else {
        throw new Error("invalid JSON escape");
      }
      continue;
    }
    if (code < 0x20) throw new Error("invalid JSON control character");
    index += 1;
  }
  throw new Error("unterminated JSON string");
}

function scanJsonValue(payload, start) {
  const index = skipJsonWhitespace(payload, start);
  const marker = payload[index];
  if (marker === '"') return scanJsonString(payload, index);
  if (marker === "{") return scanJsonObject(payload, index);
  if (marker === "[") {
    let cursor = skipJsonWhitespace(payload, index + 1);
    if (payload[cursor] === "]") return cursor + 1;
    while (cursor < payload.length) {
      cursor = scanJsonValue(payload, cursor);
      cursor = skipJsonWhitespace(payload, cursor);
      if (payload[cursor] === "]") return cursor + 1;
      if (payload[cursor] !== ",") throw new Error("invalid JSON array");
      cursor = skipJsonWhitespace(payload, cursor + 1);
    }
    throw new Error("unterminated JSON array");
  }
  if (payload.startsWith("true", index)) return index + 4;
  if (payload.startsWith("false", index)) return index + 5;
  if (payload.startsWith("null", index)) return index + 4;
  const number = payload.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
  if (number) return index + number[0].length;
  throw new Error("invalid JSON value");
}

function scanJsonObject(payload, start) {
  let index = skipJsonWhitespace(payload, start + 1);
  const keys = new Set();
  if (payload[index] === "}") return index + 1;
  while (index < payload.length) {
    const keyStart = index;
    const keyEnd = scanJsonString(payload, keyStart);
    const key = JSON.parse(payload.slice(keyStart, keyEnd));
    if (keys.has(key)) throw transportError("PROTOCOL_ERROR", "transport request contains duplicate JSON keys");
    keys.add(key);
    index = skipJsonWhitespace(payload, keyEnd);
    if (payload[index] !== ":") throw new Error("invalid JSON object");
    index = scanJsonValue(payload, index + 1);
    index = skipJsonWhitespace(payload, index);
    if (payload[index] === "}") return index + 1;
    if (payload[index] !== ",") throw new Error("invalid JSON object");
    index = skipJsonWhitespace(payload, index + 1);
  }
  throw new Error("unterminated JSON object");
}

function parseJsonWithUniqueKeys(payload) {
  try {
    const end = skipJsonWhitespace(payload, scanJsonValue(payload, 0));
    if (end !== payload.length) throw new Error("trailing JSON data");
  } catch (error) {
    if (error?.code === "PROTOCOL_ERROR") throw error;
    throw transportError("PROTOCOL_ERROR", "transport request is invalid JSON");
  }
  try {
    return JSON.parse(payload);
  } catch {
    throw transportError("PROTOCOL_ERROR", "transport request is invalid JSON");
  }
}

/**
 * Validate a renderer-requested daemon endpoint.  This deliberately does not
 * accept a general URL: the host owns the loopback boundary and only permits
 * an explicit IPv4 ws endpoint with a safe path.
 */
export function assertLoopbackWebSocketEndpoint(endpoint, { forbiddenPorts = [] } = {}) {
  if (typeof endpoint !== "string" || byteLength(endpoint) > 2048 || !ENDPOINT_PATTERN.test(endpoint)) {
    throw transportError("ENDPOINT_INVALID", "loopback WebSocket endpoint is invalid");
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw transportError("ENDPOINT_INVALID", "loopback WebSocket endpoint is invalid");
  }
  const port = Number(url.port);
  const path = endpoint.slice(endpoint.indexOf("/", "ws://127.0.0.1:".length));
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw transportError("ENDPOINT_INVALID", "loopback WebSocket endpoint path is invalid");
  }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash ||
      !Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith("/") || path.length > 512 ||
      /[\\\u0000-\u001f\u007f]/u.test(path) || /[\\\u0000-\u001f\u007f]/u.test(decodedPath) || path.includes("..") || decodedPath.includes("..") || /\/devtools(?:\/|$)/iu.test(decodedPath) || /\/(?:json|json\/version)(?:\/|$)/iu.test(decodedPath)) {
    throw transportError("ENDPOINT_INVALID", "loopback WebSocket endpoint is invalid");
  }
  const blocked = new Set(forbiddenPorts);
  if (blocked.has(port) || blocked.has(String(port))) {
    throw transportError("ENDPOINT_INVALID", "loopback WebSocket endpoint cannot target the managed CDP port");
  }
  return url;
}

/**
 * Parse the independent renderer transport binding protocol.  Every frame
 * carries pluginId so the host can re-check the currently enabled descriptor.
 */
export function parseTransportRequest(payload) {
  if (typeof payload !== "string" || byteLength(payload) > MAX_TRANSPORT_REQUEST_BYTES) {
    throw transportError("PROTOCOL_ERROR", "transport request is too large");
  }
  let request;
  request = parseJsonWithUniqueKeys(payload);
  if (!request || typeof request !== "object" || Array.isArray(request) || request.version !== TRANSPORT_PROTOCOL_VERSION) {
    throw transportError("PROTOCOL_ERROR", "transport request envelope is invalid");
  }
  requiredText(request.id, "id", REQUEST_ID_PATTERN, "transport request id is invalid");
  requiredText(request.pluginId, "pluginId", ID_PATTERN, "transport request pluginId is invalid");
  if (typeof request.op !== "string" || !["open", "send", "poll", "close"].includes(request.op)) {
    throw transportError("PROTOCOL_ERROR", "transport request operation is invalid");
  }
  const common = ["version", "id", "op", "pluginId"];
  if (request.op === "open") {
    if (!exactKeys(request, [...common, "endpoint"])) throw transportError("PROTOCOL_ERROR", "transport open request keys are not exact");
    if (typeof request.endpoint !== "string") throw transportError("PROTOCOL_ERROR", "transport endpoint is invalid");
    assertLoopbackWebSocketEndpoint(request.endpoint);
    return { version: 1, id: request.id, op: "open", pluginId: request.pluginId, endpoint: request.endpoint };
  }
  if (request.op === "send") {
    if (!exactKeys(request, [...common, "connectionId", "data"])) throw transportError("PROTOCOL_ERROR", "transport send request keys are not exact");
    requiredText(request.connectionId, "connectionId", CONNECTION_ID_PATTERN, "transport connectionId is invalid");
    if (typeof request.data !== "string") throw transportError("PROTOCOL_ERROR", "transport data is invalid");
    if (byteLength(request.data) > MAX_TRANSPORT_FRAME_BYTES) {
      throw transportError("FRAME_TOO_LARGE", "transport text frame is too large");
    }
    return { version: 1, id: request.id, op: "send", pluginId: request.pluginId, connectionId: request.connectionId, data: request.data };
  }
  if (request.op === "poll") {
    if (!exactKeys(request, [...common, "connectionId", ...(request.waitMs !== undefined ? ["waitMs"] : [])])) throw transportError("PROTOCOL_ERROR", "transport poll request keys are not exact");
    requiredText(request.connectionId, "connectionId", CONNECTION_ID_PATTERN, "transport connectionId is invalid");
    const waitMs = request.waitMs === undefined ? MAX_TRANSPORT_POLL_MS : request.waitMs;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_TRANSPORT_POLL_MS) throw transportError("PROTOCOL_ERROR", "transport poll timeout is invalid");
    return { version: 1, id: request.id, op: "poll", pluginId: request.pluginId, connectionId: request.connectionId, waitMs };
  }
  if (!exactKeys(request, [...common, "connectionId"])) throw transportError("PROTOCOL_ERROR", "transport close request keys are not exact");
  requiredText(request.connectionId, "connectionId", CONNECTION_ID_PATTERN, "transport connectionId is invalid");
  return { version: 1, id: request.id, op: "close", pluginId: request.pluginId, connectionId: request.connectionId };
}

function createBindingName() {
  return `__codex_loader_transport_${randomBytes(12).toString("hex")}`;
}

function sanitizedTransportError(error) {
  const code = typeof error?.code === "string" && /^[A-Z_]{3,32}$/u.test(error.code) ? error.code : "TRANSPORT_ERROR";
  const messageByCode = {
    ENDPOINT_INVALID: "loopback WebSocket endpoint is invalid",
    PERMISSION_DENIED: "plugin is not authorized for the loopback WebSocket transport",
    CONNECTION_LIMIT: "loopback WebSocket connection limit reached",
    CONNECTION_NOT_FOUND: "loopback WebSocket connection is unavailable",
    SOCKET_ERROR: "loopback WebSocket connection failed",
    SOCKET_CLOSED: "loopback WebSocket connection is closed",
    FRAME_TOO_LARGE: "loopback WebSocket text frame is too large",
    QUEUE_LIMIT: "loopback WebSocket queue limit reached",
    POLL_BUSY: "loopback WebSocket poll is already pending",
    DISPATCH_LIMIT: "loopback WebSocket renderer dispatch limit reached",
    PROTOCOL_ERROR: "loopback WebSocket transport protocol error",
    TRANSPORT_CLOSED: "loopback WebSocket transport is unavailable",
    TRANSPORT_ERROR: "loopback WebSocket transport failed",
  };
  return { code, message: messageByCode[code] || messageByCode.TRANSPORT_ERROR };
}

function addSocketListener(socket, type, listener) {
  if (typeof socket?.addEventListener === "function") {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  const property = `on${type}`;
  const previous = socket?.[property];
  if (socket) socket[property] = listener;
  return () => {
    if (socket?.[property] === listener) socket[property] = previous || null;
  };
}

function closeRawSocket(socket) {
  try { socket?.close?.(); }
  catch {
    try { socket?.terminate?.(); } catch {}
  }
}

async function createSocketWithTimeout(factory, endpoint, timeoutMs) {
  let factoryResult;
  try { factoryResult = factory(endpoint); }
  catch (error) { factoryResult = Promise.reject(error); }
  const factoryPromise = Promise.resolve(factoryResult);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(transportError("SOCKET_ERROR", "loopback WebSocket connection timed out")), timeoutMs);
      factoryPromise.then(resolve, reject);
    });
  } catch (error) {
    // A factory can resolve after the host-side timeout. Never leave that raw
    // socket outside a connection state that the lifecycle can dispose.
    factoryPromise.then(closeRawSocket, () => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class TransportConnection {
  constructor({ id, pluginId, endpoint, socket, ownerContextId = null, onClosed = null }) {
    this.id = id;
    this.pluginId = pluginId;
    this.endpoint = endpoint;
    this.socket = socket;
    this.ownerContextId = ownerContextId;
    this.queue = [];
    this.queueBytes = 0;
    this.pendingSends = 0;
    this.sendTail = Promise.resolve();
    this.pollWaiter = null;
    this.openWaiter = null;
    this.closed = false;
    this.closedAt = null;
    this.closeCode = 1000;
    this.onClosed = onClosed;
    this.removers = [
      addSocketListener(socket, "open", () => this.resolveOpen()),
      addSocketListener(socket, "message", event => this.receive(event)),
      addSocketListener(socket, "error", () => this.fail("SOCKET_ERROR")),
      addSocketListener(socket, "close", event => this.markClosed(Number.isInteger(event?.code) ? event.code : 1000)),
    ];
  }

  async open() {
    if (this.socket?.readyState === 1) return;
    if (this.socket?.readyState === 3) throw transportError("SOCKET_CLOSED", "loopback WebSocket connection is closed");
    await new Promise((resolve, reject) => {
      this.openWaiter = { resolve, reject };
      this.openTimer = setTimeout(() => {
        this.openWaiter = null;
        reject(transportError("SOCKET_ERROR", "loopback WebSocket connection timed out"));
        this.markClosed(1000);
      }, MAX_TRANSPORT_REQUEST_TIMEOUT_MS);
    });
  }

  resolveOpen() {
    if (!this.openWaiter) return;
    clearTimeout(this.openTimer);
    const waiter = this.openWaiter;
    this.openWaiter = null;
    waiter.resolve();
  }

  rejectOpen(error) {
    if (!this.openWaiter) return;
    clearTimeout(this.openTimer);
    const waiter = this.openWaiter;
    this.openWaiter = null;
    waiter.reject(error);
  }

  receive(event) {
    if (this.closed) return;
    if (typeof event?.data !== "string" || byteLength(event.data) > MAX_TRANSPORT_FRAME_BYTES) {
      this.fail("FRAME_TOO_LARGE");
      return;
    }
    if (this.queue.length >= MAX_TRANSPORT_QUEUE_MESSAGES || this.queueBytes + byteLength(event.data) > MAX_TRANSPORT_QUEUE_BYTES) {
      this.fail("QUEUE_LIMIT");
      return;
    }
    this.queue.push({ type: "message", data: event.data });
    this.queueBytes += byteLength(event.data);
    this.resolvePoll();
  }

  fail(code) {
    if (this.closed) return;
    this.rejectOpen(transportError(code, sanitizedTransportError({ code }).message));
    try { this.socket?.close?.(); } catch {}
    this.markClosed(code === "FRAME_TOO_LARGE" ? 1009 : 1011);
  }

  markClosed(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    this.closedAt = Date.now();
    this.closeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1000;
    this.rejectOpen(transportError("SOCKET_CLOSED", "loopback WebSocket connection closed before opening"));
    while (this.queue.length >= MAX_TRANSPORT_QUEUE_MESSAGES) {
      const removed = this.queue.shift();
      this.queueBytes -= byteLength(removed?.data || "");
    }
    this.queue.push({ type: "close", code: this.closeCode });
    try { this.onClosed?.(this); } catch {}
    this.resolvePoll();
  }

  async send(data) {
    if (typeof data !== "string" || byteLength(data) > MAX_TRANSPORT_FRAME_BYTES) throw transportError("FRAME_TOO_LARGE", "loopback WebSocket text frame is too large");
    if (this.closed || this.socket?.readyState !== 1) throw transportError("SOCKET_CLOSED", "loopback WebSocket connection is closed");
    if (this.pendingSends >= MAX_TRANSPORT_QUEUE_MESSAGES) throw transportError("QUEUE_LIMIT", "loopback WebSocket queue limit reached");
    this.pendingSends += 1;
    const task = this.sendTail.then(async () => {
      if (this.closed || this.socket?.readyState !== 1) throw transportError("SOCKET_CLOSED", "loopback WebSocket connection is closed");
      await this.socket.send(data);
    });
    this.sendTail = task.catch(() => {});
    try { await task; }
    catch (error) { this.fail("SOCKET_ERROR"); throw transportError("SOCKET_ERROR", "loopback WebSocket send failed"); }
    finally { this.pendingSends -= 1; }
  }

  async poll(waitMs) {
    if (this.queue.length > 0) return this.drainQueue();
    if (this.closed) return { events: [{ type: "close", code: this.closeCode }], closed: true };
    if (this.pollWaiter) throw transportError("POLL_BUSY", "loopback WebSocket poll is already pending");
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.pollWaiter = null;
        resolve({ events: [], closed: this.closed });
      }, Math.min(waitMs, MAX_TRANSPORT_POLL_MS));
      this.pollWaiter = { resolve, timeout };
    });
  }

  drainQueue() {
    const events = [];
    let responseBytes = 0;
    while (events.length < MAX_TRANSPORT_QUEUE_MESSAGES && this.queue.length > 0) {
      const candidate = this.queue[0];
      const candidateBytes = byteLength(candidate.data || "") + 128;
      if (events.length > 0 && responseBytes + candidateBytes > MAX_TRANSPORT_RESPONSE_BYTES - 1024) break;
      events.push(this.queue.shift());
      responseBytes += candidateBytes;
    }
    this.queueBytes = this.queue.reduce((sum, item) => sum + byteLength(item.data || ""), 0);
    return { events, closed: this.closed && this.queue.length === 0 };
  }

  resolvePoll() {
    if (!this.pollWaiter) return;
    const waiter = this.pollWaiter;
    this.pollWaiter = null;
    clearTimeout(waiter.timeout);
    waiter.resolve(this.drainQueue());
  }

  close() {
    if (this.closed) return;
    try { this.socket?.close?.(); } catch {}
    this.markClosed(1000);
  }

  dispose() {
    if (!this.closed) this.markClosed(1000);
    else this.rejectOpen(transportError("SOCKET_CLOSED", "loopback WebSocket connection closed before opening"));
    for (const remove of this.removers.splice(0).reverse()) {
      try { remove(); } catch {}
    }
    clearTimeout(this.openTimer);
    if (this.pollWaiter) {
      clearTimeout(this.pollWaiter.timeout);
      this.pollWaiter.resolve({ events: [], closed: true });
      this.pollWaiter = null;
    }
    try { this.socket?.close?.(); } catch {}
    this.queue = [];
    this.queueBytes = 0;
  }
}

/**
 * Host-owned transport binding.  It intentionally shares a CDP session with
 * the management bridge only as a carrier; its binding, protocol and socket
 * state are independent from management commands.
 */
export class LoopbackTransportHost {
  constructor({
    targetProvider = null,
    sessionFactory = null,
    bindingName = createBindingName(),
    webSocketFactory = null,
    forbiddenPorts = [],
    requestTimeoutMs = MAX_TRANSPORT_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (targetProvider !== null && typeof targetProvider !== "function") throw new TypeError("targetProvider must be a function");
    if (sessionFactory !== null && typeof sessionFactory !== "function") throw new TypeError("sessionFactory must be a function");
    this.targetProvider = targetProvider;
    this.sessionFactory = sessionFactory;
    this.bindingName = bindingName;
    this.webSocketFactory = webSocketFactory || (endpoint => {
      if (typeof globalThis.WebSocket !== "function") throw transportError("SOCKET_ERROR", "WebSocket is unavailable in the Loader host");
      return new globalThis.WebSocket(endpoint);
    });
    this.forbiddenPorts = [...forbiddenPorts];
    this.requestTimeoutMs = Math.min(Math.max(Number(requestTimeoutMs) || MAX_TRANSPORT_REQUEST_TIMEOUT_MS, 1000), MAX_TRANSPORT_REQUEST_TIMEOUT_MS);
    this.sessions = new Map();
    this.authorized = new Set();
    this.authorizationGeneration = 0;
    this.dispatchInFlight = 0;
    this.attachOperations = new Map();
    this.detachOperations = new Map();
    this.targetGenerations = new Map();
    this.closed = false;
  }

  setAuthorizedPlugins(descriptors = []) {
    if (!Array.isArray(descriptors)) throw new TypeError("descriptors must be an array");
    const nextAuthorized = new Set(descriptors
      .filter(descriptor => ID_PATTERN.test(String(descriptor?.id || "")) && Array.isArray(descriptor?.permissions) && descriptor.permissions.includes(LOOPBACK_TRANSPORT_PERMISSION))
      .map(descriptor => descriptor.id));
    if (nextAuthorized.size !== this.authorized.size || [...nextAuthorized].some(pluginId => !this.authorized.has(pluginId))) {
      this.authorizationGeneration += 1;
      this.authorized = nextAuthorized;
    }
    return this.syncAuthorization();
  }

  isAuthorized(pluginId) {
    return this.authorized.has(pluginId);
  }

  async syncAuthorization() {
    const work = [];
    for (const [targetId, state] of this.sessions) {
      for (const [connectionId, connection] of state.connections) {
        if (this.authorized.has(connection.pluginId)) continue;
        connection.close();
        connection.dispose();
        state.connections.delete(connectionId);
      }
      if (this.authorized.size === 0 && state.registrationId) work.push(this.detachBinding(targetId, state));
      else if (this.authorized.size > 0 && !state.registrationId) work.push(this.attachBinding(targetId, state));
    }
    await Promise.all(work);
  }

  async sync({ targets: suppliedTargets } = {}) {
    if (this.closed) return [];
    if (!this.targetProvider && suppliedTargets === undefined) throw new TypeError("targetProvider or targets are required");
    const targets = pickCodexTargets(suppliedTargets ?? await this.targetProvider());
    const desired = new Map(targets.map(target => [target.id, target]));
    for (const targetId of this.attachOperations.keys()) {
      if (desired.has(targetId)) continue;
      this.targetGenerations.set(targetId, (this.targetGenerations.get(targetId) || 0) + 1);
    }
    for (const [targetId, state] of this.sessions) {
      const target = desired.get(targetId);
      if (!target || target.webSocketDebuggerUrl !== state.endpoint) await this.detachSession(targetId);
    }
    if (this.authorized.size > 0) {
      for (const target of targets) {
        if (!this.sessions.has(target.id)) await this.attach(target);
      }
    }
    return targets;
  }

  async attach(target) {
    if (!this.sessionFactory) throw new TypeError("sessionFactory is required to attach a target");
    const endpoint = assertLoopbackEndpoint(target.webSocketDebuggerUrl).href;
    await this.runAttachOperation(target.id, async generation => {
      const session = await this.sessionFactory(endpoint);
      if (this.closed || (this.targetGenerations.get(target.id) || 0) !== generation || this.sessions.has(target.id)) {
        try { await session.close?.(); } catch {}
        if (this.closed || (this.targetGenerations.get(target.id) || 0) !== generation) {
          throw transportError("TRANSPORT_CLOSED", "loopback WebSocket transport is unavailable");
        }
        return;
      }
      const state = { targetId: target.id, endpoint, session, registrationId: null, unsubscribe: null, bindingPromise: null, connections: new Map(), opening: 0, generation: 0, contextGeneration: 0, destroyedContexts: new Set(), active: true };
      this.sessions.set(target.id, state);
      try {
        if (this.authorized.size > 0) await this.attachBinding(target.id, state);
      } catch (error) {
        if (this.sessions.get(target.id) === state) this.sessions.delete(target.id);
        try { await session.close?.(); } catch {}
        throw error;
      }
    });
  }

  async attachToSession(target, session) {
    if (!target?.id || !session || typeof session.sendCommand !== "function") throw new TypeError("target and CDP session are required");
    const endpoint = assertLoopbackEndpoint(target.webSocketDebuggerUrl).href;
    await this.runAttachOperation(target.id, async generation => {
      if (this.closed || (this.targetGenerations.get(target.id) || 0) !== generation) {
        throw transportError("TRANSPORT_CLOSED", "loopback WebSocket transport is unavailable");
      }
      const state = { targetId: target.id, endpoint, session, registrationId: null, unsubscribe: null, bindingPromise: null, connections: new Map(), opening: 0, generation: 0, contextGeneration: 0, destroyedContexts: new Set(), active: true, shared: true };
      this.sessions.set(target.id, state);
      try {
        if (this.authorized.size > 0) await this.attachBinding(target.id, state);
      } catch (error) {
        if (this.sessions.get(target.id) === state) this.sessions.delete(target.id);
        throw error;
      }
    });
  }

  async runAttachOperation(targetId, operation) {
    const requestedGeneration = this.targetGenerations.get(targetId) || 0;
    const previous = this.attachOperations.get(targetId);
    if (previous) {
      try { await previous; } catch {}
    }
    const detaching = this.detachOperations.get(targetId);
    if (detaching) {
      try { await detaching; } catch {}
    }
    if (this.closed) throw transportError("TRANSPORT_CLOSED", "loopback WebSocket transport is unavailable");
    if ((this.targetGenerations.get(targetId) || 0) !== requestedGeneration) {
      throw transportError("TRANSPORT_CLOSED", "loopback WebSocket transport is unavailable");
    }
    if (this.sessions.has(targetId)) return;
    const task = Promise.resolve().then(() => operation(requestedGeneration));
    this.attachOperations.set(targetId, task);
    try {
      await task;
    } finally {
      if (this.attachOperations.get(targetId) === task) this.attachOperations.delete(targetId);
    }
  }

  async attachBinding(targetId, state) {
    if (state.registrationId || this.authorized.size === 0) return;
    if (state.bindingPromise) return state.bindingPromise;
    const task = this.attachBindingInternal(targetId, state);
    state.bindingPromise = task;
    try { await task; }
    finally {
      if (state.bindingPromise === task) state.bindingPromise = null;
    }
  }

  async attachBindingInternal(targetId, state) {
    if (state.registrationId || this.authorized.size === 0) return;
    const authorizationGeneration = this.authorizationGeneration;
    const assertCurrent = () => {
      if (this.closed || state.active === false || this.sessions.get(targetId) !== state) {
        throw transportError("TRANSPORT_CLOSED", "loopback WebSocket transport is unavailable");
      }
      if (this.authorizationGeneration !== authorizationGeneration || this.authorized.size === 0) {
        throw transportError("PERMISSION_DENIED", "plugin is not authorized for the loopback WebSocket transport");
      }
    };
    let bindingAttempted = false;
    let registrationId = null;
    let unsubscribe = null;
    try {
      bindingAttempted = true;
      await state.session.sendCommand("Runtime.addBinding", { name: this.bindingName });
      assertCurrent();
      const source = buildTransportClientSource(this.bindingName, { requestTimeoutMs: this.requestTimeoutMs });
      const registration = await state.session.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
      assertCurrent();
      registrationId = registration?.identifier || registration?.result?.identifier || null;
      state.registrationId = registrationId;
      unsubscribe = state.session.onEvent?.(message => {
        if (message?.method === "Runtime.bindingCalled" && message.params?.name === this.bindingName) {
          void this.handleBindingCall(targetId, message.params, state);
          return;
        }
        if (message?.method === "Runtime.executionContextDestroyed" && Number.isInteger(message.params?.executionContextId)) {
          while (state.destroyedContexts.size >= 64) state.destroyedContexts.delete(state.destroyedContexts.values().next().value);
          state.destroyedContexts.add(message.params.executionContextId);
          this.closeConnectionsForContext(targetId, state, message.params.executionContextId);
          return;
        }
        if (message?.method === "Page.frameNavigated" && message.params?.frame && !message.params.frame.parentId) {
          this.closeConnectionsForState(targetId, state);
          return;
        }
        if (message?.method === "Target.detachedFromTarget" && (!message.params?.targetId || message.params.targetId === targetId)) {
          void this.detachSession(targetId).catch(() => {});
        }
      }) || null;
      state.unsubscribe = unsubscribe;
      assertCurrent();
      const evaluation = await state.session.sendCommand("Runtime.evaluate", { expression: source, returnByValue: true });
      assertCurrent();
      if (evaluation?.exceptionDetails) throw transportError("TRANSPORT_ERROR", "renderer rejected the local transport client");
    } catch (error) {
      try { unsubscribe?.(); } catch {}
      if (state.unsubscribe === unsubscribe) state.unsubscribe = null;
      state.registrationId = null;
      if (registrationId) {
        try { await state.session.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: registrationId }); } catch {}
      }
      if (bindingAttempted) {
        try { await state.session.sendCommand("Runtime.removeBinding", { name: this.bindingName }); } catch {}
      }
      throw error;
    }
  }

  async detachBinding(targetId, expectedState = null) {
    const state = expectedState || this.sessions.get(targetId);
    if (!state) return;
    for (const connection of state.connections.values()) connection.dispose();
    state.connections.clear();
    if (!state.registrationId) {
      try { state.unsubscribe?.(); } catch {}
      state.unsubscribe = null;
      return;
    }
    try {
      await state.session.sendCommand("Runtime.evaluate", { expression: `globalThis[${JSON.stringify(TRANSPORT_GLOBAL)}]?.dispose("Loader local transport disconnected");` });
    } catch {}
    try { state.unsubscribe?.(); } catch {}
    state.unsubscribe = null;
    if (state.registrationId) {
      try { await state.session.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: state.registrationId }); } catch {}
    }
    try { await state.session.sendCommand("Runtime.removeBinding", { name: this.bindingName }); } catch {}
    state.registrationId = null;
  }

  async detachSession(targetId) {
    const previous = this.detachOperations.get(targetId);
    if (previous) return previous;
    const task = (async () => {
      this.targetGenerations.set(targetId, (this.targetGenerations.get(targetId) || 0) + 1);
      const state = this.sessions.get(targetId);
      if (!state) return;
      state.active = false;
      state.generation += 1;
      try { await this.detachBinding(targetId, state); }
      finally {
        if (this.sessions.get(targetId) === state) this.sessions.delete(targetId);
        if (!state.shared) {
          try { await state.session.close?.(); } catch {}
        }
      }
    })();
    this.detachOperations.set(targetId, task);
    try {
      await task;
    } finally {
      if (this.detachOperations.get(targetId) === task) this.detachOperations.delete(targetId);
    }
  }

  async handleBindingCall(targetId, params, ownerState = null) {
    const state = this.sessions.get(targetId);
    if (!state || (ownerState && state !== ownerState)) return;
    if (this.dispatchInFlight >= MAX_TRANSPORT_DISPATCH_IN_FLIGHT) {
      let requestId = null;
      try { requestId = parseTransportRequest(params?.payload).id; } catch {}
      if (requestId) {
        const contextGeneration = state.contextGeneration;
        await this.sendBindingResponse(state, targetId, params, {
          version: 1,
          id: requestId,
          ok: false,
          errorCode: "DISPATCH_LIMIT",
          message: sanitizedTransportError({ code: "DISPATCH_LIMIT" }).message,
        }, ownerState, contextGeneration);
      }
      return;
    }
    this.dispatchInFlight += 1;
    try {
      await this.handleBindingCallInternal(targetId, params, ownerState);
    } finally {
      this.dispatchInFlight -= 1;
    }
  }

  async handleBindingCallInternal(targetId, params, ownerState = null) {
    const state = this.sessions.get(targetId);
    if (!state || (ownerState && state !== ownerState)) return;
    const contextGeneration = state.contextGeneration;
    let requestId = null;
    let response;
    try {
      const request = parseTransportRequest(params?.payload);
      requestId = request.id;
      const result = await this.handleRequest(state, request, { ownerContextId: Number.isInteger(params?.executionContextId) ? params.executionContextId : null });
      response = { version: 1, id: request.id, ok: true, result };
    } catch (error) {
      if (!requestId && typeof params?.payload === "string" && byteLength(params.payload) <= MAX_TRANSPORT_REQUEST_BYTES) {
        try {
          const raw = parseJsonWithUniqueKeys(params.payload);
          if (typeof raw?.id === "string" && REQUEST_ID_PATTERN.test(raw.id)) requestId = raw.id;
        } catch {}
      }
      if (!requestId) return;
      const sanitized = sanitizedTransportError(error);
      response = { version: 1, id: requestId, ok: false, errorCode: sanitized.code, message: sanitized.message };
    }
    const encoded = JSON.stringify(response);
    if (byteLength(encoded) > MAX_TRANSPORT_RESPONSE_BYTES) {
      response = { version: 1, id: requestId, ok: false, errorCode: "TRANSPORT_ERROR", message: "loopback WebSocket transport response is too large" };
    }
    if (this.closed || state.active === false || this.sessions.get(targetId) !== state || (ownerState && ownerState !== state)) return;
    await this.sendBindingResponse(state, targetId, params, response, ownerState, contextGeneration);
  }

  async sendBindingResponse(state, targetId, params, response, ownerState = null, ownerContextGeneration = null) {
    const contextId = Number.isInteger(params?.executionContextId) ? params.executionContextId : null;
    if (this.closed || state.active === false || this.sessions.get(targetId) !== state || (ownerState && ownerState !== state) ||
        (ownerContextGeneration !== null && state.contextGeneration !== ownerContextGeneration) ||
        (contextId !== null && state.destroyedContexts.has(contextId))) return;
    const expression = `globalThis[${JSON.stringify(TRANSPORT_GLOBAL)}]?.receive(${JSON.stringify(response)});`;
    try {
      await state.session.sendCommand("Runtime.evaluate", {
        expression,
        ...(Number.isInteger(params?.executionContextId) ? { contextId: params.executionContextId } : {}),
        returnByValue: true,
      });
    } catch {}
  }

  async handleRequest(state, request, { ownerContextId = null } = {}) {
    if (!this.isAuthorized(request.pluginId)) throw transportError("PERMISSION_DENIED", "plugin is not authorized for the loopback WebSocket transport");
    if (request.op === "open") {
      this.sweepExpiredClosedConnections();
      const endpoint = assertLoopbackWebSocketEndpoint(request.endpoint, { forbiddenPorts: this.forbiddenPorts });
      const authGeneration = this.authorizationGeneration;
      const stateGeneration = state.generation || 0;
      if (!this.isCurrentOpen(state, stateGeneration, authGeneration, request.pluginId)) throw this.staleOpenError(state, authGeneration, request.pluginId);
      const perTargetCount = [...state.connections.values()].filter(connection => !connection.closed).length + (state.opening || 0);
      const totalCount = [...this.sessions.values()].reduce((sum, item) => sum + [...item.connections.values()].filter(connection => !connection.closed).length + (item.opening || 0), 0);
      if (perTargetCount >= MAX_TRANSPORT_CONNECTIONS_PER_TARGET || totalCount >= MAX_TRANSPORT_CONNECTIONS_TOTAL) throw transportError("CONNECTION_LIMIT", "loopback WebSocket connection limit reached");
      state.opening = (state.opening || 0) + 1;
      let socket = null;
      let connection = null;
      try {
        try { socket = await createSocketWithTimeout(this.webSocketFactory, endpoint.href, this.requestTimeoutMs); }
        catch { throw transportError("SOCKET_ERROR", "loopback WebSocket connection failed"); }
        if (!this.isCurrentOpen(state, stateGeneration, authGeneration, request.pluginId)) throw this.staleOpenError(state, authGeneration, request.pluginId);
        connection = new TransportConnection({
          id: randomBytes(16).toString("hex"),
          pluginId: request.pluginId,
          endpoint: endpoint.href,
          socket,
          ownerContextId,
          onClosed: () => this.enforceClosedRetentionBudget(),
        });
        state.connections.set(connection.id, connection);
        await connection.open();
        if (!this.isCurrentOpen(state, stateGeneration, authGeneration, request.pluginId) || connection.closed) throw this.staleOpenError(state, authGeneration, request.pluginId);
        return { connectionId: connection.id };
      }
      catch (error) {
        if (connection) {
          state.connections.delete(connection.id);
          connection.dispose();
        } else {
          closeRawSocket(socket);
        }
        throw error;
      }
      finally {
        state.opening = Math.max(0, (state.opening || 1) - 1);
      }
    }
    const connection = state.connections.get(request.connectionId);
    if (!connection || connection.pluginId !== request.pluginId) throw transportError("CONNECTION_NOT_FOUND", "loopback WebSocket connection is unavailable");
    if (request.op !== "close" && connection.closed && Date.now() - (connection.closedAt || Date.now()) > MAX_TRANSPORT_CLOSED_RETENTION_MS) {
      state.connections.delete(connection.id);
      connection.dispose();
      throw transportError("CONNECTION_NOT_FOUND", "loopback WebSocket connection is unavailable");
    }
    if (request.op === "send") {
      await connection.send(request.data);
      return { accepted: true };
    }
    if (request.op === "poll") {
      const result = await connection.poll(request.waitMs);
      if (result.closed) {
        state.connections.delete(connection.id);
        connection.dispose();
      }
      return result;
    }
    connection.close();
    state.connections.delete(connection.id);
    connection.dispose();
    return { closed: true };
  }

  closeConnectionsForContext(targetId, state, contextId) {
    if (this.sessions.get(targetId) !== state || state.active === false) return;
    state.generation += 1;
    state.contextGeneration += 1;
    for (const [connectionId, connection] of state.connections) {
      if (connection.ownerContextId !== contextId) continue;
      connection.close();
      connection.dispose();
      state.connections.delete(connectionId);
    }
  }

  closeConnectionsForState(targetId, state) {
    if (this.sessions.get(targetId) !== state || state.active === false) return;
    state.generation += 1;
    state.contextGeneration += 1;
    for (const [connectionId, connection] of state.connections) {
      connection.close();
      connection.dispose();
      state.connections.delete(connectionId);
    }
  }

  isCurrentOpen(state, stateGeneration, authGeneration, pluginId) {
    return !this.closed && state?.active !== false && state?.generation === stateGeneration &&
      state?.targetId !== undefined && this.sessions.get(state.targetId) === state &&
      this.authorizationGeneration === authGeneration && this.isAuthorized(pluginId);
  }

  staleOpenError(state, authGeneration, pluginId) {
    if (this.closed || state?.active === false || state?.targetId === undefined || this.sessions.get(state.targetId) !== state) {
      return transportError("TRANSPORT_CLOSED", "loopback WebSocket transport is unavailable");
    }
    if (this.authorizationGeneration !== authGeneration || !this.isAuthorized(pluginId)) {
      return transportError("PERMISSION_DENIED", "plugin is not authorized for the loopback WebSocket transport");
    }
    return transportError("TRANSPORT_CLOSED", "loopback WebSocket transport is unavailable");
  }

  sweepExpiredClosedConnections() {
    const cutoff = Date.now() - MAX_TRANSPORT_CLOSED_RETENTION_MS;
    for (const state of this.sessions.values()) {
      for (const [connectionId, connection] of state.connections) {
        if (!connection.closed || !Number.isFinite(connection.closedAt) || connection.closedAt > cutoff) continue;
        connection.dispose();
        state.connections.delete(connectionId);
      }
    }
    this.enforceClosedRetentionBudget();
  }

  enforceClosedRetentionBudget() {
    const closed = [];
    for (const state of this.sessions.values()) {
      for (const [connectionId, connection] of state.connections) {
        if (connection.closed) closed.push({ state, connectionId, connection });
      }
    }
    closed.sort((left, right) => (left.connection.closedAt || 0) - (right.connection.closedAt || 0));
    while (closed.length > MAX_TRANSPORT_CLOSED_RETENTION_COUNT) {
      const item = closed.shift();
      if (!item || item.state.connections.get(item.connectionId) !== item.connection) continue;
      item.state.connections.delete(item.connectionId);
      item.connection.dispose();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const targetId of [...this.sessions.keys()]) await this.detachSession(targetId);
    this.authorized.clear();
  }
}

function buildTransportClientSource(bindingName, { requestTimeoutMs = MAX_TRANSPORT_REQUEST_TIMEOUT_MS } = {}) {
  return `(${installTransportClient.toString()})(${JSON.stringify(bindingName)}, ${JSON.stringify(TRANSPORT_GLOBAL)}, ${Number(requestTimeoutMs)}, ${MAX_TRANSPORT_FRAME_BYTES}, ${MAX_TRANSPORT_PENDING_REQUESTS});`;
}

function installTransportClient(bindingName, globalName, requestTimeoutMs, maxFrameBytes, maxPendingRequests) {
  const binding = globalThis[bindingName];
  const previous = globalThis[globalName];
  try { previous?.dispose?.("Loader local transport reconnected"); } catch {}
  if (typeof binding !== "function") {
    globalThis[globalName] = Object.freeze({
      connected: false,
      openWebSocket() { return Promise.reject(new Error("Loader local transport is not connected")); },
      dispose() {},
    });
    return;
  }

  const pending = new Map();
  const cancelledOpenRequests = new Map();
  const sockets = new Set();
  const maxBufferedEvents = 32;
  const maxBufferedBytes = 256 * 1024;
  const connectionIdPattern = /^[a-f0-9]{32}$/u;
  let nextId = 1;
  let disposed = false;

  function request(payload) {
    if (disposed) return Promise.reject(new Error("Loader local transport is not connected"));
    if (pending.size >= maxPendingRequests) return Promise.reject(new Error("Loader local transport request limit reached"));
    const id = `${Date.now().toString(36)}-${(nextId++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Loader local transport request timed out"));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, payload });
      try { binding(JSON.stringify({ version: 1, id, ...payload })); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function fireAndForget(payload) {
    if (typeof binding !== "function") return;
    const id = `${Date.now().toString(36)}-${(nextId++).toString(36)}`;
    try { binding(JSON.stringify({ version: 1, id, ...payload })); } catch {}
  }

  function rememberCancelledOpen(id, item) {
    if (item?.payload?.op !== "open") return;
    while (cancelledOpenRequests.size >= maxPendingRequests) {
      const oldest = cancelledOpenRequests.keys().next().value;
      if (oldest === undefined) break;
      const removed = cancelledOpenRequests.get(oldest);
      clearTimeout(removed?.timer);
      cancelledOpenRequests.delete(oldest);
    }
    const timer = setTimeout(() => cancelledOpenRequests.delete(id), requestTimeoutMs);
    cancelledOpenRequests.set(id, { pluginId: item.payload.pluginId, timer });
  }

  class LocalSocket {
    constructor(pluginId, endpoint) {
      this.pluginId = pluginId;
      this.endpoint = endpoint;
      this.readyState = 0;
      this.connectionId = null;
      this.listeners = new Map();
      this.handlers = { open: null, error: null, message: null, close: null };
      this.eventBuffer = [];
      this.eventBufferBytes = 0;
      this.polling = false;
      this.finished = false;
      this.closeRequested = false;
      for (const type of ["open", "error", "message", "close"]) Object.defineProperty(this, `on${type}`, { configurable: true, get: () => this.handlers[type], set: value => { this.handlers[type] = typeof value === "function" ? value : null; this.flush(type); } });
      sockets.add(this);
    }

    addEventListener(type, listener) {
      if (typeof listener !== "function") return;
      const list = this.listeners.get(type) || [];
      list.push(listener);
      this.listeners.set(type, list);
      this.flush(type);
    }

    removeEventListener(type, listener) {
      const list = this.listeners.get(type) || [];
      this.listeners.set(type, list.filter(item => item !== listener));
    }

    emit(type, event) {
      const list = this.listeners.get(type) || [];
      if (!this.handlers[type] && list.length === 0 && type !== "open") {
        this.bufferEvent(type, event);
        return;
      }
      this.dispatch(type, event);
    }

    bufferEvent(type, event) {
      const bytes = typeof event?.data === "string" ? new TextEncoder().encode(event.data).byteLength : 128;
      if (bytes > maxBufferedBytes) return;
      while (this.eventBuffer.length >= maxBufferedEvents || this.eventBufferBytes + bytes > maxBufferedBytes) {
        const removed = this.eventBuffer.shift();
        if (!removed) break;
        this.eventBufferBytes -= typeof removed.event?.data === "string" ? new TextEncoder().encode(removed.event.data).byteLength : 128;
      }
      this.eventBuffer.push({ type, event });
      this.eventBufferBytes += bytes;
    }

    dispatch(type, event) {
      try { this.handlers[type]?.(event); } catch {}
      for (const listener of this.listeners.get(type) || []) { try { listener(event); } catch {} }
    }

    flush(type) {
      if (!this.handlers[type] && (this.listeners.get(type) || []).length === 0) return;
      const pending = [];
      const remaining = [];
      for (const item of this.eventBuffer) (item.type === type ? pending : remaining).push(item);
      this.eventBuffer = remaining;
      this.eventBufferBytes = remaining.reduce((total, item) => total + (typeof item.event?.data === "string" ? new TextEncoder().encode(item.event.data).byteLength : 128), 0);
      for (const item of pending) this.dispatch(item.type, item.event);
    }

    open() {
      return request({ op: "open", pluginId: this.pluginId, endpoint: this.endpoint }).then(result => {
        if (!result || typeof result.connectionId !== "string" || !connectionIdPattern.test(result.connectionId)) throw new Error("Loader local transport returned an invalid connection");
        if (this.finished || disposed) {
          fireAndForget({ op: "close", pluginId: this.pluginId, connectionId: result.connectionId });
          throw new Error("Loader local transport owner was disposed");
        }
        this.connectionId = result.connectionId;
        this.readyState = 1;
        this.emit("open", {});
        this.poll();
        return this;
      }).catch(error => {
        this.fail(error);
        throw error;
      });
    }

    send(data) {
      if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > maxFrameBytes) throw new Error("Loader local transport text frame is too large");
      if (this.readyState !== 1 || !this.connectionId) throw new Error("Loader local transport socket is not open");
      void request({ op: "send", pluginId: this.pluginId, connectionId: this.connectionId, data }).catch(error => this.fail(error));
    }

    poll() {
      if (this.polling || this.finished || !this.connectionId || this.readyState !== 1) return;
      this.polling = true;
      void request({ op: "poll", pluginId: this.pluginId, connectionId: this.connectionId, waitMs: 1000 }).then(result => {
        this.polling = false;
        for (const event of Array.isArray(result?.events) ? result.events : []) {
          if (event?.type === "message" && typeof event.data === "string") this.emit("message", { data: event.data });
          if (event?.type === "close") this.finish(Number.isInteger(event.code) ? event.code : 1000);
        }
        if (!result?.closed && !this.finished) this.poll();
      }).catch(error => {
        this.polling = false;
        if (!this.finished) this.fail(error);
      });
    }

    close() {
      if (this.finished) return;
      if (!this.connectionId) {
        this.finish(1000);
        return;
      }
      if (this.closeRequested) return;
      this.closeRequested = true;
      this.readyState = 2;
      if (disposed || pending.size >= maxPendingRequests) {
        fireAndForget({ op: "close", pluginId: this.pluginId, connectionId: this.connectionId });
        this.finish(1000);
        return;
      }
      void request({ op: "close", pluginId: this.pluginId, connectionId: this.connectionId }).catch(() => {}).finally(() => this.finish(1000));
    }

    fail(error) {
      if (this.finished) return;
      this.emit("error", error);
      this.close();
    }

    finish(code) {
      if (this.finished) return;
      this.finished = true;
      this.readyState = 3;
      sockets.delete(this);
      this.emit("close", { code, wasClean: code === 1000 });
    }

    dispose() {
      if (!this.finished && this.connectionId && !this.closeRequested) {
        this.closeRequested = true;
        fireAndForget({ op: "close", pluginId: this.pluginId, connectionId: this.connectionId });
      }
      if (!this.finished) this.finish(1000);
      this.listeners.clear();
      this.handlers = { open: null, error: null, message: null, close: null };
      this.eventBuffer = [];
      this.eventBufferBytes = 0;
    }
  }

  globalThis[globalName] = {
    connected: true,
    openWebSocket(pluginId, endpoint) {
      if (typeof pluginId !== "string" || typeof endpoint !== "string") return Promise.reject(new Error("Loader local transport arguments are invalid"));
      const socket = new LocalSocket(pluginId, endpoint);
      return socket.open();
    },
    receive(message) {
      if (!message || typeof message.id !== "string") return;
      const item = pending.get(message.id);
      if (!item) {
        const cancelled = cancelledOpenRequests.get(message.id);
        if (!cancelled) return;
        clearTimeout(cancelled.timer);
        cancelledOpenRequests.delete(message.id);
        const connectionId = message.ok && typeof message.result?.connectionId === "string" && connectionIdPattern.test(message.result.connectionId) ? message.result.connectionId : null;
        if (connectionId) fireAndForget({ op: "close", pluginId: cancelled.pluginId, connectionId });
        return;
      }
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.ok) item.resolve(message.result);
      else item.reject(new Error(String(message.message || "Loader local transport request failed")));
    },
    dispose(reason = "Loader local transport disconnected") {
      if (disposed) return;
      disposed = true;
      for (const [id, item] of pending) {
        clearTimeout(item.timer);
        rememberCancelledOpen(id, item);
        item.reject(new Error(reason));
      }
      pending.clear();
      for (const socket of sockets) socket.dispose();
      sockets.clear();
    },
  };
}

export { buildTransportClientSource, sanitizedTransportError, TRANSPORT_GLOBAL as LOCAL_TRANSPORT_GLOBAL };
