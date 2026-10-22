import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/accounts-ui.js", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.events = new Map(); this.attributes = {}; this.style = {}; this.offsetHeight = 400; }
  append(...children) { for (const child of children) { this.children.push(child); if (typeof child === "object") child.parent = child.parentElement = this; } }
  insertBefore(child, anchor) { child.remove(); const index = this.children.indexOf(anchor); if (index < 0) this.append(child); else { this.children.splice(index, 0, child); child.parent = child.parentElement = this; } }
  replaceChildren(...children) { for (const child of this.children) if (typeof child === "object") child.parent = child.parentElement = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.events.set(key, fn); }
  getBoundingClientRect() { return { right: 52, top: 500, width: 36, height: 36 }; }
  querySelector() { return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => typeof child === "object" ? [...(selector === "button" && child.tagName === "button" ? [child] : []), ...child.querySelectorAll(selector)] : []); }
  get isConnected() { return this.connected === true || this.parent?.isConnected === true; }
  focus() { this.focused = true; }
  click() { this.events.get("click")?.(); }
  togglePopover() { this.open = !this.open; this.events.get("toggle")?.({ newState: this.open ? "open" : "closed" }); }
  hidePopover() { this.open = false; this.events.get("toggle")?.({ newState: "closed" }); }
}

function harness(backend = true) {
  const head = new Element("head"), body = new Element("body"), rail = new Element("nav"), pages = [], calls = [];
  head.connected = body.connected = true; body.append(rail);
  let removedPages = 0, opened = 0, selected = "primary", disconnected = 0, observe;
  const data = [{ id: "a".repeat(32), name: "Fixture relay", kind: "relay", status: "ready",
    baseUrl: "https://example.invalid/v1", model: "fixture-model", lastCheckedAt: null }];
  const api = { version: "0.6.0-alpha",
    settings: { registerPage(page) { pages.push(page); return { open: async () => { opened++; }, unregister: () => { removedPages++; } }; } },
  };
  if (backend) api.backend = {
    status: async () => ({ state: "running" }),
    invoke: async (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === "set_default") selected = payload.accountId;
      return { ok: true, data: operation === "status" ? { routingAvailable: false, operations: [] } :
        operation === "list_accounts" ? { accounts: data, defaultAccountId: selected } :
        operation === "list_imports" ? { accounts: [{ id: "source", name: "Fixture source", baseUrl: "https://example.invalid", model: "fixture-model" }] } :
        { saved: true } };
    },
  };
  Object.defineProperty(api, "storage", { get() { throw new Error("Account UI must not use browser storage"); } });
  Object.defineProperty(api, "composer", { get() { throw new Error("Global account UI must not register a composer accessory"); } });
  const context = vm.createContext({
    api, innerWidth: 1200, innerHeight: 800,
    document: { head, body, documentElement: body, createElement: tag => new Element(tag), querySelectorAll: () => [rail] },
    MutationObserver: class { constructor(callback) { observe = callback; } observe() {} disconnect() { disconnected++; } },
    setTimeout, clearTimeout, setInterval, clearInterval, URL,
    window: { addEventListener() {}, removeEventListener() {}, open() { throw new Error("Unexpected browser launch"); } },
  });
  return { context, head, body, rail, pages, calls, api, data, remount: () => observe(),
    counts: () => ({ removedPages, opened, disconnected }) };
}
function find(root, text) {
  if (root.textContent === text) return root;
  for (const child of root.children || []) { const result = typeof child === "object" && find(child, text); if (result) return result; }
  return null;
}

test("the built-in module mounts its settings page, reports routing honestly, and cleans up on reload", async () => {
  const h = harness();
  vm.runInContext(source, h.context); await settle();
  const first = h.context.__codexLoaderAccounts;
  assert.equal(first.version, "0.6.0-alpha");
  assert.equal(first.getStatus().connected, true);
  assert.equal(first.getStatus().routingAvailable, false);
  const root = new Element("root");
  const unmount = h.pages[0].render(root);
  assert.ok(find(root, "重启一次，接入账号路由"));
  assert.ok(find(root, "Fixture relay"));
  assert.equal(h.head.children.length, 1);
  vm.runInContext(source, h.context); await settle();
  assert.notEqual(h.context.__codexLoaderAccounts.instanceId, first.instanceId);
  assert.equal(h.head.children.length, 1);
  first.stop();
  assert.equal(h.counts().removedPages, 1);
  unmount();
  h.context.__codexLoaderAccounts.stop();
  assert.equal(h.head.children.length, 0);
  assert.equal(h.counts().removedPages, 2);
  assert.equal(h.counts().disconnected, 2);
  assert.equal(h.rail.children.length, 0);
});

