#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getDataRoot } from "./paths.mjs";
import { ScriptRegistry } from "./registry.mjs";
import { UiController, listUiCommands } from "./ui-controller.mjs";
import { startManagerServer } from "./manager-server.mjs";
import { startWindowsLiveRuntime } from "./live-runtime.mjs";
import { integrityLabel } from "./hash.mjs";

function printHelp() {
  console.log(`Codex Script Loader 0.0.1

Usage:
  codex-script-loader status [--data-dir <path>]
  codex-script-loader scripts [--data-dir <path>]
  codex-script-loader doctor [--data-dir <path>]
  codex-script-loader serve [--data-dir <path>] [--port <port>]
  codex-script-loader run [--data-dir <path>] [--live] [--debug-port <port>] [--manager-port <port>]
  codex-script-loader reload [--data-dir <path>] [--live]
  codex-script-loader safe-mode <on|off> [--data-dir <path>]
  codex-script-loader install <file-or-directory> [--enable] [--data-dir <path>]

Safety:
  reload is a dry-run unless --live is explicitly supplied.
  Only run --live launches a managed Codex instance. It refuses any existing instance.
  Stopping the loader never terminates Codex or modifies its installation/session data.
  serve binds only 127.0.0.1 and does not open a browser or inspect Codex.

UI command allowlist:
  ${listUiCommands().join(", ")}`);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} expects a value`);
  return value;
}

function has(args, name) {
  return args.includes(name);
}

function positionalArguments(args) {
  const optionsWithValues = new Set(["--data-dir", "--port", "--debug-port", "--manager-port"]);
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--")) result.push(argument);
  }
  return result;
}

function publicScript(script) {
  const fingerprint = typeof script.fingerprint === "string" ? script.fingerprint : null;
  return {
    id: String(script.id),
    name: String(script.name || script.id),
    version: String(script.version || "?"),
    enabled: Boolean(script.enabled),
    status: script.status || "ready",
    scope: script.scope || "renderer",
    runAt: script.runAt || "document-start",
    lifecycleGlobal: script.lifecycleGlobal || null,
    permissions: Array.isArray(script.permissions) ? script.permissions.map(String) : [],
    fingerprint,
    integrity: fingerprint ? integrityLabel(fingerprint) : null
  };
}

async function createController(args) {
  const root = option(args, "--data-dir") || getDataRoot();
  const registry = await new ScriptRegistry(path.resolve(root)).init();
  return new UiController({ registry });
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return 0;
  }
  if (command === "serve") {
    const root = option(args, "--data-dir") || getDataRoot();
    const portValue = option(args, "--port");
    if (has(args, "--port") && portValue === undefined) throw new Error("--port expects a number");
    const port = portValue === undefined ? 0 : Number(portValue);
    const manager = await startManagerServer({ dataRoot: path.resolve(root), port });
    console.log(JSON.stringify({ origin: manager.origin, offline: true, codexInspected: false, cdpInspected: false }, null, 2));
    await new Promise(resolve => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await manager.close();
    return 0;
  }
  if (command === "run") {
    if (!has(args, "--live")) {
      console.log(JSON.stringify({ mode: "dry-run", started: false, reason: "pass --live to launch a new managed Codex instance; current Codex was not inspected or changed" }, null, 2));
      return 0;
    }
    const root = path.resolve(option(args, "--data-dir") || getDataRoot());
    const debugPortValue = option(args, "--debug-port");
    const managerPortValue = option(args, "--manager-port");
    if (has(args, "--debug-port") && debugPortValue === undefined) throw new Error("--debug-port expects a number");
    if (has(args, "--manager-port") && managerPortValue === undefined) throw new Error("--manager-port expects a number");
    const debugPort = debugPortValue === undefined ? undefined : Number(debugPortValue);
    const managerPort = managerPortValue === undefined ? 0 : Number(managerPortValue);
    const abortController = new AbortController();
    const events = [];
    const runtime = await startWindowsLiveRuntime({
      dataRoot: root,
      debugPort,
      signal: abortController.signal,
      onEvent: event => {
        events.push(event);
        if (events.length > 100) events.shift();
      }
    });
    const controller = new UiController({ registry: runtime.registry, injector: runtime.injector, supervisor: runtime.supervisor });
    let manager;
    try {
      manager = await startManagerServer({ controller, port: managerPort });
    } catch (error) {
      await runtime.close();
      throw error;
    }
    console.log(JSON.stringify({
      mode: "live",
      started: true,
      managedProcess: true,
      codexVersion: runtime.packageInfo.version,
      cdp: { host: "127.0.0.1", port: runtime.port },
      manager: { origin: manager.origin },
      scripts: runtime.supervisor.snapshot().enabledScripts,
      note: "Keep this process running for renderer reload recovery. Ctrl+C stops only the loader, not Codex."
    }, null, 2));
    const stop = () => abortController.abort(new Error("loader shutdown requested"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runtime.run({ signal: abortController.signal });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await manager.close();
      await runtime.close();
    }
    return 0;
  }
  const controller = await createController(args);
  if (command === "status") {
    console.log(JSON.stringify(await controller.dispatch("get_app_status"), null, 2));
    return 0;
  }
  if (command === "scripts") {
    console.log(JSON.stringify((await controller.dispatch("list_scripts")).map(publicScript), null, 2));
    return 0;
  }
  if (command === "doctor") {
    console.log(JSON.stringify(await controller.dispatch("run_doctor"), null, 2));
    return 0;
  }
  if (command === "reload") {
    const result = await controller.dispatch("reload_scripts", { live: has(args, "--live") });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === "safe-mode") {
    const value = args[0];
    if (!new Set(["on", "off"]).has(value)) throw new Error("safe-mode expects on or off");
    console.log(JSON.stringify(await controller.dispatch("set_safe_mode", { enabled: value === "on" }), null, 2));
    return 0;
  }
  if (command === "install") {
    const source = positionalArguments(args)[0];
    if (!source) throw new Error("install expects a file or directory");
    const script = await controller.dispatch("install_script", { sourcePath: path.resolve(source), options: { enabled: has(args, "--enable") } });
    console.log(JSON.stringify(publicScript(script), null, 2));
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`codex-script-loader: ${error.message}`);
    process.exitCode = 1;
  });
}

export { main };
