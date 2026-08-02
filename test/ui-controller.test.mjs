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
  assert.equal(listUiCommands().includes("delete_script_permanently"), false);
  await assert.rejects(() => controller.dispatch("execute_script", { source: "danger" }), /unsupported UI command/);
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
