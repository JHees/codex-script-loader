const state = {
  codexRunning: true,
  safeMode: false,
  scripts: [
    { id: "com.bennett.ui-improvements", name: "Bennett UI Improvements", version: "1.2.4", source: "Codex++ 迁移", enabled: true, status: "running", last: "刚刚", hash: "sha256-4f7c…b318", permissions: ["DOM", "Codex renderer bridge"] },
    { id: "local.hidden-message-fix", name: "Hidden Message Visibility Fix", version: "0.2.0", source: "本地文件", enabled: false, status: "disabled", last: "—", hash: "sha256-187a…9d20", permissions: ["DOM"] }
  ],
  activities: [
    { icon: "✓", title: "Bennett UI 注入成功", detail: "renderer target 1 · 84 ms", time: "刚刚" },
    { icon: "↔", title: "CDP 已连接", detail: "仅监听 127.0.0.1", time: "1 分钟前" },
    { icon: "C", title: "Codex 受管实例已启动", detail: "ChatGPT.exe · 原型状态", time: "2 分钟前" }
  ],
  logs: [
    ["14:32:08", "loader", "加载器已就绪"],
    ["14:32:09", "cdp", "发现 1 个可信 Codex renderer target"],
    ["14:32:09", "script", "com.bennett.ui-improvements 注入成功（84 ms）"]
  ]
};

const pages = {
  overview: ["总览", "查看 Codex 和脚本运行状态"],
  scripts: ["脚本", "加载、启停和检查本地 renderer 脚本"],
  diagnostics: ["诊断", "检查连接、安全边界和脚本错误"],
  settings: ["设置", "配置启动、外观和安全模式"]
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function showPage(id) {
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.page === id));
  $$(".page").forEach(page => page.classList.toggle("active", page.id === `page-${id}`));
  $("#page-title").textContent = pages[id][0];
  $("#page-subtitle").textContent = pages[id][1];
}

function scriptState(script) {
  if (state.safeMode || !script.enabled) return ["disabled", "已停用"];
  if (script.status === "failed") return ["failed", "错误"];
  return ["running", "运行中"];
}

function renderScripts() {
  const search = $("#script-search")?.value.trim().toLowerCase() || "";
  const filter = $("#script-filter")?.value || "all";
  const filtered = state.scripts.filter(script => {
    const effective = scriptState(script)[0];
    return (!search || `${script.name} ${script.id}`.toLowerCase().includes(search)) && (filter === "all" || effective === filter);
  });

  $("#script-list").innerHTML = filtered.map(script => {
    const [status, label] = scriptState(script);
    return `<div class="script-row" data-id="${script.id}">
      <div class="script-name-cell"><span class="script-avatar">JS</span><div class="script-info"><strong>${escapeHtml(script.name)}</strong><small>${escapeHtml(script.id)} · v${escapeHtml(script.version)}</small></div></div>
      <span class="state ${status}">${label}</span>
      <span class="muted">${script.last}</span>
      <input class="toggle script-toggle" type="checkbox" ${script.enabled && !state.safeMode ? "checked" : ""} ${state.safeMode ? "disabled" : ""} aria-label="启用 ${escapeHtml(script.name)}">
      <button class="icon-button script-detail" aria-label="查看详情">•••</button>
    </div>`;
  }).join("") || `<div class="compact-item"><span class="script-info"><strong>没有符合条件的脚本</strong><small>更改搜索或筛选条件</small></span></div>`;

  $("#overview-script-list").innerHTML = state.scripts.slice(0, 4).map(script => {
    const [status, label] = scriptState(script);
    return `<div class="compact-item"><span class="script-avatar">JS</span><div class="script-info"><strong>${escapeHtml(script.name)}</strong><small>${escapeHtml(script.id)} · v${escapeHtml(script.version)}</small></div><span class="state ${status}">${label}</span></div>`;
  }).join("");

  const enabled = state.safeMode ? 0 : state.scripts.filter(script => script.enabled).length;
  const failed = state.scripts.filter(script => script.status === "failed" && script.enabled).length;
  $("#enabled-count").textContent = `${enabled} / ${state.scripts.length}`;
  $("#failed-count").textContent = `${failed} 个错误`;
}

function renderActivities() {
  $("#activity-list").innerHTML = state.activities.slice(0, 6).map(item => `<div class="activity-item"><span class="activity-icon">${item.icon}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div><time>${item.time}</time></div>`).join("");
}

function renderLogs() {
  $("#log-list").innerHTML = state.logs.map(row => `<div class="log-row"><time>${row[0]}</time><span class="log-source">${row[1]}</span><span>${escapeHtml(row[2])}</span></div>`).join("") || `<div class="compact-item"><span class="script-info"><strong>当前显示中没有日志</strong></span></div>`;
  $("#log-list").scrollTop = $("#log-list").scrollHeight;
}

