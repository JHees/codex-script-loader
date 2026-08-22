import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { makeTempRoot, makeScript } from "./helpers.mjs";
import { ScriptRegistry } from "../src/registry.mjs";

test("registry installs, lists, toggles and builds a safe injection plan", async () => {
  const root = await makeTempRoot();
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  const source = await makeScript(sourceRoot, { id: "test.registry", source: "globalThis.__registryTest = true;" });
  const dataRoot = path.join(root, "loader-data");
  const registry = await new ScriptRegistry(dataRoot).init();
  const installed = await registry.install(source, { enabled: true });
  assert.equal(installed.id, "test.registry");
  assert.equal((await registry.list()).find(item => item.id === "test.registry").enabled, true);
  const plan = await registry.buildPlan();
  assert.equal(plan.summary.length, 1);
  assert.match(plan.source, /__registryTest/);
  await registry.setSafeMode(true);
  const safePlan = await registry.buildPlan();
  assert.equal(safePlan.safeMode, true);
  assert.equal(safePlan.summary.length, 0);
});

test("invalid installed scripts are reported without becoming injectable", async () => {
  const root = await makeTempRoot();
  const dataRoot = path.join(root, "loader-data");
  const bad = path.join(dataRoot, "scripts", "broken.script");
  await mkdir(bad, { recursive: true });
  await writeFile(path.join(bad, "manifest.json"), JSON.stringify({ id: "broken.script", entry: "missing.js" }), "utf8");
  const registry = await new ScriptRegistry(dataRoot).init();
  const scripts = await registry.list();
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].status, "failed");
  assert.equal((await registry.buildPlan()).summary.length, 0);
});

test("registry reloads configuration written by another manager instance", async () => {
  const root = await makeTempRoot();
  const dataRoot = path.join(root, "loader-data");
  const source = await makeScript(path.join(root, "source"), { id: "test.shared-config" });
  const writer = await new ScriptRegistry(dataRoot).init();
  await writer.install(source, { enabled: false });
  const reader = await new ScriptRegistry(dataRoot).init();
  assert.equal((await reader.buildPlan()).summary.length, 0);
  await writer.setEnabled("test.shared-config", true);
  await reader.reloadConfig();
  assert.equal((await reader.buildPlan()).summary.length, 1);
});

test("config reload waits for an in-process mutation to finish", async () => {
  const root = await makeTempRoot();
  const dataRoot = path.join(root, "loader-data");
  const source = await makeScript(path.join(root, "source"), { id: "test.reload-lock" });
  const registry = await new ScriptRegistry(dataRoot).init();
  await registry.install(source, { enabled: false });
  const originalSave = registry.saveConfig.bind(registry);
  let releaseSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  registry.saveConfig = async () => {
    await saveGate;
    return originalSave();
  };

  const mutation = registry.setEnabled("test.reload-lock", true);
  await new Promise(resolve => setImmediate(resolve));
  let reloadFinished = false;
  const reload = registry.reloadConfig().then(() => { reloadFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reloadFinished, false);
  releaseSave();
  await mutation;
  await reload;
  assert.equal(registry.config.scripts["test.reload-lock"].enabled, true);
});

test("a failed config save rolls back a new installation", async () => {
  const root = await makeTempRoot();
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  const source = await makeScript(path.join(root, "source"), { id: "test.install-rollback" });
  registry.saveConfig = async () => { throw new Error("simulated install config failure"); };
  await assert.rejects(() => registry.install(source, { enabled: true }), /simulated install config failure/);
  assert.deepEqual(await registry.list(), []);
  assert.equal(registry.config.scripts["test.install-rollback"], undefined);
});

test("an invalid config forces safe mode without overwriting the file", async () => {
  const root = await makeTempRoot();
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot, { recursive: true });
  const configPath = path.join(dataRoot, "config.json");
  await writeFile(configPath, "{ definitely-not-json", "utf8");
  const registry = await new ScriptRegistry(dataRoot).init();
  assert.equal(registry.config.safeMode, true);
  assert.ok(registry.configLoadError);
  assert.equal((await registry.buildPlan()).summary.length, 0);
  await assert.rejects(() => registry.setSafeMode(false), /refusing to overwrite/);
  assert.equal(await readFile(configPath, "utf8"), "{ definitely-not-json");
});

