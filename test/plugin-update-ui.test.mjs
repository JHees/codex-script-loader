import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/settings-host.mjs", import.meta.url), "utf8");
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function harness() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.events = {}; }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.append(item); }
    addEventListener(name, fn) { this.events[name] = fn; }
  }
  const dialogs = [], actions = [];
  const context = vm.createContext({
    document: { documentElement: { lang: "zh-CN" }, createElement: tag => new Element(tag) },
    busy: false, connected: true, disposed: false, pluginOperationIds: new Set(),
    actionButton(text) { const button = new Element("button"); button.textContent = text; return button; },
    formatTime: value => value || "—", showDialog: async spec => { dialogs.push(spec); return "cancel"; },
    runPluginAction: (plugin, action) => actions.push(action),
    renderPlugins() {}, schedulePluginUpdateRefresh() {}, refresh: async () => {},
    scheduleUpdateRefresh() {},
    requestBridge: async () => { throw new Error("Plugin update confirmation expired."); },
  });
  vm.runInContext([
    slice("  function loaderLabels()", "  function formatTime("),
    slice("  function pluginRepository(", "  function pluginAuthor("),
    slice("    function pluginUpdateIsActive(", "    function schedulePluginUpdateRefresh("),
    slice("    function pluginUpdatePanel(", "    function renderPlugins("),
    slice("    async function runPluginUpdateAction(", "    async function runPluginAction("),
    "const labels = loaderLabels();",
  ].join("\n"), context);
  return { context, dialogs, actions, render: plugin => context.pluginUpdatePanel(plugin) };
}
const plugin = (state, extra = {}) => ({ id: "local.example", name: "Example", version: "1.0.0", enabled: true, repository: "https://github.com/example/plugin", update: { supported: true, state, ...extra } });

test("manual plugin checks keep an up-to-date result visible after buttons are restored", async () => {
  const h = harness();
  let check;
  h.context.plugins = [plugin("upToDate")];
  h.context.checkingPluginUpdates = false;
  h.context.feedback = {textContent: ""};
  h.context.checkPluginUpdatesButton = {setAttribute() {}, addEventListener: (_, handler) => { check = handler; }};
  h.context.setBusy = (busy, message = "") => { h.context.busy = busy; h.context.feedback.textContent = message; };
  h.context.requestBridge = async () => [{state: "upToDate"}];
  vm.runInContext(slice('    checkPluginUpdatesButton.addEventListener("click",', '    addArchiveButton.addEventListener("click",'), h.context);
  await check();
  assert.match(h.context.feedback.textContent, /1/);
  assert.match(h.context.feedback.textContent, /最新|没有|无/);
  assert.equal(h.context.busy, false);
  h.context.requestBridge = async () => { throw Error("offline"); };
  await check();
  assert.equal(h.context.feedback.textContent, "offline");
  assert.equal(h.context.busy, false);
});

test("update controls show actionable states and keep quiet-state details available", () => {
  const h = harness();
  for (const state of ["idle", "upToDate", "checking", "available", "downloading", "verifying", "awaitingConfirmation", "waitingForEnable", "waitingForRenderer", "installing", "reloading", "succeeded", "rolledBack", "failed"]) {
    const view = h.render(plugin(state, { progress: .42, availableVersion: "1.1.0" }));
    assert.equal(view.summary.children[0].dataset.codexLoaderSettings, "plugin-update-status");
    assert.equal(view.summary.children.at(-1).href, "https://github.com/example/plugin/releases/latest");
    assert.match(view.progress.style.cssText, /height:3px/);
    assert.equal(view.action.style.minWidth, "112px");
    if (["checking", "downloading", "verifying", "installing", "reloading"].includes(state)) {
      assert.equal(view.progress.attributes["aria-hidden"], "false");
      assert.equal(view.progress.attributes["aria-valuenow"], "42");
    } else assert.equal(view.progress.attributes["aria-hidden"], "true");
    assert.equal(view.action.disabled, ["checking", "verifying", "installing", "reloading"].includes(state));
    assert.equal(view.summary.hidden, ["idle", "upToDate", "succeeded"].includes(state));
    assert.equal(view.action.hidden, view.summary.hidden);
    assert.equal(view.progress.hidden, view.progress.attributes["aria-hidden"] === "true");
    assert.equal(typeof view.openDetails, "function");
    assert.equal(view.releaseNotes, view.summary.children.at(-1));
  }
  h.render(plugin("downloading")).action.events.click();
  assert.equal(h.actions.at(-1), "cancel-update");
  const disabled = plugin("waitingForEnable"); disabled.enabled = false;
  assert.equal(h.render(disabled).action.disabled, true);
});