function renderDoctor(running = false) {
  const checks = [
    ["Codex 安装", running ? "检查中…" : "已发现官方安装"],
    ["CDP 监听", running ? "检查中…" : "仅限 loopback"],
    ["Renderer target", running ? "检查中…" : "1 个可信 target"],
    ["脚本完整性", running ? "检查中…" : `${state.scripts.length} 个脚本通过`],
    ["会话数据边界", running ? "检查中…" : "没有读写 .codex"],
    ["安全模式", running ? "检查中…" : state.safeMode ? "已启用" : "未启用"]
  ];
  $("#doctor-list").innerHTML = checks.map(([name, detail]) => `<div class="doctor-item"><span class="doctor-result">${running ? "…" : "✓"}</span><span><strong>${name}</strong><small>${detail}</small></span></div>`).join("");
}

function applyState() {
  $("#codex-status-label").textContent = state.codexRunning ? "Codex 已连接" : "Codex 未运行";
  $("#codex-action").textContent = state.codexRunning ? "显示 Codex" : "启动 Codex";
  $("#metric-codex").textContent = state.codexRunning ? "运行正常" : "未运行";
  $("#reload-all").disabled = !state.codexRunning || state.safeMode;
  $("#safe-mode-notice").classList.toggle("hidden", !state.safeMode);
  $("#safe-mode-toggle").checked = state.safeMode;
  renderScripts();
  renderActivities();
  renderLogs();
  renderDoctor();
}

function addActivity(title, detail, icon = "✓") {
  state.activities.unshift({ icon, title, detail, time: "刚刚" });
  state.logs.push([new Date().toLocaleTimeString("zh-CN", { hour12: false }), "ui", `${title}：${detail}`]);
  renderActivities();
  renderLogs();
}

