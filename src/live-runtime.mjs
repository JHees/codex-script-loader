import net from "node:net";
import process from "node:process";
import { CdpInjector, assertLoopbackEndpoint, connectCdpSession, listTargets, pickCodexTargets } from "./cdp.mjs";
import { buildChromiumDebugArgs } from "./launcher.mjs";
import { ScriptRegistry } from "./registry.mjs";
import { LoaderHostBridge } from "./loader-bridge.mjs";
import { UiController } from "./ui-controller.mjs";
import {
  activateWindowsCodex,
  discoverWindowsCodex,
  listWindowsCodexProcesses,
  listWindowsLoopbackListeners
} from "./windows-platform.mjs";
import { activateMacCodex, discoverMacCodex, listMacCodexProcesses, listMacLoopbackListeners } from "./macos-platform.mjs";

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class ExistingCodexInstanceError extends Error {
  constructor(processes) {
    super(`Codex is already running (${processes.length} package processes); close it completely before managed launch`);
    this.name = "ExistingCodexInstanceError";
    this.code = "CODEX_ALREADY_RUNNING";
    this.processCount = processes.length;
  }
}

export function delay(ms, { signal } = {}) {
  if (!Number.isFinite(ms) || ms < 0) throw new TypeError("delay must be a non-negative number");
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("operation aborted"));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("operation aborted"));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function allocateLoopbackPort({ createServer = net.createServer } = {}) {
  const server = createServer();
  server.unref?.();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || !Number.isInteger(address.port)) {
    await new Promise(resolve => server.close(resolve));
    throw new Error("failed to allocate an IPv4 loopback port");
  }
  const port = address.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function waitForCdpReady(port, {
  targetProvider = () => listTargets(port),
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  intervalMs = 250,
  delayFn = delay,
  now = Date.now,
  signal
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid CDP port");
  const deadline = now() + timeoutMs;
  let lastError = null;
  do {
    if (signal?.aborted) throw signal.reason || new Error("CDP readiness wait aborted");
    try {
      const targets = pickCodexTargets(await targetProvider());
      if (targets.length > 0) return targets;
      lastError = new Error("CDP is reachable but no Codex renderer target exists");
    } catch (error) {
      lastError = error;
    }
    if (now() >= deadline) break;
    await delayFn(intervalMs, { signal });
  } while (now() <= deadline);
  throw new Error(`Codex CDP did not become ready within ${timeoutMs} ms`, { cause: lastError });
}

function targetSignature(targets) {
  return targets.map(target => `${target.id}:${target.webSocketDebuggerUrl}`).sort();
}

function planSignature(plan, targets) {
  return JSON.stringify({
    safeMode: Boolean(plan.safeMode),
    scripts: plan.summary.map(script => [script.id, script.fingerprint]),
    targets: targetSignature(targets)
  });
}

function sanitizedErrorMessage(error) {
  return String(error?.message || error)
    .replace(/\b(?:wss?|https?):\/\/[^\s)]+/giu, "[local endpoint]")
    .replace(/[A-Za-z]:\\[^\r\n]*/gu, "[local path]")
    .slice(0, 300);
}

export class LiveSupervisor {
  constructor({ registry, injector, targetProvider, hostBridge = null, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, onEvent = () => {} }) {
    if (!registry || !injector || typeof targetProvider !== "function") throw new TypeError("registry, injector and targetProvider are required");
    this.registry = registry;
    this.injector = injector;
    this.targetProvider = targetProvider;
    this.hostBridge = hostBridge;
    this.pollIntervalMs = pollIntervalMs;
    this.onEvent = onEvent;
    this.lastSignature = null;
    this.stopped = false;
    this.state = {
      phase: "starting",
      managedProcess: true,
      targetCount: 0,
      enabledScripts: 0,
      safeMode: false,
      lastInjectionAt: null,
      lastError: null,
      reloadCount: 0,
      scriptStatuses: []
    };
  }

  snapshot() {
    return Object.freeze({
      ...this.state,
      scriptStatuses: Object.freeze(this.state.scriptStatuses.map(item => Object.freeze({ ...item })))
    });
  }

  emit(type, detail = {}) {
    this.onEvent(Object.freeze({ type, at: new Date().toISOString(), ...detail }));
  }