test("an unavailable backend leaves the account page disconnected with recovery guidance", async () => {
  const h = harness(false);
  vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  assert.equal(h.context.__codexLoaderAccounts.getStatus().connected, false);
  assert.equal(find(root, "添加订阅账号").disabled, true);
  assert.ok(find(root, "请在 Loader 设置中检查账号模块状态，然后重新连接。"));
  h.context.__codexLoaderAccounts.stop();
});

test("protocol 2 carries new commands through the existing host status operation", async () => {
  const h = harness();
  const invoke = h.api.backend.invoke;
  h.api.backend.invoke = async (operation, payload) => {
    assert.equal(operation, "status");
    if (!payload.accountCommand) return { ok: true, data: { accountCommandProtocol: 2, operations: [] } };
    assert.equal(payload.accountCommand.protocol, 2);
    return invoke(payload.accountCommand.operation, payload.accountCommand.payload);
  };
  vm.runInContext(source, h.context); await settle();
  assert.ok(h.calls.some(call => call.operation === "list_accounts"));
  const root = new Element("root"); h.pages[0].render(root);
  assert.ok(find(root, "Fixture relay"));
  h.context.__codexLoaderAccounts.stop();
});

test("the sidebar opens a quota and login menu, selects globally and opens management without a composer control", async () => {
  const h = harness(); vm.runInContext(source, h.context); await settle();
  const trigger = h.rail.children[0].children[0];
  assert.equal(trigger.attributes["aria-label"], "切换全局账号");
  trigger.click(); await settle();
  const panel = h.body.children.find(node => node.id === "codex-loader-account-picker");
  assert.equal(trigger.attributes["aria-expanded"], "true");
  assert.ok(find(panel, "已保存接入 · 待验证"));
  assert.ok(find(panel, "余额暂不可查询"));
  const row = panel.children[2].children[1]; row.click(); await settle();
  assert.equal(h.calls.filter(call => call.operation === "set_default").at(-1).payload.accountId, "a".repeat(32));
  assert.equal(h.calls.some(call => call.operation === "switch_thread"), false);
  find(panel, "管理账号").click(); await settle();
  assert.equal(h.counts().opened, 1);
  assert.equal(trigger.attributes["aria-expanded"], "false");
  h.remount(); assert.equal(h.rail.children.length, 1);
  h.context.__codexLoaderAccounts.stop();
  assert.equal(h.rail.children.length, 0);
  assert.equal(h.body.children.some(node => node.id === "codex-loader-account-picker"), false);
});

test("import form exposes endpoint metadata without a credential field", async () => {
  const h = harness();
  vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  find(root, "导入账号").click(); await settle();
  assert.ok(find(root, "接口基础地址"));
  assert.ok(find(root, "导入所选配置"));
  assert.equal(find(root, "API Key"), null);
  h.context.__codexLoaderAccounts.stop();
});

test("late connection replies cannot revive a stopped plugin", async () => {
  const h = harness();
  let resolveStatus;
  h.api.backend.status = () => new Promise(resolve => { resolveStatus = resolve; });
  vm.runInContext(source, h.context);
  h.context.__codexLoaderAccounts.stop();
  resolveStatus({ state: "running" }); await settle();
  assert.equal(h.context.__codexLoaderAccounts, undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.head.children.length, 0);
});

