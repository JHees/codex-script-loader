import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildInjectionSource } from "../src/injection.mjs";

function descriptor({ id = "test.lifecycle", fingerprint = "a".repeat(64), source = "" } = {}) {
  return {
    id,
    version: "1.0.0",
    fingerprint,
    lifecycleGlobal: "__testLifecycle",
    source,
    runAt: "document-start"
  };
}

test("injection captures an IIFE lifecycle global and safe mode stops it", () => {
  const context = vm.createContext({});
  const snapshot = vm.runInContext(buildInjectionSource([descriptor({
    source: "globalThis.__testLifecycle = { stop() { globalThis.__stopCount = (globalThis.__stopCount || 0) + 1; } };"
  })]), context);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), [{ id: "test.lifecycle", version: "1.0.0", status: "running" }]);
  assert.equal(context.__codexScriptLoader.scripts["test.lifecycle"].status, "running");
  assert.equal(typeof context.__codexScriptLoader.scripts["test.lifecycle"].stop, "function");

  vm.runInContext(buildInjectionSource([]), context);
  assert.equal(context.__stopCount, 1);
  assert.equal(context.__testLifecycle, undefined);
  assert.equal(context.__codexScriptLoader.scripts["test.lifecycle"], undefined);
});

test("same fingerprint is idempotent while a changed fingerprint stops the old instance", () => {
  const context = vm.createContext({});
  const first = descriptor({ source: "globalThis.__starts = (globalThis.__starts || 0) + 1; globalThis.__testLifecycle = { stop() { globalThis.__stops = (globalThis.__stops || 0) + 1; } };" });
  vm.runInContext(buildInjectionSource([first]), context);
  vm.runInContext(buildInjectionSource([first]), context);
  assert.equal(context.__starts, 1);
  vm.runInContext(buildInjectionSource([{ ...first, fingerprint: "b".repeat(64) }]), context);
  assert.equal(context.__starts, 2);
  assert.equal(context.__stops, 1);
});

test("an explicit force id restarts the same fingerprint", () => {
  const context = vm.createContext({});
  const script = descriptor({ source: "globalThis.__starts = (globalThis.__starts || 0) + 1; globalThis.__testLifecycle = { stop() { globalThis.__stops = (globalThis.__stops || 0) + 1; } };" });
  vm.runInContext(buildInjectionSource([script]), context);
  vm.runInContext(buildInjectionSource([script], { forceIds: [script.id] }), context);
  assert.equal(context.__starts, 2);
  assert.equal(context.__stops, 1);
});

test("a failed start cleans an exposed lifecycle global", () => {
  const context = vm.createContext({});
  const script = descriptor({ source: "globalThis.__testLifecycle = { stop() { globalThis.__stops = (globalThis.__stops || 0) + 1; } }; throw new Error('start failed');" });
  vm.runInContext(buildInjectionSource([script]), context);
  assert.equal(context.__codexScriptLoader.scripts[script.id].status, "failed");
  assert.equal(context.__stops, 1);
  assert.equal(context.__testLifecycle, undefined);
});
