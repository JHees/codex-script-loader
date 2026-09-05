import { randomBytes } from "node:crypto";
import { assertLoopbackEndpoint, pickCodexTargets } from "./cdp.mjs";

const BRIDGE_GLOBAL = "__codexScriptLoaderHostBridge";
const ALLOWED_COMMANDS = new Set([
  "get_app_status", "list_plugins", "set_plugin_enabled", "reload_scripts", "reload_plugins",
  "pick_plugin_folder", "pick_plugin_archive", "install_plugin", "cancel_plugin_install",
  "preview_plugin_github",
  "remove_plugin", "list_quarantined", "restore_plugin", "restart_codex",
  "get_update_status", "set_auto_update", "check_for_updates", "start_update", "cancel_update",
  "check_plugin_updates", "set_plugin_auto_update", "start_plugin_update", "confirm_plugin_update", "cancel_plugin_update",
  "page_companion_probe", "page_companion_bind", "page_companion_invoke", "page_companion_unbind"
]);
const MAX_REQUEST_BYTES = 16 * 1024;

function createBindingName() {
  return `__codex_loader_${randomBytes(12).toString("hex")}`;
}

function sanitizedBridgeError(error) {
  return String(error?.message || error || "Loader request failed")
    .replace(/\b(?:wss?|https?):\/\/[^\s)]+/giu, "[local endpoint]")
    .replace(/[A-Za-z]:\\[^\r\n]*/gu, "[local path]")
    .slice(0, 300);
}

function buildBridgeClientSource(bindingName, { requestTimeoutMs = 8000 } = {}) {
  return `(${installBridgeClient.toString()})(${JSON.stringify(bindingName)}, ${JSON.stringify(BRIDGE_GLOBAL)}, ${Number(requestTimeoutMs)});`;
}

function installBridgeClient(bindingName, globalName, requestTimeoutMs) {
  const binding = globalThis[bindingName];
  const previous = globalThis[globalName];
  try { previous?.dispose?.("Loader bridge reconnected"); } catch {}
  if (typeof binding !== "function") {
    globalThis[globalName] = Object.freeze({
      connected: false,
      request() { return Promise.reject(new Error("Loader sidecar is not connected")); },
      dispose() {},
    });
    return;
  }

  const pending = new Map();
  let nextId = 1;
  let disposed = false;
  const client = {
    bindingName,
    connected: true,
    request(command, payload = {}) {
      if (disposed) return Promise.reject(new Error("Loader sidecar is not connected"));
      const id = `${Date.now().toString(36)}-${(nextId++).toString(36)}`;
      return new Promise((resolve, reject) => {
        const timeoutMs = command === "page_companion_invoke" ? Math.max(requestTimeoutMs, 300000)
          : command === "preview_plugin_github" ? Math.max(requestTimeoutMs, 150000) : requestTimeoutMs;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Loader request timed out"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          binding(JSON.stringify({ version: 1, id, command, payload }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    receive(message) {
      if (!message || typeof message.id !== "string") return;
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.ok) item.resolve(message.result);
      else item.reject(new Error(String(message.error || "Loader request failed")));
    },
    dispose(reason = "Loader sidecar disconnected") {
      if (disposed) return;
      disposed = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error(reason));
      }
      pending.clear();
    },
  };
  globalThis[globalName] = client;
}

function parseRequest(payload) {
  if (typeof payload !== "string") throw new Error("Loader bridge payload must be text");
  if (Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) throw new Error("Loader bridge payload is too large");
  let request;
  try { request = JSON.parse(payload); }
  catch { throw new Error("Loader bridge payload is invalid JSON"); }
  if (!request || request.version !== 1 || typeof request.id !== "string" || !request.id || request.id.length > 128) {
    throw new Error("Loader bridge request envelope is invalid");
  }
  if (!ALLOWED_COMMANDS.has(request.command)) throw new Error("Loader bridge command is not allowed");
  if (request.payload !== undefined && (typeof request.payload !== "object" || request.payload === null || Array.isArray(request.payload))) {
    throw new Error("Loader bridge request payload is invalid");
  }
  const body = request.payload || {};
  if (request.command === "reload_scripts") return { id: request.id, command: request.command, payload: { live: true } };
  if (request.command === "reload_plugins") return { id: request.id, command: request.command, payload: { live: true, ...(Array.isArray(body.ids) ? { ids: body.ids } : {}) } };
  return { id: request.id, command: request.command, payload: body };
}

export class LoaderHostBridge {
  constructor({ dispatch, targetProvider, sessionFactory, bindingName = createBindingName(), requestTimeoutMs = 8000, transportHost = null } = {}) {
    if (typeof dispatch !== "function" || typeof targetProvider !== "function" || typeof sessionFactory !== "function") {
      throw new TypeError("dispatch, targetProvider and sessionFactory are required");
    }
    this.dispatch = dispatch;
    this.targetProvider = targetProvider;
    this.sessionFactory = sessionFactory;
    this.bindingName = bindingName;
    this.requestTimeoutMs = requestTimeoutMs;
    this.transportHost = transportHost;
    this.sessions = new Map();
    this.syncPromise = null;
    this.closed = false;
  }