  async tick({ force = false, restartIds = [], targets: suppliedTargets } = {}) {
    await this.registry.reloadConfig();
    const plan = await this.registry.buildPlan({ forceIds: restartIds });
    const targets = pickCodexTargets(suppliedTargets ?? await this.targetProvider());
    if (this.hostBridge) await this.hostBridge.sync({ targets });
    this.state.safeMode = Boolean(plan.safeMode);
    this.state.enabledScripts = plan.summary.length;
    this.state.targetCount = targets.length;
    if (targets.length === 0) {
      this.state.phase = "degraded";
      this.state.lastError = "no Codex renderer target is available";
      this.emit("cdp-targets-missing");
      return { changed: false, targets: [], plan };
    }

    const signature = planSignature(plan, targets);
    if (!force && signature === this.lastSignature) {
      this.state.phase = "healthy";
      this.state.lastError = null;
      return { changed: false, targets, plan };
    }

    try {
      const results = await this.injector.inject(plan.source, { targets });
      this.lastSignature = signature;
      this.state.phase = "healthy";
      this.state.targetCount = results.length;
      this.state.lastInjectionAt = new Date().toISOString();
      this.state.lastError = null;
      this.state.reloadCount += 1;
      this.state.scriptStatuses = results.flatMap(result => result.scriptStatuses || []).map(item => ({ ...item }));
      const failedCount = this.state.scriptStatuses.filter(item => item.status === "failed").length;
      if (failedCount > 0) {
        this.state.phase = "degraded";
        this.state.lastError = `${failedCount} renderer scripts reported a failed state`;
      }
      this.emit("scripts-injected", { targetCount: results.length, scriptCount: plan.summary.length, failedCount, safeMode: plan.safeMode });
      return { changed: true, targets, plan, results };
    } catch (error) {
      this.state.phase = "degraded";
      this.state.lastError = sanitizedErrorMessage(error);
      this.emit("injection-failed", { error: this.state.lastError });
      throw error;
    }
  }

  async run({ signal } = {}) {
    this.stopped = false;
    while (!this.stopped && !signal?.aborted) {
      try { await this.tick(); }
      catch { /* State and a sanitized event were already recorded. */ }
      if (!this.stopped && !signal?.aborted) {
        try { await delay(this.pollIntervalMs, { signal }); }
        catch { break; }
      }
    }
    this.state.phase = "stopped";
    this.emit("supervisor-stopped");
  }

  stop() {
    this.stopped = true;
    return this.hostBridge?.close?.();
  }
}

function createLoaderHostBridge({ registry, injector, supervisor, targetProvider, sessionFactory }) {
  const controller = new UiController({ registry, injector, supervisor });
  const bridge = new LoaderHostBridge({
    targetProvider,
    sessionFactory,
    dispatch: (command, payload) => controller.dispatch(command, payload),
  });
  supervisor.hostBridge = bridge;
  return { controller, bridge };
}

export async function startWindowsLiveRuntime({
  dataRoot,
  debugPort,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  onEvent,
  signal,
  dependencies = {}
} = {}) {
  if (process.platform !== "win32" && dependencies.allowNonWindows !== true) {
    throw new Error("live managed launch is currently supported on Windows only");
  }
  if (typeof dataRoot !== "string" || !dataRoot) throw new TypeError("dataRoot is required");

  const discover = dependencies.discoverWindowsCodex || discoverWindowsCodex;
  const listProcesses = dependencies.listWindowsCodexProcesses || listWindowsCodexProcesses;
  const allocatePort = dependencies.allocateLoopbackPort || allocateLoopbackPort;
  const activate = dependencies.activateWindowsCodex || activateWindowsCodex;
  const getTargets = dependencies.listTargets || listTargets;
  const listListeners = dependencies.listWindowsLoopbackListeners || listWindowsLoopbackListeners;
  const createSession = dependencies.connectCdpSession || connectCdpSession;
  const Registry = dependencies.ScriptRegistry || ScriptRegistry;

  const packageInfo = await discover();
  const existingProcesses = await listProcesses(packageInfo);
  if (existingProcesses.length > 0) throw new ExistingCodexInstanceError(existingProcesses);
  const registry = await new Registry(dataRoot).init();

  const port = debugPort ?? await allocatePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("debug port must be between 1 and 65535");
  const targetProvider = () => getTargets(port);
  const activation = await activate(packageInfo, buildChromiumDebugArgs(port));
  const readyTargets = await waitForCdpReady(port, { targetProvider, timeoutMs: readyTimeoutMs, signal });

  const managedProcesses = await listProcesses(packageInfo);
  const listeners = await listListeners(port);
  const managedIds = new Set(managedProcesses.map(item => item.processId));
  if (listeners.length === 0 || listeners.some(listener => !managedIds.has(listener.processId))) {
    throw new Error("CDP listener ownership could not be verified as the managed Codex package");
  }

  const verifiedSessionFactory = endpoint => {
    const url = assertLoopbackEndpoint(endpoint);
    const endpointPort = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
    if (endpointPort !== port) throw new Error("CDP target endpoint port does not match the managed listener");
    return createSession(endpoint);
  };
  const injector = new CdpInjector({ targetProvider, sessionFactory: verifiedSessionFactory });
  const supervisor = new LiveSupervisor({ registry, injector, targetProvider, pollIntervalMs, onEvent });
  const { controller, bridge } = createLoaderHostBridge({
    registry,
    injector,
    supervisor,
    targetProvider,
    sessionFactory: verifiedSessionFactory,
  });
  await supervisor.tick({ force: true, targets: readyTargets });
  return Object.freeze({
    port,
    packageInfo,
    activation,
    registry,
    injector,
    supervisor,
    controller,
    bridge,
    run: options => supervisor.run(options),
    close: async () => supervisor.stop()
  });
}

