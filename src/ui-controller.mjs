import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { summarizePlan } from "./injection.mjs";
import { describeTextScript, loadScriptDescriptor } from "./manifest.mjs";
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
  "inspect_script_text",
  "install_script",
  "install_script_text",
  "list_quarantined",
  "remove_script",
  "restore_quarantined",
  "run_doctor"
]);

export class UiController {
  constructor({ registry, injector = null, supervisor = null }) {
    this.registry = registry;
    this.injector = injector;
    this.supervisor = supervisor;
    this.startedAt = new Date().toISOString();
  }

  get supportsLive() {
    return Boolean(this.injector && this.supervisor);
  }

  async dispatch(command, payload = {}) {
    if (!COMMANDS.has(command)) throw new Error(`unsupported UI command: ${command}`);
    switch (command) {
      case "get_app_status": return this.getAppStatus();
      case "list_scripts": return this.listScripts();
      case "get_script": return this.getScript(payload.id);
      case "set_script_enabled": return this.setScriptEnabled(payload.id, payload.enabled);
      case "set_safe_mode": return this.setSafeMode(payload.enabled);
      case "reload_scripts": return this.reloadScripts(payload);
      case "inspect_script_source": return this.inspectScriptSource(payload.sourcePath);
      case "inspect_script_text": return this.inspectScriptText(payload);
      case "install_script": return this.registry.install(payload.sourcePath, payload.options || {});
      case "install_script_text": return this.registry.installSourceText(payload, payload.options || {});
      case "list_quarantined": return this.registry.listQuarantined();
      case "remove_script": return this.registry.quarantineScript(payload.id, { mode: payload.mode || "quarantine" });
      case "restore_quarantined": return this.registry.restoreQuarantined(payload.key);
      case "run_doctor": return this.getDoctorReport();
      default: throw new Error(`unreachable command: ${command}`);
    }
  }

  async getAppStatus() {
    await this.registry.reloadConfig();
    const scripts = await this.registry.list();
    const failedScripts = scripts.filter(script => script.status === "failed").length;
    const runtime = this.supervisor?.snapshot?.() || null;
    const live = Boolean(runtime);
    const phase = runtime?.phase || "stopped";
    return {
      loader: "healthy",
      codex: live ? (phase === "starting" ? "starting" : phase === "stopped" ? "stopped" : "healthy") : "stopped",
      cdp: live ? phase : "stopped",
      safeMode: Boolean(this.registry.config.safeMode),
      managedProcess: live,
      targetCount: runtime?.targetCount || 0,
      enabledScripts: scripts.filter(script => script.enabled).length,
      failedScripts,
      configHealthy: !this.registry.configLoadError,
      startedAt: this.startedAt,
      lastInjectionAt: runtime?.lastInjectionAt || null,
      lastError: runtime?.lastError || null,
      offline: !live,
      codexInspected: live,
      cdpInspected: live
    };
  }

  async refreshLiveScripts() {
    if (!this.supportsLive) return null;
    try { return await this.supervisor.tick({ force: true }); }
    catch { return null; }
  }

  async setScriptEnabled(id, enabled) {
    const script = await this.registry.setEnabled(id, enabled);
    await this.refreshLiveScripts();
    return script;
  }

  async setSafeMode(enabled) {
    const safeMode = await this.registry.setSafeMode(enabled);
    await this.refreshLiveScripts();
    return { safeMode };
  }

  async getScript(id) {
    const script = (await this.listScripts()).find(item => item.id === id);
    if (!script) throw new Error(`unknown script: ${id}`);
    return script;
  }

  async listScripts() {
    await this.registry.reloadConfig();
    const scripts = await this.registry.list();
    const runtime = this.supervisor?.snapshot?.() || null;
    const statusById = new Map((runtime?.scriptStatuses || []).map(item => [item.id, item.status]));
    return scripts.map(script => ({
      ...script,
      status: script.status === "failed"
        ? "failed"
        : statusById.get(script.id) || (runtime?.phase === "healthy" && script.enabled && !this.registry.config.safeMode ? "running" : script.status)
    }));
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

  async inspectScriptText({ name, sourceText }) {
    return { installPreview: true, script: describeTextScript({ name, sourceText }), requiresConfirmation: true };
  }

  async reloadScripts({ live = false, ids = null } = {}) {
    await this.registry.reloadConfig();
    const plan = await this.registry.buildPlan();
    if (!live) {
      return { mode: "dry-run", targetCount: 0, summary: summarizePlan(plan.descriptors), safeMode: plan.safeMode };
    }
    if (!this.supportsLive) throw new Error("live CDP injector is not configured");
    const result = await this.supervisor.tick({ force: true, restartIds: ids || "all" });
    const targets = result.results || [];
    return { mode: "live", targetCount: targets.length, targets, summary: summarizePlan(result.plan.descriptors), safeMode: result.plan.safeMode };
  }

  async getDoctorReport() {
    await this.registry.reloadConfig();
    const scripts = await this.registry.list();
    const runtime = this.supervisor?.snapshot?.() || null;
    if (runtime) {
      return {
        offline: false,
        checks: [
          { id: "loader-data", status: "pass", detail: this.registry.layout.dataRoot },
          { id: "loader-config", status: this.registry.configLoadError ? "warn" : "pass", detail: this.registry.configLoadError ? "configuration is invalid; safe mode is forced" : "configuration loaded" },
          { id: "script-integrity", status: scripts.every(script => script.status !== "failed") ? "pass" : "warn", detail: `${scripts.length} scripts inspected` },
          { id: "codex-process", status: runtime.phase === "stopped" ? "warn" : "pass", detail: runtime.phase === "stopped" ? "managed runtime stopped" : "managed Codex instance" },
          { id: "cdp", status: runtime.phase === "healthy" ? "pass" : "warn", detail: `${runtime.targetCount} renderer targets; ${runtime.phase}` }
        ]
      };
    }
    return {
      offline: true,
      checks: [
        { id: "loader-data", status: "pass", detail: this.registry.layout.dataRoot },
        { id: "loader-config", status: this.registry.configLoadError ? "warn" : "pass", detail: this.registry.configLoadError ? "configuration is invalid; safe mode is forced" : "configuration loaded" },
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
