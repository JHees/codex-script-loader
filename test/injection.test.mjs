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

test("host-only update metadata is not exposed through renderer api.manifest", () => {
  const context = vm.createContext({ console });
  const script = {
    ...descriptor({ id: "test.update-host-only", source: "globalThis.__rendererManifest = api.manifest;" }),
    update: { provider: "github-releases", repository: "Example/private-host-interface", asset: "plugin-{version}.zip" },
    raw: { update: { provider: "github-releases", repository: "Example/private-host-interface", asset: "plugin-{version}.zip" } },
  };
  vm.runInContext(buildInjectionSource([script]), context);
  assert.equal(Object.hasOwn(context.__rendererManifest, "update"), false);
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
  assert.equal(context.__codexScriptLoader.settingsHost.snapshot().version, "0.5.6");

  const withoutPermission = { ...descriptor({ id: "test.no-settings", source: "globalThis.__settingsWithoutPermission = api.settings;" }), permissions: [] };
  vm.runInContext(buildInjectionSource([withoutPermission]), context);
  assert.equal(context.__settingsWithoutPermission, undefined);
});

test("settings host groups management and plugin pages under Script-Loader without refreshing Codex", () => {
  const source = buildInjectionSource([]);
  assert.match(source, /loaderGroup: "Script-Loader"/);
  assert.match(source, /const implementationRevision = "0\.5\.6-native-plugin-list-metadata-tooltip-final"/);
  assert.match(source, /current\?\.version === version && current\?\.implementationRevision === implementationRevision/);
  assert.match(source, /implementationRevision,/);
  assert.doesNotMatch(source, /tweaksGroup:/);
  assert.match(source, /title: loaderLabels\(\)\.settings/);
  assert.match(source, /data-codex-loader-brand-icon/);
  assert.match(source, /data:image\/png;base64/);
  assert.match(source, /mask-image:url/);
  assert.doesNotMatch(source, /M4 10a6 6 0 0 1/);
  assert.doesNotMatch(source, /Add folder/);
  assert.doesNotMatch(source, /添加文件夹/);
  assert.match(source, /Install plugin ZIP/);
  assert.match(source, /安装插件 ZIP/);
  assert.match(source, /Reload plugins/);
  assert.match(source, /重载插件/);
  assert.doesNotMatch(source, /Reload all/);
  assert.doesNotMatch(source, /全部重新加载/);
  assert.match(source, /async function addPlugin\(command\) \{\s+if \(busy\) return;\s+setBusy\(true\);/);
  assert.match(source, /reload_plugins/);
  assert.match(source, /check_plugin_updates/);
  assert.match(source, /set_plugin_auto_update/);
  assert.match(source, /start_plugin_update/);
  assert.match(source, /confirm_plugin_update/);
  assert.match(source, /cancel_plugin_update/);
  assert.match(source, /Check plugin updates/);
  assert.match(source, /检查插件更新/);
  assert.match(source, /Check for updates/);
  assert.match(source, /检查更新/);
  assert.match(source, /Checking…/);
  assert.match(source, /检查中…/);
  assert.doesNotMatch(source, /Recently removed/);
  assert.doesNotMatch(source, /最近移除/);
  assert.match(source, /Enable plugin/);
  assert.match(source, /启用插件/);
  assert.match(source, /More actions/);
  assert.match(source, /更多操作/);
  assert.match(source, /dataset\.codexLoaderSettings = "plugin-native-list"/);
  assert.match(source, /pluginsCard\.setAttribute\("role", "list"\)/);
  assert.doesNotMatch(source, /plugin-market-table/);
  assert.doesNotMatch(source, /setAttribute\("role", "table"\)/);
  assert.doesNotMatch(source, /plugin-market-header/);
  assert.doesNotMatch(source, /plugin-market-tabs/);
  assert.doesNotMatch(source, /setAttribute\("role", "tablist"\)/);
  assert.doesNotMatch(source, /requestBridge\("list_quarantined"/);
  assert.doesNotMatch(source, /requestBridge\("restore_plugin"/);
  assert.match(source, /dataset\.codexLoaderSettings = "plugin-market-row"/);
  assert.match(source, /row\.setAttribute\("role", "listitem"\)/);
  assert.match(source, /rounded-2xl p-2 hover:bg-token-list-hover-background/);
  assert.doesNotMatch(source, /gridTemplateColumns/);
  assert.doesNotMatch(source, /autoUpdateColumn/);
  assert.doesNotMatch(source, /plugin-setting-row/);
  assert.match(source, /pluginAutoUpdateEnabled: "已开启"/);
  assert.match(source, /pluginAutoUpdateDisabled: "已关闭"/);
  assert.match(source, /enablePluginAutoUpdate: "开启自动更新"/);
  assert.match(source, /disablePluginAutoUpdate: "关闭自动更新"/);
  assert.match(source, /pluginAutoUpdateInline\(value\) \{ return `自动更新：\$\{value\}`; \}/);
  assert.match(source, /detailParts\.push\(labels\.pluginAutoUpdateInline\(pluginAutoUpdateStatus\(plugin\)\)\)/);
  assert.match(source, /plugin\.update\?\.automatic === true \? labels\.disablePluginAutoUpdate : labels\.enablePluginAutoUpdate/);
  assert.match(source, /pluginUpdates: "插件更新"/);
  assert.match(source, /pluginUpdates: "Plugin updates"/);
  assert.match(source, /function pluginActionsMenu/);
  assert.doesNotMatch(source, /actionButton\(labels\.moreActions\)/);
  assert.match(source, /trigger\.dataset\.codexLoaderSettings = "plugin-more-actions"/);
  assert.match(source, /trigger\.setAttribute\("aria-label", labels\.moreActions\)/);
  assert.match(source, /trigger\.innerHTML = moreActionsIcon\(\)/);
  assert.match(source, /function helpIcon\(\)/);
  assert.match(source, /function pluginDocumentationSummary\(plugin\)/);
  assert.match(source, /dataset\.codexLoaderSettings = "plugin-documentation-help"/);
  assert.match(source, /tooltip\.setAttribute\("role", "tooltip"\)/);
  assert.match(source, /button\.addEventListener\("mouseenter", show\)/);
  assert.match(source, /button\.addEventListener\("focus", show\)/);
  assert.doesNotMatch(source, /appendItem\(labels\.documentation/);
  assert.match(source, /function pluginRepository\(plugin\)/);
  assert.match(source, /function pluginAuthor\(plugin, repository\)/);
  assert.match(source, /github\.com\/\$\{repository\}/);
  assert.doesNotMatch(source, /meta\.textContent = `\$\{plugin\.id\} · \$\{labels\.version\}/);
  assert.match(source, /item\.style\.color = "var\(--color-text-danger\)"/);
  assert.match(source, /actions\.append\(switchControl\(plugin\), pluginActionsMenu\(plugin\)\)/);
  assert.match(source, /document\.addEventListener\("click", dismissPluginMenu\)/);
  assert.match(source, /target\?\.closest\("\[data-codex-loader-plugin-menu\]"\)/);
  assert.match(source, /document\.removeEventListener\("click", dismissPluginMenu\)/);
  assert.match(source, /actionButton\(labels\.addArchive, \{ primary: true \}\)/);
  assert.match(source, /background:var\(--color-text-primary,#1a1c1f\)/);
  assert.match(source, /requestBridge\("check_plugin_updates", \{ ids: \[plugin\.id\] \}\)/);
  assert.match(source, /pluginUpdateSummary/);
  assert.match(source, /pluginUpdateActionLabel/);
  assert.match(source, /managedPlugins\.filter\(\(plugin\) => plugin\.enabled\)/);
  assert.doesNotMatch(source, /pluginsCard\.innerHTML = ""/);
  assert.match(source, /pluginsCard\.replaceChildren\(\.\.\.renderedRows\)/);
  assert.match(source, /restart_codex/);
  assert.match(source, /color-background-primary/);
  assert.match(source, /p-panel/);
  assert.match(source, /max-w-3xl/);
  assert.match(source, /rounded-2xl/);
  assert.match(source, /px-4 gap-6 py-3/);
  assert.match(source, /mountedGroups/);
  assert.match(source, /get_app_status/);
  assert.match(source, /updateHeaderStack\.appendChild\(updateFeedback\)/);
  assert.match(source, /updateCard\.append\([^\n]*updateError\.row/);
  assert.match(source, /function showUpdateError/);
  assert.match(source, /let updateStatusError = null/);
  assert.doesNotMatch(source, /feedback\.textContent = labels\.updateError/);
  assert.match(source, /scheduleUpdateRefresh\(active \? 750 : 15000\)/);
  assert.doesNotMatch(source, /setInterval\([^\n]*refreshUpdateStatus/);
  assert.doesNotMatch(source, /location\.reload\s*\(/);
});
