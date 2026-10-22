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
  const loader = api;
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let stopped = false, connected = false, polling = null, page = null, sidebar = null, refreshTimer = null, refreshing = false;
  let accounts = [], defaultAccountId = "primary", notice = "", routingAvailable = false, primaryAccount = null;
  let accountCommandProtocol = 1, backendUpdate = null;
  const views = new Set(), operations = new Map();
  let globalAccount = { pendingThreads: 0, busyThreads: 0, failedThreads: 0 };
  const messages = {
    ACCOUNT_BUSY: "这个账号仍有进行中的聊天或操作，请结束后再试。",
    ACCOUNT_NOT_READY: "请先完成登录或启用这个账号。",
    ACCOUNT_NAME_INVALID: "名称需要包含 1–80 个字符。",
    ACCOUNT_ALREADY_EXISTS: "这个账号和工作区已经存在。",
    ACCOUNT_REMOVED: "这个账号已从列表移除。",
    ACCOUNT_HAS_THREADS: "仍有聊天绑定这个账号。请先将这些聊天切换到其他账号。",
    ROUTER_NOT_CONNECTED: "聊天路由尚未连接。请通过支持账号路由的 Loader 启动 Codex。",
    THREAD_BUSY: "当前轮或关联子任务仍在运行，请结束后再切换。",
    THREAD_SWITCHING: "这个聊天正在切换账号，请稍候。",
    SWITCH_FAILED: "切换未完成，聊天仍保留原账号归属。",
    AUTHENTICATION_FAILED: "认证未通过，请检查密钥或重新登录。",
    BACKEND_BUSY: "后台仍有操作在进行，请先完成或取消。",
    BACKEND_UNAVAILABLE: "账号后台未连接，请在 Loader 设置中检查账号模块状态。",
    ACCOUNT_MODULE_UNAVAILABLE: "账号后台未连接，请在 Loader 设置中重新启用账号模块。",
    ACCOUNT_MODULE_DISABLED: "账号模块已关闭，请在 Loader 设置中启用。",
    ACCOUNT_MODULE_SAFE_MODE: "安全模式下不启动账号模块。",
    BACKEND_OPERATION_DENIED: "当前 Loader 不支持这项操作。",
    CONNECTION_FAILED: "连接失败，请检查网络和接口地址。",
    CONNECTION_TIMEOUT: "请求超时，请稍后重试。",
    ENDPOINT_INVALID: "请输入不含密钥或查询参数的 HTTPS 接口地址。",
    IMPORT_ORIGIN_CHANGED: "导入时只能调整原服务的接口路径，不能更换密钥的目标网站。",
    IMPORT_SOURCE_UNAVAILABLE: "没有找到可导入的 CC Switch 配置。",
    IMPORT_SOURCE_UNSUPPORTED: "暂时无法读取这份 CC Switch 配置。",
    IMPORT_SOURCE_BUSY: "CC Switch 配置正在写入，请稍后重试。",
    PROVIDER_INVALID: "请选择支持的模型接入类型。",
    PROVIDER_ORIGIN_MISMATCH: "接口地址需要属于所选服务；其他服务请选择自定义。",
    PROVIDER_KEY_REQUIRED: "请输入 API Key。更换服务网站时需要重新填写密钥。",
    PROVIDER_PROFILE_REQUIRED: "这条记录没有可编辑的模型配置。",
    PROVIDER_CONFIGURATION_MANAGED: "这条接入已使用配置版本管理，请从“编辑配置”修改，重复导入不会覆盖它。",
    MODEL_DISCOVERY_UNSUPPORTED: "服务没有提供模型列表，请手动填写模型 ID 和高级设置。",
    MODEL_INVALID: "请填写完整模型 ID，不包含空格。",
    MODEL_OR_ENDPOINT_NOT_FOUND: "没有找到模型或 Responses 接口。请获取官方模型列表后选择，并核对接口基础地址。",
    MODEL_SETTINGS_INVALID: "请检查上下文长度和模型能力设置。",
    CONFIGURATION_INVALID: "未找到有效的配置版本。",
    CONFIGURATION_CHANGED: "配置已更新，请刷新列表后重新打开。",
    CONFIGURATION_VERSION_UNSUPPORTED: "此配置由不同格式的版本保存，请使用支持它的 Loader。",
    INPUT_INVALID: "请检查填写的内容。",
    LOGIN_FAILED: "登录未完成，可以重新发起授权。",
    LOGIN_ALREADY_RUNNING: "已有一个账号正在授权，请完成或取消后再添加。",
    OFFICIAL_CLI_UNAVAILABLE: "未找到可验证的官方 Codex 后端，请先正常启动一次 Codex。",
    RATE_LIMITED: "服务暂时限制了请求，请稍后重试或检查额度。",
    RESPONSE_INCOMPLETE: "服务未返回完整结果。",
    RESPONSE_INVALID: "服务返回的内容不符合预期。",
    SERVICE_UNAVAILABLE: "服务暂时不可用，请检查接口地址和模型。",
    STORAGE_UNAVAILABLE: "无法访问本地账号数据。",
    TOO_MANY_OPERATIONS: "已有三个操作在进行，请稍后再试。",
    USAGE_UNAVAILABLE: "账号可用，但暂时无法读取额度。",
  };

  function errorText(error) { return messages[error?.code || error?.message || error] || "操作未完成，请重试。"; }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, action, options = {}) {
    const node = element("button", text, options.className || "as-button");
    node.type = "button";
    node.disabled = options.disabled || false;
    node.addEventListener("click", () => {
      if (node.disabled || stopped) return;
      Promise.resolve().then(action).catch(error => {
        if (!stopped) { notice = errorText(error); renderNotices(); }
      });
    });
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
  function busy(id) { return [...operations.values()].some(item => item.accountId === id && ["running", "waiting_auth"].includes(item.state)); }
  function field(form, label, value = "", type = "text") {
    const wrapper = element("label", undefined, "as-field");
    wrapper.append(element("span", label));
    const input = element("input");
    input.type = type;
    input.value = value;
    input.autocomplete = "off";
    input.maxLength = type === "url" ? 2048 : 80;
    wrapper.append(input);
    form.append(wrapper);
    return input;
  }
  function openForm(view, title) {
    view.modelsOperationId = null; view.onModels = null;
    view.form.replaceChildren();
    view.form.hidden = false;
    view.form.append(element("h3", title));
    return view.form;
  }
  function closeForm(view) { view.modelsOperationId = null; view.onModels = null; view.form.hidden = true; view.form.replaceChildren(); }
  function formActions(view, submitText, submit) {
    const row = element("div", undefined, "as-actions");
    let saving = false;
    const save = button(submitText, async () => {
      if (saving) return;
      saving = true; save.disabled = true;
      try { await submit(); closeForm(view); await refresh(); }
      finally { saving = false; save.disabled = false; }
    }, { className: "as-button as-primary" });
    row.append(save, button("取消", () => closeForm(view)));
    view.form.append(row);
  }
  function openLogin(view, account) {
    const form = openForm(view, account ? "重新授权" : "添加订阅账号");
    form.append(element("p", "在官方页面完成授权。桌面的主登录保持不变。", "as-muted"));
    const name = account ? null : field(form, "账号名称", "新的订阅账号");
    formActions(view, "开始授权", async () => {
      const operation = await invoke("begin_login", account ? { accountId: account.id } : { name: name.value.trim() });
      operations.set(operation.id, operation);
      schedulePoll();
    });
    name?.focus();
  }
  async function openImport(view) {
    const source = await invoke("list_imports");
    if (stopped || !views.has(view)) return;
    const form = openForm(view, "导入已有账号");
    form.append(element("p", "可导入 CC Switch 的 Codex 接入或已保存的订阅账号快照。只复制选中记录，不更改来源配置。", "as-muted"));
    if (!source.accounts?.length) {
      form.append(element("p", "未找到可导入的 Responses 接入或订阅账号快照。"));
      form.append(button("关闭", () => closeForm(view)));
      return;
    }
    const label = element("label", undefined, "as-field");
    label.append(element("span", "接入配置"));
    const select = element("select");
    for (const account of source.accounts) {
      const option = element("option", `${account.name} · ${account.model}`);
      option.value = account.id; select.append(option);
    }
    label.append(select); form.append(label);
    const endpoint = field(form, "接口基础地址", source.accounts[0].baseUrl, "url");
    const hint = element("p", "保留服务要求的接口路径，例如 /v1。重复导入会更新同一条记录。", "as-muted");
    form.append(hint);
    function updateSource() {
      const selected = source.accounts.find(item => item.id === select.value) || source.accounts[0];
      endpoint.value = selected.baseUrl || "";
      endpoint.parentElement.hidden = selected.kind === "chatgpt";
      hint.hidden = selected.kind === "chatgpt";
    }
    select.addEventListener("change", updateSource);
    updateSource();
    formActions(view, "导入所选配置", async () => {
      await invoke("import_account", { sourceId: select.value, baseUrl: endpoint.value.trim() });
      notice = "配置已导入，可以测试连接。";
    });
  }
  function openRename(view, account) {
    const form = openForm(view, "修改账号名称");
    const input = field(form, "名称", account.name);
    formActions(view, "保存名称", () => invoke("rename_account", { accountId: account.id, name: input.value.trim() }));
    input.focus();
  }
  function choice(form, label, values, value) {
    const wrapper = element("label", undefined, "as-field");
    wrapper.append(element("span", label));
    const select = element("select");
    for (const [id, text] of values) {
      const option = element("option", text); option.value = id; select.append(option);
    }
    select.value = value; wrapper.append(select); form.append(wrapper);
    return select;
  }
  async function openProvider(view, account) {
    const saved = account ? await invoke("get_provider_configuration", { accountId: account.id }) : null;
    if (stopped || !views.has(view)) return;
    const form = openForm(view, account ? "编辑模型配置" : "添加模型接入");
    form.append(element("p", "使用支持 Responses 的模型接口。保存后可测试连接，再从账号列表切换使用。", "as-muted"));
    const grid = element("div", undefined, "as-provider-grid"); form.append(grid);
    const name = field(grid, "接入名称", account?.name || "DeepSeek");
    const provider = choice(grid, "服务", [["deepseek", "DeepSeek"], ["openrouter", "OpenRouter"], ["custom", "自定义 Responses"]], saved?.settings.provider || "deepseek");
    const key = field(grid, account ? "API Key（留空保留，换网站需重填）" : "API Key", "", "password"); key.maxLength = 8192;
    const picker = choice(grid, "模型", [["", "手动填写模型 ID"]], "");
    const model = field(grid, "模型 ID", ""); model.maxLength = 160;
    model.placeholder = "完整模型 ID，或输入关键词后获取模型";
    const advanced = element("details", undefined, "as-provider-advanced");
    advanced.append(element("summary", "高级设置 · 根据模型自动填写，可手动调整"));
    const options = element("div", undefined, "as-provider-grid"); advanced.append(options); form.append(advanced);
    const endpoint = field(options, "接口基础地址", "", "url");
    const context = field(options, "上下文长度（tokens）", "", "number"); context.min = "1024"; context.step = "1";
    const effort = choice(options, "推理强度", [["", "不发送推理参数"], ...["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(value => [value, value])], "");
    const tools = choice(options, "补丁工具格式", [["function", "Function"], ["freeform", "Freeform（模型需支持）"]], "function");
    const images = field(options, "支持图片输入", "", "checkbox");
    const parallel = field(options, "支持并行工具调用", "", "checkbox");
    const catalogHint = element("p", "DeepSeek 预设已按官方说明配置。其他服务可获取模型列表，或展开高级设置手动填写。", "as-muted");
    let models = [];
    const canKeepDefaults = saved?.legacy || saved?.settings.useDefaultModelMetadata;
    function updateMetadataControls() {
      const keepDefaults = canKeepDefaults && !context.value && model.value === saved.settings.model;
      effort.disabled = tools.disabled = images.disabled = parallel.disabled = Boolean(keepDefaults);
    }
    context.addEventListener("input", updateMetadataControls);
    model.addEventListener("input", updateMetadataControls);
    function setEffort(levels, selected) {
      const supported = levels?.length ? levels : provider.value === "deepseek" ? ["low", "high", "max"] : ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
      effort.replaceChildren();
      for (const [id, label] of [["", "不发送推理参数"], ...supported.map(value => [value, value])]) {
        const option = element("option", label); option.value = id; effort.append(option);
      }
      effort.value = selected || "";
    }
    function chooseModel() {
      const selected = models.find(item => item.id === picker.value);
      model.parentElement.hidden = Boolean(selected);
      if (!selected) return;
      model.value = selected.id;
      context.value = String(selected.contextWindow || "");
      setEffort(selected.reasoningLevels, selected.defaultReasoningEffort);
      images.checked = selected.supportsImages === true;
      parallel.checked = selected.parallelToolCalls === true;
      tools.value = selected.toolFormat || "function";
      catalogHint.textContent = selected.supportsTools === false ? "此模型未声明工具调用支持，暂不适合作为 Codex 编码模型。"
        : selected.contextWindow ? "模型参数已填写。保存后可测试连接。" : "服务未提供此模型的上下文长度，请在高级设置中填写。";
      if (!selected.contextWindow) advanced.open = true;
      updateMetadataControls();
    }
    function showModels(items) {
      models = items;
      picker.replaceChildren();
      for (const [id, label] of [["", "手动填写模型 ID"], ...items.map(item => [item.id, `${item.name} · ${item.id}`])]) {
        const option = element("option", label); option.value = id; picker.append(option);
      }
      picker.value = items.find(item => item.id === model.value || item.name.toLocaleLowerCase() === model.value.toLocaleLowerCase())?.id || "";
      model.parentElement.hidden = Boolean(picker.value);
    }
    picker.addEventListener("change", chooseModel);
    function fill(settings) {
      endpoint.value = settings.baseUrl; model.value = settings.model; context.value = String(settings.contextWindow || "");
      setEffort(null, settings.reasoningEffort); tools.value = settings.toolFormat;
      images.checked = settings.supportsImages; parallel.checked = settings.parallelToolCalls;
      updateMetadataControls();
    }
    function preset() {
      fill(provider.value === "deepseek"
        ? { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", contextWindow: 1048576, reasoningEffort: "high", toolFormat: "freeform", supportsImages: true, parallelToolCalls: true }
        : { baseUrl: provider.value === "openrouter" ? "https://openrouter.ai/api/v1" : "", model: "", contextWindow: "", toolFormat: "function", supportsImages: false, parallelToolCalls: false });
      showModels(provider.value === "deepseek" ? [
        { id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 1048576, defaultReasoningEffort: "high", supportsImages: true, supportsTools: true, toolFormat: "freeform", parallelToolCalls: true },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1048576, defaultReasoningEffort: "high", supportsImages: false, supportsTools: true, toolFormat: "freeform", parallelToolCalls: true },
      ] : []);
      advanced.open = provider.value === "custom";
    }
    preset();
    if (saved) { fill(saved.settings); showModels(models); }
    provider.addEventListener("change", () => { preset(); key.value = ""; view.modelsOperationId = null; });
    const discover = button("获取模型并自动配置", async () => {
      const requestProvider = provider.value, requestEndpoint = endpoint.value.trim();
      const operation = await invoke("begin_provider_models", { provider: requestProvider, baseUrl: requestEndpoint, apiKey: key.value.trim(), query: model.value.trim(), ...(account ? { accountId: account.id } : {}) });
      view.modelsOperationId = operation.id;
      view.onModels = items => {
        if (provider.value !== requestProvider || endpoint.value.trim() !== requestEndpoint) return;
        showModels(items);
        if (picker.value) chooseModel();
        else catalogHint.textContent = items.length ? `已读取 ${items.length} 个匹配模型，请选择。可手动填写关键词后重新获取。` : "没有找到匹配模型，请检查模型 ID 或搜索关键词。";
      };
      operations.set(operation.id, operation); renderAll(); schedulePoll();
    });
    form.append(discover, catalogHint);
    if (canKeepDefaults) form.append(element("p", "保留同一模型时，修改密钥或地址可沿用原有模型默认参数。填写上下文长度后才会启用自定义高级参数。原配置会保留为可恢复版本。", "as-muted"));
    formActions(view, account ? "保存为新版本" : "保存模型接入", async () => {
      const contextWindow = Number(context.value);
      const useDefaultModelMetadata = Boolean(canKeepDefaults && contextWindow === 0 && model.value.trim() === saved.settings.model);
      if (!Number.isInteger(contextWindow) || (contextWindow < 1024 && !useDefaultModelMetadata) || contextWindow > 2147483647) { advanced.open = true; throw new Error("MODEL_SETTINGS_INVALID"); }
      await invoke(account ? "save_provider_configuration" : "create_provider", {
        ...(account ? { accountId: account.id } : {}), name: name.value.trim(), apiKey: key.value.trim(),
        settings: { provider: provider.value, baseUrl: endpoint.value.trim(), model: model.value.trim(), contextWindow, useDefaultModelMetadata,
          reasoningEffort: effort.value || null, supportsImages: images.checked, toolFormat: tools.value, parallelToolCalls: parallel.checked },
      });
      key.value = "";
      notice = account ? "新版本已保存。" : "模型接入已保存，可以测试连接。";
    });
    if (saved?.versions?.length) {
      const history = element("div", undefined, "as-version-history");
      history.append(element("p", `当前配置 v${saved.activeVersion} · 恢复历史版本也会恢复该版本的密钥。`, "as-muted"));
      const version = choice(history, "配置历史", saved.versions.map(item => [String(item.version), `v${item.version} · ${item.model} · ${new Date(item.createdAt).toLocaleDateString()}`]), String(saved.activeVersion));
      history.append(button("恢复此版本", async () => {
        await invoke("activate_provider_version", { accountId: account.id, version: Number(version.value) });
        closeForm(view); notice = `已恢复配置 v${version.value}。`; await refresh();
      }));
      form.append(history);
    }
    name.focus();
  }
  function openRemove(view, account) {
    const form = openForm(view, "移除账号");
    form.append(element("p", `将“${account.name}”从可选列表移除。本机保存的凭证与历史会保留；桌面主账号不受影响。`));
    formActions(view, "从列表移除", async () => {
      await invoke("remove_account", { accountId: account.id });
      notice = "已从列表移除，原数据已保留。";
    });
  }
  function creditText(account) {
    const credits = account.credits;
    if (!credits) return null;
    return credits.unlimited ? "Credits 不限额" : credits.balance != null ? `余额 ${credits.balance}${/[a-z]/i.test(credits.balance) ? "" : " Credits"}`
      : credits.hasCredits ? "Credits 可用" : "无可用 Credits";
  }
  function remaining(window) { return Number.isFinite(window?.usedPercent) ? Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent))) : null; }
  function quotaText(account) {
    const parts = [];
    const credits = creditText(account); if (credits) parts.push(credits);
    for (const window of account.usage || []) {
      const label = window.windowDurationMins === 10080 ? "每周" : window.windowDurationMins === 300 ? "5 小时" : "额度";
      const value = remaining(window);
      parts.push(value === null ? `${label}待刷新` : `${label}剩余 ${value}%`);
    }
    return parts.join(" · ") || (account.status === "pending" ? "登录后查看额度" : account.kind === "relay" ? "暂不支持此接入的余额查询" : "额度待刷新");
  }
  function quotaBadge(account) {
    if (account.credits) return { value: account.credits.unlimited ? "不限额" : account.credits.balance ?? "—",
      label: /[a-z]/i.test(account.credits.balance || "") ? "余额" : "Credits" };
    const window = account.usage?.find(item => item.windowDurationMins === 10080) || account.usage?.[0];
    const value = remaining(window);
    return { value: value === null ? "—" : `${value}%`, label: window?.windowDurationMins === 10080 ? "每周剩余" : window?.windowDurationMins === 300 ? "5 小时剩余" : "余额 / 额度" };
  }
  function renderAccounts(view) {
    const query = (view.search?.value || "").trim().toLocaleLowerCase();
    const snapshot = JSON.stringify([accounts, primaryAccount, defaultAccountId, query, [...operations.values()]]);
    if (view.accountsSnapshot === snapshot) return;
    view.accountsSnapshot = snapshot;
    view.list.replaceChildren();
    const shown = allAccounts().filter(account => `${account.name} ${account.email || ""} ${account.plan || ""} ${account.baseUrl || ""} ${account.model || ""}`.toLocaleLowerCase().includes(query));
    view.count.textContent = `${allAccounts().length} 个账号`;
    for (const account of shown) {
      const current = account.id === defaultAccountId;
      const card = element("article", undefined, "as-card");
      card.dataset.accountId = account.id; card.dataset.selected = String(current);
      const avatar = element("span", Array.from(account.name.trim())[0]?.toUpperCase() || "A", "as-avatar");
      avatar.setAttribute("aria-hidden", "true");
      const heading = element("div", undefined, "as-card-heading");
      heading.append(element("h3", account.name));
      if (current) heading.append(element("span", "当前全局", "as-badge"));
      if (account.configurationVersion) heading.append(element("span", `配置 v${account.configurationVersion}`, "as-plan"));
      const metadata = element("span", account.email || account.baseUrl || (account.id === "primary" ? "Codex 桌面登录" : "订阅账号"), "as-account-detail");
      metadata.title = metadata.textContent;
      const detail = element("div", undefined, "as-account-meta"); detail.append(metadata);
      if (account.plan) detail.append(element("span", account.plan, "as-plan"));
      if (account.model) detail.append(element("span", account.model, "as-account-detail"));
      const status = element("span", accountState(account), "as-status");
      status.dataset.state = account.lastError && account.lastError !== "USAGE_UNAVAILABLE" ? "error" : account.status;
      detail.append(status);
      const quota = element("p", quotaText(account), "as-quota-summary"); quota.title = quota.textContent;
      const actions = element("div", undefined, "as-card-actions");
      if (account.id !== "primary" || !current) {
        const menu = element("details", undefined, "as-account-menu");
        const trigger = element("summary"); trigger.innerHTML = MORE_ICON; trigger.setAttribute("aria-label", `${account.name}的账号操作`);
        const items = element("div", undefined, "as-menu-actions");
        const disabled = !connected || busy(account.id);
        if (account.id !== "primary" && account.kind === "relay" && account.status === "ready") items.append(button("编辑配置", () => openProvider(view, account), { disabled }));
        if (!current && account.status === "ready") items.append(button("切换到此账号", () => selectAccount(account.id), { disabled }));
        if (account.id !== "primary" && account.status === "ready") items.append(button("测试连接", async () => {
          const operation = await invoke("begin_probe", { accountId: account.id });
          operations.set(operation.id, operation); renderAll(); schedulePoll();
        }, { disabled }));
        if (account.id !== "primary" && account.kind === "chatgpt" && account.status !== "disabled")
          items.append(button(account.status === "pending" ? "继续登录" : "重新授权", () => openLogin(view, account), { disabled }));
        if (account.id !== "primary") items.append(button("改名", () => openRename(view, account), { disabled }));
        if (account.id !== "primary" && account.status !== "pending") items.append(button(account.status === "disabled" ? "启用" : "停用", async () => {
          await invoke("set_enabled", { accountId: account.id, enabled: account.status === "disabled" }); await refresh();
        }, { disabled }));
        if (account.id !== "primary") items.append(button("移除", () => openRemove(view, account), { disabled, className: "as-button as-danger" }));
        menu.append(trigger, items); actions.append(menu);
        menu.addEventListener("keydown", event => { if (event.key === "Escape") { menu.open = false; trigger.focus(); } });
        items.addEventListener("click", () => { menu.open = false; });
      }
      const identity = element("div", undefined, "as-card-copy"); identity.append(heading, detail, quota);
      card.append(avatar, identity, actions);
      view.list.append(card);
    }
    if (!shown.length) view.list.append(element("p", "没有匹配的账号。", "as-empty"));
  }
  function renderNotices() {
    renderSidebar();
    for (const view of views) {
      view.notice.textContent = notice;
      view.notice.hidden = !notice;
    }
  }
  function renderOperations(view) {
    const snapshot = JSON.stringify([...operations.values()].filter(item => ["running", "waiting_auth"].includes(item.state)));
    if (view.operationsSnapshot === snapshot) return;
    view.operationsSnapshot = snapshot;
    view.operations.replaceChildren();
    for (const operation of operations.values()) {
      if (!["running", "waiting_auth"].includes(operation.state)) continue;
      const row = element("div", undefined, "as-operation");
      const progress = { models: "正在获取模型与能力…", probe: "正在测试连接…", switch: "正在安全交接聊天，请稍候…", usage: "正在刷新账号与额度…", login: "正在准备授权…" };
      row.append(element("span", operation.state === "waiting_auth" ? "请在官方页面完成账号授权" : progress[operation.kind] || "正在处理…"));
      if (operation.authUrl) row.append(button("打开官方授权页", () => {
        const url = new URL(operation.authUrl);
        if (url.origin !== "https://auth.openai.com") throw new Error("LOGIN_FAILED");
        window.open(operation.authUrl, "_blank", "noopener,noreferrer");
      }));
      row.append(button("取消操作", async () => { await invoke("cancel_operation", { operationId: operation.id }); schedulePoll(); }));
      view.operations.append(row);
    }
  }
  function renderAll() {
    if (stopped) return;
    for (const view of views) {
      view.currentName.textContent = allAccounts().find(account => account.id === defaultAccountId)?.name || "桌面主账号";
      view.currentStatus.textContent = globalMessage();
      view.currentStatus.hidden = !routingAvailable || !(globalAccount.pendingThreads || globalAccount.failedThreads);
      view.retry.hidden = !globalAccount.failedThreads;
      view.connection.textContent = connected ? "本地后台已连接" : "本地后台未连接";
      view.connection.dataset.connected = String(connected);
      view.backendStatus.textContent = ({ checking: "正在检查账号后台更新…", waiting: "账号后台更新已排队，等待登录或连接检测完成。聊天可继续。", switching: "正在更新账号管理后台，聊天连接保持运行。", succeeded: "账号后台已更新。", failed: "账号后台更新未完成，原有聊天连接保持运行。" })[backendUpdate?.state] || "";
      view.backendStatus.hidden = !view.backendStatus.textContent;
      view.import.disabled = view.login.disabled = view.provider.disabled = !connected;
      view.requirement.hidden = connected;
      view.boundary.hidden = routingAvailable;
      renderAccounts(view); renderOperations(view);
    }
    renderSidebar();
    renderNotices();
  }
  async function refresh() {
    const snapshot = await invoke("list_accounts");
    if (stopped) return;
    accounts = snapshot.accounts; defaultAccountId = snapshot.defaultAccountId;
    routingAvailable = snapshot.routingAvailable === true;
    primaryAccount = snapshot.primaryAccount || null;
    backendUpdate = snapshot.backendUpdate || null;
    globalAccount = snapshot.globalAccount || { pendingThreads: 0, busyThreads: 0, failedThreads: 0 };
    renderAll();
  }
  async function connect() {
    notice = "";
    try {
      if (!loader.backend) throw new Error("BACKEND_UNAVAILABLE");
      const state = await loader.backend.status();
      if (state.state !== "running") throw new Error(state.errorCode || "BACKEND_UNAVAILABLE");
      const status = await invoke("status");
      if (stopped) return;
      accountCommandProtocol = status.accountCommandProtocol === 2 ? 2 : 1;
      connected = true;
      for (const operation of status.operations || []) operations.set(operation.id, operation);
      await refresh();
      schedulePoll();
    } catch (error) {
      if (stopped) return;
      connected = false; notice = errorText(error); renderAll();
    }
  }
  function schedulePoll() {
    if (stopped || polling || ![...operations.values()].some(item => ["running", "waiting_auth"].includes(item.state))) return;
    polling = setTimeout(async () => {
      polling = null;
      let changed = false;
      try {
        for (const operation of [...operations.values()]) {
          if (!["running", "waiting_auth"].includes(operation.state)) continue;
          const updated = await invoke("operation_status", { operationId: operation.id });
          if (stopped) return;
          operations.set(updated.id, updated);
          if (updated.kind === "models" && updated.state === "completed") {
            for (const view of views) if (view.modelsOperationId === updated.id) { view.onModels?.(updated.models || []); view.modelsOperationId = null; }
          }
          if (updated.state !== operation.state) changed = true;
          if (updated.state === "completed") notice = updated.kind === "models" ? "模型列表已获取。" : updated.kind === "usage" ? "账号与额度已刷新。" : updated.kind === "switch" ? "聊天账号已切换，历史已保留。" : updated.kind === "probe" ? "连接测试通过。" : "账号授权完成。";
          if (updated.state === "failed") notice = errorText(updated.errorCode);
          if (updated.state === "cancelled") notice = "操作已取消。";
        }
        if (changed) await refresh();
      } catch (error) {
        if (!stopped) { notice = errorText(error); renderNotices(); }
        return;
      }
      schedulePoll();
    }, 1000);
  }
  function renderSettings(root) {
    const shell = element("section", undefined, "as-settings");
    shell.dataset.accountSwitcherSettings = instanceId;
    const header = element("div", undefined, "as-header");
    const title = element("div");
    title.append(element("h2", "账号管理"), element("p", "一个全局账号，连接所有本地聊天。", "as-muted"));
    const connection = element("span", "", "as-connection");
    header.append(title);
    const boundary = element("div", undefined, "as-boundary");
    boundary.append(element("strong", "重启一次，接入账号路由"),
      element("p", "你已启用账号模块。请退出 Codex 后通过 Loader 重新启动，之后日常切换无需重启。"));
    const toolbar = element("div", undefined, "as-actions");
    const view = { shell, connection, boundary, currentName: element("strong", "", "as-current-name"), currentStatus: element("p", "", "as-current-status"), list: element("div", undefined, "as-list"),
      form: element("section", undefined, "as-form"), notice: element("p", "", "as-notice"),
      operations: element("div"), count: element("span", "", "as-muted"), backendStatus: element("p", "", "as-muted"),
      requirement: element("p", "请在 Loader 设置中检查账号模块状态，然后重新连接。", "as-muted") };
    view.form.hidden = true; view.notice.setAttribute("role", "status"); view.notice.setAttribute("aria-live", "polite");
    view.import = button("导入账号", () => openImport(view));
    view.login = button("添加订阅账号", () => openLogin(view), { className: "as-button as-primary" });
    view.provider = button("添加模型接入", () => openProvider(view));
    toolbar.append(button("刷新额度", refreshUsage), view.import, view.provider, view.login);
    header.append(toolbar);
    const summary = element("div", undefined, "as-global-panel");
    view.retry = button("重试未完成的切换", () => selectAccount(defaultAccountId), { className: "as-text-button" });
    summary.append(element("span", "全局账号", "as-overline"), view.currentName, connection, view.retry);
    const listHeader = element("div", undefined, "as-list-header");
    const search = element("input");
    search.type = "search"; search.placeholder = "搜索名称、邮箱或服务";
    search.setAttribute("aria-label", "搜索账号");
    search.addEventListener("input", () => renderAccounts(view));
    view.search = search;
    listHeader.append(view.count, search);
    shell.append(header, summary, view.currentStatus, view.backendStatus, boundary, view.requirement, view.notice, view.operations, view.form, listHeader, view.list,
      element("p", "切换保留聊天历史。账号凭证仅保存在本机。", "as-footer"));
    root.replaceChildren(shell); views.add(view); renderAll();
    return () => { views.delete(view); root.replaceChildren(); };
  }
  function accountState(account) {
    if (account.status === "disabled") return "已停用";
    if (account.status === "pending") return "等待登录";
    if (busy(account.id)) return "操作进行中";
    if (account.lastError === "AUTHENTICATION_FAILED") return "需要重新登录";
    if (account.lastError && account.lastError !== "USAGE_UNAVAILABLE") return "连接异常";
    if (account.id === "primary" && !primaryAccount) return "沿用桌面账号 · 待读取";
    if (!account.lastCheckedAt) return account.kind === "relay" ? "已保存接入 · 待验证" : "已保存登录 · 待验证";
    return account.kind === "relay" ? "连接正常" : "已登录";
  }
  function allAccounts() {
    return [{ ...primaryAccount, id: "primary", name: "桌面主账号", status: "ready", kind: primaryAccount?.kind || "chatgpt" }, ...accounts];
  }
  function globalMessage() {
    if (!connected) return "账号后台未连接";
    if (!routingAvailable) return "全局选择已保存，重启 Codex 后接入聊天路由";
    if (globalAccount.failedThreads) return `${globalAccount.failedThreads} 个聊天切换未完成，原账号和历史已保留`;
    if (globalAccount.busyThreads) return `${globalAccount.busyThreads} 个聊天正在运行，将在本轮结束后切换`;
    if (globalAccount.pendingThreads) return `正在切换 ${globalAccount.pendingThreads} 个聊天，保留原历史`;
    return "所有本地聊天使用此账号";
  }
  async function selectAccount(accountId) {
    await invoke("set_default", { accountId });
    notice = "";
    await refresh();
  }
  async function refreshUsage() {
    if (!routingAvailable) { await connect(); return; }
    const operation = await invoke("refresh_accounts");
    operations.set(operation.id, operation); renderAll(); schedulePoll();
  }
  function positionSidebar() {
    if (!sidebar?.open) return;
    const rect = sidebar.trigger.getBoundingClientRect();
    sidebar.panel.style.left = `${Math.max(8, Math.min(rect.right + 10, innerWidth - 360))}px`;
    sidebar.panel.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - sidebar.panel.offsetHeight - 12))}px`;
  }
  function renderSidebar() {
    if (!sidebar) return;
    const current = allAccounts().find(account => account.id === defaultAccountId);
    sidebar.trigger.title = `全局账号：${current?.name || "桌面主账号"}`;
    if (!sidebar.open) return;
    const signature = JSON.stringify([accounts, primaryAccount, defaultAccountId, globalAccount, connected, routingAvailable, notice, [...operations.values()]]);
    if (sidebar.signature === signature) { positionSidebar(); return; }
    sidebar.signature = signature;
    const focusedAccount = document.activeElement?.dataset?.accountId;
    const header = element("div", undefined, "as-picker-header");
    header.append(element("strong", "切换全局账号"), button("管理账号", () => { sidebar.panel.hidePopover(); return page.open(); }, { className: "as-text-button" }));
    const status = element("p", globalMessage(), "as-picker-status"); status.setAttribute("role", "status");
    const list = element("div", undefined, "as-picker-list");
    for (const account of allAccounts()) {
      const selected = account.id === defaultAccountId;
      const row = button("", () => selectAccount(account.id), { className: "as-picker-account", disabled: !connected || account.status !== "ready" || busy(account.id) });
      row.dataset.selected = String(selected);
      row.dataset.accountId = account.id;
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(selected));
      const avatar = element("span", Array.from(account.name.trim())[0]?.toUpperCase() || "A", "as-picker-avatar"); avatar.setAttribute("aria-hidden", "true");
      const copy = element("span", undefined, "as-picker-copy");
      const heading = element("span", undefined, "as-picker-heading");
      heading.append(element("span", `${account.name}${account.plan ? ` · ${account.plan}` : ""}`, "as-picker-name"));
      if (selected) heading.append(element("span", "当前", "as-picker-badge"));
      copy.append(heading, element("span", accountState(account), "as-picker-meta"));
      if (account.kind === "relay" && !account.credits) copy.append(element("span", "余额暂不可查询", "as-picker-meta"));
      const quota = quotaBadge(account);
      const amount = element("span", undefined, "as-picker-amount");
      amount.append(element("span", quota.value), element("small", quota.label));
      row.title = quotaText(account);
      row.append(avatar, copy, amount);
      list.append(row);
    }
    const footer = element("div", undefined, "as-picker-footer");
    footer.append(button("刷新状态与额度", refreshUsage, { className: "as-text-button", disabled: !connected }));
    if (globalAccount.failedThreads) footer.append(button("重试切换", () => selectAccount(defaultAccountId), { className: "as-text-button" }));
    sidebar.panel.replaceChildren(header, status, list, footer);
    for (const action of [...header.querySelectorAll("button"), ...footer.querySelectorAll("button")]) action.setAttribute("role", "menuitem");
    if (focusedAccount) [...list.querySelectorAll("button")].find(row => row.dataset.accountId === focusedAccount)?.focus();
    if (notice) { const message = element("p", notice, "as-picker-status"); message.setAttribute("role", "alert"); sidebar.panel.append(message); }
    positionSidebar();
  }
  function mountSidebar() {
    if (stopped || !sidebar) return;
    const rails = [...document.querySelectorAll("nav[data-app-navigation-rail]")].filter(node => node.getBoundingClientRect().width > 0);
    if (rails.length !== 1) { sidebar.slot.remove(); if (sidebar.open) sidebar.panel.hidePopover(); return; }
    const rail = rails[0];
    if (sidebar.slot.parentElement === rail) return;
    const profile = rail.querySelector('button[aria-label="打开个人资料菜单"],button[aria-label="Open profile menu"]');
    let anchor = profile;
    while (anchor && anchor.parentElement !== rail) anchor = anchor.parentElement;
    rail.insertBefore(sidebar.slot, anchor);
  }
  function startSidebar() {
    const slot = element("div", undefined, "as-sidebar-slot"); slot.dataset.loaderAccounts = "sidebar";
    const panel = element("div", undefined, "as-picker");
    panel.id = "codex-loader-account-picker";
    panel.setAttribute("popover", "auto"); panel.setAttribute("role", "menu"); panel.setAttribute("aria-label", "切换全局账号");
    const trigger = button("", () => panel.togglePopover(), { className: "as-sidebar-trigger" });
    trigger.setAttribute("aria-label", "切换全局账号"); trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false"); trigger.setAttribute("aria-controls", panel.id);
    trigger.innerHTML = ACCOUNT_ICON;
    slot.append(trigger);
    sidebar = { slot, trigger, panel, open: false, signature: null, observer: null };
    panel.addEventListener("toggle", event => {
      sidebar.open = event.newState === "open"; trigger.setAttribute("aria-expanded", String(sidebar.open));
      if (sidebar.open) {
        sidebar.signature = null; renderSidebar();
        panel.querySelector('[role="menuitemradio"][aria-checked="true"]')?.focus();
        void refresh().catch(error => { notice = errorText(error); renderNotices(); });
      }
    });
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { panel.hidePopover(); trigger.focus(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...panel.querySelectorAll('[role^="menuitem"]:not(:disabled)')];
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    });
    document.body.append(panel);
    sidebar.observer = new MutationObserver(mountSidebar);
    sidebar.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", positionSidebar);
    mountSidebar();
  }
  const style = element("style");
  style.id = STYLE;
  style.textContent = `
    .as-settings,.as-picker { --as-border:color-mix(in srgb,currentColor 12%,transparent); --as-muted:color-mix(in srgb,currentColor 65%,transparent); --as-surface:var(--color-background-primary,var(--color-token-main-surface-primary,Canvas)); color:var(--color-text-primary,var(--color-token-text-primary,CanvasText)); font:13px/1.5 system-ui,sans-serif; }
    .as-settings { max-width:880px; padding:4px 0 28px; } .as-settings *,.as-picker * { box-sizing:border-box; }
    .as-settings h2 { font-size:24px; line-height:1.3; font-weight:500; letter-spacing:-.5px; margin:0; }
    .as-settings h3 { font-size:15px; font-weight:500; line-height:1.4; margin:0; }
    .as-settings p { margin:5px 0; } .as-muted,.as-footer { color:var(--as-muted); font-size:12px; }
    .as-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:18px; margin-bottom:26px; }
    .as-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:14px; }
    .as-header .as-actions { margin:0; flex-shrink:0; }
    .as-button,.as-text-button { appearance:none; border:1px solid var(--as-border); border-radius:8px; background:transparent; color:inherit; font:inherit; font-size:12px; line-height:18px; padding:7px 12px; cursor:pointer; }
    .as-button:hover:not(:disabled),.as-text-button:hover:not(:disabled) { background:color-mix(in srgb,currentColor 7%,transparent); }
    .as-button:disabled,.as-text-button:disabled,.as-picker-account:disabled { opacity:.45; cursor:default; }
    .as-primary { background:var(--color-text-primary,var(--color-token-text-primary,CanvasText)); color:var(--as-surface); border-color:transparent; font-weight:600; }
    .as-primary:hover:not(:disabled) { background:var(--color-text-primary,var(--color-token-text-primary,CanvasText)); opacity:.86; }
    .as-text-button { border:0; padding:5px 7px; color:var(--as-muted); } .as-danger { color:#d75252; }
    .as-button:focus-visible,.as-text-button:focus-visible,.as-sidebar-trigger:focus-visible,.as-picker-account:focus-visible,.as-account-menu summary:focus-visible,.as-field input:focus-visible,.as-field select:focus-visible,.as-list-header input:focus-visible { outline:2px solid var(--color-accent-blue,#3286c9); outline-offset:2px; }
    .as-global-panel { display:flex; align-items:center; flex-wrap:wrap; gap:8px; border-bottom:1px solid var(--as-border); padding:0 0 14px; margin:0 0 12px; }
    .as-overline { font-size:12px; color:var(--as-muted); } .as-current-name { font-size:12px; font-weight:500; }
    .as-current-status { color:var(--as-muted); font-size:12px; margin:8px 0!important; } .as-connection { color:var(--as-muted); font-size:11px; margin-left:auto; }
    .as-connection[data-connected="true"] { color:var(--color-text-success,#299167); }
    .as-boundary { border-inline-start:2px solid #b18d50; padding:8px 12px; margin:14px 0; color:var(--as-muted); font-size:12px; }
    .as-boundary strong { font-weight:550; color:inherit; } .as-boundary p { margin-bottom:0; }
    .as-list-header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:24px 0 12px; }
    .as-list-header input { border:1px solid var(--as-border); border-radius:8px; padding:7px 10px; width:220px; max-width:62%; background:transparent; color:inherit; font:inherit; font-size:12px; }
    .as-list { display:grid; gap:10px; } .as-card { display:flex; align-items:center; gap:12px; min-height:88px; border:1px solid transparent; border-radius:14px; padding:12px 16px; background:color-mix(in srgb,currentColor 4%,transparent); }
    .as-card[data-selected="true"] { border-color:transparent; background:color-mix(in srgb,currentColor 5%,transparent); }
    .as-card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; } .as-card-copy { flex:1; min-width:0; }
    .as-card-heading { display:flex; align-items:center; gap:10px; } .as-identity { display:flex; align-items:center; gap:10px; min-width:0; }
    .as-identity h3 { overflow-wrap:anywhere; } .as-avatar { display:grid; place-items:center; width:40px; height:40px; flex-shrink:0; border-radius:50%; background:color-mix(in srgb,currentColor 7%,transparent); font-size:13px; font-weight:550; }
    .as-badge { flex-shrink:0; border-radius:5px; padding:2px 6px; color:var(--as-muted); background:color-mix(in srgb,currentColor 5%,transparent); font-size:10px; }
    .as-account-meta { margin-top:3px; display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; } .as-account-detail { font-size:12px; color:var(--as-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .as-status { font-size:11px; color:var(--as-muted); } .as-status[data-state="error"] { color:#cf6b59; }
    .as-card-actions { display:flex; align-items:center; gap:6px; flex-shrink:0; } .as-card-actions .as-button { padding:5px 9px; }
    .as-quota-summary { color:var(--as-muted); font-size:11px; margin:3px 0 0!important; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .as-plan { color:var(--as-muted); font-size:10px; border:1px solid var(--as-border); border-radius:4px; padding:0 4px; }
    .as-account-menu { position:relative; } .as-account-menu summary { cursor:pointer; list-style:none; border:0; border-radius:6px; padding:6px 8px; font-size:11px; color:var(--as-muted); }
    .as-account-menu summary svg { width:18px; height:18px; display:block; }
    .as-account-menu summary::-webkit-details-marker { display:none; } .as-account-menu summary:hover { background:color-mix(in srgb,currentColor 7%,transparent); }
    .as-menu-actions { position:absolute; z-index:5; right:0; top:32px; min-width:130px; display:grid; gap:2px; padding:5px; border:1px solid var(--as-border); border-radius:10px; background:var(--as-surface); box-shadow:0 12px 30px #0002; }
    .as-menu-actions .as-button { border:0; text-align:left; padding:7px 9px; }
    .as-form { padding:18px; border:1px solid var(--as-border); border-radius:12px; margin-top:18px; } .as-field { display:grid; gap:6px; margin-top:12px; font-size:12px; }
    .as-field input,.as-field select { width:100%; border:1px solid var(--as-border); border-radius:8px; background:var(--as-surface); color:inherit; padding:8px 10px; font:inherit; }
    .as-provider-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr)); gap:0 16px; }
    .as-provider-advanced { margin:16px 0; } .as-provider-advanced summary { cursor:pointer; color:var(--as-muted); font-size:12px; }
    .as-field input[type=checkbox] { width:18px; height:18px; margin:0; }
    .as-version-history { border-top:1px solid var(--as-border); margin-top:20px; padding-top:12px; }
    .as-version-history .as-button { margin-top:12px; }
    .as-notice { font-size:12px; margin:12px 0!important; } .as-operation { display:flex; flex-wrap:wrap; align-items:center; gap:8px; border:1px solid var(--as-border); border-radius:8px; padding:10px; margin-top:12px; }
    .as-empty { padding:16px 0; color:var(--as-muted); } .as-footer { border-top:1px solid var(--as-border); padding-top:16px; margin-top:24px!important; font-size:11px; }
    .as-sidebar-slot { flex-shrink:0; display:flex; justify-content:center; width:36px; }
    .as-sidebar-trigger { -webkit-app-region:no-drag; display:grid; place-items:center; width:36px; height:36px; border:0; padding:0; border-radius:10px; cursor:pointer; color:inherit; background:transparent; }
    .as-sidebar-trigger svg { width:20px; height:20px; stroke-width:1.65; } .as-sidebar-trigger:hover,.as-sidebar-trigger[aria-expanded="true"] { background:color-mix(in srgb,currentColor 8%,transparent); }
    .as-picker { -webkit-app-region:no-drag; position:fixed; inset:auto; margin:0; padding:0; width:340px; max-width:calc(100vw - 24px); max-height:calc(100vh - 24px); overflow:auto; border:1px solid var(--as-border); border-radius:16px; background:var(--as-surface); box-shadow:0 12px 42px #0003; }
    .as-picker:popover-open { display:block; visibility:visible; }
    .as-picker-header { display:flex; align-items:center; justify-content:space-between; padding:15px 16px 0; } .as-picker-header strong { font-size:13px; font-weight:600; }
    .as-picker-status { color:var(--as-muted); font-size:11px; padding:0 16px; margin:4px 0 12px; }
    .as-picker-list { padding:0 6px; } .as-picker-account { display:flex; align-items:center; gap:10px; min-height:65px; width:100%; border:0; border-radius:10px; padding:12px 10px; margin-bottom:2px; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
    .as-picker-account:hover:not(:disabled),.as-picker-account[data-selected="true"] { background:color-mix(in srgb,currentColor 6%,transparent); }
    .as-picker-heading { display:flex; gap:10px; align-items:center; } .as-picker-name { font-size:13px; font-weight:550; overflow-wrap:anywhere; }
    .as-picker-badge { font-size:10px; color:var(--as-muted); white-space:nowrap; } .as-picker-meta { display:block; font-size:11px; color:var(--as-muted); margin-top:3px; }
    .as-picker-avatar { display:grid; place-items:center; width:28px; height:28px; border-radius:50%; background:color-mix(in srgb,currentColor 7%,transparent); font-size:11px; flex-shrink:0; }
    .as-picker-copy { flex:1; min-width:0; } .as-picker-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .as-picker-amount { display:flex; flex-direction:column; align-items:flex-end; gap:2px; font-size:15px; font-variant-numeric:tabular-nums; flex-shrink:0; }
    .as-picker-amount small { font-size:10px; color:var(--as-muted); }
    .as-picker-footer { display:flex; justify-content:space-between; border-top:1px solid var(--as-border); margin-top:6px; padding:8px 10px; }
    @media(max-width:620px) { .as-header { align-items:flex-start; flex-direction:column; gap:12px; } .as-card { padding:12px; gap:10px; } .as-account-meta { gap:3px 6px; } }
  `;
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(polling); polling = null;
    page?.unregister();
    if (refreshTimer) clearInterval(refreshTimer);
    sidebar?.observer?.disconnect();
    sidebar?.slot.remove(); sidebar?.panel.remove();
    window.removeEventListener("resize", positionSidebar);
    sidebar = null;
    for (const view of views) view.shell.remove();
    views.clear(); style.remove();
    if (globalThis[GLOBAL]?.instanceId === instanceId) delete globalThis[GLOBAL];
  }
  try {
    document.head.append(style);
    page = loader.settings.registerPage({ id: "accounts", title: "账号管理", description: "本地账号与中转接入", render: renderSettings });
    startSidebar();
    refreshTimer = setInterval(async () => {
      if (stopped || refreshing || (!views.size && !sidebar?.open)) return;
      refreshing = true;
      try { await refresh(); } catch (error) { if (!stopped) { notice = errorText(error); renderNotices(); } }
      finally { refreshing = false; }
    }, 3000);
  } catch (error) { stop(); throw error; }
  globalThis[GLOBAL] = {
    version: VERSION, instanceId,
    getStatus: () => ({ connected, accountCount: accounts.length, routingAvailable, backendRevision: backendUpdate?.revision || null, backendState: backendUpdate?.state || null, sidebarMounted: Boolean(sidebar?.slot.isConnected), sidebarOpen: sidebar?.open === true, activeOperations: [...operations.values()].filter(item => ["running", "waiting_auth"].includes(item.state)).length }),
    stop,
  };
  void connect();
})();