test("registry quarantines and restores scripts without permanent deletion", async () => {
  const root = await makeTempRoot();
  const source = await makeScript(path.join(root, "source"), { id: "test.recoverable", name: "Recoverable", source: "globalThis.__recoverable = true;" });
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await registry.install(source, { enabled: true });

  const removed = await registry.quarantineScript("test.recoverable");
  assert.match(removed.key, /^q-[a-z0-9]+-[a-f0-9]{24}$/);
  assert.equal(removed.scriptId, "test.recoverable");
  assert.equal(removed.enabled, true);
  assert.equal((await registry.list()).length, 0);
  assert.equal(registry.config.scripts["test.recoverable"], undefined);

  const quarantined = await registry.listQuarantined();
  assert.deepEqual(quarantined, [removed]);
  assert.equal("directory" in quarantined[0], false);
  assert.equal("source" in quarantined[0], false);
  const metadata = JSON.parse(await readFile(path.join(registry.layout.quarantineRoot, removed.key, "metadata.json"), "utf8"));
  assert.deepEqual(Object.keys(metadata).sort(), ["enabled", "key", "name", "quarantinedAt", "schemaVersion", "scriptId", "version"]);

  const restored = await registry.restoreQuarantined(removed.key);
  assert.equal(restored.key, removed.key);
  assert.equal(restored.script.id, "test.recoverable");
  assert.equal(restored.script.enabled, true);
  assert.deepEqual(await registry.listQuarantined(), []);
  assert.deepEqual(registry.config.scripts["test.recoverable"], { enabled: true });

  const removedAgain = await registry.quarantineScript("test.recoverable");
  assert.notEqual(removedAgain.key, removed.key);
});

test("restore refuses conflicts and permanent removal modes", async () => {
  const root = await makeTempRoot();
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  const original = await makeScript(path.join(root, "original"), { id: "test.conflict", source: "globalThis.__version = 1;" });
  await registry.install(original, { enabled: false });
  const removed = await registry.quarantineScript("test.conflict");

  const replacement = await makeScript(path.join(root, "replacement"), { id: "test.conflict", source: "globalThis.__version = 2;" });
  await registry.install(replacement, { enabled: true });
  await assert.rejects(() => registry.install(replacement, { enabled: true, overwrite: true }), /overwrite is not supported/);
  await assert.rejects(() => registry.restoreQuarantined(removed.key), /restore conflict/);
  assert.equal((await registry.listQuarantined()).length, 1);
  assert.match((await registry.list())[0].source, /__version = 2/);

  await assert.rejects(() => registry.quarantineScript("test.conflict", { mode: "permanent" }), /only quarantine/);
  assert.equal((await registry.list()).length, 1);
});

test("quarantine and restore roll back moves when config persistence fails", async () => {
  const root = await makeTempRoot();
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  const source = await makeScript(path.join(root, "source"), { id: "test.rollback" });
  await registry.install(source, { enabled: true });
  const saveConfig = registry.saveConfig.bind(registry);

  registry.saveConfig = async () => { throw new Error("simulated config failure"); };
  await assert.rejects(() => registry.quarantineScript("test.rollback"), /simulated config failure/);
  assert.equal((await registry.list()).length, 1);
  assert.deepEqual(await registry.listQuarantined(), []);
  assert.deepEqual(registry.config.scripts["test.rollback"], { enabled: true });

  registry.saveConfig = saveConfig;
  const removed = await registry.quarantineScript("test.rollback");
  registry.saveConfig = async () => { throw new Error("simulated restore config failure"); };
  await assert.rejects(() => registry.restoreQuarantined(removed.key), /simulated restore config failure/);
  assert.equal((await registry.list()).length, 0);
  assert.equal((await registry.listQuarantined()).length, 1);
  assert.equal(registry.config.scripts["test.rollback"], undefined);
});

test("quarantine refuses invalid installed packages and detects tampered restore contents", async () => {
  const root = await makeTempRoot();
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await mkdir(path.join(registry.layout.scriptsRoot, "broken-package"), { recursive: true });
  await writeFile(path.join(registry.layout.scriptsRoot, "broken-package", "manifest.json"), "not-json", "utf8");
  await assert.rejects(() => registry.quarantineScript("broken-package"), /invalid installed script/);

  const source = await makeScript(path.join(root, "source-valid"), { id: "test.tamper", name: "Tamper" });
  await registry.install(source, { enabled: false });
  const removed = await registry.quarantineScript("test.tamper");
  const manifestPath = path.join(registry.layout.quarantineRoot, removed.key, "script", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.id = "test.different";
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  assert.deepEqual(await registry.listQuarantined(), []);
  await assert.rejects(() => registry.restoreQuarantined(removed.key), /invalid quarantine entry/);
});
