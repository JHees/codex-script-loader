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

test("update controls keep a badge, release notes entry and progress slot across states", () => {
  const h = harness();
  for (const state of ["idle", "checking", "available", "downloading", "verifying", "awaitingConfirmation", "waitingForEnable", "waitingForRenderer", "installing", "reloading", "succeeded", "rolledBack", "failed"]) {
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
  }
  h.render(plugin("downloading")).action.events.click();
  assert.equal(h.actions.at(-1), "cancel-update");
  const disabled = plugin("waitingForEnable"); disabled.enabled = false;
  assert.equal(h.render(disabled).action.disabled, true);
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
