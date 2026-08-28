import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadScriptDescriptor } from "../src/manifest.mjs";
import { ScriptRegistry } from "../src/registry.mjs";
import { makeTempRoot } from "./helpers.mjs";

const packageDirectory = fileURLToPath(new URL("../packages/example-ui-plugin/", import.meta.url));

test("bundled example satisfies the public plugin package contract", async () => {
  const descriptor = await loadScriptDescriptor(packageDirectory);
  assert.equal(descriptor.id, "dev.codex-script-loader.example-ui");
  assert.equal(descriptor.version, "1.0.0");
  assert.equal(descriptor.lifecycleGlobal, "__codexScriptLoaderExampleUi");
  assert.equal(descriptor.settingsMode, "page");
  assert.equal(descriptor.documentation, "README.md");
  assert.deepEqual(descriptor.permissions, ["dom", "local-storage", "settings"]);
  assert.doesNotMatch(descriptor.source, /https?:\/\//iu);

  const root = await makeTempRoot();
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await registry.install(packageDirectory, { enabled: true });
  const plan = await registry.buildPlan();
  assert.deepEqual(plan.summary.map(item => item.id), ["dev.codex-script-loader.example-ui"]);
  assert.doesNotThrow(() => new vm.Script(plan.source), "the complete public injection plan should compile");
});