function toast(title, detail) {
  const element = document.createElement("div");
  element.className = "toast";
  element.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  $("#toast-region").append(element);
  setTimeout(() => element.remove(), 3200);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function inspectFile(file) {
  if (!file) return;
  const valid = /\.(js|json|zip)$/i.test(file.name);
  if (!valid) return toast("不支持的文件", "请选择 .js、manifest.json 或本地安装包");
  const name = file.name.replace(/\.(js|json|zip)$/i, "").replace(/[-_]+/g, " ");
  $("#dialog-content").innerHTML = `<p class="eyebrow">加载本地脚本</p><h2>${escapeHtml(file.name)}</h2><p class="dialog-section">选择文件只会进入检查阶段，不会立即执行。真实版本将由 Rust 后端验证入口、权限、冲突和 SHA-256。</p><dl class="detail-grid"><dt>来源</dt><dd>本地文件</dd><dt>大小</dt><dd>${Math.max(1, Math.round(file.size / 1024))} KB</dd><dt>权限</dt><dd>等待 manifest 检查</dd><dt>状态</dt><dd>原型验证通过</dd></dl><div class="dialog-actions"><button class="button secondary" value="cancel">取消</button><button class="button primary" id="confirm-install" value="default">复制并安装</button></div>`;
  $("#script-dialog").showModal();
  $("#confirm-install").addEventListener("click", event => {
    event.preventDefault();
    const id = `local.${file.name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}`;
    if (state.scripts.some(script => script.id === id)) return toast("脚本已存在", "请先移除旧版本或使用更新流程");
    state.scripts.push({ id, name, version: "local", source: "本地文件", enabled: false, status: "disabled", last: "—", hash: "等待后端计算", permissions: ["等待检查"] });
    $("#script-dialog").close();
    renderScripts();
    addActivity("脚本已安装但未启用", file.name, "＋");
    toast("安装完成", "脚本尚未执行，请检查后手动启用");
  }, { once: true });
}

function showScriptDetails(script) {
  const [status, label] = scriptState(script);
  $("#dialog-content").innerHTML = `<p class="eyebrow">脚本详情</p><h2>${escapeHtml(script.name)}</h2><p>${escapeHtml(script.id)}</p><dl class="detail-grid"><dt>版本</dt><dd>${escapeHtml(script.version)}</dd><dt>来源</dt><dd>${escapeHtml(script.source)}</dd><dt>状态</dt><dd><span class="state ${status}">${label}</span></dd><dt>SHA-256</dt><dd>${escapeHtml(script.hash)}</dd><dt>权限</dt><dd>${script.permissions.map(escapeHtml).join("、")}</dd><dt>最近注入</dt><dd>${script.last}</dd></dl><div class="dialog-actions"><button class="button secondary" value="cancel">关闭</button><button class="button secondary" id="remove-script" value="default">移除</button><button class="button primary" id="reload-script" value="default" ${!script.enabled || state.safeMode ? "disabled" : ""}>重新加载</button></div>`;
  $("#script-dialog").showModal();
  $("#reload-script").addEventListener("click", event => { event.preventDefault(); script.last = "刚刚"; $("#script-dialog").close(); addActivity(`${script.name} 已重新加载`, "原型操作完成"); renderScripts(); toast("重新加载完成", script.name); }, { once: true });
  $("#remove-script").addEventListener("click", event => { event.preventDefault(); state.scripts = state.scripts.filter(item => item.id !== script.id); $("#script-dialog").close(); addActivity("脚本已移到回收区", script.name, "−"); renderScripts(); toast("已移除", "真实版本默认保留可恢复副本"); }, { once: true });
}

$$(".nav-item").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));
$$(`[data-go]`).forEach(button => button.addEventListener("click", () => showPage(button.dataset.go)));
$("#script-search").addEventListener("input", renderScripts);
$("#script-filter").addEventListener("change", renderScripts);
$("#load-script").addEventListener("click", () => $("#script-file").click());
$("#script-file").addEventListener("change", event => inspectFile(event.target.files[0]));
$("#drop-zone").addEventListener("click", () => $("#script-file").click());
$("#drop-zone").addEventListener("dragover", event => { event.preventDefault(); event.currentTarget.classList.add("dragging"); });
$("#drop-zone").addEventListener("dragleave", event => event.currentTarget.classList.remove("dragging"));
$("#drop-zone").addEventListener("drop", event => { event.preventDefault(); event.currentTarget.classList.remove("dragging"); inspectFile(event.dataTransfer.files[0]); });
$("#script-list").addEventListener("change", event => {
  if (!event.target.classList.contains("script-toggle")) return;
  const script = state.scripts.find(item => item.id === event.target.closest(".script-row").dataset.id);
  script.enabled = event.target.checked;
  script.status = script.enabled ? "running" : "disabled";
  script.last = script.enabled ? "刚刚" : script.last;
  addActivity(`${script.name} 已${script.enabled ? "启用" : "停用"}`, script.enabled ? "已注入当前 renderer" : "生命周期已停止", script.enabled ? "✓" : "Ⅱ");
  renderScripts();
});
$("#script-list").addEventListener("click", event => {
  const button = event.target.closest(".script-detail");
  if (!button) return;
  showScriptDetails(state.scripts.find(item => item.id === button.closest(".script-row").dataset.id));
});
$("#reload-all").addEventListener("click", () => { state.scripts.filter(script => script.enabled).forEach(script => script.last = "刚刚"); $("#last-injection").textContent = "刚刚"; addActivity("全部脚本已重新加载", `${state.scripts.filter(script => script.enabled).length} 个脚本`, "↻"); renderScripts(); toast("重新加载完成", "没有发现脚本异常"); });
$("#codex-action").addEventListener("click", () => { if (!state.codexRunning) { state.codexRunning = true; addActivity("Codex 已启动", "受管 CDP 会话已建立", "C"); toast("Codex 已启动", "正在等待 renderer 注入"); } else { toast("显示 Codex", "真实版本将聚焦受管窗口"); } applyState(); });
$("#safe-mode-toggle").addEventListener("change", event => { state.safeMode = event.target.checked; addActivity(`安全模式已${state.safeMode ? "启用" : "关闭"}`, state.safeMode ? "所有脚本已暂停" : "已恢复启用脚本", "!"); applyState(); toast(state.safeMode ? "安全模式已启用" : "安全模式已关闭", state.safeMode ? "Codex 将保持原生界面" : "已恢复脚本注入"); });
$("#run-doctor").addEventListener("click", event => { event.currentTarget.disabled = true; renderDoctor(true); setTimeout(() => { renderDoctor(false); event.currentTarget.disabled = false; addActivity("完整检查已完成", "6 项通过，0 项警告", "✓"); toast("诊断完成", "所有检查均已通过"); }, 900); });
$("#clear-log").addEventListener("click", () => { state.logs = []; renderLogs(); });
$("#export-log").addEventListener("click", () => toast("诊断包预览", "真实版本会先列出脱敏后的导出内容"));
$("#migrate-button").addEventListener("click", () => toast("Codex++ 迁移", "真实版本只复制选中的用户脚本，不删除原文件"));
$$(`.open-folder`).forEach(button => button.addEventListener("click", () => toast("打开目录", "原型不会访问本机文件系统")));
$("#theme-select").addEventListener("change", event => { const value = event.target.value; document.documentElement.dataset.theme = value === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : value; });

applyState();
const requestedPage = new URLSearchParams(location.search).get("page");
if (requestedPage && pages[requestedPage]) showPage(requestedPage);
