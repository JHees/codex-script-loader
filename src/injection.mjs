import { integrityLabel } from "./hash.mjs";
import { buildSettingsHostSource } from "./settings-host.mjs";

export function buildBootstrapSource() {
  return `(() => {
  const existing = globalThis.__codexScriptLoader;
  const runtime = existing && typeof existing === "object" ? existing : {};
  runtime.runtimeVersion = "0.1.0";
  runtime.documentId = runtime.documentId || Math.random().toString(36).slice(2);
  runtime.scripts = runtime.scripts || Object.create(null);
  runtime.errors = Array.isArray(runtime.errors) ? runtime.errors.slice(-100) : [];
  runtime.recordError = (entry) => {
    runtime.errors.push(entry);
    if (runtime.errors.length > 100) runtime.errors.splice(0, runtime.errors.length - 100);
  };
  globalThis.__codexScriptLoader = runtime;
})();`;
}

export function wrapScript(descriptor, { force = false } = {}) {
  const id = JSON.stringify(descriptor.id);
  const fingerprint = JSON.stringify(descriptor.fingerprint);
  const lifecycleGlobal = descriptor.lifecycleGlobal ? JSON.stringify(descriptor.lifecycleGlobal) : "null";
  const permissions = JSON.stringify(descriptor.permissions || []);
  const manifest = JSON.stringify({
    id: descriptor.id,
    name: descriptor.name,
    version: descriptor.version,
    description: descriptor.raw?.description || "",
    author: descriptor.raw?.author || "",
    permissions: descriptor.permissions || [],
    scope: descriptor.scope || "renderer",
  });
  const source = descriptor.source;
  return `(() => {
  const runtime = globalThis.__codexScriptLoader || (globalThis.__codexScriptLoader = { scripts: Object.create(null), errors: [] });
  const previous = runtime.scripts[${id}];
  if (!${force ? "true" : "false"} && previous && previous.fingerprint === ${fingerprint} && previous.status === "running") return;
  if (previous && typeof previous.stop === "function") {
    try { previous.stop(); } catch (error) { runtime.recordError({ id: ${id}, phase: "stop", error: String(error) }); }
  }
  const record = { id: ${id}, version: ${JSON.stringify(descriptor.version)}, fingerprint: ${fingerprint}, integrity: ${JSON.stringify(integrityLabel(descriptor.fingerprint))}, status: "loading", stop: null };
  runtime.scripts[${id}] = record;
  try {
    const permissionSet = new Set(${permissions});
    const settingsPrefix = "codex-script-loader:${descriptor.id}:";
    const disposers = [];
    const manifest = Object.freeze(${manifest});
    const requirePermission = (permission) => {
      if (!permissionSet.has(permission)) throw new Error(permission + " permission is required");
    };
    const storage = Object.freeze({
      get: (key, fallback = null) => {
        requirePermission("local-storage");
        try {
          const raw = localStorage.getItem(settingsPrefix + String(key));
          return raw === null ? fallback : JSON.parse(raw);
        } catch { return fallback; }
      },
      set: (key, value) => {
        requirePermission("local-storage");
        localStorage.setItem(settingsPrefix + String(key), JSON.stringify(value));
        return value;
      },
      delete: (key) => {
        requirePermission("local-storage");
        localStorage.removeItem(settingsPrefix + String(key));
      }
    });
    const settings = permissionSet.has("settings") ? Object.freeze({
      register: (section) => {
        const handle = runtime.settingsHost.registerSection(${id}, manifest, section);
        disposers.push(() => handle.unregister());
        return handle;
      },
      registerPage: (page) => {
        const handle = runtime.settingsHost.registerPage(${id}, manifest, page);
        disposers.push(() => handle.unregister());
        return handle;
      }
    }) : undefined;
    const api = Object.freeze({
      id: ${id},
      version: ${JSON.stringify(descriptor.version)},
      manifest,
      process: "renderer",
      permissions: Object.freeze([...permissionSet]),
      log: Object.freeze({
        info: (...args) => console.info("[${descriptor.id}]", ...args),
        warn: (...args) => console.warn("[${descriptor.id}]", ...args),
        error: (...args) => console.error("[${descriptor.id}]", ...args)
      }),
      storage,
      settings,
      dom: Object.freeze({
        ready: () => document.readyState === "loading" ? new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true })) : Promise.resolve(),
        observe: (target, callback, options = { childList: true, subtree: true }) => {
          requirePermission("dom");
          const observer = new MutationObserver(callback);
          observer.observe(target, options);
          disposers.push(() => observer.disconnect());
          return () => observer.disconnect();
        }
      }),
      events: Object.freeze({
        on: (target, type, listener, options) => {
          target.addEventListener(type, listener, options);
          const dispose = () => target.removeEventListener(type, listener, options);
          disposers.push(dispose);
          return dispose;
        }
      })
    });
    const module = { exports: {} };
    runtime.activeApi = api;
    try {
      ((module, exports, api) => {\n${source}\n//# sourceURL=codex-script-loader/${descriptor.id}.js\n})(module, module.exports, api);
    } finally {
      if (runtime.activeApi === api) delete runtime.activeApi;
    }
    const moduleValue = module.exports;
    let startResult = null;
    if (moduleValue && typeof moduleValue.start === "function") startResult = moduleValue.start(api);
    const exportedStop = moduleValue && typeof moduleValue.stop === "function" ? () => moduleValue.stop() : typeof startResult === "function" ? startResult : startResult && typeof startResult.stop === "function" ? () => startResult.stop() : null;
    const lifecycleValue = ${lifecycleGlobal} ? globalThis[${lifecycleGlobal}] : null;
    const lifecycleStop = !exportedStop && lifecycleValue && typeof lifecycleValue.stop === "function" ? () => {
      try { lifecycleValue.stop(); }
      finally { if (globalThis[${lifecycleGlobal}] === lifecycleValue) delete globalThis[${lifecycleGlobal}]; }
    } : null;
    if (exportedStop || lifecycleStop || disposers.length) record.stop = () => {
      try {
        if (exportedStop) exportedStop();
        else if (lifecycleStop) lifecycleStop();
      }
      finally { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch {} } }
    };
    record.status = "running";
  } catch (error) {
    record.status = "failed";
    record.error = String(error && (error.stack || error.message) || error);
    if (${lifecycleGlobal}) {
      const failedLifecycle = globalThis[${lifecycleGlobal}];
      if (failedLifecycle && typeof failedLifecycle.stop === "function") {
        try { failedLifecycle.stop(); } catch (stopError) { runtime.recordError({ id: ${id}, phase: "failed-start-stop", error: String(stopError) }); }
      }
      if (globalThis[${lifecycleGlobal}] === failedLifecycle) delete globalThis[${lifecycleGlobal}];
    }
    runtime.recordError({ id: ${id}, phase: "start", error: record.error });
  }
})();`;
}

