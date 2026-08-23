import path from "node:path";
import { randomBytes } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { getLayout, assertWithinDirectory, safeScriptIdFromName } from "./paths.mjs";
import { describeTextScript, loadScriptDescriptor } from "./manifest.mjs";
import { buildInjectionSource, summarizePlan } from "./injection.mjs";

const DEFAULT_CONFIG = Object.freeze({ schemaVersion: 1, globalEnabled: true, safeMode: false, scripts: {} });
const SCRIPT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const QUARANTINE_KEY_PATTERN = /^q-[a-z0-9]+-[a-f0-9]{24}$/;
const QUARANTINE_METADATA = "metadata.json";
const QUARANTINE_SCRIPT_DIRECTORY = "script";

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function cloneDefaultConfig() {
  return { schemaVersion: DEFAULT_CONFIG.schemaVersion, globalEnabled: true, safeMode: false, scripts: {} };
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeLoadedConfig(value) {
  if (!isPlainRecord(value) || Number(value.schemaVersion ?? 1) !== 1) throw new Error("unsupported loader config schema");
  if (value.globalEnabled !== undefined && typeof value.globalEnabled !== "boolean") throw new Error("globalEnabled must be a boolean");
  if (value.safeMode !== undefined && typeof value.safeMode !== "boolean") throw new Error("safeMode must be a boolean");
  if (value.scripts !== undefined && !isPlainRecord(value.scripts)) throw new Error("scripts must be an object");
  const scripts = {};
  for (const [id, settings] of Object.entries(value.scripts || {})) {
    if (!SCRIPT_ID_PATTERN.test(id) || !isPlainRecord(settings)) throw new Error("invalid script configuration entry");
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error("script enabled state must be a boolean");
    scripts[id] = settings.enabled === undefined ? {} : { enabled: settings.enabled };
  }
  return {
    schemaVersion: 1,
    globalEnabled: value.globalEnabled ?? true,
    safeMode: value.safeMode ?? false,
    scripts
  };
}

function publicQuarantineRecord(record) {
  return {
    key: record.key,
    scriptId: record.scriptId,
    name: record.name,
    version: record.version,
    enabled: record.enabled,
    quarantinedAt: record.quarantinedAt,
    status: "quarantined"
  };
}

function configSnapshot(config, id) {
  const present = Object.prototype.hasOwnProperty.call(config.scripts, id);
  return { present, value: present ? { ...config.scripts[id] } : undefined };
}

function restoreConfigSnapshot(config, id, snapshot) {
  if (snapshot.present) config.scripts[id] = snapshot.value;
  else delete config.scripts[id];
}

function metadataText(value, fallback) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, 128);
}

export class ScriptRegistry {
  constructor(dataRoot) {
    this.layout = getLayout(dataRoot);
    this.config = cloneDefaultConfig();
    this.configLoadError = null;
    this.mutationTail = Promise.resolve();
  }