export async function startMacLiveRuntime({ dataRoot, debugPort, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS, onEvent, signal, dependencies = {} } = {}) {
  if (process.platform !== "darwin" && dependencies.allowNonMac !== true) throw new Error("macOS live launch requires darwin");
  if (typeof dataRoot !== "string" || !dataRoot) throw new TypeError("dataRoot is required");
  const discover = dependencies.discoverMacCodex || discoverMacCodex;
  const listProcesses = dependencies.listMacCodexProcesses || listMacCodexProcesses;
  const allocatePort = dependencies.allocateLoopbackPort || allocateLoopbackPort;
  const activate = dependencies.activateMacCodex || activateMacCodex;
  const getTargets = dependencies.listTargets || listTargets;
  const listListeners = dependencies.listMacLoopbackListeners || listMacLoopbackListeners;
  const createSession = dependencies.connectCdpSession || connectCdpSession;
  const Registry = dependencies.ScriptRegistry || ScriptRegistry;
  const packageInfo = await discover();
  const existingProcesses = await listProcesses(packageInfo);
  if (existingProcesses.length > 0) throw new ExistingCodexInstanceError(existingProcesses);
  const registry = await new Registry(dataRoot).init();
  const port = debugPort ?? await allocatePort();
  const targetProvider = () => getTargets(port);
  const activation = await activate(packageInfo, buildChromiumDebugArgs(port));
  const readyTargets = await waitForCdpReady(port, { targetProvider, timeoutMs: readyTimeoutMs, signal });
  const managedProcesses = await listProcesses(packageInfo);
  const listeners = await listListeners(port);
  const managedIds = new Set(managedProcesses.map(item => item.processId));
  managedIds.add(activation.processId);
  if (listeners.length === 0 || listeners.some(listener => !managedIds.has(listener.processId))) throw new Error("CDP listener ownership could not be verified as the managed Codex process family");
  const verifiedSessionFactory = endpoint => {
    const url = assertLoopbackEndpoint(endpoint);
    const endpointPort = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
    if (endpointPort !== port) throw new Error("CDP target endpoint port does not match the managed listener");
    return createSession(endpoint);
  };
  const injector = new CdpInjector({ targetProvider, sessionFactory: verifiedSessionFactory });
  const supervisor = new LiveSupervisor({ registry, injector, targetProvider, pollIntervalMs, onEvent });
  const { controller, bridge } = createLoaderHostBridge({
    registry,
    injector,
    supervisor,
    targetProvider,
    sessionFactory: verifiedSessionFactory,
  });
  await supervisor.tick({ force: true, targets: readyTargets });
  return Object.freeze({
    port, packageInfo, activation, registry, injector, supervisor, controller, bridge,
    run: options => supervisor.run(options),
    close: async () => supervisor.stop()
  });
}

export function startLiveRuntime(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") return startWindowsLiveRuntime(options);
  if (platform === "darwin") return startMacLiveRuntime(options);
  throw new Error(`live managed launch is unsupported on ${platform}`);
}
