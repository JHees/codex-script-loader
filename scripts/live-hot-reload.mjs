import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpInjector, connectCdpSession, listTargets, pickCodexTargets } from "../src/cdp.mjs";
import { ensureBundledPackages } from "../src/bundled.mjs";
import { LoaderHostBridge } from "../src/loader-bridge.mjs";
import { LiveSupervisor } from "../src/live-runtime.mjs";
import { loadScriptDescriptor } from "../src/manifest.mjs";
import { ScriptRegistry } from "../src/registry.mjs";
import { UiController } from "../src/ui-controller.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const pluginId = "dev.codex-script-loader.example-ui";
const lifecycleGlobal = "__codexScriptLoaderExampleUi";
const port = Number(option("--port", "9229"));
const expectedVersion = option("--version", "1.0.0");
const packageDirectory = fileURLToPath(new URL("../packages/example-ui-plugin/", import.meta.url));
const descriptor = await loadScriptDescriptor(packageDirectory);
if (descriptor.id !== pluginId) throw new Error(`unexpected bundled package id: ${descriptor.id}`);
if (descriptor.version !== expectedVersion) throw new Error(`package version ${descriptor.version} does not match ${expectedVersion}`);

const targets = pickCodexTargets(await listTargets(port)).filter(target => target.url === "app://-/index.html");
if (targets.length < 1) throw new Error("no exact app://-/index.html renderer target was found");

const dataRoot = fileURLToPath(new URL("../.runtime/manual/", import.meta.url));
const registry = await new ScriptRegistry(path.resolve(dataRoot)).init();
await ensureBundledPackages(registry);
const targetProvider = async () => pickCodexTargets(await listTargets(port));
const sessionFactory = endpoint => connectCdpSession(endpoint);
const injector = new CdpInjector({ targetProvider, sessionFactory });
const supervisor = new LiveSupervisor({ registry, injector, targetProvider });
const controller = new UiController({ registry, injector, supervisor });
const bridge = new LoaderHostBridge({
  targetProvider,
  sessionFactory,
  dispatch: (command, payload) => controller.dispatch(command, payload),
});
supervisor.hostBridge = bridge;

const session = await connectCdpSession(targets[0].webSocketDebuggerUrl);
const runtimeExceptions = [];
session.onEvent?.(message => {
  if (message.method !== "Runtime.exceptionThrown") return;
  const description = String(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "renderer exception");
  if (/codex-script-loader|example-ui-plugin/iu.test(description)) runtimeExceptions.push(description);
});
await session.sendCommand("Runtime.enable", {});

const evaluate = async expression => {
  const result = await session.sendCommand("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "renderer evaluation failed");
  return result?.result?.value;
};

const snapshotExpression = `(() => {
  const lifecycle = globalThis[${JSON.stringify(lifecycleGlobal)}];
  return {
    version: lifecycle?.version || null,
    scriptLoadId: lifecycle?.scriptLoadId || null,
    hasStop: typeof lifecycle?.stop === "function",
    hasSetBadgeEnabled: typeof lifecycle?.setBadgeEnabled === "function",
    loaderStatus: globalThis.__codexScriptLoader?.scripts?.[${JSON.stringify(pluginId)}]?.status || null,
    settingsEntries: document.querySelectorAll('[data-codex-loader-settings="nav:${pluginId}:main"]').length,
    styles: document.querySelectorAll("#codex-script-loader-example-ui-style").length,
    badges: document.querySelectorAll("#codex-script-loader-example-ui-badge").length,
    loaderErrors: Array.isArray(globalThis.__codexScriptLoader?.errors) ? globalThis.__codexScriptLoader.errors.length : 0
  };
})()`;

try {
  const before = await evaluate(snapshotExpression);
  await supervisor.tick({ force: true, restartIds: "all", targets });
  await new Promise(resolve => setTimeout(resolve, 700));
  const first = await evaluate(snapshotExpression);
  const reloadResult = await controller.dispatch("reload_scripts", { live: true });
  await new Promise(resolve => setTimeout(resolve, 700));
  const second = await evaluate(snapshotExpression);

  for (const snapshot of [first, second]) {
    if (snapshot.version !== expectedVersion) throw new Error(`example lifecycle version does not match ${expectedVersion}`);
    if (snapshot.loaderStatus !== "running") throw new Error("Loader did not report the example plugin as running");
    if (!snapshot.hasStop || !snapshot.hasSetBadgeEnabled) throw new Error("example lifecycle interface is incomplete");
    for (const key of ["settingsEntries", "styles", "badges"]) {
      if (snapshot[key] > 1) throw new Error(`duplicate example or Loader node detected for ${key}`);
    }
  }
  if (first.scriptLoadId === second.scriptLoadId) throw new Error("reload did not replace the example lifecycle instance");
  if (runtimeExceptions.length) throw new Error(`renderer reported ${runtimeExceptions.length} relevant uncaught exception(s): ${runtimeExceptions.join(" | ")}`);

  console.log(JSON.stringify({
    port,
    targetCount: targets.length,
    target: { id: targets[0].id, url: targets[0].url },
    packageDirectory,
    reloadResult,
    runtimeExceptions,
    before,
    first,
    second,
  }, null, 2));
} finally {
  await bridge.close();
  await session.close();
}
