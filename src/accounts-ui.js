(() => {
  "use strict";
  const VERSION = api.version;
  const GLOBAL = "__codexLoaderAccounts";
  const STYLE = "codex-loader-accounts-style";
  globalThis[GLOBAL]?.stop?.();
  /* Lucide users-round and ellipsis icons. https://lucide.dev
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

  */
  const ACCOUNT_ICON = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M18 21a8 8 0 0 0-16 0" />
  <circle cx="10" cy="8" r="5" />
  <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
</svg>
`;
  const MORE_ICON = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="1" />
  <circle cx="19" cy="12" r="1" />
  <circle cx="5" cy="12" r="1" />
</svg>
`;
  const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const loader = api;
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let stopped = false, connected = false, page = null, sidebar = null;
  let accounts = [], primaryAccount = null, defaultAccountId = "primary";
  let preferences = { newChatAccountPolicy: "default" };
  let routingAvailable = false, historyState = null, globalAccount = { pendingThreads: 0, busyThreads: 0, failedThreads: 0, pinnedThreads: 0 };
  let boundThreads = {}, threads = [];
  let notice = "", noticeTone = "info", accountCommandProtocol = 1;
  let operationTimer = null;
  const views = new Set(), operations = new Map();

  const ERRORS = {
    ACCOUNT_BUSY: "账号仍有运行中的聊天。结束后再试。",
    ACCOUNT_NOT_READY: "账号尚未就绪。完成登录或启用后重试。",
    ACCOUNT_NAME_INVALID: "名称需为 1–80 个字符。修改后重试。",
    ACCOUNT_ALREADY_EXISTS: "该账号已存在。换个名称或直接使用现有账号。",
    ACCOUNT_REMOVED: "账号已移除。刷新列表后重试。",
    ACCOUNT_HAS_THREADS: "仍有聊天使用该账号。先在聊天页切换这些聊天。",
    ACCOUNT_MODULE_UNAVAILABLE: "账号模块不可用。在 Loader 设置中重新启用。",
    ACCOUNT_MODULE_DISABLED: "账号模块已关闭。在 Loader 设置中启用。",
    ACCOUNT_MODULE_SAFE_MODE: "安全模式不启动账号模块。关闭安全模式后重启。",
    ROUTER_NOT_CONNECTED: "聊天路由未连接。重启 Codex 后重试。",
    THREAD_BUSY: "聊天正在运行。结束后再切换。",
    THREAD_SWITCHING: "该聊天正在切换。稍后重试。",
    SWITCH_FAILED: "切换未完成。聊天保留原账号。",
    AUTHENTICATION_FAILED: "认证失败。检查 API Key 或重新登录。",
    BACKEND_BUSY: "后台仍有操作。完成或取消后重试。",
    BACKEND_UNAVAILABLE: "账号后台未连接。在 Loader 设置中检查账号模块。",
    BACKEND_OPERATION_DENIED: "当前 Loader 不支持此操作。更新 Loader 后重试。",
    CONNECTION_FAILED: "连接失败。检查网络和接口地址。",
    CONNECTION_TIMEOUT: "请求超时。稍后重试。",
    ENDPOINT_INVALID: "接口地址无效。填写不含查询参数的 HTTPS 地址。",
    IMPORT_ORIGIN_CHANGED: "不能更改导入配置的目标网站。恢复原接口地址后重试。",
    IMPORT_SOURCE_UNAVAILABLE: "未找到可导入配置。先在 CC Switch 中保存。",
    IMPORT_SOURCE_UNSUPPORTED: "无法读取这份 CC Switch 配置。检查文件后重试。",
    IMPORT_SOURCE_BUSY: "CC Switch 配置正在写入。稍后重试。",
    PROVIDER_INVALID: "接入类型无效。重新选择服务。",
    PROVIDER_ORIGIN_MISMATCH: "接口地址与所选服务不符。更换服务或选择自定义。",
    PROVIDER_KEY_REQUIRED: "需要 API Key。填写密钥后重试。",
    PROVIDER_PROFILE_REQUIRED: "该账号没有可编辑的模型配置。",
    PROVIDER_CONFIGURATION_MANAGED: "该接入已按版本管理。从“编辑”修改，重复导入不会覆盖。",
    MODEL_DISCOVERY_UNSUPPORTED: "服务未提供模型列表。手动填写模型 ID。",
    MODEL_INVALID: "模型 ID 无效。填写不含空格的完整 ID。",
    MODEL_OR_ENDPOINT_NOT_FOUND: "未找到模型或接口。核对基础地址后重试。",
    MODEL_SETTINGS_INVALID: "模型参数无效。检查上下文长度和能力设置。",
    CONFIGURATION_INVALID: "配置版本无效。重新打开编辑器后重试。",
    CONFIGURATION_CHANGED: "配置已被更新。重新打开编辑器。",
    CONFIGURATION_VERSION_UNSUPPORTED: "此配置版本不受当前 Loader 支持。更新 Loader 后重试。",
    INPUT_INVALID: "填写内容有误。检查后重试。",
    LOGIN_FAILED: "登录未完成。重新发起授权。",
    LOGIN_ALREADY_RUNNING: "已有一个账号正在授权。完成或取消后重试。",
    OFFICIAL_CLI_UNAVAILABLE: "未找到可用的官方 Codex 后端。先正常启动一次 Codex。",
    RATE_LIMITED: "请求被服务限制。稍后重试。",
    RESPONSE_INCOMPLETE: "服务未返回完整结果。稍后重试。",
    RESPONSE_INVALID: "返回内容无法识别。检查接口地址。",
    SERVICE_UNAVAILABLE: "服务不可用。检查接口地址和模型。",
    STORAGE_UNAVAILABLE: "无法读取本地账号数据。重启 Loader 后重试。",
    TOO_MANY_OPERATIONS: "同时进行的操作过多。稍后重试。",
    USAGE_UNAVAILABLE: "额度暂不可用。稍后刷新或检查密钥。",
    OPERATION_FAILED: "操作未完成。重试一次。",
  };

  function errorText(error) {
    const code = error?.code || error?.message || error;
    return ERRORS[code] || "操作未完成。重试一次。";
  }
  function el(tag, content, className) {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (className) node.className = className;
    return node;
  }
  function text(node, value) { if (node.textContent !== value) node.textContent = value; }
  function attr(node, key, value) {
    if (value === null || value === undefined) node.removeAttribute(key);
    else node.setAttribute(key, String(value));
  }
  function button(label, action, options = {}) {
    const node = el("button", label, options.className || "as-button");
    node.type = "button";
    if (options.action) node.dataset.action = options.action;
    if (options.disabled) node.disabled = true;
    if (options.role) attr(node, "role", options.role);
    if (options.label) attr(node, "aria-label", options.label);
    node.addEventListener("click", event => {
      event?.preventDefault?.();
      if (node.disabled || stopped) return;
      Promise.resolve().then(action).catch(error => {
        if (!stopped) setNotice(errorText(error), "error");
      });
    });
    return node;
  }
  function iconButton(svg, label, action, options = {}) {
    const node = button("", action, { ...options, className: options.className || "as-icon-button", label });
    node.innerHTML = svg;
    return node;
  }
  function field(parent, label, options = {}) {
    const wrapper = el("label", undefined, "as-field");
    wrapper.append(el("span", label, "as-field-label"));
    const input = el("input");
    input.type = options.type || "text";
    input.value = options.value === undefined ? "" : String(options.value);
    input.autocomplete = "off";
    if (options.field) input.dataset.field = options.field;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.min !== undefined) input.min = String(options.min);
    if (options.step !== undefined) input.step = String(options.step);
    attr(input, "aria-label", label);
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }
  function choice(parent, label, values, value, options = {}) {
    const wrapper = el("label", undefined, "as-field");
    wrapper.append(el("span", label, "as-field-label"));
    const select = el("select");
    if (options.field) select.dataset.field = options.field;
    for (const [id, labelText] of values) {
      const option = el("option", labelText);
      option.value = id;
      select.append(option);
    }
    select.value = value;
    attr(select, "aria-label", label);
    wrapper.append(select);
    parent.append(wrapper);
    return select;
  }
  function checkbox(parent, label, checked, options = {}) {
    const wrapper = el("label", undefined, "as-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked === true;
    if (options.field) input.dataset.field = options.field;
    attr(input, "aria-label", label);
    wrapper.append(input, el("span", label));
    parent.append(wrapper);
    return input;
  }
  function section(parent, legend) {
    const box = el("fieldset", undefined, "as-section");
    box.append(el("legend", legend, "as-legend"));
    parent.append(box);
    return box;
  }
  function rowAction(label, action, options) {
    const node = button(label, action, options);
    attr(node, "role", "menuitem");
    return node;
  }

  async function invoke(operation, payload = {}) {
    if (stopped || !loader.backend) throw new Error("BACKEND_UNAVAILABLE");
    const response = accountCommandProtocol === 2 && operation !== "status"
      ? await loader.backend.invoke("status", { accountCommand: { protocol: 2, operation, payload } })
      : await loader.backend.invoke(operation, payload);
    if (!response?.ok) throw new Error(response?.errorCode || "OPERATION_FAILED");
    return response.data;
  }
  function activeOperations() {
    return [...operations.values()].filter(item => ["running", "waiting_auth"].includes(item.state));
  }
  function accountBusy(id) {
    return activeOperations().some(item => item.accountId === id);
  }
  function setNotice(message, tone) {
    notice = message || "";
    noticeTone = tone || "info";
    renderNotices();
  }
  function clearNotice() { if (notice) setNotice(""); }

  function accountStatus(account) {
    if (account.status === "disabled") return "已停用";
    if (account.status === "pending") return "未验证";
    if (account.lastError === "AUTHENTICATION_FAILED") return "需要重新登录";
    if (account.lastError && account.lastError !== "USAGE_UNAVAILABLE") return "未验证";
    if (account.status === "ready" && account.lastCheckedAt) return "正常";
    return "未验证";
  }
  function accountState(account) {
    if (account.status === "disabled") return "disabled";
    if (account.status === "pending") return "pending";
    if (account.lastError && account.lastError !== "USAGE_UNAVAILABLE") return "error";
    if (account.status === "ready" && account.lastCheckedAt) return "ready";
    return "unknown";
  }
  function remaining(window) {
    return Number.isFinite(window?.usedPercent) ? Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent))) : null;
  }
  function creditText(account) {
    const credits = account.credits;
    if (!credits) return null;
    return credits.unlimited ? "Credits 不限额" : credits.balance != null
      ? `余额 ${credits.balance}${/[a-z]/i.test(String(credits.balance)) ? "" : " Credits"}`
      : credits.hasCredits ? "Credits 可用" : "无可用 Credits";
  }
  function quotaText(account) {
    if (account.status === "disabled") return "已停用，不参与新聊天";
    const parts = [];
    const credits = creditText(account);
    if (credits) parts.push(credits);
    for (const window of account.usage || []) {
      const label = window.windowDurationMins === 10080 ? "每周" : window.windowDurationMins === 300 ? "5 小时" : "额度";
      const value = remaining(window);
      parts.push(value === null ? `${label}待刷新` : `${label}剩余 ${value}%`);
    }
    return parts.join(" · ") || "额度未提供";
  }
  function quotaBadge(account) {
    if (account.credits) {
      return {
        value: account.credits.unlimited ? "不限额" : account.credits.balance ?? "—",
        label: /[a-z]/i.test(String(account.credits.balance || "")) ? "余额" : "Credits",
      };
    }
    const window = account.usage?.find(item => item.windowDurationMins === 10080) || account.usage?.[0];
    const value = remaining(window);
    return {
      value: value === null ? "未提供" : `${value}%`,
      label: window?.windowDurationMins === 10080 ? "每周剩余" : window?.windowDurationMins === 300 ? "5 小时剩余" : "额度",
    };
  }
  function allAccounts() {
    const primary = {
      ...(primaryAccount || {}), id: "primary", name: "桌面主账号",
      kind: primaryAccount?.kind || "chatgpt", status: primaryAccount?.status || "ready",
    };
    return [primary, ...accounts];
  }
  function defaultAccount() {
    return allAccounts().find(account => account.id === defaultAccountId) || allAccounts()[0];
  }
  function connectionText() {
    if (!connected) return "未连接";
    return routingAvailable ? "已连接" : "已连接 · 重启 Codex 后启用聊天路由";
  }

  async function makeDefault(accountId, name) {
    await invoke("set_default", { accountId });
    defaultAccountId = accountId;
    setNotice(name ? `新聊天将使用「${name}」。` : "已设为新聊天默认账号。");
    await refresh();
  }

  function renderNotices() {
    for (const view of views) {
      text(view.notice, notice);
      view.notice.hidden = !notice;
      view.notice.dataset.tone = noticeTone;
    }
    renderSidebar();
  }
  async function refresh() {
    const snapshot = await invoke("list_accounts");
    if (stopped) return;
    accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    defaultAccountId = snapshot.defaultAccountId || "primary";
    routingAvailable = snapshot.routingAvailable === true;
    primaryAccount = snapshot.primaryAccount || null;
    globalAccount = snapshot.globalAccount || { pendingThreads: 0, busyThreads: 0, failedThreads: 0, pinnedThreads: 0 };
    historyState = snapshot.history || null;
    boundThreads = snapshot.boundThreads || {};
    if (snapshot.preferences?.newChatAccountPolicy === "quota" || snapshot.preferences?.newChatAccountPolicy === "default")
      preferences = { newChatAccountPolicy: snapshot.preferences.newChatAccountPolicy };
    renderAll();
  }
  async function connect() {
    notice = "";
    try {
      if (!loader.backend) throw new Error("BACKEND_UNAVAILABLE");
      const state = await loader.backend.status();
      if (stopped) return;
      if (state.state !== "running") throw new Error(state.errorCode || "BACKEND_UNAVAILABLE");
      const status = await invoke("status");
      if (stopped) return;
      accountCommandProtocol = status?.accountCommandProtocol === 2 ? 2 : 1;
      connected = true;
      for (const operation of status?.operations || []) operations.set(operation.id, operation);
      await refresh();
      renderOperations();
      if (activeOperations().length) scheduleOperationsPoll();
    } catch (error) {
      if (stopped) return;
      connected = false;
      setNotice(errorText(error), "error");
      renderAll();
    }
  }
  function scheduleOperationsPoll() {
    if (stopped || operationTimer || !activeOperations().length) return;
    operationTimer = setTimeout(async () => {
      operationTimer = null;
      if (stopped) return;
      let changed = false;
      for (const operation of [...operations.values()]) {
        if (!["running", "waiting_auth"].includes(operation.state)) continue;
        try {
          const updated = await invoke("operation_status", { operationId: operation.id });
          if (stopped) return;
          operations.set(updated.id, updated);
          if (updated.state !== operation.state) changed = true;
          if (updated.kind === "models" && updated.state === "completed") {
            for (const view of views) {
              if (view.modelsOperationId !== updated.id) continue;
              view.modelsOperationId = null;
              view.onModels?.(updated.models || []);
            }
          }
          if (updated.state === "completed" && updated.kind !== "models") {
            setNotice({ login: "授权完成。", probe: "连接测试通过。", usage: "额度已刷新。", switch: "聊天已切换。" }[updated.kind] || "操作完成。");
            if (updated.kind === "switch") {
              for (const view of views) if (view.tab === "chat") void loadThreads(view, { silent: true });
            }
          }
          if (updated.state === "failed") setNotice(errorText(updated.errorCode), "error");
          if (updated.state === "cancelled") setNotice("操作已取消。");
        } catch (error) {
          operations.delete(operation.id);
          changed = true;
          setNotice(errorText(error), "error");
        }
      }
      if (changed) {
        try { await refresh(); } catch (error) { if (!stopped) setNotice(errorText(error), "error"); }
        const chatView = [...views].find(view => view.tab === "chat");
        if (chatView) await loadThreads(chatView, { silent: true });
      }
      renderOperations();
      scheduleOperationsPoll();
    }, 1000);
  }
  function trackOperation(operation) {
    if (!operation?.id) return;
    operations.set(operation.id, operation);
    renderOperations();
    scheduleOperationsPoll();
  }
  async function refreshUsage() {
    const operation = await invoke("refresh_accounts");
    trackOperation(operation);
    setNotice("正在刷新额度…");
  }
  async function setPolicy(value) {
    await invoke("set_new_chat_policy", { policy: value });
    preferences = { newChatAccountPolicy: value };
    setNotice(value === "quota" ? "新聊天将按剩余额度自动选择。" : "新聊天将使用默认账号。");
    await refresh();
  }

  function operationProgress(operation) {
    return {
      models: "正在获取模型…", probe: "正在测试连接…", switch: "正在切换聊天…",
      usage: "正在刷新额度…", login: "正在准备授权…",
    }[operation.kind] || "正在处理…";
  }
  function renderOperations() {
    for (const view of views) {
      view.operations.replaceChildren();
      for (const operation of activeOperations()) {
        const row = el("div", undefined, "as-operation");
        row.append(el("span", operation.state === "waiting_auth" ? "请在官方页面完成授权" : operationProgress(operation)));
        if (operation.authUrl) row.append(button("打开授权页", () => {
          const url = new URL(operation.authUrl);
          if (url.origin !== "https://auth.openai.com") throw new Error("LOGIN_FAILED");
          window.open(operation.authUrl, "_blank", "noopener,noreferrer");
        }, { action: "open-auth" }));
        row.append(button("取消", async () => {
          await invoke("cancel_operation", { operationId: operation.id });
          setNotice("正在取消操作…");
        }, { action: "cancel-operation", className: "as-text-button" }));
        view.operations.append(row);
      }
      view.operations.hidden = !view.operations.children.length;
    }
  }

  function accountRow(view, account) {
    const root = el("article", undefined, "as-row");
    root.dataset.accountId = account.id;
    const selectWrap = el("label", undefined, "as-row-select");
    const select = el("input");
    select.type = "checkbox";
    select.dataset.action = "select-account";
    attr(select, "aria-label", `选择 ${account.name}`);
    select.addEventListener("change", () => {
      if (select.checked) view.batch.selected.add(account.id);
      else view.batch.selected.delete(account.id);
      updateBatch(view);
    });
    selectWrap.append(select);
    const avatar = el("span", Array.from(account.name.trim())[0]?.toUpperCase() || "A", "as-avatar");
    attr(avatar, "aria-hidden", "true");
    const copy = el("div", undefined, "as-row-copy");
    const heading = el("div", undefined, "as-row-heading");
    const name = el("h3", account.name);
    const badge = el("span", "默认", "as-badge");
    const plan = el("span", "", "as-plan");
    heading.append(name, badge, plan);
    const meta = el("p", "", "as-row-meta");
    const status = el("span", "", "as-status");
    status.dataset.status = "";
    meta.append(status);
    const detail = el("span", "", "as-row-detail");
    meta.append(detail);
    const quota = el("p", "", "as-quota");
    const result = el("p", "", "as-row-result");
    result.dataset.batchResult = account.id;
    result.hidden = true;
    copy.append(heading, meta, quota, result);
    const actions = el("div", undefined, "as-row-actions");
    const edit = button("编辑", () => account.kind === "relay" ? openRelayEditor(view, account) : openNameEditor(view, account), {
      action: "edit", className: "as-button as-small",
    });
    const setDefault = button("设为默认", () => makeDefault(account.id, account.name), { action: "default", className: "as-button as-small" });
    actions.append(edit, setDefault);
    let menu = null;
    if (account.id !== "primary") menu = accountMenu(view, account);
    if (menu) actions.append(menu.wrap);
    root.append(selectWrap, avatar, copy, actions);
    return { root, selectWrap, select, avatar, name, badge, plan, status, detail, quota, result, edit, setDefault, menu, menuSignature: null };
  }
  function accountMenu(view, account) {
    const wrap = el("div", undefined, "as-menu");
    const trigger = iconButton(MORE_ICON, `${account.name} 更多操作`, () => {
      const open = list.hidden;
      list.hidden = !open;
      attr(trigger, "aria-expanded", String(open));
      if (open) list.children[0]?.focus();
    }, { action: "menu", className: "as-menu-trigger" });
    attr(trigger, "aria-haspopup", "menu");
    attr(trigger, "aria-expanded", "false");
    const list = el("div", undefined, "as-menu-list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    const close = () => { list.hidden = true; attr(trigger, "aria-expanded", "false"); };
    list.addEventListener("click", close);
    wrap.addEventListener("keydown", event => {
      if (event.key === "Escape") { close(); trigger.focus(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...list.children].filter(child => !child.disabled);
      if (!items.length) return;
      event.preventDefault?.();
      const current = items.indexOf(document.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (Math.max(current, 0) + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    });
    wrap.append(trigger, list);
    return { wrap, trigger, list, close };
  }
  function fillAccountMenu(view, refs, account) {
    const signature = JSON.stringify([connected, account.status, account.kind, account.lastError, accountBusy(account.id)]);
    if (refs.menuSignature === signature) return;
    refs.menuSignature = signature;
    const list = refs.menu.list;
    list.replaceChildren();
    const disabled = !connected || accountBusy(account.id);
    const add = (label, action, options = {}) => {
      list.append(rowAction(label, async () => { refs.menu.close(); await action(); }, { ...options, disabled: disabled || options.disabled }));
    };
    if (account.status === "ready") add("测试连接", async () => {
      trackOperation(await invoke("begin_probe", { accountId: account.id }));
      setNotice("正在测试连接…");
    });
    if (account.kind === "chatgpt" && account.status === "ready") add("重新授权", () => openLoginEditor(view, account));
    if (account.status !== "pending") add(account.status === "disabled" ? "启用" : "停用", async () => {
      await invoke("set_enabled", { accountId: account.id, enabled: account.status === "disabled" });
      setNotice(account.status === "disabled" ? "账号已启用。" : "账号已停用。");
      await refresh();
    });
    add("移除", async () => {
      await invoke("remove_account", { accountId: account.id });
      setNotice("已从列表移除。凭证与历史仍保留。");
      await refresh();
    }, { className: "as-button as-danger" });
    refs.menu.trigger.disabled = !connected;
    attr(refs.menu.trigger, "aria-label", `${account.name} 更多操作`);
  }
  function updateAccountRow(view, refs, account) {
    const current = account.id === defaultAccountId;
    refs.root.dataset.selected = String(current);
    refs.root.dataset.state = accountState(account);
    text(refs.name, account.name);
    text(refs.avatar, Array.from(account.name.trim())[0]?.toUpperCase() || "A");
    refs.badge.hidden = !current;
    text(refs.plan, account.plan || (account.provider ? String(account.provider) : ""));
    refs.plan.hidden = !refs.plan.textContent;
    text(refs.status, accountStatus(account));
    refs.status.dataset.state = accountState(account);
    const detail = account.email || account.baseUrl || (account.id === "primary" ? "Codex 桌面登录" : "");
    text(refs.detail, account.model ? `${detail}${detail ? " · " : ""}${account.model}` : detail);
    text(refs.quota, quotaText(account));
    refs.selectWrap.hidden = !view.batch.active || account.id === "primary";
    refs.select.checked = view.batch.selected.has(account.id);
    const batchResult = view.batch.results.get(account.id);
    refs.result.hidden = !batchResult;
    if (batchResult) text(refs.result, batchResult.ok ? "成功" : `失败：${errorText(batchResult.errorCode)}`);
    if (account.id === "primary") {
      refs.edit.hidden = true;
      refs.setDefault.hidden = false;
    } else {
      refs.edit.hidden = false;
      refs.edit.disabled = !connected;
      fillAccountMenu(view, refs, account);
    }
    refs.setDefault.disabled = current || account.status === "disabled" || !connected;
    text(refs.setDefault, current ? "默认账号" : "设为默认");
  }
  function syncAccountList(view) {
    const list = allAccounts();
    const seen = new Set();
    for (const account of list) {
      seen.add(account.id);
      let refs = view.rows.get(account.id);
      if (!refs) {
        refs = accountRow(view, account);
        view.rows.set(account.id, refs);
      }
      updateAccountRow(view, refs, account);
      view.list.append(refs.root);
    }
    for (const [id, refs] of view.rows) {
      if (seen.has(id)) continue;
      refs.root.remove();
      view.rows.delete(id);
    }
    view.empty.hidden = list.length > 0;
  }

  function buildBatch(view) {
    const bar = el("section", undefined, "as-batch");
    bar.dataset.batchBar = "";
    bar.hidden = true;
    const meta = el("div", undefined, "as-batch-meta");
    const count = el("span", "已选 0 个", "as-batch-count");
    const selectAll = button("全选", () => selectBatch(view, "all"), { action: "batch-all", className: "as-text-button" });
    const selectRelay = button("模型接入", () => selectBatch(view, "relay"), { action: "batch-relay", className: "as-text-button" });
    const selectSubscription = button("订阅", () => selectBatch(view, "subscription"), { action: "batch-subscription", className: "as-text-button" });
    const clear = button("清空选择", () => selectBatch(view, "none"), { action: "batch-clear", className: "as-text-button" });
    const exit = button("退出批量", () => {
      view.batch.active = false;
      view.batch.selected.clear();
      view.batch.results = new Map();
      view.batch.summary.hidden = true;
      updateBatch(view);
      syncAccountList(view);
    }, { action: "batch-exit", className: "as-text-button" });
    meta.append(count, selectAll, selectRelay, selectSubscription, clear, exit);
    const actions = el("div", undefined, "as-batch-actions");
    const actionButtons = {
      enable: button("启用", () => runBatch(view, "enable"), { action: "batch-enable", className: "as-button as-small" }),
      disable: button("停用", () => runBatch(view, "disable"), { action: "batch-disable", className: "as-button as-small" }),
      refresh: button("刷新额度", () => runBatch(view, "refresh"), { action: "batch-refresh", className: "as-button as-small" }),
      remove: button("移除", () => runBatch(view, "remove"), { action: "batch-remove", className: "as-button as-small as-danger" }),
      models: button("统一模型设置", () => { view.batch.settingsForm.hidden = !view.batch.settingsForm.hidden; }, { action: "batch-models", className: "as-button as-small" }),
    };
    actions.append(...Object.values(actionButtons));
    const settingsForm = el("div", undefined, "as-batch-settings");
    settingsForm.hidden = true;
    const grid = el("div", undefined, "as-form-grid");
    const model = field(grid, "模型 ID", { field: "batch-model", placeholder: "模型 ID", maxLength: 160 });
    const context = field(grid, "上下文长度（tokens）", { field: "batch-context", type: "number", min: 1024, step: 1 });
    const effort = choice(grid, "推理强度", [["", "不发送推理参数"], ...EFFORTS.map(value => [value, value])], "", { field: "batch-effort" });
    const toolFormat = choice(grid, "补丁工具格式", [["function", "Function"], ["freeform", "Freeform"]], "function", { field: "batch-tool-format" });
    const flags = el("div", undefined, "as-flags");
    const images = checkbox(flags, "支持图片输入", false, { field: "batch-images" });
    const parallel = checkbox(flags, "支持并行工具调用", false, { field: "batch-parallel" });
    grid.append(flags);
    settingsForm.append(grid, button("应用到所选账号", async () => {
      const modelValue = model.value.trim();
      if (!modelValue) { setNotice("先填写模型 ID。", "error"); return; }
      const contextValue = context.value.trim() ? Number(context.value) : 0;
      if (contextValue !== 0 && (!Number.isInteger(contextValue) || contextValue < 1024)) {
        setNotice("上下文长度需 ≥1024，或留空沿用默认参数。", "error");
        return;
      }
      await runBatch(view, "update_provider", {
        model: modelValue, contextWindow: contextValue, reasoningEffort: effort.value || null,
        supportsImages: images.checked, toolFormat: toolFormat.value, parallelToolCalls: parallel.checked,
        useDefaultModelMetadata: contextValue === 0,
      });
    }, { action: "batch-apply-models", className: "as-button as-primary as-small" }));
    const summary = el("p", "", "as-batch-summary");
    summary.dataset.batchSummary = "";
    summary.hidden = true;
    bar.append(meta, actions, settingsForm, summary);
    return { bar, count, summary, settingsForm, actionButtons };
  }
  function selectBatch(view, mode) {
    view.batch.selected.clear();
    for (const account of accounts) {
      if (mode === "all" || mode === account.kind) view.batch.selected.add(account.id);
      if (mode === "subscription" && account.kind !== "relay") view.batch.selected.add(account.id);
    }
    updateBatch(view);
  }
  async function runBatch(view, operation, settings) {
    const accountIds = [...view.batch.selected];
    if (!accountIds.length) { setNotice("先选择账号。", "error"); return; }
    const payload = { accountIds, operation };
    if (settings) payload.settings = settings;
    const data = await invoke("batch_accounts", payload);
    view.batch.results = new Map();
    for (const result of data?.results || []) view.batch.results.set(result.accountId, result);
    const list = [...view.batch.results.values()];
    const failed = list.filter(item => !item.ok).length;
    text(view.batch.summary, list.length ? `${list.length - failed} 成功 · ${failed} 失败` : "未返回结果。");
    view.batch.summary.hidden = !list.length;
    setNotice(failed ? `${failed} 个账号未完成。查看各行结果后重试。` : "批量操作已完成。", failed ? "error" : "info");
    updateBatch(view);
    await refresh();
  }
  function updateBatch(view) {
    view.batchToggle.dataset.checked = String(view.batch.active);
    attr(view.batchToggle, "aria-checked", String(view.batch.active));
    view.batch.bar.hidden = !view.batch.active;
    view.batch.settingsForm.hidden = view.batch.settingsForm.hidden || !view.batch.active;
    const count = view.batch.selected.size;
    text(view.batch.count, `已选 ${count} 个`);
    for (const [key, node] of Object.entries(view.batch.actionButtons)) {
      if (key === "models") continue;
      node.disabled = count === 0 || !connected;
    }
    view.batch.actionButtons.models.disabled = count === 0 || !connected;
    if (!view.batch.active) view.batch.selected.clear();
    syncBatchSelection(view);
  }
  function syncBatchSelection(view) {
    for (const [id, refs] of view.rows) {
      refs.selectWrap.hidden = !view.batch.active || id === "primary";
      refs.select.checked = view.batch.selected.has(id);
    }
  }

  function beginEditor(view, title, account) {
    view.head.hidden = true;
    view.listWrap.hidden = true;
    view.batch.bar.hidden = true;
    view.editorHost.hidden = false;
    const node = el("section", undefined, "as-editor");
    node.dataset.accountEditor = "";
    const back = button("← 返回", () => closeEditor(view), { className: "as-text-button", action: "editor-back" });
    attr(back, "aria-label", "返回账号列表");
    node.append(back, el("h2", title, "as-editor-title"));
    view.editorHost.replaceChildren(node);
    view.editor = { node, account, title };
    view.modelsOperationId = null;
    view.onModels = null;
    return view.editor;
  }
  function closeEditor(view) {
    view.editor = null;
    view.modelsOperationId = null;
    view.onModels = null;
    view.editorHost.replaceChildren();
    view.editorHost.hidden = true;
    view.head.hidden = false;
    view.listWrap.hidden = false;
    view.batch.bar.hidden = !view.batch.active;
    view.tabs.accounts.focus?.();
  }
  function editorActions(view, form, saveLabel, save, extra) {
    const actions = el("div", undefined, "as-actions");
    const saveButton = button(saveLabel, save, { className: "as-button as-primary", action: "save" });
    actions.append(saveButton);
    if (extra) actions.append(extra);
    actions.append(button("取消", () => closeEditor(view), { action: "cancel" }));
    form.append(actions);
    return saveButton;
  }

  function openRelayEditor(view, account) {
    const editor = beginEditor(view, account ? "编辑账号" : "添加模型接入", account);
    if (!account) { renderRelayForm(view, null, null); return; }
    const loading = el("p", "正在读取配置…", "as-muted");
    editor.node.append(loading);
    invoke("get_provider_configuration", { accountId: account.id }).then(saved => {
      if (stopped || view.editor !== editor) return;
      loading.remove();
      renderRelayForm(view, account, saved || {});
    }).catch(error => {
      if (stopped || view.editor !== editor) return;
      loading.remove();
      editor.node.append(el("p", errorText(error), "as-notice"));
      editor.node.append(button("返回账号列表", () => closeEditor(view), { action: "editor-back" }));
    });
  }
  function normalizeModel(value) {
    const item = typeof value === "string" ? { id: value } : value || {};
    const context = Number(item.contextWindow);
    return {
      id: String(item.id || "").trim(),
      name: String(item.name || "").trim(),
      contextWindow: Number.isFinite(context) && context >= 1024 ? context : null,
      reasoningLevels: Array.isArray(item.reasoningLevels) ? item.reasoningLevels.map(String) : [],
      supportedReasoningLevels: Array.isArray(item.supportedReasoningLevels) ? item.supportedReasoningLevels.map(String)
        : Array.isArray(item.reasoningLevels) ? item.reasoningLevels.map(String) : [],
      defaultReasoningEffort: item.defaultReasoningEffort || "",
      supportsImages: item.supportsImages === true,
      supportsTools: item.supportsTools !== false,
      toolFormat: item.toolFormat || "function",
      parallelToolCalls: item.parallelToolCalls === true,
      enabled: item.enabled !== false,
    };
  }
  function normalizeUsage(usage) {
    const value = usage || {};
    return {
      mode: value.mode === "custom" ? "custom" : "auto",
      url: value.url || "", remainingPath: value.remainingPath || "", unitPath: value.unitPath || "",
      limitPath: value.limitPath || "", usedPath: value.usedPath || "", validPath: value.validPath || "",
    };
  }
  function renderRelayForm(view, account, saved) {
    const editor = view.editor;
    const settings = saved?.settings || {};
    const state = {
      account, models: (settings.models || []).map(normalizeModel),
      usage: normalizeUsage(settings.usage),
      versions: saved?.versions || [], activeVersion: saved?.activeVersion || 0,
    };
    const fallbackLevels = settings.provider === "deepseek" ? ["low", "high", "max"] : ["low", "medium", "high"];
    for (const item of state.models) {
      if (!item.supportedReasoningLevels.length) item.supportedReasoningLevels = fallbackLevels.slice();
      if (!item.reasoningLevels.length) item.reasoningLevels = item.supportedReasoningLevels.slice();
      if (!item.supportedReasoningLevels.includes(item.defaultReasoningEffort)) item.defaultReasoningEffort = item.reasoningLevels[0] || "";
    }
    editor.state = state;
    const form = el("div", undefined, "as-form-body");
    editor.node.append(form);

    const identity = section(form, "账号");
    const name = field(identity, "名称", { value: account?.name || "新模型接入", field: "name", maxLength: 80 });
    const provider = choice(identity, "服务", [["deepseek", "DeepSeek"], ["openrouter", "OpenRouter"], ["custom", "自定义 Responses"]], settings.provider || "custom", { field: "provider" });
    const apiKey = field(identity, "API Key", { type: "password", field: "apiKey", maxLength: 8192, placeholder: account ? "留空沿用现有密钥" : "必填" });
    const baseUrl = field(identity, "接口基础地址", { type: "url", value: settings.baseUrl || "", field: "baseUrl", maxLength: 2048, placeholder: "https://api.example.com/v1" });

    const modelBox = section(form, "默认模型");
    const grid = el("div", undefined, "as-form-grid");
    const model = field(grid, "模型 ID", { value: settings.model || "", field: "model", maxLength: 160, placeholder: "例如 deepseek-flash" });
    const context = field(grid, "上下文长度（tokens）", { type: "number", value: Number(settings.contextWindow) || "", field: "contextWindow", min: 1024, step: 1 });
    const effort = choice(grid, "推理强度", [["", "不发送推理参数"], ...EFFORTS.map(value => [value, value])], settings.reasoningEffort || "", { field: "reasoningEffort" });
    const toolFormat = choice(grid, "补丁工具格式", [["function", "Function"], ["freeform", "Freeform（模型需支持）"]], settings.toolFormat || "function", { field: "toolFormat" });
    const flags = el("div", undefined, "as-flags");
    const supportsImages = checkbox(flags, "支持图片输入", settings.supportsImages === true, { field: "supportsImages" });
    const parallel = checkbox(flags, "支持并行工具调用", settings.parallelToolCalls === true, { field: "parallelToolCalls" });
    const useDefault = checkbox(flags, "沿用 Codex 默认模型参数", settings.useDefaultModelMetadata === true, { field: "useDefaultModelMetadata" });
    grid.append(flags);
    modelBox.append(grid);

    const catalog = section(form, "模型目录");
    const search = field(catalog, "搜索模型", { field: "model-search", placeholder: "模型 ID 或显示名称" });
    search.addEventListener("input", renderModelRows);
    const catalogActions = el("div", undefined, "as-actions");
    const fetchModels = button("自动获取模型列表", async () => {
      const query = search.value.trim();
      const operation = await invoke("begin_provider_models", {
        provider: provider.value, baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim(), query,
        ...(account ? { accountId: account.id } : {}),
      });
      view.modelsOperationId = operation.id;
      view.onModels = items => {
        for (const raw of items) {
          const item = normalizeModel(raw);
          if (!item.id) continue;
          const existing = state.models.find(modelItem => modelItem.id === item.id);
          if (existing) {
            const fetchedLevels = item.reasoningLevels;
            if (fetchedLevels.length) {
              existing.supportedReasoningLevels = fetchedLevels;
              existing.reasoningLevels = existing.reasoningLevels.filter(level => fetchedLevels.includes(level));
              if (!existing.reasoningLevels.length) existing.reasoningLevels = fetchedLevels.slice();
            }
            Object.assign(existing, item, {
              enabled: existing.enabled,
              supportedReasoningLevels: existing.supportedReasoningLevels,
              reasoningLevels: existing.reasoningLevels,
            });
            if (!existing.reasoningLevels.includes(existing.defaultReasoningEffort))
              existing.defaultReasoningEffort = existing.reasoningLevels[0] || "";
          } else {
            if (!item.supportedReasoningLevels.length) item.supportedReasoningLevels = fallbackLevels.slice();
            if (!item.reasoningLevels.length) item.reasoningLevels = item.supportedReasoningLevels.slice();
            item.enabled = true;
            state.models.push(item);
          }
        }
        search.value = "";
        renderModelRows();
        setNotice(`已获取 ${items.length} 个模型。`);
      };
      trackOperation(operation);
      setNotice("正在获取模型…");
    }, { action: "fetch-models", className: "as-button as-small", disabled: !connected });
    const selectAll = button("全选", () => setModelsEnabled(state, true, renderModelRows, search), { action: "models-all", className: "as-text-button" });
    const selectNone = button("清空", () => setModelsEnabled(state, false, renderModelRows, search), { action: "models-none", className: "as-text-button" });
    catalogActions.append(fetchModels, selectAll, selectNone);
    if (account && connected)
      globalThis.queueMicrotask?.(() => { if (!stopped) void fetchModels(); });
    catalog.append(catalogActions);
    const manualRow = el("div", undefined, "as-manual");
    const manual = field(manualRow, "手动添加模型 ID", { field: "model-manual", placeholder: "模型 ID", maxLength: 160 });
    const addModel = button("添加模型", () => {
      const id = manual.value.trim();
      if (!id) { setNotice("先填写模型 ID。", "error"); return; }
      if (!state.models.some(item => item.id === id)) {
        const levels = provider.value === "deepseek" ? ["low", "high", "max"] : ["low", "medium", "high"];
        const item = normalizeModel({ id, reasoningLevels: levels, supportedReasoningLevels: levels });
        item.enabled = true;
        state.models.push(item);
      }
      manual.value = "";
      renderModelRows();
    }, { action: "model-add", className: "as-button as-small" });
    manualRow.append(addModel);
    catalog.append(manualRow);
    const catalogHint = el("p", "", "as-muted");
    const modelList = el("div", undefined, "as-models");
    modelList.dataset.modelList = "";
    catalog.append(catalogHint, modelList);

    function renderModelRows() {
      modelList.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const items = state.models.filter(item => !query || `${item.id} ${item.name}`.toLowerCase().includes(query));
      for (const item of items) modelList.append(modelRow(item, state, renderModelRows));
      text(catalogHint, state.models.length ? `${items.filter(item => item.enabled).length} / ${state.models.length} 已加入` : "");
    }
    function modelRow(item, currentState, rerender) {
      const row = el("div", undefined, "as-model");
      row.dataset.modelId = item.id;
      const enableWrap = el("label", undefined, "as-check as-model-enable");
      const enable = el("input");
      enable.type = "checkbox";
      enable.checked = item.enabled !== false;
      enable.dataset.property = "enabled";
      attr(enable, "aria-label", `启用模型 ${item.id}`);
      enable.addEventListener("change", () => { item.enabled = enable.checked; });
      enableWrap.append(enable, el("span", item.id, "as-model-id"));
      row.append(enableWrap);
      const modelGrid = el("div", undefined, "as-model-grid");
      const displayName = modelInput(modelGrid, "显示名称", item.name, "name", value => { item.name = value; });
      const contextInput = modelInput(modelGrid, "上下文长度", item.contextWindow || "", "contextWindow", value => { item.contextWindow = Number(value) || 0; }, "number");
      const supportedLevels = item.supportedReasoningLevels?.length ? item.supportedReasoningLevels : item.reasoningLevels;
      if (supportedLevels.length) {
        const levelWrap = el("div", undefined, "as-model-levels");
        levelWrap.append(el("span", "思考程度", "as-mini-label"));
        for (const level of supportedLevels) {
          const levelLabel = el("label", undefined, "as-check");
          const levelInput = el("input");
          levelInput.type = "checkbox";
          levelInput.checked = item.reasoningLevels.includes(level);
          attr(levelInput, "aria-label", `${item.id} 支持 ${level}`);
          levelInput.addEventListener("change", () => {
            item.reasoningLevels = levelInput.checked
              ? [...new Set([...item.reasoningLevels, level])]
              : item.reasoningLevels.filter(value => value !== level);
            if (!item.reasoningLevels.includes(item.defaultReasoningEffort)) {
              item.defaultReasoningEffort = item.reasoningLevels[0] || "";
            }
            rerender();
          });
          levelLabel.append(levelInput, el("span", level));
          levelWrap.append(levelLabel);
        }
        modelGrid.append(levelWrap);
      }
      const effortValues = item.reasoningLevels.length ? item.reasoningLevels : [];
      const defaultEffort = modelChoice(modelGrid, "默认推理强度", [["", "不指定"], ...effortValues.map(value => [value, value])], item.defaultReasoningEffort, value => { item.defaultReasoningEffort = value; });
      const modelToolFormat = modelChoice(modelGrid, "补丁格式", [["function", "Function"], ["freeform", "Freeform"]], item.toolFormat, value => { item.toolFormat = value; });
      const modelFlags = el("div", undefined, "as-flags as-model-flags");
      const imagesFlag = modelCheck(modelFlags, "支持图片", item.supportsImages, checked => { item.supportsImages = checked; });
      const parallelFlag = modelCheck(modelFlags, "并行工具调用", item.parallelToolCalls, checked => { item.parallelToolCalls = checked; });
      modelGrid.append(modelFlags);
      row.append(modelGrid, button("移除", () => {
        const index = currentState.models.indexOf(item);
        if (index >= 0) currentState.models.splice(index, 1);
        rerender();
      }, { action: "remove-model", className: "as-text-button as-danger", label: `移除模型 ${item.id}` }));
      return row;
    }
    renderModelRows();

    const usageBox = section(form, "额度查询");
    const usageMode = choice(usageBox, "查询方式", [["auto", "自动"], ["custom", "自定义"]], state.usage.mode, { field: "usageMode" });
    const usageCustom = el("div", undefined, "as-usage-custom");
    usageCustom.dataset.usageCustom = "";
    usageCustom.hidden = state.usage.mode !== "custom";
    const usageUrl = field(usageCustom, "额度接口地址", { type: "url", value: state.usage.url, field: "usageUrl", maxLength: 2048, placeholder: "https://api.example.com/user/balance" });
    const usageGrid = el("div", undefined, "as-form-grid");
    const remainingPath = field(usageGrid, "剩余额度路径", { value: state.usage.remainingPath, field: "usageRemainingPath", placeholder: "remaining" });
    const unitPath = field(usageGrid, "单位路径", { value: state.usage.unitPath, field: "usageUnitPath", placeholder: "unit" });
    const limitPath = field(usageGrid, "总量路径", { value: state.usage.limitPath, field: "usageLimitPath", placeholder: "limit" });
    const usedPath = field(usageGrid, "已用路径", { value: state.usage.usedPath, field: "usageUsedPath", placeholder: "used" });
    const validPath = field(usageGrid, "有效标记路径", { value: state.usage.validPath, field: "usageValidPath", placeholder: "isValid" });
    usageCustom.append(usageGrid);
    const usageResult = el("p", "", "as-result");
    usageResult.dataset.usageResult = "";
    attr(usageResult, "role", "status");
    attr(usageResult, "aria-live", "polite");
    const usageActions = el("div", undefined, "as-actions");
    usageActions.append(button("测试额度", async () => {
      const usage = readUsage(usageMode, usageUrl, remainingPath, unitPath, limitPath, usedPath, validPath);
      const testBaseUrl = usage.mode === "custom" && usage.url ? usage.url : baseUrl.value.trim();
      const data = await invoke("test_usage", {
        baseUrl: testBaseUrl, apiKey: apiKey.value.trim(), usage,
        ...(account ? { accountId: account.id } : {}),
      });
      if (data?.credits) {
        text(usageResult, data.credits.unlimited ? "额度：不限额" : data.credits.balance != null ? `余额 ${data.credits.balance}` : "额度：可用");
      } else if (data?.errorCode) {
        text(usageResult, errorText(data.errorCode));
      } else {
        text(usageResult, "接口未返回额度。检查路径后重试。");
      }
    }, { action: "test-usage", className: "as-button as-small" }));
    usageBox.append(usageCustom, usageActions, usageResult);
    usageMode.addEventListener("change", () => { usageCustom.hidden = usageMode.value !== "custom"; });

    if (account && state.versions.length) {
      const history = section(form, "配置版本");
      const versionSelect = choice(history, "历史版本", state.versions.map(item => [String(item.version), `v${item.version} · ${item.model || "模型"}`]), String(state.activeVersion), { field: "version" });
      history.append(button("恢复此版本", async () => {
        const version = Number(versionSelect.value);
        await invoke("activate_provider_version", { accountId: account.id, version });
        setNotice(`已恢复配置 v${version}。`);
        closeEditor(view);
        await refresh();
      }, { action: "restore-version" }));
    }

    editorActions(view, form, account ? "保存" : "添加模型接入", async () => {
      const nameValue = name.value.trim();
      if (!nameValue) { setNotice("先填写账号名称。", "error"); return; }
      const modelValue = model.value.trim();
      if (!modelValue) { setNotice("先填写模型 ID。", "error"); return; }
      const useDefaultMetadata = useDefault.checked === true;
      let contextValue = Number(context.value);
      if (useDefaultMetadata) contextValue = 0;
      else if (!Number.isInteger(contextValue) || contextValue < 1024) {
        setNotice("上下文长度需 ≥1024，或勾选“沿用 Codex 默认模型参数”。", "error");
        return;
      }
      const settingsPayload = {
        provider: provider.value, baseUrl: baseUrl.value.trim(), model: modelValue, contextWindow: contextValue,
        reasoningEffort: effort.value || null, supportsImages: supportsImages.checked, toolFormat: toolFormat.value,
        parallelToolCalls: parallel.checked, useDefaultModelMetadata: useDefaultMetadata,
        models: state.models.map(item => ({
          id: item.id, name: item.name, contextWindow: item.contextWindow >= 1024 ? item.contextWindow : null,
          reasoningLevels: item.reasoningLevels, supportedReasoningLevels: item.supportedReasoningLevels,
          defaultReasoningEffort: item.defaultReasoningEffort || null,
          supportsImages: item.supportsImages, supportsTools: item.supportsTools !== false,
          toolFormat: item.toolFormat, parallelToolCalls: item.parallelToolCalls, enabled: item.enabled !== false,
        })),
        usage: readUsage(usageMode, usageUrl, remainingPath, unitPath, limitPath, usedPath, validPath),
      };
      await invoke(account ? "save_provider_configuration" : "create_provider", {
        ...(account ? { accountId: account.id } : {}), name: nameValue, apiKey: apiKey.value.trim(), settings: settingsPayload,
      });
      apiKey.value = "";
      setNotice(account ? "已保存新的配置版本。" : "模型接入已添加。");
      closeEditor(view);
      await refresh();
    });
    name.focus?.();
  }
  function modelInput(parent, label, value, property, onChange, type) {
    const wrapper = el("label", undefined, "as-mini-field");
    wrapper.append(el("span", label, "as-mini-label"));
    const input = el("input");
    input.type = type || "text";
    input.value = value === undefined || value === null ? "" : String(value);
    input.dataset.property = property;
    input.autocomplete = "off";
    attr(input, "aria-label", label);
    input.addEventListener("input", () => onChange(input.value));
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }
  function modelChoice(parent, label, values, value, onChange) {
    const wrapper = el("label", undefined, "as-mini-field");
    wrapper.append(el("span", label, "as-mini-label"));
    const select = el("select");
    for (const [id, labelText] of values) {
      const option = el("option", labelText);
      option.value = id;
      select.append(option);
    }
    select.value = value || "";
    attr(select, "aria-label", label);
    select.addEventListener("change", () => onChange(select.value));
    wrapper.append(select);
    parent.append(wrapper);
    return select;
  }
  function modelCheck(parent, label, checked, onChange) {
    const wrapper = el("label", undefined, "as-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked === true;
    attr(input, "aria-label", label);
    input.addEventListener("change", () => onChange(input.checked));
    wrapper.append(input, el("span", label));
    parent.append(wrapper);
    return input;
  }
  function setModelsEnabled(state, enabled, rerender, search) {
    const query = search.value.trim().toLowerCase();
    for (const item of state.models) {
      if (query && !`${item.id} ${item.name}`.toLowerCase().includes(query)) continue;
      item.enabled = enabled;
    }
    rerender();
  }
  function readUsage(usageMode, url, remainingPath, unitPath, limitPath, usedPath, validPath) {
    if (usageMode.value !== "custom") {
      return { mode: "auto", remainingPath: "remaining", unitPath: "unit", limitPath: "limit", usedPath: "used", validPath: "isValid" };
    }
    const pathOf = (input, fallback) => input.value.trim() || fallback;
    return {
      mode: "custom", url: url.value.trim(),
      remainingPath: pathOf(remainingPath, "remaining"), unitPath: pathOf(unitPath, "unit"),
      limitPath: pathOf(limitPath, "limit"), usedPath: pathOf(usedPath, "used"),
      validPath: pathOf(validPath, "isValid"),
    };
  }

  function openNameEditor(view, account) {
    const editor = beginEditor(view, "编辑账号", account);
    const form = el("div", undefined, "as-form-body");
    editor.node.append(form);
    const identity = section(form, "账号");
    const name = field(identity, "名称", { value: account.name, field: "name", maxLength: 80 });
    const extra = account.kind === "chatgpt"
      ? button("重新授权", () => openLoginEditor(view, account), { action: "reauth", className: "as-button" })
      : null;
    editorActions(view, form, "保存", async () => {
      await invoke("rename_account", { accountId: account.id, name: name.value.trim() });
      setNotice("名称已保存。");
      closeEditor(view);
      await refresh();
    }, extra);
    name.focus?.();
  }
  function openLoginEditor(view, account) {
    const editor = beginEditor(view, account ? "重新授权" : "添加订阅账号", account);
    const form = el("div", undefined, "as-form-body");
    editor.node.append(form);
    const identity = section(form, "订阅账号");
    const name = field(identity, "账号名称", { value: account?.name || "新的订阅账号", field: "name", maxLength: 80 });
    editorActions(view, form, account ? "开始重新授权" : "开始授权", async () => {
      const operation = await invoke("begin_login", account ? { accountId: account.id } : { name: name.value.trim() });
      closeEditor(view);
      trackOperation(operation);
      setNotice("已发起授权。在官方页面完成登录。");
    });
    name.focus?.();
  }
  async function openImportEditor(view) {
    const editor = beginEditor(view, "导入现有账号", null);
    const loading = el("p", "正在读取可导入配置…", "as-muted");
    editor.node.append(loading);
    let source;
    try { source = await invoke("list_imports"); }
    catch (error) {
      if (stopped || view.editor !== editor) return;
      text(loading, errorText(error));
      return;
    }
    if (stopped || view.editor !== editor) return;
    loading.remove();
    const sources = source?.accounts || [];
    if (!sources.length) {
      editor.node.append(el("p", "未找到可导入配置。先在 CC Switch 中保存 Codex 接入。", "as-muted"));
      editor.node.append(button("返回", () => closeEditor(view), { action: "editor-back" }));
      return;
    }
    const form = el("div", undefined, "as-form-body");
    editor.node.append(form);
    const identity = section(form, "导入来源");
    const sourceSelect = choice(identity, "配置", sources.map(item => [item.id, `${item.name} · ${item.defaultModel || item.model || ""}`]), sources[0].id, { field: "import-source" });
    const baseUrl = field(identity, "接口基础地址", { type: "url", value: sources[0].baseUrl || "", field: "import-base-url", maxLength: 2048 });
    const modelsBox = el("div", undefined, "as-import-models");
    identity.append(modelsBox);
    const selectedModels = new Set();
    function syncSource() {
      const current = sources.find(item => item.id === sourceSelect.value) || sources[0];
      baseUrl.value = current.baseUrl || "";
      baseUrl.parentElement.hidden = current.kind === "chatgpt";
      modelsBox.replaceChildren();
      selectedModels.clear();
      if (!current.models?.length) return;
      modelsBox.append(el("p", "导入模型（可选）", "as-field-label"));
      for (const model of current.models) {
        const id = typeof model === "string" ? model : model.id;
        if (!id) continue;
        selectedModels.add(id);
        const wrapper = el("label", undefined, "as-check");
        const input = el("input");
        input.type = "checkbox";
        input.checked = true;
        attr(input, "aria-label", `导入模型 ${id}`);
        input.addEventListener("change", () => { if (input.checked) selectedModels.add(id); else selectedModels.delete(id); });
        wrapper.append(input, el("span", typeof model === "string" ? model : model.name || id));
        modelsBox.append(wrapper);
      }
    }
    sourceSelect.addEventListener("change", syncSource);
    syncSource();
    editorActions(view, form, "导入所选配置", async () => {
      await invoke("import_account", {
        sourceId: sourceSelect.value, baseUrl: baseUrl.value.trim(),
        ...(selectedModels.size ? { models: [...selectedModels] } : {}),
      });
      setNotice("已导入配置。可以测试连接。");
      closeEditor(view);
      await refresh();
    });
  }

  async function loadThreads(view, options = {}) {
    if (stopped) return;
    if (!connected) {
      view.chat.loaded = true;
      text(view.chat.empty, "账号后台未连接。");
      view.chat.empty.hidden = false;
      return;
    }
    try {
      const data = await invoke("list_threads", { limit: 30 });
      if (stopped) return;
      threads = Array.isArray(data?.threads) ? data.threads : [];
      view.chat.loaded = true;
      clearNotice();
      renderChat(view);
    } catch (error) {
      if (!stopped && !options.silent) setNotice(errorText(error), "error");
    }
  }
  function renderChat(view) {
    view.chat.list.replaceChildren();
    for (const item of threads) {
      const row = el("article", undefined, "as-thread");
      row.dataset.threadId = item.id;
      const copy = el("div", undefined, "as-thread-copy");
      const heading = el("div", undefined, "as-thread-heading");
      heading.append(el("h3", item.title || "未命名聊天"));
      if (item.pinned) heading.append(el("span", "固定", "as-badge"));
      if (item.busy) heading.append(el("span", "运行中", "as-badge as-badge-busy"));
      const meta = el("p", "", "as-thread-meta");
      meta.append(el("span", item.accountName || item.accountId || "未知账号"), el("span", item.modelName || item.model || ""));
      copy.append(heading, meta);
      const same = item.accountId === defaultAccountId;
      const switchButton = button(item.busy ? "运行中" : same ? "当前账号" : "切换此聊天", async () => {
        const operation = await invoke("switch_thread", { threadId: item.id, accountId: defaultAccountId });
        trackOperation(operation);
        setNotice("正在切换聊天…");
      }, { action: "switch-thread", className: "as-button as-small", disabled: item.busy || same || !connected });
      row.append(copy, switchButton);
      view.chat.list.append(row);
    }
    view.chat.empty.hidden = threads.length > 0;
    view.chat.empty.textContent = view.chat.loaded ? "没有最近聊天。" : "正在读取最近聊天…";
  }

  function selectTab(view, name) {
    view.tab = name;
    for (const [key, tab] of [["accounts", view.tabs.accounts], ["chat", view.tabs.chat]]) {
      tab.dataset.selected = String(key === name);
      attr(tab, "aria-selected", String(key === name));
      attr(tab, "tabindex", key === name ? "0" : "-1");
    }
    view.panels.accounts.hidden = name !== "accounts";
    view.panels.chat.hidden = name !== "chat";
    if (name === "chat") void loadThreads(view);
  }
  function renderSettings(root) {
    const shell = el("section", undefined, "as-settings");
    shell.dataset.accountSwitcherSettings = instanceId;

    const tablist = el("div", undefined, "as-tabs");
    attr(tablist, "role", "tablist");
    attr(tablist, "aria-label", "账号设置");
    const accountsTab = el("button", "账号", "as-tab");
    accountsTab.type = "button";
    accountsTab.id = `${instanceId}-tab-accounts`;
    accountsTab.dataset.tab = "accounts";
    attr(accountsTab, "role", "tab");
    accountsTab.addEventListener("click", () => selectTab(view, "accounts"));
    const chatTab = el("button", "聊天", "as-tab");
    chatTab.type = "button";
    chatTab.id = `${instanceId}-tab-chat`;
    chatTab.dataset.tab = "chat";
    attr(chatTab, "role", "tab");
    chatTab.addEventListener("click", () => selectTab(view, "chat"));
    tablist.append(accountsTab, chatTab);
    tablist.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault?.();
      const next = event.key === "Home" ? "accounts" : event.key === "End" ? "chat"
        : view.tab === "accounts" ? "chat" : "accounts";
      selectTab(view, next);
      view.tabs[next].focus?.();
    });

    const noticeNode = el("p", "", "as-notice");
    noticeNode.dataset.notice = "";
    attr(noticeNode, "role", "status");
    attr(noticeNode, "aria-live", "polite");
    noticeNode.hidden = true;
    const operationsNode = el("div", undefined, "as-operations");
    operationsNode.hidden = true;

    const accountsPanel = el("section", undefined, "as-panel");
    accountsPanel.id = `${instanceId}-panel-accounts`;
    attr(accountsPanel, "role", "tabpanel");
    attr(accountsPanel, "aria-labelledby", accountsTab.id);
    const chatPanel = el("section", undefined, "as-panel");
    chatPanel.id = `${instanceId}-panel-chat`;
    attr(chatPanel, "role", "tabpanel");
    attr(chatPanel, "aria-labelledby", chatTab.id);
    chatPanel.hidden = true;

    const head = el("div", undefined, "as-head");
    const headCopy = el("div", undefined, "as-head-copy");
    const currentName = el("strong", "桌面主账号", "as-current");
    const connection = el("span", "", "as-connection");
    attr(connection, "role", "status");
    const historyNode = el("p", "", "as-muted");
    historyNode.hidden = true;
    headCopy.append(currentName, connection, historyNode);
    const headControls = el("div", undefined, "as-head-controls");
    const policyWrap = el("label", undefined, "as-policy");
    policyWrap.append(el("span", "新聊天账号", "as-field-label"));
    const policy = el("select");
    policy.dataset.field = "new-chat-policy";
    attr(policy, "aria-label", "新聊天账号");
    for (const [value, label] of [["default", "默认账号"], ["quota", "按剩余额度自动选择"]]) {
      const option = el("option", label);
      option.value = value;
      policy.append(option);
    }
    policy.addEventListener("change", () => { void setPolicy(policy.value); });
    policyWrap.append(policy);
    const refreshButton = button("刷新", refreshUsage, { action: "refresh", className: "as-button as-small" });
    const batchToggle = button("批量修改", () => {
      view.batch.active = !view.batch.active;
      if (!view.batch.active) {
        view.batch.selected.clear();
        view.batch.results = new Map();
        view.batch.summary.hidden = true;
      }
      updateBatch(view);
      if (!view.batch.active) syncAccountList(view);
    }, { action: "batch-toggle", className: "as-button as-small" });
    attr(batchToggle, "role", "switch");
    attr(batchToggle, "aria-checked", "false");
    batchToggle.dataset.checked = "false";
    const addDetails = el("details", undefined, "as-add");
    addDetails.append(el("summary", "添加账号"));
    const addMenu = el("div", undefined, "as-add-menu");
    const addMenuItems = [
      button("添加模型接入", () => openRelayEditor(view, null), { action: "add-relay", className: "as-add-item" }),
      button("添加订阅账号", () => openLoginEditor(view, null), { action: "add-login", className: "as-add-item" }),
      button("导入现有账号", () => { void openImportEditor(view); }, { action: "add-import", className: "as-add-item" }),
    ];
    addMenu.append(...addMenuItems);
    addMenu.addEventListener("click", () => { addDetails.open = false; });
    addDetails.append(addMenu);
    headControls.append(policyWrap, refreshButton, batchToggle, addDetails);
    head.append(headCopy, headControls);

    const listWrap = el("div", undefined, "as-list-wrap");
    const list = el("div", undefined, "as-list");
    list.dataset.accountsList = "";
    const empty = el("p", "暂无账号。点击“添加账号”。", "as-empty");
    empty.hidden = true;
    listWrap.append(list, empty);
    const editorHost = el("div", undefined, "as-editor-host");
    editorHost.hidden = true;
    accountsPanel.append(head);

    const chatHead = el("div", undefined, "as-head");
    const chatCopy = el("div", undefined, "as-head-copy");
    chatCopy.append(el("span", "最近聊天", "as-overline"));
    const chatControls = el("div", undefined, "as-head-controls");
    const refreshThreads = button("刷新", () => { void loadThreads(view); }, { action: "refresh-threads", className: "as-button as-small" });
    chatControls.append(refreshThreads);
    chatHead.append(chatCopy, chatControls);
    const threadList = el("div", undefined, "as-threads");
    threadList.dataset.threadList = "";
    const threadEmpty = el("p", "正在读取最近聊天…", "as-empty");
    chatPanel.append(chatHead, threadList, threadEmpty);

    attr(accountsTab, "aria-controls", accountsPanel.id);
    attr(chatTab, "aria-controls", chatPanel.id);
    shell.append(tablist, noticeNode, operationsNode, accountsPanel, chatPanel);
    root.replaceChildren(shell);

    const view = {
      shell, tabs: { accounts: accountsTab, chat: chatTab }, panels: { accounts: accountsPanel, chat: chatPanel },
      notice: noticeNode, operations: operationsNode, head, currentName, connection, historyNode, policy,
      refreshButton, batchToggle, listWrap, list, empty, rows: new Map(), editorHost, editor: null,
      onModels: null, modelsOperationId: null, tab: "accounts", policyValue: preferences.newChatAccountPolicy,
      batch: {
        active: false, selected: new Set(), results: new Map(), bar: null, count: null,
        summary: null, settingsForm: null, actionButtons: {},
      },
      chat: { list: threadList, empty: threadEmpty, refreshButton: refreshThreads },
    };
    const batchControls = buildBatch(view);
    view.batch.bar = batchControls.bar;
    view.batch.count = batchControls.count;
    view.batch.summary = batchControls.summary;
    view.batch.settingsForm = batchControls.settingsForm;
    view.batch.actionButtons = batchControls.actionButtons;
    accountsPanel.append(batchControls.bar, listWrap, editorHost);
    view.editorHost = editorHost;
    views.add(view);
    selectTab(view, "accounts");
    renderAll();
    return () => { views.delete(view); root.replaceChildren(); };
  }

  function renderAll() {
    if (stopped) return;
    for (const view of views) {
      const current = defaultAccount();
      text(view.currentName, current?.name || "桌面主账号");
      text(view.connection, connectionText());
      view.connection.dataset.connected = String(connected);
      view.refreshButton.disabled = !connected;
      view.chat.refreshButton.disabled = !connected;
      view.policy.disabled = !connected;
      if (view.policy.value !== preferences.newChatAccountPolicy) view.policy.value = preferences.newChatAccountPolicy;
      updateBatch(view);
      syncAccountList(view);
      renderOperations();
      text(view.notice, notice);
      view.notice.hidden = !notice;
      view.notice.dataset.tone = noticeTone;
    }
    renderSidebar();
  }

  function positionSidebar() {
    if (!sidebar?.open) return;
    const rect = sidebar.trigger.getBoundingClientRect();
    sidebar.panel.style.left = `${Math.max(8, Math.min(rect.right + 10, innerWidth - 360))}px`;
    sidebar.panel.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - sidebar.panel.offsetHeight - 12))}px`;
  }
  function renderSidebar() {
    if (!sidebar) return;
    const current = defaultAccount();
    sidebar.trigger.title = `新聊天账号：${current?.name || "桌面主账号"}`;
    if (!sidebar.open) return;
    const signature = JSON.stringify([accounts, primaryAccount, defaultAccountId, connected, notice, activeOperations().map(item => item.id)]);
    if (sidebar.signature === signature) return;
    sidebar.signature = signature;
    const header = el("div", undefined, "as-picker-header");
    header.append(el("strong", "新聊天账号"));
    const status = el("p", connected ? "选择只影响新聊天。" : "账号后台未连接。", "as-picker-status");
    attr(status, "role", "status");
    const list = el("div", undefined, "as-picker-list");
    sidebar.selectedRow = null;
    for (const account of allAccounts()) {
      const selected = account.id === defaultAccountId;
      const row = button("", () => makeDefault(account.id, account.name), {
        className: "as-picker-account", action: "pick-account",
        disabled: !connected || account.status !== "ready",
      });
      row.dataset.selected = String(selected);
      row.dataset.accountId = account.id;
      attr(row, "role", "menuitemradio");
      attr(row, "aria-checked", String(selected));
      const avatar = el("span", Array.from(account.name.trim())[0]?.toUpperCase() || "A", "as-picker-avatar");
      attr(avatar, "aria-hidden", "true");
      const copy = el("span", undefined, "as-picker-copy");
      const heading = el("span", undefined, "as-picker-heading");
      heading.append(el("span", `${account.name}${account.plan ? ` · ${account.plan}` : ""}`, "as-picker-name"));
      if (selected) heading.append(el("span", "默认", "as-picker-badge"));
      copy.append(heading, el("span", accountStatus(account), "as-picker-meta"));
      const badge = quotaBadge(account);
      const amount = el("span", undefined, "as-picker-amount");
      amount.append(el("span", badge.value), el("small", badge.label));
      row.title = quotaText(account);
      row.append(avatar, copy, amount);
      if (selected) sidebar.selectedRow = row;
      list.append(row);
    }
    const footer = el("div", undefined, "as-picker-footer");
    const manage = button("管理账号", () => { sidebar.panel.hidePopover(); page?.open(); }, { className: "as-text-button", action: "manage-accounts" });
    const refresh = button("刷新额度", () => refreshUsage().catch(error => setNotice(errorText(error), "error")), { className: "as-text-button", action: "sidebar-refresh", disabled: !connected });
    attr(manage, "role", "menuitem");
    attr(refresh, "role", "menuitem");
    footer.append(manage, refresh);
    sidebar.panel.replaceChildren(header, status, list, footer);
    if (notice) {
      const message = el("p", notice, "as-picker-status");
      attr(message, "role", "status");
      sidebar.panel.append(message);
    }
    positionSidebar();
  }
  function mountSidebar() {
    if (stopped || !sidebar) return;
    const rails = [...document.querySelectorAll("nav[data-app-navigation-rail]")].filter(node => node.getBoundingClientRect().width > 0);
    if (rails.length !== 1) {
      sidebar.slot.remove();
      if (sidebar.open) sidebar.panel.hidePopover();
      return;
    }
    const rail = rails[0];
    sidebar.rail = rail;
    if (sidebar.userPlaced && sidebar.slot.isConnected) return;
    sidebar.userPlaced = false;
    const usage = [...rail.children].find(child => child.querySelector?.('[data-codexpp="app-theme-toggle"], [aria-label^="切换为深色外观"]'));
    if (usage) {
      if (usage.firstElementChild !== sidebar.slot) usage.insertBefore(sidebar.slot, usage.firstChild);
    } else if (rail.firstElementChild !== sidebar.slot) rail.insertBefore(sidebar.slot, rail.firstChild);
  }
  function startPointerDrag(pointer) {
    if (!sidebar || sidebar.dragState) return;
    const slot = sidebar.slot;
    const rect = slot.getBoundingClientRect();
    const ghost = slot.cloneNode(true);
    ghost.classList.add("as-drag-ghost");
    ghost.removeAttribute("data-loader-accounts");
    ghost.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.append(ghost);
    const placeholder = el("div", undefined, "as-drag-placeholder");
    placeholder.style.width = `${rect.width}px`;
    placeholder.style.height = `${rect.height}px`;
    slot.parentElement?.insertBefore(placeholder, slot);
    slot.classList.add("as-dragging-source");
    sidebar.dragState = { ghost, placeholder, offsetX: pointer.x - rect.left, offsetY: pointer.y - rect.top, found: null, lastY: pointer.y, before: false };
  }
  function updatePointerDrag(event) {
    const state = sidebar?.dragState;
    if (!state) return;
    state.ghost.style.left = `${event.clientX - state.offsetX}px`;
    state.ghost.style.top = `${event.clientY - state.offsetY}px`;
    const target = document.elementFromPoint?.(event.clientX, event.clientY) || event.target;
    const found = dropAnchor(target, sidebar.rail);
    state.found = found && found.anchor !== sidebar.slot && found.anchor !== state.placeholder ? found : null;
    if (!state.found) return;
    const rect = state.found.anchor.getBoundingClientRect();
    state.before = event.clientY < rect.top + rect.height / 2;
    const anchor = state.before ? state.found.anchor : state.found.anchor.nextSibling;
    if (state.placeholder.parentElement !== state.found.container || state.placeholder.nextSibling !== anchor)
      state.found.container.insertBefore(state.placeholder, anchor);
  }
  function finishPointerDrag() {
    const state = sidebar?.dragState;
    if (!state) return;
    if (state.found) {
      state.found.container.insertBefore(sidebar.slot, state.before ? state.found.anchor : state.found.anchor.nextSibling);
      sidebar.userPlaced = true;
    }
    state.ghost.remove();
    state.placeholder.remove();
    sidebar.slot.classList.remove("as-dragging-source");
    sidebar.dragState = null;
    sidebar.suppressClick = true;
    setTimeout(() => { if (sidebar) sidebar.suppressClick = false; }, 0);
  }
  function pointerMove(event) {
    const pointer = sidebar?.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!sidebar.dragState && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 4) return;
    if (!sidebar.dragState) startPointerDrag(pointer);
    if (sidebar.dragState) { sidebar.dragState.lastY = event.clientY; updatePointerDrag(event); }
  }
  function pointerEnd(event) {
    const pointer = sidebar?.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    window.removeEventListener("pointermove", pointerMove, true);
    window.removeEventListener("pointerup", pointerEnd, true);
    window.removeEventListener("pointercancel", pointerEnd, true);
    sidebar.pointer = null;
    if (sidebar.dragState) finishPointerDrag();
  }
  function dropAnchor(target, rail) {
    let button = target?.closest?.("button");
    if (button && !button.closest(".as-sidebar-slot")) {
      const parent = button.parentElement;
      if (parent && parent !== rail) {
        if (parent.children.length === 1 && parent.parentElement) return { container: parent.parentElement, anchor: parent };
        return { container: parent, anchor: button };
      }
      return { container: rail, anchor: button };
    }
    let node = target;
    while (node && node !== rail) {
      if (node.parentElement === rail) return { container: rail, anchor: node };
      node = node.parentElement;
    }
    return null;
  }
  function startSidebar() {
    const slot = el("div", undefined, "as-sidebar-slot");
    slot.dataset.loaderAccounts = "sidebar";
    const panel = el("div", undefined, "as-picker");
    panel.id = "codex-loader-account-picker";
    panel.setAttribute("popover", "auto");
    attr(panel, "role", "menu");
    attr(panel, "aria-label", "新聊天账号");
    const trigger = button("", () => {
      if (sidebar?.suppressClick) { sidebar.suppressClick = false; return; }
      panel.togglePopover();
    }, { className: "as-sidebar-trigger", label: "账号" });
    attr(trigger, "aria-haspopup", "menu");
    attr(trigger, "aria-expanded", "false");
    attr(trigger, "aria-controls", panel.id);
    trigger.innerHTML = ACCOUNT_ICON;
    slot.append(trigger);
    trigger.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !sidebar) return;
      sidebar.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      trigger.setPointerCapture?.(event.pointerId);
      window.addEventListener("pointermove", pointerMove, true);
      window.addEventListener("pointerup", pointerEnd, true);
      window.addEventListener("pointercancel", pointerEnd, true);
    });
    sidebar = { slot, trigger, panel, open: false, signature: null, observer: null, selectedRow: null, rail: null, userPlaced: false, pointer: null, dragState: null, suppressClick: false };
    panel.addEventListener("toggle", event => {
      sidebar.open = event.newState === "open";
      attr(trigger, "aria-expanded", String(sidebar.open));
      if (!sidebar.open) return;
      sidebar.signature = null;
      renderSidebar();
      sidebar.selectedRow?.focus?.();
      if (connected) refresh().catch(error => setNotice(errorText(error), "error"));
    });
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { panel.hidePopover(); trigger.focus(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...panel.children].flatMap(child => child.children || []).filter(child => child.attributes?.role?.startsWith("menuitem"));
      if (!items.length) return;
      event.preventDefault?.();
      const current = items.indexOf(document.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (Math.max(current, 0) + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index].focus?.();
    });
    document.body.append(panel);
    sidebar.observer = new MutationObserver(mountSidebar);
    sidebar.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", positionSidebar);
    mountSidebar();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(operationTimer); operationTimer = null;
    page?.unregister();
    sidebar?.observer?.disconnect();
    sidebar?.slot?.remove();
    sidebar?.panel?.remove();
    window.removeEventListener("resize", positionSidebar);
    sidebar = null;
    for (const view of views) view.shell?.remove?.();
    views.clear();
    style.remove();
    if (globalThis[GLOBAL]?.instanceId === instanceId) delete globalThis[GLOBAL];
  }

  const style = el("style");
  style.id = STYLE;
  style.textContent = `
    .as-settings,.as-picker { --as-border:color-mix(in srgb,currentColor 12%,transparent); --as-muted:color-mix(in srgb,currentColor 62%,transparent); --as-surface:var(--color-background-primary,var(--color-token-main-surface-primary,Canvas)); color:var(--color-text-primary,var(--color-token-text-primary,CanvasText)); font:13px/1.5 system-ui,sans-serif; }
    .as-settings { max-width:920px; padding:4px 0 28px; } .as-settings *,.as-picker * { box-sizing:border-box; }
    .as-settings [hidden],.as-picker [hidden] { display:none!important; }
    .as-settings h2 { font-size:22px; line-height:1.3; font-weight:500; letter-spacing:-.4px; margin:8px 0 0; }
    .as-settings h3 { font-size:14px; font-weight:500; line-height:1.4; margin:0; }
    .as-settings p { margin:5px 0; } .as-muted,.as-footer { color:var(--as-muted); font-size:12px; }
    .as-tabs { display:flex; gap:4px; border-bottom:1px solid var(--as-border); margin-bottom:14px; }
    .as-tab { appearance:none; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--as-muted); font:inherit; font-size:13px; padding:8px 10px; cursor:pointer; }
    .as-tab[data-selected="true"] { color:inherit; border-bottom-color:currentColor; font-weight:560; }
    .as-notice { font-size:12px; margin:10px 0!important; padding:8px 10px; border:1px solid var(--as-border); border-radius:8px; }
    .as-notice[data-tone="error"] { color:#cf6b59; border-color:color-mix(in srgb,#cf6b59 32%,transparent); }
    .as-operations { display:grid; gap:6px; margin-bottom:10px; }
    .as-operation { display:flex; flex-wrap:wrap; align-items:center; gap:8px; border:1px solid var(--as-border); border-radius:8px; padding:8px 10px; font-size:12px; }
    .as-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:14px; }
    .as-head-copy { min-width:0; flex:1 1 300px; } .as-current { display:inline-block; margin:2px 8px 0 0; font-size:13px; font-weight:560; }
    .as-overline { color:var(--as-muted); font-size:12px; } .as-connection { color:var(--as-muted); font-size:11px; }
    .as-connection[data-connected="true"] { color:var(--color-text-success,#299167); }
    .as-head-controls { display:flex; align-items:flex-end; gap:8px; flex-wrap:wrap; }
    .as-policy { display:grid; gap:4px; font-size:11px; color:var(--as-muted); }
    .as-policy select,.as-field select,.as-field input,.as-import-models select { border:1px solid var(--as-border); border-radius:8px; background:var(--as-surface); color:inherit; padding:7px 9px; font:inherit; font-size:12px; }
    .as-button,.as-text-button,.as-add summary { appearance:none; border:1px solid var(--as-border); border-radius:8px; background:transparent; color:inherit; font:inherit; font-size:12px; line-height:18px; padding:7px 12px; cursor:pointer; }
    .as-button:hover:not(:disabled),.as-text-button:hover:not(:disabled) { background:color-mix(in srgb,currentColor 7%,transparent); }
    .as-button:disabled,.as-text-button:disabled,.as-picker-account:disabled { opacity:.45; cursor:default; }
    .as-small { padding:5px 10px; } .as-primary { background:var(--color-text-primary,var(--color-token-text-primary,CanvasText)); color:var(--as-surface); border-color:transparent; font-weight:600; }
    .as-primary:hover:not(:disabled) { opacity:.86; } .as-text-button { border:0; padding:5px 7px; color:var(--as-muted); } .as-danger { color:#cf6b59; }
    .as-settings button:focus-visible,.as-settings input:focus-visible,.as-settings select:focus-visible,.as-settings summary:focus-visible,.as-sidebar-trigger:focus-visible,.as-picker-account:focus-visible { outline:2px solid var(--color-accent-blue,#3286c9); outline-offset:2px; }
    .as-add { position:relative; } .as-add summary { list-style:none; border-color:transparent; background:var(--color-text-primary,CanvasText); color:var(--as-surface); font-weight:600; }
    .as-add summary::-webkit-details-marker { display:none; }
    .as-add-menu { position:absolute; z-index:9; right:0; top:34px; min-width:160px; display:grid; gap:2px; padding:5px; border:1px solid var(--as-border); border-radius:10px; background:var(--as-surface); box-shadow:0 12px 30px #0002; }
    .as-add-item { border:0; text-align:left; }
    .as-list-wrap { display:grid; gap:10px; } .as-list { display:grid; gap:8px; }
    .as-row { display:flex; align-items:center; gap:12px; min-height:84px; border:1px solid transparent; border-radius:14px; padding:12px 14px; background:color-mix(in srgb,currentColor 4%,transparent); }
    .as-row:hover { background:color-mix(in srgb,currentColor 5.5%,transparent); }
    .as-row[data-selected="true"] { background:color-mix(in srgb,currentColor 6%,transparent); }
    .as-row[data-state="error"] { border-color:color-mix(in srgb,#cf6b59 26%,transparent); }
    .as-row-select { display:grid; place-items:center; } .as-row-select input { width:17px; height:17px; margin:0; }
    .as-avatar { display:grid; place-items:center; width:38px; height:38px; flex-shrink:0; border-radius:50%; background:color-mix(in srgb,currentColor 7%,transparent); font-size:13px; font-weight:550; }
    .as-row-copy { flex:1; min-width:0; } .as-row-heading { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .as-badge { flex-shrink:0; border-radius:5px; padding:1px 6px; color:var(--as-muted); background:color-mix(in srgb,currentColor 5%,transparent); font-size:10px; }
    .as-badge-busy { color:#b7791f; }
    .as-plan { color:var(--as-muted); font-size:10px; border:1px solid var(--as-border); border-radius:4px; padding:0 4px; }
    .as-row-meta { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; margin:3px 0 0!important; }
    .as-status { font-size:11px; color:var(--as-muted); } .as-status[data-state="error"] { color:#cf6b59; } .as-status[data-state="disabled"] { opacity:.7; }
    .as-row-detail { font-size:12px; color:var(--as-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .as-quota { color:var(--as-muted); font-size:11px; margin:3px 0 0!important; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .as-row-result { font-size:11px; margin:3px 0 0!important; }
    .as-row-actions { display:flex; align-items:center; gap:4px; flex-shrink:0; }
    .as-icon-button { display:grid; place-items:center; width:30px; height:30px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--as-muted); cursor:pointer; }
    .as-icon-button svg { width:18px; height:18px; } .as-icon-button:hover { background:color-mix(in srgb,currentColor 7%,transparent); }
    .as-menu { position:relative; } .as-menu-list { position:absolute; z-index:6; right:0; top:34px; min-width:132px; display:grid; gap:2px; padding:5px; border:1px solid var(--as-border); border-radius:10px; background:var(--as-surface); box-shadow:0 12px 30px #0002; }
    .as-menu-list .as-button { border:0; text-align:left; padding:7px 9px; }
    .as-batch { border:1px solid var(--as-border); border-radius:12px; padding:10px 12px; margin-bottom:12px; display:grid; gap:8px; }
    .as-batch-meta,.as-batch-actions { display:flex; align-items:center; gap:4px; flex-wrap:wrap; } .as-batch-count { font-size:12px; font-weight:560; margin-right:6px; }
    .as-batch-settings { border-top:1px solid var(--as-border); padding-top:10px; }
    .as-batch-summary { font-size:12px; margin:0!important; }
    .as-form-body { display:grid; gap:6px; } .as-section { border:1px solid var(--as-border); border-radius:12px; padding:12px 14px 14px; margin:0; }
    .as-legend { font-size:12px; font-weight:560; padding:0 4px; }
    .as-form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:0 14px; }
    .as-field { display:grid; gap:5px; margin-top:10px; font-size:12px; } .as-field-label { color:var(--as-muted); font-size:11px; } .as-field input,.as-field select { width:100%; }
    .as-flags { display:flex; flex-wrap:wrap; gap:10px 16px; margin-top:10px; }
    .as-check { display:flex; align-items:center; gap:7px; font-size:12px; margin-top:8px; } .as-check input { width:17px; height:17px; margin:0; }
    .as-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:14px; }
    .as-manual { display:flex; align-items:flex-end; gap:8px; flex-wrap:wrap; } .as-manual .as-field { flex:1 1 240px; }
    .as-models { display:grid; gap:8px; margin-top:8px; }
    .as-model { display:flex; align-items:flex-start; gap:10px; border:1px solid var(--as-border); border-radius:10px; padding:8px 10px; }
    .as-model-enable { margin-top:2px; min-width:150px; } .as-model-id { font-size:12px; font-weight:550; overflow-wrap:anywhere; }
    .as-model-levels { grid-column:1/-1; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .as-model-grid { flex:1; display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr)); gap:0 10px; }
    .as-mini-field { display:grid; gap:4px; margin-top:4px; } .as-mini-field input,.as-mini-field select { width:100%; border:1px solid var(--as-border); border-radius:6px; background:var(--as-surface); color:inherit; padding:5px 7px; font:inherit; font-size:12px; }
    .as-mini-label { color:var(--as-muted); font-size:10px; } .as-model-flags { grid-column:1/-1; margin-top:2px; }
    .as-result { font-size:12px; margin:8px 0 0!important; color:var(--as-muted); }
    .as-editor { border:1px solid var(--as-border); border-radius:14px; padding:14px 16px 18px; }
    .as-editor-title { margin-top:6px!important; } .as-threads { display:grid; gap:8px; } .as-thread { display:flex; align-items:center; gap:12px; border:1px solid var(--as-border); border-radius:12px; padding:10px 12px; }
    .as-thread-copy { flex:1; min-width:0; } .as-thread-heading { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .as-thread-meta { display:flex; gap:10px; flex-wrap:wrap; color:var(--as-muted); font-size:11px; margin:3px 0 0!important; }
    .as-empty { padding:16px 0; color:var(--as-muted); font-size:12px; }
    .as-sidebar-slot { flex-shrink:0; display:flex; justify-content:center; width:36px; }
    .as-sidebar-trigger { -webkit-app-region:no-drag; -webkit-user-drag:none; touch-action:none; display:grid; place-items:center; width:36px; height:36px; border:0; padding:0; border-radius:10px; cursor:pointer; color:inherit; background:transparent; }
    .as-sidebar-trigger svg { width:20px; height:20px; stroke-width:1.65; }
    .as-sidebar-trigger:hover,.as-sidebar-trigger[aria-expanded="true"] { background:color-mix(in srgb,currentColor 8%,transparent); }
    .as-sidebar-slot.as-dragging-source { opacity:0; }
    .as-drag-placeholder { flex-shrink:0; border-radius:10px; background:color-mix(in srgb,currentColor 10%,transparent); opacity:.6; }
    .as-drag-ghost { position:fixed; z-index:10000; margin:0!important; pointer-events:none; opacity:.92; filter:drop-shadow(0 8px 18px #0004); transform:scale(1.04); transform-origin:center; }
    .as-picker { -webkit-app-region:no-drag; position:fixed; inset:auto; margin:0; padding:0; width:340px; max-width:calc(100vw - 24px); max-height:calc(100vh - 24px); overflow:auto; border:1px solid var(--as-border); border-radius:16px; background:var(--as-surface); box-shadow:0 12px 42px #0003; }
    .as-picker:popover-open { display:block; visibility:visible; }
    .as-picker-header { display:flex; align-items:center; justify-content:space-between; padding:15px 16px 0; } .as-picker-header strong { font-size:13px; font-weight:600; }
    .as-picker-status { color:var(--as-muted); font-size:11px; padding:0 16px; margin:4px 0 10px; }
    .as-picker-list { padding:0 6px; } .as-picker-account { display:flex; align-items:center; gap:10px; min-height:62px; width:100%; border:0; border-radius:10px; padding:10px; margin-bottom:2px; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
    .as-picker-account:hover:not(:disabled),.as-picker-account[data-selected="true"] { background:color-mix(in srgb,currentColor 6%,transparent); }
    .as-picker-heading { display:flex; gap:8px; align-items:center; min-width:0; } .as-picker-name { font-size:13px; font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .as-picker-badge { font-size:10px; color:var(--as-muted); } .as-picker-meta { display:block; font-size:11px; color:var(--as-muted); margin-top:3px; }
    .as-picker-avatar { display:grid; place-items:center; width:28px; height:28px; border-radius:50%; background:color-mix(in srgb,currentColor 7%,transparent); font-size:11px; flex-shrink:0; }
    .as-picker-copy { flex:1; min-width:0; } .as-picker-amount { display:flex; flex-direction:column; align-items:flex-end; gap:2px; font-size:14px; font-variant-numeric:tabular-nums; flex-shrink:0; }
    .as-picker-amount small { font-size:10px; color:var(--as-muted); } .as-picker-footer { display:flex; justify-content:space-between; border-top:1px solid var(--as-border); margin-top:6px; padding:8px 10px; }
    @media(max-width:680px) { .as-row { flex-wrap:wrap; } .as-row-copy { flex-basis:calc(100% - 100px); } .as-row-actions { width:100%; justify-content:flex-end; } .as-head-controls { width:100%; } }
  `;

  try {
    document.head.append(style);
    page = loader.settings.registerPage({ id: "accounts", title: "账号管理", description: "本地账号与中转接入", render: renderSettings });
    startSidebar();
    void connect();
  } catch (error) {
    stop();
    throw error;
  }
  globalThis[GLOBAL] = {
    version: VERSION,
    instanceId,
    getStatus: () => ({
      connected,
      accountCount: accounts.length,
      routingAvailable,
      backendRevision: null,
      backendState: null,
      sidebarMounted: Boolean(sidebar?.slot.isConnected),
      sidebarOpen: sidebar?.open === true,
      activeOperations: activeOperations().length,
      tab: [...views][0]?.tab || null,
      threadCount: threads.length,
    }),
    stop,
  };
})();
