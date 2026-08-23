#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getDataRoot } from "./paths.mjs";
import { ScriptRegistry } from "./registry.mjs";
import { UiController, listUiCommands } from "./ui-controller.mjs";
import { startLiveRuntime } from "./live-runtime.mjs";
import { integrityLabel } from "./hash.mjs";
import { ensureBundledPackages } from "./bundled.mjs";

function printHelp() {
  console.log(`Codex Script Loader 0.1.0

Usage:
  codex-script-loader run --live [--data-dir <path>] [--debug-port <port>]
  codex-script-loader status [--data-dir <path>]
  codex-script-loader scripts [--data-dir <path>]
  codex-script-loader doctor [--data-dir <path>]
  codex-script-loader reload [--data-dir <path>] [--live]
  codex-script-loader safe-mode <on|off> [--data-dir <path>]
  codex-script-loader install <file-or-directory> [--enable] [--data-dir <path>]

Scope:
  Renderer script discovery, validation, start/stop lifecycle, hot reload,
  scoped storage/DOM helpers, and api.settings.register/registerPage.

Safety:
  The loader does not modify Codex files, manage accounts/providers/MCP/Skills,
  or run a Responses proxy. reload is a dry-run unless --live is supplied.

Controller commands:
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
  const optionsWithValues = new Set(["--data-dir", "--debug-port"]);
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
    permissions: Array.isArray(script.permissions) ? script.permissions.map(String) : [],
    fingerprint,
    integrity: fingerprint ? integrityLabel(fingerprint) : null,
  };
}

async function createController(args) {
  const root = path.resolve(option(args, "--data-dir") || getDataRoot());
  const registry = await new ScriptRegistry(root).init();
  await ensureBundledPackages(registry);
  return new UiController({ registry });
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return 0;
  }

  if (command === "run") {
    if (!has(args, "--live")) {
      console.log(JSON.stringify({ mode: "dry-run", started: false, reason: "pass --live to launch a managed Codex instance" }, null, 2));
      return 0;
    }
    const root = path.resolve(option(args, "--data-dir") || getDataRoot());
    const debugPortValue = option(args, "--debug-port");
    const debugPort = debugPortValue === undefined ? undefined : Number(debugPortValue);
    const abortController = new AbortController();
    const runtime = await startLiveRuntime({ dataRoot: root, debugPort, signal: abortController.signal });
    await ensureBundledPackages(runtime.registry);
    await runtime.supervisor.tick({ force: true });
    console.log(JSON.stringify({
      mode: "live",
      started: true,
      codexVersion: runtime.packageInfo.version,
      cdp: { host: "127.0.0.1", port: runtime.port },
      scripts: runtime.supervisor.snapshot().enabledScripts,
      note: "Keep this process running for renderer reload recovery. Ctrl+C stops only the loader.",
    }, null, 2));
    const stop = () => abortController.abort(new Error("loader shutdown requested"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try { await runtime.run({ signal: abortController.signal }); }
    finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await runtime.close();
    }
    return 0;
  }

  const controller = await createController(args);
  if (command === "status") console.log(JSON.stringify(await controller.dispatch("get_app_status"), null, 2));
  else if (command === "scripts") console.log(JSON.stringify((await controller.dispatch("list_scripts")).map(publicScript), null, 2));
  else if (command === "doctor") console.log(JSON.stringify(await controller.dispatch("run_doctor"), null, 2));
  else if (command === "reload") console.log(JSON.stringify(await controller.dispatch("reload_scripts", { live: has(args, "--live") }), null, 2));
  else if (command === "safe-mode") {
    const value = positionalArguments(args)[0];
    if (!new Set(["on", "off"]).has(value)) throw new Error("safe-mode expects on or off");
    console.log(JSON.stringify(await controller.dispatch("set_safe_mode", { enabled: value === "on" }), null, 2));
  } else if (command === "install") {
    const source = positionalArguments(args)[0];
    if (!source) throw new Error("install expects a file or directory");
    const script = await controller.dispatch("install_script", { sourcePath: path.resolve(source), options: { enabled: has(args, "--enable") } });
    console.log(JSON.stringify(publicScript(script), null, 2));
  } else throw new Error(`unknown command: ${command}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`codex-script-loader: ${error.message}`);
    process.exitCode = 1;
  });
}

export { main };
