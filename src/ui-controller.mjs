import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { summarizePlan } from "./injection.mjs";
import { loadScriptDescriptor } from "./manifest.mjs";
import { safeScriptIdFromName } from "./paths.mjs";
import { sha256Text } from "./hash.mjs";

const COMMANDS = new Set([
  "get_app_status",
  "list_scripts",
  "get_script",
  "set_script_enabled",
  "reload_scripts",
  "set_safe_mode",
  "inspect_script_source",
  "install_script",
  "run_doctor"
]);

export class UiController {
  constructor({ registry, injector = null }) {
    this.registry = registry;
    this.injector = injector;
    this.startedAt = new Date().toISOString();
  }

  async dispatch(command, payload = {}) {
    if (!COMMANDS.has(command)) throw new Error(`unsupported UI command: ${command}`);
    switch (command) {
      case "get_app_status": return this.getAppStatus();
      case "list_scripts": return this.registry.list();
      case "get_script": return this.getScript(payload.id);
      case "set_script_enabled": return this.registry.setEnabled(payload.id, payload.enabled);
      case "set_safe_mode": return { safeMode: await this.registry.setSafeMode(payload.enabled) };
      case "reload_scripts": return this.reloadScripts(payload);
      case "inspect_script_source": return this.inspectScriptSource(payload.sourcePath);
      case "install_script": return this.registry.install(payload.sourcePath, payload.options || {});
      case "run_doctor": return this.getDoctorReport();
      default: throw new Error(`unreachable command: ${command}`);
    }
  }

  async getAppStatus() {
    const scripts = await this.registry.list();
    const failedScripts = scripts.filter(script => script.status === "failed").length;
    return {
      loader: "healthy",
      codex: "stopped",
      cdp: "stopped",
      safeMode: Boolean(this.registry.config.safeMode),
      managedProcess: false,
      targetCount: 0,
      enabledScripts: scripts.filter(script => script.enabled).length,
      failedScripts,
      startedAt: this.startedAt
    };
  }

  async getScript(id) {
    const script = (await this.registry.list()).find(item => item.id === id);
    if (!script) throw new Error(`unknown script: ${id}`);
    return script;
  }

  async inspectScriptSource(sourcePath) {
    const source = path.resolve(sourcePath);
    const info = await stat(source);
    let descriptor;
    if (info.isDirectory()) {
      descriptor = await loadScriptDescriptor(source);
    } else if (info.isFile() && source.toLowerCase().endsWith(".js")) {
      const sourceText = await readFile(source, "utf8");
      const baseName = path.basename(source, ".js");
      descriptor = {
        id: safeScriptIdFromName(baseName),
        name: baseName,
        version: "local",
        source: sourceText,
        fingerprint: sha256Text(sourceText),
        permissions: [],
        scope: "renderer",
        runAt: "document-start",
        directory: path.dirname(source),
        entry: path.basename(source)
      };
    } else {
      throw new Error("script source must be a directory with manifest.json or a .js file");
    }
    return { installPreview: true, script: descriptor, requiresConfirmation: true };
  }

  async reloadScripts({ live = false } = {}) {
    const plan = await this.registry.buildPlan();
    if (!live) {
      return { mode: "dry-run", targetCount: 0, summary: summarizePlan(plan.descriptors), safeMode: plan.safeMode };
    }
    if (!this.injector) throw new Error("live CDP injector is not configured");
    const targets = await this.injector.inject(plan.source);
    return { mode: "live", targetCount: targets.length, targets, summary: summarizePlan(plan.descriptors) };
  }

  async getDoctorReport() {
    const scripts = await this.registry.list();
    return {
      offline: true,
      checks: [
        { id: "loader-data", status: "pass", detail: this.registry.layout.dataRoot },
        { id: "script-integrity", status: scripts.every(script => script.status !== "failed") ? "pass" : "warn", detail: `${scripts.length} scripts inspected` },
        { id: "codex-process", status: "skipped", detail: "offline mode does not inspect running Codex" },
        { id: "cdp", status: "skipped", detail: "offline mode does not query any CDP port" }
      ]
    };
  }
}

export function listUiCommands() {
  return [...COMMANDS].sort();
}
