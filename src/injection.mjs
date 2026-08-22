import { integrityLabel } from "./hash.mjs";

export function buildBootstrapSource() {
  return `(() => {
  const existing = globalThis.__codexScriptLoader;
  const runtime = existing && typeof existing === "object" ? existing : {};
  runtime.runtimeVersion = "0.0.1";
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
    const moduleValue = (() => {\n${source}\n//# sourceURL=codex-script-loader/${descriptor.id}.js\n})();
    if (moduleValue && typeof moduleValue.stop === "function") record.stop = moduleValue.stop;
    if (!record.stop && ${lifecycleGlobal}) {
      const lifecycleValue = globalThis[${lifecycleGlobal}];
      if (lifecycleValue && typeof lifecycleValue.stop === "function") {
        record.stop = () => {
          try { lifecycleValue.stop(); }
          finally { if (globalThis[${lifecycleGlobal}] === lifecycleValue) delete globalThis[${lifecycleGlobal}]; }
        };
      }
    }
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
  return [buildBootstrapSource(), buildLifecycleSyncSource(descriptors), ...descriptors.map(descriptor => wrapScript(descriptor, { force: forced.has(descriptor.id) })), buildRuntimeSnapshotSource()].join("\n");
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
