import { createHash } from "node:crypto";
import { assertLoopbackEndpoint } from "./cdp.mjs";

const ALLOWED_ORIGINS = new Set(["https://chatgpt.com"]);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const RUNTIME_GLOBAL = "__codexScriptLoaderPageCompanions";

function targetOrigin(target) {
  try { return new URL(target.url).origin; } catch { return null; }
}

function descriptorMap(descriptors) {
  return new Map((descriptors || [])
    .filter(item => item?.pageCompanion && item.permissions?.includes("browser-page-companion"))
    .map(item => [item.id, item]));
}

export class PageCompanionHost {
  constructor({ targetProvider, sessionFactory }) {
    if (typeof targetProvider !== "function" || typeof sessionFactory !== "function") throw new TypeError("targetProvider and sessionFactory are required");
    this.targetProvider = targetProvider;
    this.sessionFactory = sessionFactory;
    this.authorized = new Map();
    this.bindings = new Map();
    this.closed = false;
  }

  async setAuthorizedPlugins(descriptors) {
    const desired = descriptorMap(descriptors);
    for (const [pluginId, binding] of this.bindings) {
      if (desired.get(pluginId)?.pageCompanion?.fingerprint !== binding.fingerprint) await this.unbind(pluginId, { requireAuthorization: false });
    }
    this.authorized = desired;
  }

  async probe(pluginId) {
    const descriptor = this.requireDescriptor(pluginId);
    const targets = await this.targetsFor(descriptor.pageCompanion.origin);
    return { available: targets.length === 1, candidateCount: targets.length, bound: this.bindings.has(pluginId), origin: descriptor.pageCompanion.origin };
  }

  async bind(pluginId) {
    const descriptor = this.requireDescriptor(pluginId);
    const companion = descriptor.pageCompanion;
    const previous = this.bindings.get(pluginId);
    if (previous && await this.isCurrent(previous, companion)) return { bound: true, targetIdentity: previous.targetId, origin: companion.origin };
    if (previous) await this.unbind(pluginId, { requireAuthorization: false });
    const targets = await this.targetsFor(companion.origin);
    if (targets.length === 0) throw new Error("PAGE_COMPANION_TARGET_NOT_FOUND");
    if (targets.length !== 1) throw new Error("PAGE_COMPANION_TARGET_AMBIGUOUS");
    const target = targets[0];
    const session = await this.sessionFactory(assertLoopbackEndpoint(target.webSocketDebuggerUrl).href);
    let registrationId = null;
    try {
      await session.sendCommand("Runtime.enable", {});
      await session.sendCommand("Page.enable", {});
      const source = buildPageCompanionSource(pluginId, companion);
      const registration = await session.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
      registrationId = registration?.identifier || registration?.result?.identifier || null;
      const binding = { pluginId, targetId: target.id, endpoint: target.webSocketDebuggerUrl, origin: companion.origin, fingerprint: companion.fingerprint, session, registrationId };
      binding.unsubscribe = session.onEvent?.(message => {
        if (message?.method !== "Page.frameNavigated") return;
        if (message.params?.frame?.parentId) return;
        // Any main-frame navigation (including a same-origin reload) destroys
        // the authorization lifetime. A fresh explicit bind must reinject.
        void this.unbind(pluginId, { requireAuthorization: false }).catch(() => {});
      });
      this.bindings.set(pluginId, binding);
      const evaluation = await session.sendCommand("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true });
      if (evaluation?.exceptionDetails) throw new Error("Page companion bundle failed to start");
      return { bound: true, targetIdentity: target.id, origin: companion.origin };
    } catch (error) {
      this.bindings.delete(pluginId);
      if (registrationId) await session.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: registrationId }).catch(() => {});
      await session.close?.().catch?.(() => {});
      throw error;
    }
  }

  async invoke(pluginId, operation, payload = {}) {
    const descriptor = this.requireDescriptor(pluginId);
    if (!descriptor.pageCompanion.operations.includes(operation)) throw new Error("Page companion operation is not allowed");
    const serializedPayload = JSON.stringify(payload);
    if (Buffer.byteLength(serializedPayload, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("Page companion payload is too large");
    const binding = this.bindings.get(pluginId);
    if (!binding || !await this.isCurrent(binding, descriptor.pageCompanion)) {
      if (binding) await this.unbind(pluginId, { requireAuthorization: false });
      throw new Error("PAGE_COMPANION_BINDING_UNAVAILABLE");
    }
    const expression = `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}]?.plugins?.[${JSON.stringify(pluginId)}]?.invoke(${JSON.stringify(operation)}, ${serializedPayload})`;
    const evaluation = await binding.session.sendCommand("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (evaluation?.exceptionDetails) throw new Error("Page companion operation failed");
    const value = evaluation?.result?.value ?? evaluation?.value;
    if (value === undefined) throw new Error("Page companion returned no serializable result");
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESULT_BYTES) throw new Error("Page companion result is too large");
    return value;
  }

  async unbind(pluginId, { requireAuthorization = true } = {}) {
    if (requireAuthorization) this.requireDescriptor(pluginId);
    const binding = this.bindings.get(pluginId);
    if (!binding) return { unbound: true, wasBound: false };
    this.bindings.delete(pluginId);
    try { binding.unsubscribe?.(); } catch {}
    const expression = `globalThis[${JSON.stringify(RUNTIME_GLOBAL)}]?.plugins?.[${JSON.stringify(pluginId)}]?.stop?.("Loader page companion unbound")`;
    await binding.session.sendCommand("Runtime.evaluate", { expression }).catch(() => {});
    if (binding.registrationId) await binding.session.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: binding.registrationId }).catch(() => {});
    await binding.session.close?.().catch?.(() => {});
    return { unbound: true, wasBound: true };
  }

  async sync() {
    for (const [pluginId, binding] of [...this.bindings]) {
      const descriptor = this.authorized.get(pluginId);
      if (!descriptor?.pageCompanion || !await this.isCurrent(binding, descriptor.pageCompanion)) await this.unbind(pluginId, { requireAuthorization: false });
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const pluginId of [...this.bindings.keys()]) await this.unbind(pluginId, { requireAuthorization: false });
    this.authorized.clear();
  }

  requireDescriptor(pluginId) {
    if (this.closed) throw new Error("Page companion host is closed");
    const descriptor = this.authorized.get(pluginId);
    if (!descriptor?.pageCompanion) throw new Error("PAGE_COMPANION_PERMISSION_DENIED");
    return descriptor;
  }

  async targetsFor(origin) {
    if (!ALLOWED_ORIGINS.has(origin)) throw new Error("Page companion origin is not allowlisted");
    return (await this.targetProvider()).filter(target => target?.type === "page" && targetOrigin(target) === origin && target.webSocketDebuggerUrl);
  }

  async isCurrent(binding, companion) {
    const target = (await this.targetProvider()).find(item => item.id === binding.targetId);
    return Boolean(target && target.webSocketDebuggerUrl === binding.endpoint && targetOrigin(target) === companion.origin);
  }
}

