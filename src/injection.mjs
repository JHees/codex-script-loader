import { integrityLabel } from "./hash.mjs";

export function buildBootstrapSource() {
  return `(() => {
  const existing = globalThis.__codexScriptLoader;
  const runtime = existing && typeof existing === "object" ? existing : {};
  runtime.runtimeVersion = "0.0.1";
  runtime.documentId = runtime.documentId || Math.random().toString(36).slice(2);
  runtime.scripts = runtime.scripts || Object.create(null);
  runtime.errors = runtime.errors || [];
  globalThis.__codexScriptLoader = runtime;
})();`;
}

export function wrapScript(descriptor) {
  const id = JSON.stringify(descriptor.id);
  const fingerprint = JSON.stringify(descriptor.fingerprint);
  const source = descriptor.source;
  return `(() => {
  const runtime = globalThis.__codexScriptLoader || (globalThis.__codexScriptLoader = { scripts: Object.create(null), errors: [] });
  const previous = runtime.scripts[${id}];
  if (previous && previous.fingerprint === ${fingerprint} && previous.status === "running") return;
  if (previous && typeof previous.stop === "function") {
    try { previous.stop(); } catch (error) { runtime.errors.push({ id: ${id}, phase: "stop", error: String(error) }); }
  }
  const record = { id: ${id}, version: ${JSON.stringify(descriptor.version)}, fingerprint: ${fingerprint}, integrity: ${JSON.stringify(integrityLabel(descriptor.fingerprint))}, status: "loading", stop: null };
  runtime.scripts[${id}] = record;
  try {
    const moduleValue = (() => {\n${source}\n//# sourceURL=codex-script-loader/${descriptor.id}.js\n})();
    if (moduleValue && typeof moduleValue.stop === "function") record.stop = moduleValue.stop;
    record.status = "running";
  } catch (error) {
    record.status = "failed";
    record.error = String(error && (error.stack || error.message) || error);
    runtime.errors.push({ id: ${id}, phase: "start", error: record.error });
  }
})();`;
}

export function buildInjectionSource(descriptors) {
  return [buildBootstrapSource(), ...descriptors.map(wrapScript)].join("\n");
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