export function buildLifecycleSyncSource(descriptors) {
  const activeIds = JSON.stringify(descriptors.map(descriptor => descriptor.id));
  return `(() => {
  const runtime = globalThis.__codexScriptLoader;
  if (!runtime || !runtime.scripts) return;
  const active = new Set(${activeIds});
  for (const id of Object.keys(runtime.scripts)) {
    if (active.has(id)) continue;
    const record = runtime.scripts[id];
    if (record && typeof record.stop === "function") {
      try { record.stop(); } catch (error) { runtime.recordError({ id, phase: "stop", error: String(error) }); }
    }
    delete runtime.scripts[id];
  }
})();`;
}

export function buildRuntimeSnapshotSource() {
  return `(() => {
  const scripts = globalThis.__codexScriptLoader?.scripts || {};
  return Object.values(scripts).map((record) => ({
    id: String(record?.id || ""),
    version: String(record?.version || ""),
    status: new Set(["loading", "running", "failed"]).has(record?.status) ? record.status : "failed"
  }));
})()`;
}

export function buildInjectionSource(descriptors, { forceIds = [] } = {}) {
  if (!Array.isArray(forceIds)) throw new TypeError("forceIds must be an array");
  const forced = new Set(forceIds);
  return [buildBootstrapSource(), buildSettingsHostSource(), buildLifecycleSyncSource(descriptors), ...descriptors.map(descriptor => wrapScript(descriptor, { force: forced.has(descriptor.id) })), buildRuntimeSnapshotSource()].join("\n");
}

export function summarizePlan(descriptors) {
  return descriptors.map(descriptor => ({
    id: descriptor.id,
    version: descriptor.version,
    fingerprint: descriptor.fingerprint,
    integrity: integrityLabel(descriptor.fingerprint),
    runAt: descriptor.runAt
  }));
}