export function buildPageCompanionSource(pluginId, companion) {
  const fingerprint = companion.fingerprint || createHash("sha256").update(companion.source).digest("hex");
  return `(() => {
    const runtime = globalThis[${JSON.stringify(RUNTIME_GLOBAL)}] || (globalThis[${JSON.stringify(RUNTIME_GLOBAL)}] = { plugins: Object.create(null) });
    const previous = runtime.plugins[${JSON.stringify(pluginId)}];
    if (previous?.fingerprint === ${JSON.stringify(fingerprint)} && typeof previous.invoke === "function") return { ready: true, reused: true };
    try { previous?.stop?.("Loader page companion replaced"); } catch {}
    const module = { exports: {} };
    ((module, exports) => {\n${companion.source}\n})(module, module.exports);
    const implementation = module.exports?.default || module.exports;
    if (!implementation || typeof implementation.invoke !== "function") throw new Error("Page companion must export invoke(operation, payload)");
    let stopped = false;
    const record = {
      fingerprint: ${JSON.stringify(fingerprint)},
      invoke(operation, payload) { if (stopped) throw new Error("Page companion is stopped"); return implementation.invoke(operation, payload); },
      stop(reason) { if (stopped) return; stopped = true; try { implementation.stop?.(reason); } finally { if (runtime.plugins[${JSON.stringify(pluginId)}] === record) delete runtime.plugins[${JSON.stringify(pluginId)}]; } }
    };
    runtime.plugins[${JSON.stringify(pluginId)}] = record;
    return { ready: true, reused: false };
  })()\n//# sourceURL=codex-script-loader/page-companion/${pluginId}.js`;
}

export { ALLOWED_ORIGINS, MAX_PAYLOAD_BYTES, MAX_RESULT_BYTES };