  async runMutation(operation) {
    const previous = this.mutationTail;
    let release;
    this.mutationTail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  async init() {
    await mkdir(this.layout.scriptsRoot, { recursive: true });
    await mkdir(this.layout.quarantineRoot, { recursive: true });
    await this.reloadConfig();
    return this;
  }

  async reloadConfig() {
    await this.mutationTail;
    if (await exists(this.layout.configPath)) {
      try {
        this.config = normalizeLoadedConfig(JSON.parse(await readFile(this.layout.configPath, "utf8")));
        this.configLoadError = null;
      } catch (error) {
        this.config = cloneDefaultConfig();
        this.config.safeMode = true;
        this.configLoadError = String(error?.message || error).slice(0, 200);
      }
    } else {
      this.config = cloneDefaultConfig();
      this.configLoadError = null;
    }
    return this.config;
  }

  async saveConfig() {
    if (this.configLoadError) throw new Error("loader configuration is invalid; refusing to overwrite it");
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

  async install(sourcePath, options = {}) {
    return this.runMutation(() => this.installUnlocked(sourcePath, options));
  }

  async installUnlocked(sourcePath, { enabled = false, overwrite = false } = {}) {
    const source = path.resolve(sourcePath);
    let temporaryDirectory = null;
    try {
      const sourceStats = await lstat(source);
      let descriptor;
      if (sourceStats.isDirectory()) {
        descriptor = await loadScriptDescriptor(source);
      } else if (sourceStats.isFile() && source.toLowerCase().endsWith(".js")) {
        const id = safeScriptIdFromName(path.basename(source, ".js"));
        temporaryDirectory = path.join(this.layout.dataRoot, `.install-${process.pid}-${Date.now()}`);
        await mkdir(temporaryDirectory, { recursive: true });
        await writeFile(path.join(temporaryDirectory, "index.js"), await readFile(source, "utf8"), "utf8");
        await writeFile(path.join(temporaryDirectory, "manifest.json"), JSON.stringify({ id, name: path.basename(source, ".js"), version: "local", main: "index.js", scope: "renderer" }), "utf8");
        descriptor = await loadScriptDescriptor(temporaryDirectory);
      } else {
        throw new Error("install source must be a directory with manifest.json or a .js file");
      }

      const target = assertWithinDirectory(this.layout.scriptsRoot, path.join(this.layout.scriptsRoot, descriptor.id), "script install target");
      if (await exists(target)) {
        if (overwrite) throw new Error(`script overwrite is not supported; quarantine the installed script first: ${descriptor.id}`);
        throw new Error(`script already installed: ${descriptor.id}`);
      }
      try {
        await cp(descriptor.directory, target, { recursive: true, force: false, errorOnExist: true });
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        throw error;
      }
      const previousConfig = configSnapshot(this.config, descriptor.id);
      this.config.scripts[descriptor.id] = { enabled: Boolean(enabled) };
      try {
        await this.saveConfig();
      } catch (error) {
        restoreConfigSnapshot(this.config, descriptor.id, previousConfig);
        await rm(target, { recursive: true, force: true });
        throw error;
      }
      return (await this.list({ includeInvalid: false })).find(item => item.id === descriptor.id);
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async installSourceText({ name, sourceText }, { enabled = false, overwrite = false } = {}) {
    const descriptor = describeTextScript({ name, sourceText });
    await mkdir(this.layout.dataRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(path.join(this.layout.dataRoot, ".text-install-"));
    try {
      await writeFile(path.join(temporaryDirectory, "index.js"), descriptor.source, "utf8");
      await writeFile(path.join(temporaryDirectory, "manifest.json"), JSON.stringify({
        schemaVersion: 1,
        id: descriptor.id,
        name: descriptor.name,
        version: descriptor.version,
        main: descriptor.entry,
        scope: descriptor.scope,
        runAt: descriptor.runAt,
        lifecycleGlobal: descriptor.lifecycleGlobal,
        permissions: descriptor.permissions
      }), "utf8");
      return await this.install(temporaryDirectory, { enabled, overwrite });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async setEnabled(id, enabled) {
    return this.runMutation(async () => {
      const scripts = await this.list({ includeInvalid: false });
      if (!scripts.some(script => script.id === id)) throw new Error(`unknown script: ${id}`);
      const previousConfig = configSnapshot(this.config, id);
      this.config.scripts[id] = { ...(this.config.scripts[id] || {}), enabled: Boolean(enabled) };
      try { await this.saveConfig(); }
      catch (error) {
        restoreConfigSnapshot(this.config, id, previousConfig);
        throw error;
      }
      return (await this.list({ includeInvalid: false })).find(script => script.id === id);
    });
  }

  async setSafeMode(enabled) {
    return this.runMutation(async () => {
      const previous = this.config.safeMode;
      this.config.safeMode = Boolean(enabled);
      try { await this.saveConfig(); }
      catch (error) {
        this.config.safeMode = previous;
        throw error;
      }
      return this.config.safeMode;
    });
  }

  async createQuarantineEntry() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const key = `q-${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
      const entryDirectory = assertWithinDirectory(this.layout.quarantineRoot, path.join(this.layout.quarantineRoot, key), "quarantine entry");
      try {
        await mkdir(entryDirectory, { recursive: false });
        return { key, entryDirectory };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw new Error("failed to allocate a unique quarantine entry");
  }

  async readQuarantineRecord(key) {
    if (typeof key !== "string" || !QUARANTINE_KEY_PATTERN.test(key)) throw new Error("invalid quarantine key");
    const entryDirectory = assertWithinDirectory(this.layout.quarantineRoot, path.join(this.layout.quarantineRoot, key), "quarantine entry");
    let entryInfo;
    try { entryInfo = await lstat(entryDirectory); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error(`unknown quarantine entry: ${key}`);
      throw error;
    }
    if (!entryInfo.isDirectory() || entryInfo.isSymbolicLink()) throw new Error(`invalid quarantine entry: ${key}`);
    const metadataPath = assertWithinDirectory(entryDirectory, path.join(entryDirectory, QUARANTINE_METADATA), "quarantine metadata");
    let metadata;
    try {
      const metadataInfo = await lstat(metadataPath);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) throw new Error("invalid metadata file");
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    }
    catch { throw new Error(`invalid quarantine entry: ${key}`); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || metadata.schemaVersion !== 1 || metadata.key !== key
      || typeof metadata.scriptId !== "string" || !SCRIPT_ID_PATTERN.test(metadata.scriptId)
      || typeof metadata.name !== "string" || !metadata.name || metadata.name.length > 128
      || typeof metadata.version !== "string" || metadata.version.length > 128
      || typeof metadata.enabled !== "boolean"
      || typeof metadata.quarantinedAt !== "string" || Number.isNaN(Date.parse(metadata.quarantinedAt))) {
      throw new Error(`invalid quarantine entry: ${key}`);
    }
    const scriptDirectory = assertWithinDirectory(entryDirectory, path.join(entryDirectory, QUARANTINE_SCRIPT_DIRECTORY), "quarantined script");
    let scriptInfo;
    try { scriptInfo = await lstat(scriptDirectory); }
    catch { throw new Error(`invalid quarantine entry: ${key}`); }
    if (!scriptInfo.isDirectory() || scriptInfo.isSymbolicLink()) throw new Error(`invalid quarantine entry: ${key}`);
    try {
      const descriptor = await loadScriptDescriptor(scriptDirectory);
      if (descriptor.id !== metadata.scriptId) throw new Error("script id does not match quarantine metadata");
    } catch {
      throw new Error(`invalid quarantine entry: ${key}`);
    }
    return { ...metadata, entryDirectory, metadataPath, scriptDirectory };
  }

  async listQuarantined() {
    const entries = await readdir(this.layout.quarantineRoot, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !QUARANTINE_KEY_PATTERN.test(entry.name)) continue;
      try { records.push(publicQuarantineRecord(await this.readQuarantineRecord(entry.name))); }
      catch { /* Corrupt or incomplete entries are never exposed as restorable. */ }
    }
    return records.sort((left, right) => right.quarantinedAt.localeCompare(left.quarantinedAt));
  }

  async quarantineScript(id, { mode = "quarantine" } = {}) {
    return this.runMutation(async () => {
      if (mode !== "quarantine") throw new Error("only quarantine removal is supported");
      if (typeof id !== "string" || !SCRIPT_ID_PATTERN.test(id)) throw new Error("invalid script id");
      const script = (await this.list()).find(item => item.id === id);
      if (!script) throw new Error(`unknown script: ${id}`);
      if (script.status === "failed") throw new Error(`invalid installed script: ${id}`);
      const sourceDirectory = assertWithinDirectory(this.layout.scriptsRoot, script.directory, "installed script");
      const sourceInfo = await lstat(sourceDirectory);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error(`invalid installed script: ${id}`);

      const { key, entryDirectory } = await this.createQuarantineEntry();
      const scriptDirectory = assertWithinDirectory(entryDirectory, path.join(entryDirectory, QUARANTINE_SCRIPT_DIRECTORY), "quarantined script");
      const metadataPath = assertWithinDirectory(entryDirectory, path.join(entryDirectory, QUARANTINE_METADATA), "quarantine metadata");
      const metadataTemporary = assertWithinDirectory(entryDirectory, path.join(entryDirectory, `${QUARANTINE_METADATA}.tmp`), "quarantine metadata temporary");
      const metadata = {
        schemaVersion: 1,
        key,
        scriptId: id,
        name: metadataText(script.name, id),
        version: metadataText(script.version, "?"),
        enabled: Boolean(script.enabled),
        quarantinedAt: new Date().toISOString()
      };
      let moved = false;
      try {
        await writeFile(metadataTemporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(metadataTemporary, metadataPath);
        await rename(sourceDirectory, scriptDirectory);
        moved = true;
      } catch (error) {
        if (!moved) await rm(entryDirectory, { recursive: true, force: true });
        throw error;
      }

      const previousConfig = configSnapshot(this.config, id);
      delete this.config.scripts[id];
      try {
        await this.saveConfig();
      } catch (error) {
        restoreConfigSnapshot(this.config, id, previousConfig);
        try {
          await rename(scriptDirectory, sourceDirectory);
          await rm(entryDirectory, { recursive: true, force: true });
        } catch (rollbackError) {
          throw new Error(`quarantine rollback failed for ${id}`, { cause: rollbackError });
        }
        throw error;
      }
      return publicQuarantineRecord(metadata);
    });
  }

  async restoreQuarantined(key) {
    return this.runMutation(async () => {
      const record = await this.readQuarantineRecord(key);
      const target = assertWithinDirectory(this.layout.scriptsRoot, path.join(this.layout.scriptsRoot, record.scriptId), "script restore target");
      if ((await this.list()).some(script => script.id === record.scriptId) || await exists(target)) {
        throw new Error(`restore conflict: script already installed: ${record.scriptId}`);
      }
      await rename(record.scriptDirectory, target);

      const previousConfig = configSnapshot(this.config, record.scriptId);
      this.config.scripts[record.scriptId] = { enabled: record.enabled };
      try {
        await this.saveConfig();
      } catch (error) {
        restoreConfigSnapshot(this.config, record.scriptId, previousConfig);
        try { await rename(target, record.scriptDirectory); }
        catch (rollbackError) { throw new Error(`restore rollback failed for ${record.scriptId}`, { cause: rollbackError }); }
        throw error;
      }

      try {
        await rm(record.metadataPath, { force: true });
        await rmdir(record.entryDirectory);
      } catch { /* The script and config are restored; stale metadata is ignored by listQuarantined. */ }
      const restored = (await this.list()).find(script => script.id === record.scriptId);
      return { key, script: restored };
    });
  }

  async buildPlan({ forceIds = [] } = {}) {
    const scripts = await this.list({ includeInvalid: false });
    const enabled = this.config.globalEnabled && !this.config.safeMode ? scripts.filter(script => script.enabled) : [];
    if (forceIds !== "all" && !Array.isArray(forceIds)) throw new TypeError("forceIds must be an array or all");
    const requestedForceIds = forceIds === "all" ? enabled.map(script => script.id) : forceIds;
    return { descriptors: enabled, source: buildInjectionSource(enabled, { forceIds: requestedForceIds }), summary: summarizePlan(enabled), safeMode: Boolean(this.config.safeMode) };
  }
}
