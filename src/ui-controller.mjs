import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { summarizePlan } from "./injection.mjs";
import { describeTextScript, loadScriptDescriptor } from "./manifest.mjs";
import { safeScriptIdFromName } from "./paths.mjs";
import { sha256Text } from "./hash.mjs";

const COMMANDS = new Set([
  "get_app_status",
  "list_plugins",
  "set_plugin_enabled",
  "list_scripts",
  "get_script",
  "set_script_enabled",
  "reload_scripts",
  "reload_plugins",
  "set_safe_mode",
  "inspect_script_source",
  "inspect_script_text",
  "install_script",
  "install_script_text",
  "list_quarantined",
  "remove_script",
  "restore_quarantined",
  "remove_plugin",
  "restore_plugin",
  "run_doctor",
  "get_update_status",
  "set_auto_update",
  "check_for_updates",
  "start_update",
  "cancel_update",
]);

export class UiController {
  constructor({ registry, injector = null, supervisor = null }) {
    this.registry = registry;
    this.injector = injector;
    this.supervisor = supervisor;
    this.startedAt = new Date().toISOString();
    this.liveReloadPromise = null;
  }

  get supportsLive() {
    return Boolean(this.injector && this.supervisor);
  }

  async dispatch(command, payload = {}) {
    if (!COMMANDS.has(command)) throw new Error(`unsupported loader command: ${command}`);
    switch (command) {
      case "get_app_status": return this.getAppStatus();
      case "list_plugins": return this.listPlugins();
      case "set_plugin_enabled": return this.setScriptEnabled(payload.id, payload.enabled);
      case "list_scripts": return this.listScripts();
      case "get_script": return this.getScript(payload.id);
      case "set_script_enabled": return this.setScriptEnabled(payload.id, payload.enabled);
      case "set_safe_mode": return this.setSafeMode(payload.enabled);
      case "reload_scripts": return this.reloadScripts(payload);
      case "reload_plugins": return this.reloadScripts({ ...payload, live: true });
      case "inspect_script_source": return this.inspectScriptSource(payload.sourcePath);
      case "inspect_script_text": return this.inspectScriptText(payload);
      case "install_script": return this.registry.install(payload.sourcePath, payload.options || {});
      case "install_script_text": return this.registry.installSourceText(payload, payload.options || {});
      case "list_quarantined": return this.registry.listQuarantined();
      case "remove_script": return this.registry.quarantineScript(payload.id, { mode: payload.mode || "quarantine" });
      case "restore_quarantined": return this.registry.restoreQuarantined(payload.key);
      case "remove_plugin": return this.registry.quarantineScript(payload.id, { mode: "quarantine" });
      case "restore_plugin": return this.registry.restoreQuarantined(payload.key);
      case "run_doctor": return this.getDoctorReport();
      case "get_update_status":
      case "set_auto_update":
      case "check_for_updates": return this.getUpdateStatus();
      case "start_update": throw new Error("online host updates require the standard Windows NSIS installation");
      case "cancel_update": throw new Error("no update download is active");
      default: throw new Error(`unreachable command: ${command}`);
    }
  }

  async getAppStatus() {
    await this.registry.reloadConfig();
    const scripts = await this.registry.list();
    const runtime = this.supervisor?.snapshot?.() || null;
    return {
      loader: "healthy",
      codex: runtime ? (runtime.phase === "stopped" ? "stopped" : "healthy") : "stopped",
      cdp: runtime?.phase || "stopped",
      safeMode: Boolean(this.registry.config.safeMode),
      managedProcess: Boolean(runtime),
      targetCount: runtime?.targetCount || 0,
      enabledScripts: scripts.filter((script) => script.enabled).length,
      failedScripts: scripts.filter((script) => script.status === "failed").length,
      configHealthy: !this.registry.configLoadError,
      startedAt: this.startedAt,
      lastInjectionAt: runtime?.lastInjectionAt || null,
      lastError: runtime?.lastError || null,
      scope: "renderer-plugins-only",
    };
  }