test("a partial registration failure cleans up the page and style before reporting failure", () => {
  const h = harness();
  h.context.MutationObserver = class { observe() { throw new Error("fixture registration failure"); } disconnect() {} };
  assert.throws(() => vm.runInContext(source, h.context), /fixture registration failure/);
  assert.equal(h.head.children.length, 0);
  assert.equal(h.counts().removedPages, 1);
  assert.equal(h.context.__codexLoaderAccounts, undefined);
  assert.equal(h.calls.length, 0);
});

test("compact account cards show quota and credits without treating unknown usage as zero", async () => {
  const h = harness();
  h.data.push({ id: "b".repeat(32), name: "Subscription fixture", kind: "chatgpt", status: "ready", email: "fixture@example.invalid",
    usage: [{ usedPercent: 112, windowDurationMins: 300 }, { usedPercent: null, windowDurationMins: 10080 }],
    credits: { hasCredits: true, unlimited: false, balance: "12.5" } });
  vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  assert.ok(find(root, "余额 12.5 Credits · 5 小时剩余 0% · 每周待刷新"));
  assert.ok(find(root, "3 个账号"));
  const search = root.children[0].children.find(child => child.className === "as-list-header").children[1];
  search.value = "subscription";
  search.events.get("input")();
  assert.ok(find(root, "Subscription fixture"));
  assert.equal(find(root, "Fixture relay"), null);
  h.context.__codexLoaderAccounts.stop();
});

test("relay balances show their currency instead of a Credits label", async () => {
  const h = harness();
  Object.assign(h.data[0], { credits: { hasCredits: true, unlimited: false, balance: "17.38 USD" } });
  vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  assert.ok(find(root, "余额 17.38 USD"));
  assert.equal(find(root, "余额 17.38 USD Credits"), null);
  h.rail.children[0].children[0].click(); await settle();
  assert.ok(find(h.body, "17.38 USD"));
  assert.ok(find(h.body, "余额"));
  h.context.__codexLoaderAccounts.stop();
});

test("global selection reports busy conversations without claiming the switch already finished", async () => {
  const h = harness(); const invoke = h.api.backend.invoke;
  h.api.backend.invoke = async (operation, payload) => {
    const result = await invoke(operation, payload);
    if (operation === "list_accounts") Object.assign(result.data, { routingAvailable: true, globalAccount: { pendingThreads: 2, busyThreads: 1, failedThreads: 0 } });
    return result;
  };
  vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  assert.ok(find(root, "1 个聊天正在运行，将在本轮结束后切换"));
  h.rail.children[0].children[0].click(); await settle();
  assert.ok(find(h.body, "1 个聊天正在运行，将在本轮结束后切换"));
  h.context.__codexLoaderAccounts.stop();
});

function input(root, label) { return find(root, label).parentElement.children[1]; }

test("model form saves native Responses settings and clears credentials when changing service", async () => {
  const h = harness(); vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  find(root, "添加模型接入").click(); await settle();
  assert.equal(input(root, "模型 ID").value, "deepseek-flash");
  const key = input(root, "API Key"); assert.equal(key.type, "password");
  key.value = "fixture-key"; assert.equal(key.maxLength, 8192);
  const provider = input(root, "服务"); provider.value = "openrouter"; provider.events.get("change")();
  assert.equal(key.value, "");
  assert.equal(input(root, "接口基础地址").value, "https://openrouter.ai/api/v1");
  assert.equal(input(root, "上下文长度（tokens）").value, "");
  find(root, "保存模型接入").click(); await settle();
  assert.equal(h.calls.some(call => call.operation === "create_provider"), false);
  input(root, "模型 ID").value = "vendor/fixture-model"; input(root, "上下文长度（tokens）").value = "64000";
  key.value = "fixture-new-key";
  find(root, "保存模型接入").click(); await settle();
  const saved = h.calls.find(call => call.operation === "create_provider").payload;
  assert.equal(saved.settings.provider, "openrouter");
  assert.equal(saved.settings.model, "vendor/fixture-model");
  assert.equal(saved.settings.contextWindow, 64000);
  assert.equal(saved.settings.reasoningEffort, null);
  assert.equal(saved.apiKey, "fixture-new-key");
  assert.equal(key.value, "");
  assert.equal(find(root, "API Key"), null);
  h.context.__codexLoaderAccounts.stop();
});

