import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempRoot, makeScript } from "./helpers.mjs";
import { writeFile } from "node:fs/promises";
import { ScriptRegistry } from "../src/registry.mjs";
import { UiController, listUiCommands } from "../src/ui-controller.mjs";

test("UI controller exposes allowlisted commands and offline status", async () => {
  const root = await makeTempRoot();
  const source = await makeScript(path.join(root, "source"), { id: "test.ui" });
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await registry.install(source, { enabled: true });
  const controller = new UiController({ registry });
  const status = await controller.dispatch("get_app_status");
  assert.equal(status.codex, "stopped");
  assert.equal(status.enabledScripts, 1);
  assert.ok(listUiCommands().includes("reload_scripts"));
  assert.ok(listUiCommands().includes("remove_script"));
  assert.ok(listUiCommands().includes("list_quarantined"));
  assert.ok(listUiCommands().includes("restore_quarantined"));
  assert.ok(listUiCommands().includes("get_update_status"));
  const update = await controller.dispatch("get_update_status");
  assert.equal(update.currentVersion, "0.5.9");
  assert.equal(update.requiresInstaller, true);
  assert.equal(listUiCommands().includes("delete_script_permanently"), false);
  await assert.rejects(() => controller.dispatch("execute_script", { source: "danger" }), /unsupported loader command/);
});

test("reload defaults to a dry-run and does not touch any CDP endpoint", async () => {
  const root = await makeTempRoot();
  const source = await makeScript(path.join(root, "source"), { id: "test.dryrun" });
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await registry.install(source, { enabled: true });
  let connected = false;
  const controller = new UiController({ registry, injector: { inject: async () => { connected = true; return []; } } });
  const result = await controller.dispatch("reload_scripts");
  assert.equal(result.mode, "dry-run");
  assert.equal(connected, false);
  assert.equal(result.targetCount, 0);
});

test("live UI controller reports supervisor state and routes explicit reloads", async () => {
  const root = await makeTempRoot();
  const source = await makeScript(path.join(root, "source"), { id: "test.live-ui" });
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await registry.install(source, { enabled: true });
  let reloads = 0;
  let lastTickOptions;
  const supervisor = {
    snapshot: () => ({ phase: "healthy", targetCount: 1, lastInjectionAt: "2026-08-03T00:00:00.000Z", lastError: null, scriptStatuses: [{ id: "test.live-ui", status: "running" }] }),
    tick: async options => {
      reloads += 1;
      lastTickOptions = options;
      const plan = await registry.buildPlan();
      return { plan, results: [{ targetId: "codex-page", injected: true }] };
    }
  };
  const controller = new UiController({ registry, injector: {}, supervisor });
  const status = await controller.dispatch("get_app_status");
  assert.equal(status.scope, "renderer-plugins-only");
  assert.equal(status.codex, "healthy");
  assert.equal(status.cdp, "healthy");
  assert.equal(status.targetCount, 1);
  assert.equal((await controller.dispatch("list_scripts"))[0].status, "running");
  const result = await controller.dispatch("reload_scripts", { live: true, ids: ["test.live-ui"] });
  assert.equal(result.mode, "live");
  assert.equal(result.targetCount, 1);
  assert.equal(reloads, 1);
  assert.deepEqual(lastTickOptions, { force: true, restartIds: ["test.live-ui"] });
  await controller.dispatch("set_safe_mode", { enabled: true });
  assert.equal(reloads, 2);
});

test("live reload requests share one in-flight supervisor restart", async () => {
  const root = await makeTempRoot();
  const source = await makeScript(path.join(root, "source"), { id: "test.single-flight" });
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await registry.install(source, { enabled: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markTickStarted;
  const tickStarted = new Promise(resolve => { markTickStarted = resolve; });
  let reloads = 0;
  const supervisor = {
    snapshot: () => ({ phase: "healthy", targetCount: 1, scriptStatuses: [] }),
    async tick() {
      reloads += 1;
      markTickStarted();
      await gate;
      return { plan: await registry.buildPlan(), results: [{ targetId: "codex-page", injected: true }] };
    },
  };
  const controller = new UiController({ registry, injector: {}, supervisor });
  const first = controller.dispatch("reload_scripts", { live: true });
  const second = controller.dispatch("reload_scripts", { live: true });
  await tickStarted;
  assert.equal(reloads, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(reloads, 1);
});

test("script inspection does not install or execute a source", async () => {
  const root = await makeTempRoot();
  const sourcePath = path.join(root, "preview.js");
  await writeFile(sourcePath, "globalThis.__mustNotRun = true;", "utf8");
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  const controller = new UiController({ registry });
  const result = await controller.dispatch("inspect_script_source", { sourcePath });
  assert.equal(result.requiresConfirmation, true);
  assert.equal((await registry.list()).length, 0);
});
