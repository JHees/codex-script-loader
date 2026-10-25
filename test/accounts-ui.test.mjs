import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/accounts-ui.js", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
async function flush(count = 3) { for (let index = 0; index < count; index += 1) await settle(); }
const plain = value => JSON.parse(JSON.stringify(value));
const activeHarnesses = [];
afterEach(() => {
  for (const h of activeHarnesses.splice(0)) {
    try { h.context.__codexLoaderAccounts?.stop(); } catch { /* already stopped */ }
  }
});

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.textContent = "";
    this.dataset = {};
    this.events = new Map();
    this.attributes = {};
    this.style = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.offsetHeight = 400;
    this.parent = null;
    this.parentElement = null;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
    };
  }
  setPointerCapture() {}
  cloneNode() {
    const clone = new Element(this.tagName);
    clone.className = this.className;
    clone.dataset = { ...this.dataset };
    clone.attributes = { ...this.attributes };
    for (const child of this.children) if (typeof child === "object") clone.append(child.cloneNode());
    return clone;
  }
  append(...children) {
    for (const child of children) {
      if (typeof child !== "object" || child === null) { this.textContent += String(child); continue; }
      if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
      this.children.push(child);
      child.parent = child.parentElement = this;
    }
  }
  insertBefore(child, anchor) {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
    const index = this.children.indexOf(anchor);
    if (index < 0) this.append(child);
    else { this.children.splice(index, 0, child); child.parent = child.parentElement = this; }
  }
  replaceChildren(...children) {
    for (const child of this.children) if (typeof child === "object") child.parent = child.parentElement = null;
    this.children = [];
    this.textContent = "";
    this.append(...children);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = this.parentElement = null;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.events.set(key, handler); }
  getBoundingClientRect() { return { right: 52, top: 500, width: 36, height: 36 }; }
  querySelector() { return null; }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (typeof child !== "object") continue;
        if (selector === "button" && child.tagName === "button") found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  get isConnected() { return this.connected === true || this.parent?.isConnected === true; }
  focus() { this.focused = true; }
  click() { if (this.disabled) return; this.events.get("click")?.({ preventDefault() {} }); }
  togglePopover() { this.open = !this.open; this.events.get("toggle")?.({ newState: this.open ? "open" : "closed" }); }
  hidePopover() { this.open = false; this.events.get("toggle")?.({ newState: "closed" }); }
}

const ACCOUNTS = [
  { id: "relay-1", name: "中转 A", kind: "relay", status: "ready", provider: "custom",
    baseUrl: "https://relay.invalid/v1", model: "fixture-model", configurationVersion: 2,
    lastCheckedAt: "2026-10-22T00:00:00Z", usage: [{ usedPercent: 20, windowDurationMins: 300 }] },
  { id: "relay-2", name: "中转 B", kind: "relay", status: "disabled", provider: "custom",
    baseUrl: "https://relay-b.invalid/v1", model: "other-model", lastCheckedAt: null },
  { id: "sub-1", name: "订阅 B", kind: "chatgpt", status: "ready", email: "b@example.invalid",
    plan: "Plus", lastCheckedAt: "2026-10-22T00:00:00Z", credits: { hasCredits: true, unlimited: false, balance: "12.5" } },
];
const THREADS = [
  { id: "thread-1", title: "修复登录流程", accountId: "sub-1", accountName: "订阅 B", model: "gpt-5", modelName: "GPT-5", pinned: true, busy: false },
  { id: "thread-2", title: "生成发布说明", accountId: "sub-1", accountName: "订阅 B", model: "gpt-5", modelName: "GPT-5", pinned: false, busy: true },
  { id: "thread-3", title: "整理测试", accountId: "relay-1", accountName: "中转 A", model: "fixture-model", modelName: "Fixture Model", pinned: false, busy: false },
];
const FETCHED_MODELS = [
  { id: "model-a", name: "Model A", contextWindow: 64000, reasoningLevels: ["low", "high"], defaultReasoningEffort: "high",
    supportsImages: true, supportsTools: true, toolFormat: "function", parallelToolCalls: true },
  { id: "model-b", name: "Model B", contextWindow: 32000, reasoningLevels: ["low"], defaultReasoningEffort: "low",
    supportsImages: false, supportsTools: true, toolFormat: "dependency", parallelToolCalls: false },
];

