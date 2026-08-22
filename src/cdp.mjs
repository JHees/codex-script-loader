const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertLoopbackEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (!new Set(["ws:", "wss:"]).has(url.protocol)) throw new Error("CDP endpoint must use ws/wss");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.username || url.password || !LOOPBACK_HOSTS.has(hostname)) throw new Error("CDP endpoint must be loopback-only");
  return url;
}

export function isLikelyCodexTarget(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const haystack = `${target.title || ""} ${target.url || ""}`.toLowerCase();
  return haystack.includes("codex") || haystack.includes("chatgpt");
}

export function pickCodexTargets(targets) {
  return (Array.isArray(targets) ? targets : []).filter(isLikelyCodexTarget);
}

export async function listTargets(port, { fetchFn = globalThis.fetch, timeoutMs = 3000 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid CDP port");
  if (typeof fetchFn !== "function") throw new Error("fetch is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/json`, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`CDP target query failed: ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("CDP target response must be an array");
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildCdpInjectionCommands(source) {
  return [
    { method: "Runtime.enable", params: {} },
    { method: "Page.enable", params: {} },
    { method: "Page.addScriptToEvaluateOnNewDocument", params: { source } },
    { method: "Runtime.evaluate", params: { expression: source, awaitPromise: false, returnByValue: true } }
  ];
}

export class CdpInjector {
  constructor({ targetProvider, sessionFactory }) {
    this.targetProvider = targetProvider;
    this.sessionFactory = sessionFactory;
    this.registrationIds = new Map();
  }

  async inject(source, { targets: suppliedTargets } = {}) {
    const targets = pickCodexTargets(suppliedTargets ?? await this.targetProvider());
    const activeTargetIds = new Set(targets.map(target => target.id));
    for (const targetId of this.registrationIds.keys()) {
      if (!activeTargetIds.has(targetId)) this.registrationIds.delete(targetId);
    }
    const results = [];
    for (const target of targets) {
      assertLoopbackEndpoint(target.webSocketDebuggerUrl);
      const session = await this.sessionFactory(target.webSocketDebuggerUrl);
      try {
        const previousId = this.registrationIds.get(target.id);
        if (previousId) {
          this.registrationIds.delete(target.id);
          try {
            await session.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: previousId });
          } catch {
            // A renderer reload invalidates old registration ids. Re-register below.
          }
        }
        await session.sendCommand("Runtime.enable", {});
        await session.sendCommand("Page.enable", {});
        const registration = await session.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
        const identifier = registration && (registration.identifier || registration.result?.identifier);
        let evaluation;
        try {
          evaluation = await session.sendCommand("Runtime.evaluate", { expression: source, awaitPromise: false, returnByValue: true });
          if (evaluation?.exceptionDetails) throw new Error("renderer rejected the injected script source");
        } catch (error) {
          if (identifier) {
            try { await session.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier }); }
            catch { /* The target may already have reloaded. */ }
          }
          throw error;
        }
        if (identifier) this.registrationIds.set(target.id, identifier);
        const scriptStatuses = Array.isArray(evaluation?.result?.value)
          ? evaluation.result.value.filter(item => item && typeof item.id === "string" && new Set(["loading", "running", "failed"]).has(item.status)).map(item => ({ id: item.id, version: String(item.version || ""), status: item.status }))
          : [];
        results.push({ targetId: target.id, injected: true, registrationId: identifier || null, ...(scriptStatuses.length ? { scriptStatuses } : {}) });
      } finally {
        if (typeof session.close === "function") await session.close();
      }
    }
    return results;
  }
}

export async function connectCdpSession(endpoint, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 5000 } = {}) {
  assertLoopbackEndpoint(endpoint);
  if (typeof WebSocketImpl !== "function") throw new Error("WebSocket is unavailable");
  const socket = new WebSocketImpl(endpoint);
  const pending = new Map();
  let nextId = 1;
  let opened = false;
  let resolveOpen;
  let rejectOpen;
  const openPromise = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const timer = setTimeout(() => {
    rejectOpen(new Error("CDP WebSocket connection timed out"));
    try { socket.close(); } catch {}
  }, timeoutMs);

  socket.onopen = () => { opened = true; clearTimeout(timer); resolveOpen(); };
  socket.onerror = event => {
    if (!opened) {
      clearTimeout(timer);
      rejectOpen(new Error(`CDP WebSocket error: ${event?.message || "unknown"}`));
    }
  };
  function rejectPending(error) {
    for (const pendingItem of pending.values()) {
      clearTimeout(pendingItem.timer);
      pendingItem.reject(error);
    }
    pending.clear();
  }

  socket.onclose = () => {
    clearTimeout(timer);
    if (!opened) rejectOpen(new Error("CDP WebSocket closed before opening"));
    rejectPending(new Error("CDP WebSocket closed"));
  };
  socket.onmessage = async event => {
    let message;
    try {
      const data = event.data;
      const text = typeof data === "string" ? data : data?.text ? await data.text() : new TextDecoder().decode(data);
      message = JSON.parse(text);
    } catch { return; }
    if (!message || !message.id || !pending.has(message.id)) return;
    const pendingItem = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(pendingItem.timer);
    if (message.error) pendingItem.reject(new Error(message.error.message || "CDP command failed"));
    else pendingItem.resolve(message.result);
  };

  await openPromise;
  return {
    sendCommand(method, params = {}) {
      if (socket.readyState !== undefined && socket.readyState !== 1) return Promise.reject(new Error("CDP WebSocket is not open"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const commandTimer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer: commandTimer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(commandTimer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      rejectPending(new Error("CDP session closed"));
      try { socket.close(); } catch {}
    }
  };
}