  getUpdateStatus() {
    return {
      currentVersion: "0.5.1",
      availableVersion: null,
      state: "idle",
      lastCheckedAt: null,
      progress: null,
      releaseUrl: null,
      error: null,
      requiresInstaller: true,
      autoUpdate: false,
      channel: "stable",
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
    const script = (await this.listScripts()).find((item) => item.id === id);
    if (!script) throw new Error(`unknown script: ${id}`);
    return script;
  }

  async listScripts() {
    await this.registry.reloadConfig();
    const scripts = await this.registry.list();
    const runtime = this.supervisor?.snapshot?.() || null;
    const statusById = new Map((runtime?.scriptStatuses || []).map((item) => [item.id, item.status]));
    return scripts.map((script) => ({
      ...script,
      status: script.status === "failed" ? "failed" : statusById.get(script.id) || script.status,
    }));
  }

  async listPlugins() {
    return (await this.listScripts()).map(script => ({
      ...script,
      bundled: false,
      settingsMode: script.settingsMode || "legacy",
      settingsPageId: script.settingsPageId || null,
      settingsPageTitle: script.settingsPageTitle || null,
      documentation: script.documentation || null,
      documentationExcerpt: null,
      legacy: !script.documentation || (script.settingsMode || "legacy") === "legacy",
    }));
  }

  async inspectScriptSource(sourcePath) {
    const source = path.resolve(sourcePath);
    const info = await stat(source);
    let descriptor;
    if (info.isDirectory()) descriptor = await loadScriptDescriptor(source);
    else if (info.isFile() && source.toLowerCase().endsWith(".js")) {
      const sourceText = await readFile(source, "utf8");
      const baseName = path.basename(source, ".js");
      descriptor = {
        id: safeScriptIdFromName(baseName), name: baseName, version: "local",
        source: sourceText, fingerprint: sha256Text(sourceText), permissions: [],
        scope: "renderer", runAt: "document-start", directory: path.dirname(source), entry: path.basename(source),
      };
    } else throw new Error("script source must be a directory with manifest.json or a .js file");
    return { installPreview: true, script: descriptor, requiresConfirmation: true };
  }

  async inspectScriptText({ name, sourceText }) {
    return { installPreview: true, script: describeTextScript({ name, sourceText }), requiresConfirmation: true };
  }

  async reloadScripts({ live = false, ids = null } = {}) {
    if (!live) {
      await this.registry.reloadConfig();
      const plan = await this.registry.buildPlan();
      return { mode: "dry-run", targetCount: 0, summary: summarizePlan(plan.descriptors), safeMode: plan.safeMode };
    }
    if (!this.supportsLive) throw new Error("live CDP injector is not configured");
    if (this.liveReloadPromise) return this.liveReloadPromise;
    this.liveReloadPromise = (async () => {
      await this.registry.reloadConfig();
      const result = await this.supervisor.tick({ force: true, restartIds: ids || "all" });
      return { mode: "live", targetCount: result.results?.length || 0, targets: result.results || [], summary: summarizePlan(result.plan.descriptors), safeMode: result.plan.safeMode };
    })().finally(() => { this.liveReloadPromise = null; });
    return this.liveReloadPromise;
  }

  async getDoctorReport() {
    await this.registry.reloadConfig();
    const scripts = await this.registry.list();
    const runtime = this.supervisor?.snapshot?.() || null;
    return {
      offline: !runtime,
      checks: [
        { id: "loader-data", status: "pass", detail: this.registry.layout.dataRoot },
        { id: "loader-config", status: this.registry.configLoadError ? "warn" : "pass", detail: this.registry.configLoadError ? "configuration is invalid; safe mode is forced" : "configuration loaded" },
        { id: "script-integrity", status: scripts.every((script) => script.status !== "failed") ? "pass" : "warn", detail: `${scripts.length} scripts inspected` },
        { id: "cdp", status: runtime?.phase === "healthy" ? "pass" : "skipped", detail: runtime ? `${runtime.targetCount} renderer targets; ${runtime.phase}` : "offline mode" },
      ],
    };
  }
}

export function listUiCommands() {
  return [...COMMANDS].sort();
}
