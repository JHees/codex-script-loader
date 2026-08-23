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

test("module lifecycle receives the scoped API and disposes on reload", () => {
  const context = vm.createContext({ console, setInterval, clearInterval, localStorage: { values: new Map(), getItem(key) { return this.values.get(key) ?? null; }, setItem(key, value) { this.values.set(key, value); } } });
  const script = { ...descriptor({ id: "test.module", source: "module.exports = { start(api) { globalThis.__moduleApi = { id: api.id, permissions: api.permissions }; return () => { globalThis.__moduleStops = (globalThis.__moduleStops || 0) + 1; }; } };" }), permissions: ["local-storage"] };
  vm.runInContext(buildInjectionSource([script]), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__moduleApi)), { id: "test.module", permissions: ["local-storage"] });
  assert.equal(context.__codexScriptLoader.managerOrigin, undefined);
  vm.runInContext(buildInjectionSource([]), context);
  assert.equal(context.__moduleStops, 1);
});

test("settings API is permission-gated and owned by the loader host", () => {
  const context = vm.createContext({ console, setTimeout, clearTimeout });
  const script = {
    ...descriptor({ id: "test.settings", source: "globalThis.__settingsApi = api.settings; globalThis.__processKind = api.process;" }),
    permissions: ["settings"]
  };
  vm.runInContext(buildInjectionSource([script]), context);
  assert.equal(typeof context.__settingsApi.registerPage, "function");
  assert.equal(typeof context.__settingsApi.register, "function");
  assert.equal(context.__processKind, "renderer");
  assert.equal(context.__codexScriptLoader.settingsHost.snapshot().version, "0.3.2");

  const withoutPermission = { ...descriptor({ id: "test.no-settings", source: "globalThis.__settingsWithoutPermission = api.settings;" }), permissions: [] };
  vm.runInContext(buildInjectionSource([withoutPermission]), context);
  assert.equal(context.__settingsWithoutPermission, undefined);
});

test("settings host keeps Loader management separate from plugin pages without refreshing Codex", () => {
  const source = buildInjectionSource([]);
  assert.ok(source.indexOf("groupHeader(groupLabels.loaderGroup)") < source.indexOf("groupHeader(groupLabels.tweaksGroup)"));
  assert.match(source, /loaderGroup: "加载器"/);
  assert.match(source, /tweaksGroup: "插件"/);
  assert.match(source, /Reload plugin scripts/);
  assert.match(source, /重新加载插件脚本/);
  assert.match(source, /color-background-primary/);
  assert.match(source, /border-radius:14px/);
  assert.match(source, /mountedGroups/);
  assert.match(source, /get_app_status/);
  assert.match(source, /reload_scripts/);
  assert.doesNotMatch(source, /location\.reload\s*\(/);
});