test("Loader update card keeps check results visible and exposes installer actions", async () => {
  const h = harness();
  for (const name of ["currentVersion", "updateChannel", "updateLastChecked", "availableVersion", "updateState", "updateError"]) {
    h.context[name] = {row: {}, value: {}};
  }
  for (const name of ["autoUpdateToggle", "autoUpdateKnob", "checkUpdateButton", "installUpdateButton", "cancelUpdateButton", "updateProgress", "updateHint", "releaseNotes", "manualDownload", "installerDownloadButton"]) {
    h.context[name] = {style: {}, setAttribute() {}};
  }
  vm.runInContext(slice("    function renderUpdateStatus()", "    async function refreshUpdateStatus("), h.context);
  h.context.updateStatus = {state: "idle", currentVersion: "1.0.0"};
  h.context.renderUpdateStatus();
  for (const name of ["availableVersion", "updateError"]) assert.equal(h.context[name].row.hidden, true);
  assert.equal(h.context.updateState.row.hidden, false);
  assert.equal(h.context.updateState.value.textContent, "尚未检查更新");
  h.context.updateStatus.lastCheckedAt = "now";
  h.context.renderUpdateStatus();
  assert.equal(h.context.updateState.value.textContent, "已是最新版本");
  assert.equal(h.context.installUpdateButton.hidden, true);
  h.context.updateStatus = {state: "available", currentVersion: "1.0.0", availableVersion: "1.1.0"};
  h.context.renderUpdateStatus();
  assert.equal(h.context.availableVersion.row.hidden, false);
  assert.equal(h.context.installUpdateButton.hidden, false);
  h.context.updateStatus.requiresInstaller = true;
  h.context.renderUpdateStatus();
  assert.equal(h.context.updateState.row.hidden, false);
  assert.equal(h.context.installUpdateButton.hidden, false);
  assert.equal(h.context.installUpdateButton.disabled, true, "older hosts offer manual download instead of an unsupported command");
  assert.match(h.context.updateHint.textContent, /手动|发布页/);
  h.context.updateStatus.installerUpdateSupported = true;
  h.context.renderUpdateStatus();
  assert.equal(h.context.installUpdateButton.disabled, false);
  assert.equal(h.context.installUpdateButton.textContent, "下载安装包");
  h.context.updateStatus.installerReady = true;
  h.context.renderUpdateStatus();
  assert.equal(h.context.installUpdateButton.textContent, "退出并安装");
  h.context.updateStatus = {state: "failed", error: "offline"};
  h.context.renderUpdateStatus();
  assert.equal(h.context.updateError.row.hidden, false);
  h.context.updateError.row.hidden = true;
  h.context.showUpdateError(new Error("offline"));
  assert.equal(h.context.updateError.row.hidden, false);

  let check;
  h.context.checkUpdateButton.addEventListener = (_, handler) => { check = handler; };
  vm.runInContext(slice('    checkUpdateButton.addEventListener("click",', '    async function downloadInstaller()'), h.context);
  let finish;
  h.context.requestBridge = () => new Promise(resolve => { finish = resolve; });
  const checking = check();
  assert.equal(h.context.checkUpdateButton.disabled, true);
  assert.equal(h.context.checkUpdateButton.textContent, "检查中…");
  finish({state: "idle", currentVersion: "1.0.0", lastCheckedAt: "just now"});
  await checking;
  assert.equal(h.context.updateState.value.textContent, "已是最新版本");
  assert.equal(h.context.checkUpdateButton.disabled, false);
  h.context.requestBridge = async () => { throw Error("offline"); };
  await check();
  assert.equal(h.context.checkUpdateButton.disabled, false, "failed checks can be retried");
  assert.equal(h.context.updateError.row.hidden, false);

  let install;
  h.context.installUpdateButton.addEventListener = (_, handler) => { install = handler; };
  vm.runInContext(slice('    installUpdateButton.addEventListener("click",', '    cancelUpdateButton.addEventListener("click",'), h.context);
  const calls = [];
  h.context.updateStatus = {state: "available", availableVersion: "1.1.0", requiresInstaller: true, installerReady: true, installerUpdateSupported: true};
  h.context.requestBridge = async (...args) => { calls.push(args); };
  await install();
  assert.equal(calls.length, 0, "cancel never shuts down Codex");
  h.context.showDialog = async () => "install";
  await install();
  assert.equal(calls[0][0], "install_prepared_update");
  assert.equal(calls[0][1].version, "1.1.0");
  assert.equal(calls[0][1].confirmed, true);
});

test("release notes use the checked release; unsafe and missing sources stay disabled", () => {
  const h = harness();
  const releaseUrl = "https://github.com/example/plugin/releases/tag/v1.1.0";
  const notes = h.render(plugin("available", { releaseUrl })).summary.children.at(-1);
  assert.equal(notes.href, releaseUrl);
  assert.equal(notes.rel, "noopener noreferrer");
  const unknown = plugin("idle", { releaseUrl: "javascript:alert(1)" }); unknown.repository = null;
  const disabled = h.render(unknown).summary.children.at(-1);
  assert.equal(disabled.href, undefined);
  assert.equal(disabled.attributes["aria-disabled"], "true");
});

test("a failed update keeps its actual error in requested details without page-header feedback", async () => {
  const h = harness(), candidate = plugin("available");
  await h.context.runPluginUpdateAction(candidate, "update");
  assert.equal(candidate.update.state, "failed");
  assert.equal(candidate.update.error, "Plugin update confirmation expired.");
  assert.equal(h.context.pluginOperationIds.size, 0);
  const view = h.render(candidate);
  assert.equal(h.dialogs.length, 0);
  await view.summary.children[0].events.click();
  assert.match(h.dialogs[0].body, /Plugin update confirmation expired\./);
  assert.doesNotMatch(view.summary.children[0].children.at(-1).textContent, /GitHub/);
});
