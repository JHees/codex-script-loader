import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/settings-host.mjs", import.meta.url), "utf8");
// Exercise the actual private dialog/installation functions without a browser dependency.
const functions = source.slice(source.indexOf("    async function previewGitHubPlugin()"), source.indexOf("    async function refresh({ preserveFeedback"));

function harness(respond) {
  let document;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.events = {}; this.value = ""; this.isConnected = true; }
    setAttribute(name, value) { this[name] = value; }
    append(...items) { for (const item of items) this.appendChild(item); }
    appendChild(item) { this.children.push(item); item.parent = this; if (this.tag === "select" && !this.value) this.value = item.value; }
    addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
    emit(name, event = {}) { for (const fn of this.events[name] || []) fn({ preventDefault() {}, ...event }); }
    click() { this.emit("click"); }
    focus() { document.activeElement = this; }
    remove() { this.parent.children = this.parent.children.filter(item => item !== this); this.isConnected = false; }
    get lastElementChild() { return this.children.at(-1); }
  }
  document = { createElement: tag => new Element(tag), body: new Element("body"), activeElement: null };
  const calls = [];
  const context = vm.createContext({
    document, HTMLElement: Element, openDialogs: new Set(), disposed: false, busy: false,
    feedback: {}, labels: new Proxy({}, { get: (_, key) => key === "replaceNotice" || key === "bundledSkill" ? value => `${key}: ${value}` : key }),
    actionButton(label) { const button = new Element("button"); button.textContent = label; return button; },
    setBusy() {}, refresh: async () => {},
    async requestBridge(command, payload) { calls.push({ command, payload }); return respond(command, payload); },
  });
  vm.runInContext(functions + "\nglobalThis.start = addPlugin; globalThis.dialog = showDialog;", context);
  const all = (node = document.body) => [node, ...node.children.flatMap(all)];
  const button = label => { const item = all().find(node => node.tag === "button" && node.textContent === label); assert.ok(item, label); return item; };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { context, document, calls, all, button, flush };
}

test("GitHub UI pins multi-asset choice, discloses source and uses ordinary confirmation", async () => {
  const releaseUrl = "https://github.com/Example/plugin-repository/releases/tag/v1.0.0";
  const h = harness((command, payload) => {
    if (command === "preview_plugin_github") return payload.asset
      ? { releaseUrl, preview: { token: "pending", id: "local.example", name: "Example", version: "1.0.0", permissions: ["dom"], settingsMode: "none", sourceUrl: releaseUrl, archiveSha256: "a".repeat(64) } }
      : { releaseUrl, assets: ["first-1.0.0.zip", "second-1.0.0.zip"] };
    return {};
  });
  const pending = h.context.start("preview_plugin_github");
  assert.equal(h.document.activeElement.tag, "input");
  h.button("githubContinue").click();
  assert.equal(h.calls.length, 0, "empty URL stays in the dialog");
  h.document.activeElement.value = "https://github.com/Example/plugin-repository";
  h.document.activeElement.emit("keydown", { key: "Enter" });
  await h.flush();
  assert.equal(h.document.activeElement.tag, "select");
  h.document.activeElement.value = "second-1.0.0.zip";
  h.button("githubContinue").click();
  await h.flush();
  assert.equal(h.calls[1].payload.url, releaseUrl);
  assert.equal(h.calls[1].payload.asset, "second-1.0.0.zip");
  const disclosure = h.all().map(node => node.textContent || "").join("\n");
  assert.ok(disclosure.includes(releaseUrl));
  assert.ok(disclosure.includes("SHA-256: " + "a".repeat(64)));
  assert.equal(h.calls.some(call => call.command === "install_plugin"), false);
  h.button("installEnabled").click();
  await pending;
  assert.equal(h.calls.at(-1).command, "install_plugin");
  assert.equal(h.calls.at(-1).payload.enabled, true);
  assert.equal(h.context.openDialogs.size, 0);
});

test("closing Settings cancels a staged install instead of leaving an unresolved dialog", async () => {
  const h = harness(() => ({ preview: { token: "pending", id: "local.example", name: "Example", permissions: [], settingsMode: "none" } }));
  const pending = h.context.start("preview_plugin_github");
  h.document.activeElement.value = "https://github.com/Example/plugin-repository";
  h.button("githubContinue").click();
  await h.flush();
  h.context.disposed = true;
  for (const cancelDialog of h.context.openDialogs) cancelDialog();
  await pending;
  assert.equal(h.calls.at(-1).command, "cancel_plugin_install");
  assert.equal(h.context.openDialogs.size, 0);
  assert.equal(h.document.body.children.length, 0);
});
