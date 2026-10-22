import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/settings-host.mjs", import.meta.url), "utf8");
const factory = source.slice(source.indexOf("  function accountModuleSection()"), source.indexOf("  function renderLoaderPage("));
const settle = () => new Promise(resolve => setImmediate(resolve));

test("the account page is visible without a plugin record and disappears on unregister", () => {
  const start = source.indexOf("  function pluginEntries()");
  const end = source.indexOf("\n  function ", start + 10);
  const pages = new Map([["loader:accounts", { id: "loader:accounts", ownerId: "loader", title: "账号管理" }],
    ["disabled:page", { id: "disabled:page", ownerId: "disabled", title: "Disabled" }]]);
  const context = vm.createContext({ pages, sections: new Map(), managedPlugins: [] });
  vm.runInContext(source.slice(start, end), context);
  assert.deepEqual(Array.from(context.pluginEntries(), entry => entry.id), ["loader:accounts"]);
  pages.delete("loader:accounts");
  assert.equal(context.pluginEntries().length, 0);
});

function fixture() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.events = {}; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.append(item); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, fn) { this.events[key] = fn; }
  }
  let status = { enabled: false, state: "stopped", needsRestart: false };
  let blocked = false, supported = true;
  const calls = [];
  const context = vm.createContext({
    document: { documentElement: { lang: "zh-CN" }, createElement: tag => new Element(tag) },
    settingsSection: () => new Element("section"), settingsCard: () => new Element("card"),
    valueRow: () => { const row = new Element("row"), value = new Element("value"); row.append(value); return { row, value }; },
    setInterval, clearInterval,
    requestBridge: async (command, payload) => {
      calls.push({ command, payload });
      if (!supported) throw Error("Unknown command");
      if (command === "set_accounts_enabled") {
        if (blocked) throw Error("ACCOUNT_MODULE_BUSY");
        status = { enabled: payload.enabled, state: payload.enabled ? "running" : "stopped", needsRestart: payload.enabled };
      }
      return status;
    },
  });
  vm.runInContext(factory, context);
  const view = context.accountModuleSection();
  const card = view.element.children[0], toggle = card.children[0].children[0].children[0], feedback = card.children[1];
  return { view, toggle, feedback, calls, block: value => { blocked = value; }, support: value => { supported = value; } };
}

test("the built-in account switch defaults off, persists the requested state and shows startup guidance", async () => {
  const f = fixture(); await settle();
  try {
    assert.equal(f.toggle.attributes["aria-checked"], "false");
    assert.equal(f.toggle.disabled, false);
    await f.toggle.events.click();
    assert.equal(f.toggle.attributes["aria-checked"], "true");
    assert.match(f.feedback.textContent, /下次启动 Codex/);
    await f.toggle.events.click();
    assert.equal(f.toggle.attributes["aria-checked"], "false");
    assert.match(f.feedback.textContent, /不会显示账号设置页/);
    assert.deepEqual(f.calls.filter(call => call.command === "set_accounts_enabled").map(call => call.payload.enabled), [true, false]);
  } finally { f.view.stop(); }
});

test("a busy module stays enabled when shutdown is refused", async () => {
  const f = fixture(); await settle();
  try {
    await f.toggle.events.click(); f.block(true);
    await f.toggle.events.click();
    assert.equal(f.toggle.attributes["aria-checked"], "true");
    assert.equal(f.toggle.disabled, false);
    assert.match(f.feedback.textContent, /仍有聊天/);
  } finally { f.view.stop(); }
});

test("an older host cannot pretend to enable the built-in module", async () => {
  const f = fixture(); f.support(false); await settle();
  try {
    // A fresh mount observes the unsupported host on its first status request.
    f.block(true);
    await f.toggle.events.click();
    assert.equal(f.toggle.disabled, true);
    assert.equal(f.toggle.attributes["aria-checked"], "false");
  } finally { f.view.stop(); }
});