test("configuration history restores a chosen version without reading credentials", async () => {
  const h = harness(); Object.assign(h.data[0], { configurationGroup: "c".repeat(32), configurationVersion: 2, provider: "custom" });
  const invoke = h.api.backend.invoke;
  h.api.backend.invoke = async (operation, payload) => {
    const result = await invoke(operation, payload);
    if (operation === "get_provider_configuration") result.data = {
      activeVersion: 2, settings: { provider: "custom", baseUrl: "https://example.invalid/v1", model: "fixture-model",
        contextWindow: 64000, reasoningEffort: null, supportsImages: false, toolFormat: "function", parallelToolCalls: false },
      versions: [1, 2].map(version => ({ version, model: "fixture-model", createdAt: "2026-10-21T00:00:00Z" })),
    };
    return result;
  };
  vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  assert.ok(find(root, "配置 v2"));
  find(root, "编辑配置").click(); await settle();
  assert.equal(input(root, "API Key（留空保留，换网站需重填）").value, "");
  input(root, "配置历史").value = "1";
  find(root, "恢复此版本").click(); await settle();
  const restored = h.calls.find(call => call.operation === "activate_provider_version").payload;
  assert.equal(restored.accountId, h.data[0].id);
  assert.equal(restored.version, 1);
  assert.equal(find(root, "配置历史"), null);
  h.context.__codexLoaderAccounts.stop();
});

test("imported relays expose editing without a configuration group and save a revision", async () => {
  const h = harness(); const invoke = h.api.backend.invoke;
  h.api.backend.invoke = async (operation, payload) => {
    const result = await invoke(operation, payload);
    if (operation === "get_provider_configuration") result.data = { legacy: true, activeVersion: 0, versions: [],
      settings: { provider: "custom", baseUrl: "https://example.invalid/v1", model: "fixture-model", contextWindow: 0, toolFormat: "function" } };
    return result;
  };
  vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  find(root, "编辑配置").click(); await settle();
  assert.equal(input(root, "接口基础地址").value, "https://example.invalid/v1");
  assert.equal(input(root, "API Key（留空保留，换网站需重填）").value, "");
  find(root, "保存为新版本").click(); await settle();
  const saved = h.calls.find(call => call.operation === "save_provider_configuration").payload;
  assert.equal(saved.accountId, h.data[0].id);
  assert.equal(saved.apiKey, "");
  assert.equal(saved.settings.useDefaultModelMetadata, true);
  assert.equal(saved.settings.contextWindow, 0);
  h.context.__codexLoaderAccounts.stop();
});

test("DeepSeek presets configure Pro and discovered names resolve to actual API IDs", async () => {
  const h = harness(); const invoke = h.api.backend.invoke; let poll;
  h.context.setTimeout = callback => { poll = callback; return 1; };
  h.api.backend.invoke = async (operation, payload) => {
    const result = await invoke(operation, payload);
    if (operation === "begin_provider_models") result.data = { id: "model-query", kind: "models", state: "running" };
    if (operation === "operation_status") result.data = { id: "model-query", kind: "models", state: "completed", models: [
      { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1048576, supportsImages: true, defaultReasoningEffort: "high", toolFormat: "freeform", parallelToolCalls: true },
    ] };
    return result;
  };
  vm.runInContext(source, h.context); await settle();
  const root = new Element("root"); h.pages[0].render(root);
  find(root, "添加模型接入").click(); await settle();
  const picker = input(root, "模型"); picker.value = "deepseek-v4-pro"; picker.events.get("change")();
  assert.equal(input(root, "模型 ID").value, "deepseek-v4-pro");
  assert.equal(input(root, "支持图片输入").checked, false);
  input(root, "模型 ID").value = "DeepSeek-V4.1-Flash";
  find(root, "获取模型并自动配置").click(); await settle(); await poll();
  assert.equal(input(root, "模型 ID").value, "deepseek-flash");
  assert.equal(input(root, "上下文长度（tokens）").value, "1048576");
  assert.equal(input(root, "支持图片输入").checked, true);
  assert.equal(input(root, "推理强度").value, "high");
  h.context.__codexLoaderAccounts.stop();
});