  async sync({ targets: suppliedTargets } = {}) {
    if (this.closed) return [];
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.syncUnlocked(suppliedTargets).finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }

  async syncUnlocked(suppliedTargets) {
    const targets = pickCodexTargets(suppliedTargets ?? await this.targetProvider());
    const desired = new Map(targets.map(target => [target.id, target]));
    for (const [targetId, state] of this.sessions) {
      const target = desired.get(targetId);
      if (!target || target.webSocketDebuggerUrl !== state.endpoint) await this.dropSession(targetId);
    }
    for (const target of targets) {
      if (this.sessions.has(target.id)) continue;
      await this.attach(target);
    }
    return targets;
  }

  async attach(target) {
    const endpoint = assertLoopbackEndpoint(target.webSocketDebuggerUrl).href;
    const session = await this.sessionFactory(endpoint);
    if (typeof session.onEvent !== "function") {
      await session.close?.();
      throw new Error("CDP session does not support runtime events");
    }
    let registrationId = null;
    try {
      await session.sendCommand("Runtime.enable", {});
      await session.sendCommand("Page.enable", {});
      await session.sendCommand("Runtime.addBinding", { name: this.bindingName });
      const source = buildBridgeClientSource(this.bindingName, { requestTimeoutMs: this.requestTimeoutMs });
      const registration = await session.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
      registrationId = registration?.identifier || registration?.result?.identifier || null;
      const unsubscribe = session.onEvent(message => {
        if (message?.method !== "Runtime.bindingCalled" || message.params?.name !== this.bindingName) return;
        void this.handleBindingCall(target.id, message.params);
      });
      this.sessions.set(target.id, { endpoint, session, unsubscribe, registrationId });
      if (this.transportHost?.attachToSession) await this.transportHost.attachToSession(target, session);
      const evaluation = await session.sendCommand("Runtime.evaluate", { expression: source, returnByValue: true });
      if (evaluation?.exceptionDetails) throw new Error("renderer rejected the Loader bridge client");
    } catch (error) {
      try { await this.transportHost?.detachSession?.(target.id); } catch {}
      this.sessions.delete(target.id);
      if (registrationId) {
        try { await session.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: registrationId }); } catch {}
      }
      try { await session.sendCommand("Runtime.removeBinding", { name: this.bindingName }); } catch {}
      try { await session.close?.(); } catch {}
      throw error;
    }
  }

  async handleBindingCall(targetId, params) {
    let requestId = null;
    let response;
    try {
      const request = parseRequest(params?.payload);
      requestId = request.id;
      const dispatched = await this.dispatch(request.command, request.payload);
      const result = request.command === "reload_scripts" || request.command === "reload_plugins"
        ? {
            mode: "live",
            targetCount: Number(dispatched?.targetCount || 0),
            scriptCount: Array.isArray(dispatched?.summary) ? dispatched.summary.length : 0,
            safeMode: Boolean(dispatched?.safeMode),
          }
        : dispatched;
      response = { id: request.id, ok: true, result };
    } catch (error) {
      if (!requestId) {
        const rawPayload = params?.payload;
        if (typeof rawPayload === "string" && Buffer.byteLength(rawPayload, "utf8") <= MAX_REQUEST_BYTES) {
          try { requestId = JSON.parse(rawPayload)?.id || null; } catch {}
        }
      }
      if (!requestId) return;
      response = { id: String(requestId).slice(0, 128), ok: false, error: sanitizedBridgeError(error) };
    }
    const state = this.sessions.get(targetId);
    if (!state) return;
    const expression = `globalThis[${JSON.stringify(BRIDGE_GLOBAL)}]?.receive(${JSON.stringify(response)});`;
    try {
      await state.session.sendCommand("Runtime.evaluate", {
        expression,
        ...(Number.isInteger(params?.executionContextId) ? { contextId: params.executionContextId } : {}),
        returnByValue: true,
      });
    } catch {
      // The renderer may have been replaced while a reload request completed.
    }
  }

  async dropSession(targetId) {
    const state = this.sessions.get(targetId);
    if (!state) return;
    this.sessions.delete(targetId);
    try { await this.transportHost?.detachSession?.(targetId); } catch {}
    try { state.unsubscribe?.(); } catch {}
    try {
      await state.session.sendCommand("Runtime.evaluate", {
        expression: `globalThis[${JSON.stringify(BRIDGE_GLOBAL)}]?.bindingName === ${JSON.stringify(this.bindingName)} && globalThis[${JSON.stringify(BRIDGE_GLOBAL)}].dispose("Loader sidecar disconnected");`,
      });
    } catch {}
    if (state.registrationId) {
      try { await state.session.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: state.registrationId }); } catch {}
    }
    try { await state.session.sendCommand("Runtime.removeBinding", { name: this.bindingName }); } catch {}
    try { await state.session.close?.(); } catch {}
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map(targetId => this.dropSession(targetId)));
  }
}

export { ALLOWED_COMMANDS, BRIDGE_GLOBAL, MAX_REQUEST_BYTES, buildBridgeClientSource, parseRequest, sanitizedBridgeError };
