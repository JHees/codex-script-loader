#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getDataRoot } from "./paths.mjs";
import { ScriptRegistry } from "./registry.mjs";
import { UiController, listUiCommands } from "./ui-controller.mjs";

function printHelp() {
  console.log(`Codex Script Loader 0.0.1

Usage:
  codex-script-loader status [--data-dir <path>]
  codex-script-loader scripts [--data-dir <path>]
  codex-script-loader doctor [--data-dir <path>]
  codex-script-loader run [--data-dir <path>] [--live]
  codex-script-loader reload [--data-dir <path>] [--live]
  codex-script-loader safe-mode <on|off> [--data-dir <path>]
  codex-script-loader install <file-or-directory> [--enable] [--data-dir <path>]

Safety:
  reload is a dry-run unless --live is explicitly supplied.
  This prototype never launches, stops, or attaches to Codex by default.

UI command allowlist:
  ${listUiCommands().join(", ")}`);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args, name) {
  return args.includes(name);
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
  const controller = await createController(args);
  if (command === "status") {
    console.log(JSON.stringify(await controller.dispatch("get_app_status"), null, 2));
    return 0;
  }
  if (command === "scripts") {
    console.log(JSON.stringify(await controller.dispatch("list_scripts"), null, 2));
    return 0;
  }
  if (command === "doctor") {
    console.log(JSON.stringify(await controller.dispatch("run_doctor"), null, 2));
    return 0;
  }
  if (command === "run") {
    if (has(args, "--live")) throw new Error("live Codex launching is not implemented in Phase 0; no process was started");
    console.log(JSON.stringify({ mode: "dry-run", started: false, reason: "platform launcher is not enabled; current Codex was not inspected or changed" }, null, 2));
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
    const source = args.find(item => !item.startsWith("--"));
    if (!source) throw new Error("install expects a file or directory");
    const script = await controller.dispatch("install_script", { sourcePath: path.resolve(source), options: { enabled: has(args, "--enable") } });
    console.log(JSON.stringify(script, null, 2));
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