function providerConfiguration(overrides = {}) {
  return {
    activeVersion: 2,
    settings: {
      provider: "custom", baseUrl: "https://relay.invalid/v1", model: "fixture-model", contextWindow: 128000,
      reasoningEffort: "high", supportsImages: true, toolFormat: "function", parallelToolCalls: true,
      useDefaultModelMetadata: false,
      models: [{ id: "fixture-model", name: "Fixture Model", contextWindow: 128000, reasoningLevels: ["low", "high"],
        defaultReasoningEffort: "high", supportsImages: true, supportsTools: true, toolFormat: "function", parallelToolCalls: true, enabled: true }],
      usage: { mode: "auto", url: "", remainingPath: "", unitPath: "", limitPath: "", usedPath: "", validPath: "" },
      ...overrides.settings,
    },
    versions: overrides.versions || [
      { version: 1, model: "fixture-model", createdAt: "2026-10-20T00:00:00Z" },
      { version: 2, model: "fixture-model", createdAt: "2026-10-21T00:00:00Z" },
    ],
    ...overrides,
  };
}

function harness(options = {}) {
  const head = new Element("head"), body = new Element("body"), rail = new Element("nav"), pages = [];
  head.connected = body.connected = rail.connected = true;
  body.append(rail);
  let removedPages = 0, opened = 0, disconnected = 0, observe;
  const calls = [], raw = [];
  const state = {
    accounts: options.accounts || ACCOUNTS,
    defaultAccountId: "relay-1",
    preferences: { newChatAccountPolicy: options.policy || "default" },
    threads: THREADS,
    config: options.config,
  };
  const overrides = options.override || {};
  const handlers = {
    status: () => ({ accountCommandProtocol: 2, routingAvailable: true, operations: [] }),
    list_accounts: () => ({
      accounts: state.accounts, defaultAccountId: state.defaultAccountId, routingAvailable: true,
      preferences: state.preferences, boundThreads: {},
      globalAccount: { pendingThreads: 0, busyThreads: 0, failedThreads: 0, pinnedThreads: 1 },
      primaryAccount: { id: "primary", name: "桌面主账号", kind: "chatgpt", status: "ready" },
    }),
    list_threads: () => ({ threads: state.threads }),
    list_imports: () => ({ accounts: [{ id: "source-1", name: "来源接入", kind: "relay", baseUrl: "https://source.invalid/v1",
      defaultModel: "source-model", models: ["source-model", "source-alt"] }] }),
    get_provider_configuration: () => state.config || providerConfiguration(),
    begin_provider_models: () => ({ id: "op-models", kind: "models", state: "running" }),
    operation_status: payload => ({ id: payload.operationId, kind: "models", state: "completed", models: FETCHED_MODELS }),
    begin_login: () => ({ id: "op-login", kind: "login", state: "running" }),
    begin_probe: () => ({ id: "op-probe", kind: "probe", state: "running" }),
    refresh_accounts: () => ({ id: "op-refresh", kind: "usage", state: "running" }),
    switch_thread: () => ({ id: "op-switch", kind: "switch", state: "running" }),
    set_default: payload => { state.defaultAccountId = payload.accountId; return { saved: true }; },
    set_new_chat_policy: payload => { state.preferences.newChatAccountPolicy = payload.policy; return { saved: true }; },
    test_usage: () => ({ credits: { hasCredits: true, unlimited: false, balance: "9.5" }, errorCode: null }),
    batch_accounts: payload => ({
      results: payload.accountIds.map((accountId, index) => index === 1
        ? { accountId, ok: false, errorCode: "ACCOUNT_BUSY" }
        : { accountId, ok: true }),
    }),
  };
  const api = {
    version: "0.6.0-alpha",
    settings: {
      registerPage(page) {
        pages.push(page);
        return { open: async () => { opened += 1; }, unregister: () => { removedPages += 1; } };
      },
    },
  };
  async function dispatch(operation, payload) {
    calls.push({ operation, payload });
    if (overrides[operation]) {
      const result = overrides[operation](payload);
      if (result && typeof result === "object" && "ok" in result) return result;
      return { ok: true, data: result };
    }
    const data = handlers[operation] ? handlers[operation](payload) : { saved: true };
    return { ok: true, data };
  }
  if (options.backend !== false) {
    api.backend = {
      status: async () => ({ state: "running" }),
      invoke: async (operation, payload = {}) => {
        raw.push({ operation, payload });
        if (operation === "status" && payload.accountCommand)
          return dispatch(payload.accountCommand.operation, payload.accountCommand.payload || {});
        return dispatch(operation, payload);
      },
    };
  }
  Object.defineProperty(api, "storage", { get() { throw new Error("Account UI must not use browser storage"); } });
  Object.defineProperty(api, "composer", { get() { throw new Error("Account UI must not register a composer accessory"); } });
  const windowEvents = new Map();
  const window = {
    addEventListener(type, handler) { const list = windowEvents.get(type) || []; list.push(handler); windowEvents.set(type, list); },
    removeEventListener(type, handler) { windowEvents.set(type, (windowEvents.get(type) || []).filter(item => item !== handler)); },
    open() { throw new Error("Unexpected browser launch"); },
  };
  const context = vm.createContext({
    api, innerWidth: 1200, innerHeight: 800,
    document: { head, body, documentElement: body, createElement: tag => new Element(tag), querySelectorAll: () => [rail] },
    MutationObserver: class { constructor(callback) { observe = callback; } observe() {} disconnect() { disconnected += 1; } },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, console,
    window,
  });
  return {
    context, head, body, rail, pages, calls, raw, api, state, overrides, remount: () => observe(),
    dispatchWindow: (type, event) => { for (const handler of windowEvents.get(type) || []) handler(event); },
    counts: () => ({ removedPages, opened, disconnected }),
  };
}

