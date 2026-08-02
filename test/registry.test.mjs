import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
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

