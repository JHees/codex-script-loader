import path from "node:path";
import { access, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { getLayout, assertWithinDirectory, safeScriptIdFromName } from "./paths.mjs";
import { loadScriptDescriptor } from "./manifest.mjs";
import { buildInjectionSource, summarizePlan } from "./injection.mjs";

const DEFAULT_CONFIG = Object.freeze({ schemaVersion: 1, globalEnabled: true, safeMode: false, scripts: {} });

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function cloneDefaultConfig() {
  return { schemaVersion: DEFAULT_CONFIG.schemaVersion, globalEnabled: true, safeMode: false, scripts: {} };
}

export class ScriptRegistry {
  constructor(dataRoot) {
    this.layout = getLayout(dataRoot);
    this.config = cloneDefaultConfig();
  }

  async init() {
    await mkdir(this.layout.scriptsRoot, { recursive: true });
    await mkdir(this.layout.quarantineRoot, { recursive: true });
    if (await exists(this.layout.configPath)) {
      const loaded = JSON.parse(await readFile(this.layout.configPath, "utf8"));
      this.config = {
        ...cloneDefaultConfig(),
        ...loaded,
        scripts: loaded && loaded.scripts && typeof loaded.scripts === "object" ? loaded.scripts : {}
      };
    }
    return this;
  }

  async saveConfig() {
    await mkdir(this.layout.dataRoot, { recursive: true });
    const temporary = `${this.layout.configPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
    await rename(temporary, this.layout.configPath);
  }

  async list({ includeInvalid = true } = {}) {
    const entries = await readdir(this.layout.scriptsRoot, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.layout.scriptsRoot, entry.name);
      try {
        const descriptor = await loadScriptDescriptor(directory);
        const override = this.config.scripts[descriptor.id] || {};
        result.push({ ...descriptor, enabled: override.enabled ?? true, status: "ready" });
      } catch (error) {
        if (includeInvalid) result.push({ id: entry.name, name: entry.name, version: "?", enabled: false, status: "failed", error: String(error), directory });
      }
    }
    return result.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  }

  async install(sourcePath, { enabled = false, overwrite = false } = {}) {
    const source = path.resolve(sourcePath);
    const sourceStats = await stat(source);
    let descriptor;
    let temporaryDirectory;
    if (sourceStats.isDirectory()) {
      descriptor = await loadScriptDescriptor(source);
    } else if (sourceStats.isFile() && source.toLowerCase().endsWith(".js")) {
      const id = safeScriptIdFromName(path.basename(source, ".js"));
      temporaryDirectory = path.join(this.layout.dataRoot, `.install-${process.pid}-${Date.now()}`);
      await mkdir(temporaryDirectory, { recursive: true });
      await writeFile(path.join(temporaryDirectory, "index.js"), await readFile(source, "utf8"), "utf8");
      await writeFile(path.join(temporaryDirectory, "manifest.json"), JSON.stringify({ id, name: path.basename(source, ".js"), version: "local", entry: "index.js", scope: "renderer" }), "utf8");
      descriptor = await loadScriptDescriptor(temporaryDirectory);
    } else {
      throw new Error("install source must be a directory with manifest.json or a .js file");
    }

    const target = assertWithinDirectory(this.layout.scriptsRoot, path.join(this.layout.scriptsRoot, descriptor.id), "script install target");
    if (await exists(target) && !overwrite) throw new Error(`script already installed: ${descriptor.id}`);
    if (await exists(target)) await rm(target, { recursive: true, force: true });
    await cp(descriptor.directory, target, { recursive: true, force: true });
    this.config.scripts[descriptor.id] = { enabled: Boolean(enabled) };
    await this.saveConfig();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    return (await this.list({ includeInvalid: false })).find(item => item.id === descriptor.id);
  }

  async setEnabled(id, enabled) {
    const scripts = await this.list({ includeInvalid: false });
    if (!scripts.some(script => script.id === id)) throw new Error(`unknown script: ${id}`);
    this.config.scripts[id] = { ...(this.config.scripts[id] || {}), enabled: Boolean(enabled) };
    await this.saveConfig();
    return (await this.list({ includeInvalid: false })).find(script => script.id === id);
  }

  async setSafeMode(enabled) {
    this.config.safeMode = Boolean(enabled);
    await this.saveConfig();
    return this.config.safeMode;
  }

  async buildPlan() {
    const scripts = await this.list({ includeInvalid: false });
    const enabled = this.config.globalEnabled && !this.config.safeMode ? scripts.filter(script => script.enabled) : [];
    return { descriptors: enabled, source: buildInjectionSource(enabled), summary: summarizePlan(enabled), safeMode: Boolean(this.config.safeMode) };
  }
}