async function mount(h) {
  activeHarnesses.push(h);
  vm.runInContext(source, h.context);
  await flush(2);
  const root = new Element("root");
  const unmount = h.pages[0].render(root);
  await flush(2);
  return { root, unmount };
}
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) if (typeof child === "object") walk(child, visit);
}
function byData(root, key, value) {
  let found = null;
  walk(root, node => { if (!found && node.dataset && node.dataset[key] === value) found = node; });
  return found;
}
function allByData(root, key, value) {
  const found = [];
  walk(root, node => { if (node.dataset && node.dataset[key] === value) found.push(node); });
  return found;
}
function findByText(root, content) {
  let found = null;
  walk(root, node => { if (!found && node.textContent === content) found = node; });
  return found;
}
function fieldOf(scope, name) { return byData(scope, "field", name); }
function change(node) { node.events.get("change")?.({}); }
function lastCall(h, operation) { return h.calls.filter(call => call.operation === operation).at(-1); }

test("page mounts its tabs, renders accounts, and instance replacement cleans up", async () => {
  const h = harness();
  const { root, unmount } = await mount(h);
  assert.equal(h.pages[0].id, "accounts");
  assert.equal(h.pages[0].title, "账号管理");
  assert.equal(h.pages[0].description, "本地账号与中转接入");
  assert.equal(h.context.__codexLoaderAccounts.version, "0.6.0-alpha");
  assert.equal(h.context.__codexLoaderAccounts.getStatus().connected, true);
  assert.ok(byData(root, "tab", "accounts"));
  assert.ok(byData(root, "tab", "chat"));
  assert.equal(h.head.children.length, 1);
  assert.ok(findByText(root, "中转 A"));
  const first = h.context.__codexLoaderAccounts;
  vm.runInContext(source, h.context); await flush(2);
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

test("account data refreshes only on user-driven events", () => {
  assert.doesNotMatch(source, /refreshTimer\s*=\s*setInterval/);
});

test("account rows expose edit and set-default actions without switching chats", async () => {
  const h = harness();
  const { root } = await mount(h);
  const row = byData(root, "accountId", "sub-1");
  const defaultButton = byData(row, "action", "default");
  assert.equal(defaultButton.textContent, "设为默认");
  defaultButton.click(); await flush();
  assert.equal(lastCall(h, "set_default").payload.accountId, "sub-1");
  assert.equal(h.calls.some(call => call.operation === "switch_thread"), false);
  assert.ok(findByText(root, "新聊天将使用「订阅 B」。"));
  const relayRow = byData(root, "accountId", "relay-1");
  byData(relayRow, "action", "edit").click(); await flush();
  assert.ok(byData(root, "accountEditor", ""));
  assert.equal(fieldOf(root, "name").value, "中转 A");
  assert.equal(fieldOf(root, "baseUrl").value, "https://relay.invalid/v1");
  assert.equal(fieldOf(root, "contextWindow").value, "128000");
  byData(root, "action", "editor-back").click(); await flush();
  assert.equal(byData(root, "accountEditor", ""), null);
  byData(byData(root, "accountId", "relay-1"), "action", "edit").click(); await flush();
  assert.equal(fieldOf(root, "version").value, "2");
  fieldOf(root, "version").value = "1";
  byData(root, "action", "restore-version").click(); await flush();
  assert.equal(lastCall(h, "activate_provider_version").payload.version, 1);
  assert.equal(byData(root, "accountEditor", ""), null);
  h.context.__codexLoaderAccounts.stop();
});

test("editor shows every field, keeps legacy effort enabled, and saves an explicit default-metadata flag", async () => {
  const h = harness({ config: providerConfiguration({
    versions: [],
    settings: { provider: "custom", baseUrl: "https://relay.invalid/v1", model: "legacy-model", contextWindow: 0,
      reasoningEffort: "medium", supportsImages: false, toolFormat: "function", parallelToolCalls: false,
      useDefaultModelMetadata: true, models: [], usage: { mode: "auto" } },
  }) });
  const { root } = await mount(h);
  byData(byData(root, "accountId", "relay-1"), "action", "edit").click(); await flush();
  for (const name of ["name", "apiKey", "provider", "baseUrl", "model", "contextWindow", "reasoningEffort",
    "supportsImages", "toolFormat", "parallelToolCalls", "useDefaultModelMetadata", "usageMode"])
    assert.ok(fieldOf(root, name), `missing field ${name}`);
  assert.equal(fieldOf(root, "model").value, "legacy-model");
  assert.equal(fieldOf(root, "reasoningEffort").value, "medium");
  assert.equal(fieldOf(root, "reasoningEffort").disabled, false);
  assert.equal(fieldOf(root, "supportsImages").disabled, false);
  assert.equal(fieldOf(root, "parallelToolCalls").disabled, false);
  assert.equal(fieldOf(root, "contextWindow").value, "");
  assert.equal(fieldOf(root, "useDefaultModelMetadata").checked, true);
  byData(root, "action", "save").click(); await flush();
  const saved = lastCall(h, "save_provider_configuration").payload;
  assert.equal(saved.accountId, "relay-1");
  assert.equal(saved.apiKey, "");
  assert.equal(saved.settings.useDefaultModelMetadata, true);
  assert.equal(saved.settings.contextWindow, 0);
  assert.equal(saved.settings.reasoningEffort, "medium");
  assert.equal(saved.settings.provider, "custom");
  assert.deepEqual(plain(saved.settings.models), []);
  assert.equal(saved.settings.usage.mode, "auto");
  assert.equal(saved.settings.usage.remainingPath, "remaining");
  assert.equal(byData(root, "accountEditor", ""), null);
  assert.ok(findByText(root, "已保存新的配置版本。"));
  h.context.__codexLoaderAccounts.stop();
});

test("model fetch populates selectable rows, select-all/clear and manual add feed the saved catalog", async () => {
  const h = harness();
  let poll = null;
  h.context.setTimeout = callback => { poll = callback; return 1; };
  const { root } = await mount(h);
  byData(byData(root, "accountId", "relay-1"), "action", "edit").click(); await flush();
  const search = fieldOf(root, "model-search");
  search.value = "fixture";
  byData(root, "action", "fetch-models").click(); await settle();
  assert.ok(poll, "model fetch schedules an operation poll");
  const fetchCall = lastCall(h, "begin_provider_models");
  assert.equal(fetchCall.payload.provider, "custom");
  assert.equal(fetchCall.payload.baseUrl, "https://relay.invalid/v1");
  assert.equal(fetchCall.payload.query, "fixture");
  await poll(); await flush();
  const modelList = byData(root, "modelList", "");
  search.value = "";
  search.events.get("input")?.();
  assert.ok(byData(modelList, "modelId", "model-a"));
  assert.ok(byData(modelList, "modelId", "model-b"));
  byData(root, "action", "models-none").click(); await settle();
  assert.equal(byData(byData(modelList, "modelId", "model-a"), "property", "enabled").checked, false);
  byData(root, "action", "models-all").click(); await settle();
  assert.equal(byData(byData(modelList, "modelId", "model-a"), "property", "enabled").checked, true);
  fieldOf(root, "model-manual").value = "model-c";
  byData(root, "action", "model-add").click(); await settle();
  assert.ok(byData(modelList, "modelId", "model-c"));
  byData(root, "action", "save").click(); await flush();
  const settings = lastCall(h, "save_provider_configuration").payload.settings;
  assert.equal(settings.models.length, 4);
  assert.equal(settings.models.find(model => model.id === "model-c").contextWindow, null);
  assert.ok(settings.models.some(model => model.id === "fixture-model"));
  const modelA = settings.models.find(model => model.id === "model-a");
  assert.equal(modelA.name, "Model A");
  assert.equal(modelA.contextWindow, 64000);
  assert.deepEqual(plain(modelA.reasoningLevels), ["low", "high"]);
  assert.equal(modelA.defaultReasoningEffort, "high");
  assert.equal(modelA.supportsImages, true);
  assert.equal(modelA.enabled, true);
  assert.equal(h.context.__codexLoaderAccounts.getStatus().activeOperations, 0);
  h.context.__codexLoaderAccounts.stop();
});

test("usage editor switches between auto and custom and passes values to test_usage", async () => {
  const h = harness();
  const { root } = await mount(h);
  byData(byData(root, "accountId", "relay-1"), "action", "edit").click(); await flush();
  assert.equal(fieldOf(root, "usageMode").value, "auto");
  assert.equal(byData(root, "usageCustom", "").hidden, true);
  fieldOf(root, "usageMode").value = "custom";
  change(fieldOf(root, "usageMode"));
  assert.equal(byData(root, "usageCustom", "").hidden, false);
  fieldOf(root, "usageUrl").value = "https://usage.invalid/v1/credits";
  fieldOf(root, "usageRemainingPath").value = "data.remaining";
  fieldOf(root, "usageUnitPath").value = "data.unit";
  fieldOf(root, "usageLimitPath").value = "data.limit";
  fieldOf(root, "usageUsedPath").value = "data.used";
  fieldOf(root, "usageValidPath").value = "data.valid";
  fieldOf(root, "apiKey").value = "test-key";
  byData(root, "action", "test-usage").click(); await flush();
  // Cross-origin rejection stays backend-side; the UI passes the values unchanged.
  const payload = lastCall(h, "test_usage").payload;
  assert.equal(payload.baseUrl, "https://usage.invalid/v1/credits");
  assert.equal(payload.apiKey, "test-key");
  assert.equal(payload.accountId, "relay-1");
  assert.deepEqual(plain(payload.usage), {
    mode: "custom", url: "https://usage.invalid/v1/credits", remainingPath: "data.remaining",
    unitPath: "data.unit", limitPath: "data.limit", usedPath: "data.used", validPath: "data.valid",
  });
  assert.equal(byData(root, "usageResult", "").textContent, "余额 9.5");
  fieldOf(root, "usageMode").value = "auto";
  change(fieldOf(root, "usageMode"));
  byData(root, "action", "test-usage").click(); await flush();
  assert.equal(lastCall(h, "test_usage").payload.usage.mode, "auto");
  assert.equal(lastCall(h, "test_usage").payload.usage.remainingPath, "remaining");
  assert.equal(lastCall(h, "test_usage").payload.baseUrl, "https://relay.invalid/v1");
  h.context.__codexLoaderAccounts.stop();
});

test("batch mode selects, runs bulk actions, reports per-account results and exits", async () => {
  const h = harness();
  const { root } = await mount(h);
  byData(root, "action", "batch-toggle").click(); await flush();
  assert.equal(byData(root, "batchBar", "").hidden, false);
  assert.equal(byData(byData(root, "accountId", "relay-1"), "action", "select-account").parentElement.hidden, false);
  for (const id of ["relay-1", "sub-1"]) {
    const checkbox = byData(byData(root, "accountId", id), "action", "select-account");
    checkbox.checked = true;
    change(checkbox);
  }
  assert.equal(findByText(root, "已选 2 个").textContent, "已选 2 个");
  byData(root, "action", "batch-disable").click(); await flush();
  const bulk = lastCall(h, "batch_accounts").payload;
  assert.equal(bulk.operation, "disable");
  assert.deepEqual(plain(bulk.accountIds), ["relay-1", "sub-1"]);
  assert.equal(byData(byData(root, "accountId", "relay-1"), "batchResult", "relay-1").textContent, "成功");
  assert.equal(byData(byData(root, "accountId", "sub-1"), "batchResult", "sub-1").textContent, "失败：账号仍有运行中的聊天。结束后再试。");
  byData(root, "action", "batch-models").click();
  assert.equal(byData(root, "action", "batch-models").disabled, false);
  fieldOf(root, "batch-model").value = "unified-model";
  fieldOf(root, "batch-context").value = "64000";
  byData(root, "action", "batch-apply-models").click(); await flush();
  const unified = lastCall(h, "batch_accounts").payload;
  assert.equal(unified.operation, "update_provider");
  assert.equal(unified.settings.model, "unified-model");
  assert.equal(unified.settings.contextWindow, 64000);
  assert.equal(unified.settings.useDefaultModelMetadata, false);
  byData(root, "action", "batch-clear").click();
  byData(root, "action", "batch-relay").click();
  assert.equal(findByText(root, "已选 2 个").textContent, "已选 2 个");
  byData(root, "action", "batch-exit").click(); await flush();
  assert.equal(byData(root, "batchBar", "").hidden, true);
  assert.equal(byData(byData(root, "accountId", "relay-1"), "action", "select-account").parentElement.hidden, true);
  h.context.__codexLoaderAccounts.stop();
});

test("chat tab loads threads only when visible and switches a chat to the default account", async () => {
  const h = harness();
  const { root } = await mount(h);
  assert.equal(h.calls.filter(call => call.operation === "list_threads").length, 0);
  byData(root, "tab", "chat").click(); await flush();
  assert.equal(h.calls.filter(call => call.operation === "list_threads").length, 1);
  const threadRow = byData(root, "threadId", "thread-1");
  assert.ok(findByText(threadRow, "修复登录流程"));
  assert.ok(findByText(threadRow, "订阅 B"));
  assert.ok(findByText(threadRow, "GPT-5"));
  const switchButton = byData(threadRow, "action", "switch-thread");
  assert.equal(switchButton.textContent, "切换此聊天");
  switchButton.click(); await flush();
  assert.deepEqual(plain(lastCall(h, "switch_thread").payload), { threadId: "thread-1", accountId: "relay-1" });
  assert.equal(h.calls.some(call => call.operation === "set_default"), false);
  const busy = byData(byData(root, "threadId", "thread-2"), "action", "switch-thread");
  assert.equal(busy.disabled, true);
  assert.equal(busy.textContent, "运行中");
  const own = byData(byData(root, "threadId", "thread-3"), "action", "switch-thread");
  assert.equal(own.disabled, true);
  assert.equal(own.textContent, "当前账号");
  h.context.__codexLoaderAccounts.stop();
});

test("new-chat policy calls set_new_chat_policy and reflects the saved value", async () => {
  const h = harness();
  const { root } = await mount(h);
  const policy = fieldOf(root, "new-chat-policy");
  assert.equal(policy.value, "default");
  policy.value = "quota";
  change(policy);
  await flush();
  assert.deepEqual(plain(lastCall(h, "set_new_chat_policy").payload), { policy: "quota" });
  assert.equal(policy.value, "quota");
  assert.ok(findByText(root, "新聊天将按剩余额度自动选择。"));
  h.context.__codexLoaderAccounts.stop();
});

test("add menus, importing and login editors route their operations", async () => {
  const h = harness();
  const { root } = await mount(h);
  byData(root, "action", "add-import").click(); await flush();
  assert.equal(fieldOf(root, "import-source").value, "source-1");
  assert.equal(fieldOf(root, "import-base-url").value, "https://source.invalid/v1");
  byData(root, "action", "save").click(); await flush();
  const imported = lastCall(h, "import_account").payload;
  assert.equal(imported.sourceId, "source-1");
  assert.equal(imported.baseUrl, "https://source.invalid/v1");
  assert.deepEqual(plain(imported.models), ["source-model", "source-alt"]);
  assert.equal(byData(root, "accountEditor", ""), null);
  byData(root, "action", "add-login").click(); await flush();
  fieldOf(root, "name").value = "新的订阅账号";
  byData(root, "action", "save").click(); await flush();
  assert.deepEqual(plain(lastCall(h, "begin_login").payload), { name: "新的订阅账号" });
  const row = byData(root, "accountId", "relay-1");
  byData(row, "action", "menu").click();
  findByText(row, "停用").click(); await flush();
  assert.deepEqual(plain(lastCall(h, "set_enabled").payload), { accountId: "relay-1", enabled: false });
  assert.ok(findByText(root, "账号已停用。"));
  h.context.__codexLoaderAccounts.stop();
});

test("account and quota status use the agreed concise vocabulary", async () => {
  const h = harness({ accounts: [
    ...ACCOUNTS,
    { id: "relay-3", name: "未验证接入", kind: "relay", status: "pending" },
    { id: "sub-2", name: "过期登录", kind: "chatgpt", status: "ready", lastError: "AUTHENTICATION_FAILED" },
  ] });
  const { root } = await mount(h);
  const statusOf = id => byData(byData(root, "accountId", id), "status", "").textContent;
  assert.equal(statusOf("relay-1"), "正常");
  assert.equal(statusOf("relay-2"), "已停用");
  assert.equal(statusOf("relay-3"), "未验证");
  assert.equal(statusOf("sub-2"), "需要重新登录");
  assert.ok(findByText(root, "额度未提供"));
  h.context.__codexLoaderAccounts.stop();
});

test("errors are a concise cause plus next step in an aria-live notice", async () => {
  const h = harness({ override: { set_default: () => { throw new Error("ACCOUNT_BUSY"); } } });
  const { root } = await mount(h);
  byData(byData(root, "accountId", "sub-1"), "action", "default").click(); await flush();
  const notice = byData(root, "notice", "");
  assert.equal(notice.textContent, "账号仍有运行中的聊天。结束后再试。");
  assert.equal(notice.hidden, false);
  assert.equal(notice.attributes.role, "status");
  assert.equal(notice.attributes["aria-live"], "polite");
  assert.ok(notice.textContent.length < 40);
  assert.equal(byData(byData(root, "accountId", "relay-1"), "action", "default").textContent, "默认账号");
  h.context.__codexLoaderAccounts.stop();
});

test("the sidebar picker sets the default, refreshes quota and opens management without storage or a composer control", async () => {
  const h = harness();
  await mount(h);
  const trigger = h.rail.children[0].children[0];
  assert.equal(trigger.attributes["aria-label"], "账号");
  trigger.click(); await flush();
  const panel = h.body.children.find(node => node.id === "codex-loader-account-picker");
  assert.ok(panel);
  assert.equal(panel.attributes.role, "menu");
  assert.equal(panel.attributes["aria-label"], "新聊天账号");
  assert.ok(findByText(panel, "未提供"));
  byData(panel, "accountId", "sub-1").click(); await flush();
  assert.equal(lastCall(h, "set_default").payload.accountId, "sub-1");
  assert.equal(h.calls.some(call => call.operation === "switch_thread"), false);
  assert.ok(findByText(panel, "新聊天将使用「订阅 B」。"));
  byData(panel, "action", "sidebar-refresh").click(); await flush();
  assert.ok(h.calls.some(call => call.operation === "refresh_accounts"));
  byData(panel, "action", "manage-accounts").click(); await flush();
  assert.equal(h.counts().opened, 1);
  assert.equal(trigger.attributes["aria-expanded"], "false");
  h.context.__codexLoaderAccounts.stop();
  assert.equal(h.rail.children.length, 0);
  assert.equal(h.body.children.some(node => node.id === "codex-loader-account-picker"), false);
});

test("the account rail item uses pointer drag rather than HTML5 drag", async () => {
  const h = harness();
  const target = new Element("button");
  target.append(new Element("span"));
  h.rail.append(target);
  await mount(h);
  const slot = h.rail.children.find(child => child.dataset?.loaderAccounts === "sidebar");
  const trigger = slot.children[0];
  assert.equal(trigger.getAttribute("aria-label"), "账号");
  assert.equal("draggable" in trigger, false);
  trigger.events.get("pointerdown")({ button: 0, pointerId: 7, clientX: 20, clientY: 500 });
  h.dispatchWindow("pointermove", { pointerId: 7, clientX: 20, clientY: 520, target });
  h.dispatchWindow("pointerup", { pointerId: 7, clientX: 20, clientY: 520, target });
  assert.ok(h.rail.children.indexOf(slot) > h.rail.children.indexOf(target), "slot drops after the target");
  h.context.__codexLoaderAccounts.stop();
});

test("protocol 2 tunnels account commands through status and falls back to direct calls on protocol 1", async () => {
  const tunneled = harness();
  await mount(tunneled);
  const command = tunneled.raw.find(entry => entry.payload?.accountCommand);
  assert.ok(command);
  assert.equal(command.operation, "status");
  assert.equal(command.payload.accountCommand.protocol, 2);
  assert.equal(command.payload.accountCommand.operation, "list_accounts");
  assert.ok(tunneled.calls.some(call => call.operation === "list_accounts"));
  tunneled.context.__codexLoaderAccounts.stop();

  const direct = harness({ override: {
    status: () => ({ accountCommandProtocol: 1, routingAvailable: true, operations: [] }),
  } });
  await mount(direct);
  assert.ok(direct.raw.some(entry => entry.operation === "list_accounts"));
  assert.equal(direct.raw.some(entry => entry.payload?.accountCommand), false);
  direct.context.__codexLoaderAccounts.stop();
});

test("a missing backend reports recovery guidance and a late connection cannot revive a stopped plugin", async () => {
  const offline = harness({ backend: false });
  const { root } = await mount(offline);
  assert.equal(offline.context.__codexLoaderAccounts.getStatus().connected, false);
  assert.equal(byData(root, "action", "refresh").disabled, true);
  assert.ok(findByText(root, "账号后台未连接。在 Loader 设置中检查账号模块。"));
  offline.context.__codexLoaderAccounts.stop();

  const late = harness();
  let resolveStatus;
  late.api.backend.status = () => new Promise(resolve => { resolveStatus = resolve; });
  vm.runInContext(source, late.context);
  late.context.__codexLoaderAccounts.stop();
  resolveStatus({ state: "running" }); await flush();
  assert.equal(late.context.__codexLoaderAccounts, undefined);
  assert.equal(late.calls.length, 0);
  assert.equal(late.head.children.length, 0);
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
