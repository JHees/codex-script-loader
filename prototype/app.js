import { createManagerApi } from "./api-client.js";

const isManagerPage = location.protocol === "http:" && location.hostname === "127.0.0.1";
const api = isManagerPage ? createManagerApi() : null;

const demoScripts = [
  { id: "co.bennett.ui-improvements", name: "Bennett UI Improvements", version: "1.3.0", source: "Codex++ 迁移", enabled: true, status: "running", last: "刚刚", hash: "sha256-8a43…3f96", permissions: ["DOM", "localStorage"] },
  { id: "local.hidden-message-fix", name: "Hidden Message Visibility Fix", version: "0.2.0", source: "本地文件", enabled: false, status: "disabled", last: "—", hash: "sha256-187a…9d20", permissions: ["DOM"] }
];

const state = {
  managerMode: api ? "connecting" : "demo",
  managerError: "",
  offline: Boolean(api),
  codexRunning: !api,
  codexInspected: !api,
  cdpConnected: !api,
  cdpInspected: !api,
  targetCount: api ? 0 : 1,
  safeMode: false,
  scripts: api ? [] : demoScripts,
  quarantine: [],
  doctorChecks: null,
  activities: api
    ? [{ icon: "…", title: "正在连接本地管理服务", detail: "不会检查当前 Codex", time: "刚刚" }]
    : [
        { icon: "✓", title: "Bennett UI 注入成功", detail: "renderer target 1 · 84 ms", time: "刚刚" },
        { icon: "↔", title: "CDP 已连接", detail: "仅监听 127.0.0.1", time: "1 分钟前" },
        { icon: "C", title: "Codex 受管实例已启动", detail: "浏览器原型状态", time: "2 分钟前" }
      ],
  logs: api
    ? [[new Date().toLocaleTimeString("zh-CN", { hour12: false }), "ui", "正在连接本地管理服务"]]
    : [
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

const checkNames = {
  "loader-data": "加载器数据目录",
  "loader-config": "加载器配置",
  "script-integrity": "脚本完整性",
  "codex-process": "Codex 进程",
  cdp: "CDP 连接"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeScript(script) {
  const fingerprint = typeof script.fingerprint === "string" ? script.fingerprint : "";
  return {
    id: String(script.id),
    name: String(script.name || script.id),
    version: String(script.version || "local"),
    source: script.sourceLabel || script.sourceType || "加载器数据目录",
    enabled: Boolean(script.enabled),
    status: script.status || "ready",
    last: script.lastInjectedAt || "尚未注入",
    hash: script.integrity || (fingerprint ? `sha256-${fingerprint}` : "—"),
    permissions: Array.isArray(script.permissions) ? script.permissions.map(String) : []
  };
}

function showPage(id) {
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.page === id));
  $$(".page").forEach(page => page.classList.toggle("active", page.id === `page-${id}`));
  $("#page-title").textContent = pages[id][0];
  $("#page-subtitle").textContent = pages[id][1];
}

function scriptState(script) {
  if (state.safeMode || !script.enabled) return ["disabled", state.safeMode && script.enabled ? "安全模式暂停" : "已停用"];
  if (script.status === "failed") return ["failed", "错误"];
  if (script.status === "running") return ["running", "运行中"];
  return ["ready", "已就绪"];
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
    const controlsDisabled = state.safeMode || (api && state.managerMode !== "connected");
    return `<div class="script-row" data-id="${escapeHtml(script.id)}">
      <div class="script-name-cell"><span class="script-avatar">JS</span><div class="script-info"><strong>${escapeHtml(script.name)}</strong><small>${escapeHtml(script.id)} · v${escapeHtml(script.version)}</small></div></div>
      <span class="state ${status}">${label}</span>
      <span class="muted">${escapeHtml(script.last)}</span>
      <input class="toggle script-toggle" type="checkbox" ${script.enabled ? "checked" : ""} ${controlsDisabled ? "disabled" : ""} aria-label="启用 ${escapeHtml(script.name)}">
      <button class="icon-button script-detail" aria-label="查看详情">•••</button>
    </div>`;
  }).join("") || `<div class="compact-item"><span class="script-info"><strong>${state.managerMode === "connecting" ? "正在读取脚本…" : "没有符合条件的脚本"}</strong><small>${state.managerMode === "connecting" ? "" : "可加载一个本地 .js 文件"}</small></span></div>`;

  $("#overview-script-list").innerHTML = state.scripts.slice(0, 4).map(script => {
    const [status, label] = scriptState(script);
    return `<div class="compact-item"><span class="script-avatar">JS</span><div class="script-info"><strong>${escapeHtml(script.name)}</strong><small>${escapeHtml(script.id)} · v${escapeHtml(script.version)}</small></div><span class="state ${status}">${label}</span></div>`;
  }).join("") || `<div class="compact-item"><span class="script-info"><strong>尚未安装脚本</strong><small>安装操作默认停用且不会执行</small></span></div>`;

  const enabled = state.safeMode ? 0 : state.scripts.filter(script => script.enabled).length;
  const failed = state.scripts.filter(script => script.status === "failed" && script.enabled).length;
  $("#enabled-count").textContent = `${enabled} / ${state.scripts.length}`;
  $("#failed-count").textContent = `${failed} 个错误`;
}

function renderQuarantine() {
  $("#quarantine-count").textContent = `${state.quarantine.length} 项`;
  $("#quarantine-list").innerHTML = state.quarantine.map(record => {
    const date = new Date(record.quarantinedAt);
    const time = Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
    const restoreDisabled = api && state.managerMode !== "connected";
    return `<div class="compact-item quarantine-item" data-key="${escapeHtml(record.key)}"><span class="script-avatar">Q</span><div class="script-info"><strong>${escapeHtml(record.name)}</strong><small>${escapeHtml(record.scriptId)} · v${escapeHtml(record.version)} · ${escapeHtml(time)}</small></div><button class="button secondary restore-script" type="button" ${restoreDisabled ? "disabled" : ""}>恢复</button></div>`;
  }).join("") || `<div class="compact-item"><span class="script-info"><strong>隔离区为空</strong><small>这里不提供永久删除；移除的脚本会保留可恢复副本</small></span></div>`;
}

function renderActivities() {
  $("#activity-list").innerHTML = state.activities.slice(0, 6).map(item => `<div class="activity-item"><span class="activity-icon">${escapeHtml(item.icon)}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div><time>${escapeHtml(item.time)}</time></div>`).join("");
}

function renderLogs() {
  $("#log-list").innerHTML = state.logs.map(row => `<div class="log-row"><time>${escapeHtml(row[0])}</time><span class="log-source">${escapeHtml(row[1])}</span><span>${escapeHtml(row[2])}</span></div>`).join("") || `<div class="compact-item"><span class="script-info"><strong>当前显示中没有日志</strong></span></div>`;
  $("#log-list").scrollTop = $("#log-list").scrollHeight;
}

function defaultDoctorChecks() {
  if (!api) {
    return [
      { id: "loader-data", status: "pass", detail: "原型数据" },
      { id: "script-integrity", status: "pass", detail: `${state.scripts.length} 个原型脚本` },
      { id: "codex-process", status: "pass", detail: "原型状态" },
      { id: "cdp", status: "pass", detail: "原型状态" }
    ];
  }
  return [
    { id: "loader-data", status: state.managerMode === "connected" ? "pass" : "pending", detail: state.managerMode === "connected" ? "本地管理服务可用" : "等待连接" },
    { id: "script-integrity", status: "pending", detail: "运行诊断后检查" },
    { id: "codex-process", status: "skipped", detail: "离线阶段不检查当前 Codex" },
    { id: "cdp", status: "skipped", detail: "离线阶段不查询任何 CDP 端口" }
  ];
}

function renderDoctor(running = false) {
  const checks = state.doctorChecks || defaultDoctorChecks();
  const icons = { pass: "✓", warn: "!", failed: "×", skipped: "—", pending: "…" };
  $("#doctor-list").innerHTML = checks.map(check => {
    const status = running ? "pending" : check.status;
    return `<div class="doctor-item"><span class="doctor-result">${icons[status] || "·"}</span><span><strong>${escapeHtml(checkNames[check.id] || check.id)}</strong><small>${escapeHtml(running ? "检查中…" : check.detail)}</small></span></div>`;
  }).join("");
}

function applyState() {
  const connected = state.managerMode === "connected";
  const failed = state.managerMode === "error";
  $("#loader-health-dot").className = `health-dot ${connected || state.managerMode === "demo" ? "healthy" : failed ? "failed" : ""}`;
  $("#loader-health-label").textContent = failed ? "加载器连接失败" : connected ? "加载器正常" : state.managerMode === "demo" ? "交互原型" : "正在连接";
  $("#loader-mode-label").textContent = state.managerMode === "demo" ? "静态演示模式" : "Node 本地管理服务";
  $("#connection-notice").classList.toggle("hidden", !failed);
  $("#connection-notice-detail").textContent = state.managerError || "请从加载器启动此页面。";
  $("#safe-mode-notice").classList.toggle("hidden", !state.safeMode);

  let codexLabel = "未检查 Codex";
  let codexMetric = "未检查";
  let codexDetail = "离线服务不会检查运行实例";
  if (state.codexInspected) {
    codexLabel = state.codexRunning ? "Codex 已连接" : "Codex 未运行";
    codexMetric = state.codexRunning ? "运行正常" : "未运行";
    codexDetail = state.codexRunning ? "受加载器管理" : "没有受管实例";
  }
  $("#codex-status-label").textContent = codexLabel;
  $("#metric-codex").textContent = codexMetric;
  $("#metric-codex-detail").textContent = codexDetail;
  $("#metric-cdp").textContent = state.cdpInspected ? (state.cdpConnected ? "已连接" : "未连接") : "未检查";
  $("#metric-cdp-detail").textContent = state.cdpInspected ? `${state.targetCount} 个 renderer target` : "未查询任何调试端口";
  const live = Boolean(api && !state.offline);
  $("#codex-action").textContent = live ? "Codex 已受管" : api ? "未接管 Codex" : state.codexRunning ? "显示 Codex" : "启动 Codex";
  $("#codex-action").disabled = Boolean(api);
  $("#reload-all").textContent = api && !live ? "验证加载计划" : "重新加载全部";
  $("#reload-all").disabled = state.safeMode || (api ? !connected : !state.codexRunning);
  $("#safe-mode-toggle").checked = state.safeMode;
  $("#safe-mode-toggle").disabled = Boolean(api && !connected);
  $("#load-script").disabled = Boolean(api && !connected);
  renderScripts();
  renderQuarantine();
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

async function refreshManagerData({ announce = false } = {}) {
  if (!api) return;
  const [status, scripts, quarantine] = await Promise.all([api.status(), api.scripts(), api.quarantine()]);
  state.managerMode = "connected";
  state.managerError = "";
  state.safeMode = Boolean(status.safeMode);
  state.offline = status.offline !== false;
  state.codexInspected = status.codexInspected !== false;
  state.cdpInspected = status.cdpInspected !== false;
  state.codexRunning = status.codex === "healthy" || status.codex === "starting";
  state.cdpConnected = status.cdp === "healthy";
  state.targetCount = Number(status.targetCount || 0);
  if (status.lastInjectionAt) {
    const injectedAt = new Date(status.lastInjectionAt);
    $("#last-injection").textContent = Number.isNaN(injectedAt.valueOf()) ? "已完成" : injectedAt.toLocaleTimeString("zh-CN", { hour12: false });
    $("#last-injection-detail").textContent = `${state.targetCount} 个 renderer target`;
  }
  state.scripts = scripts.map(normalizeScript);
  state.quarantine = quarantine;
  if (announce) {
    const detail = state.offline ? "离线管理模式；未检查 Codex/CDP" : `受管运行模式；${state.targetCount} 个 renderer target`;
    state.activities = [{ icon: "✓", title: "本地管理服务已连接", detail, time: "刚刚" }];
    state.logs = [[new Date().toLocaleTimeString("zh-CN", { hour12: false }), "loader", detail]];
  }
  applyState();
}

function showInstallPreview(preview, file, sourceText) {
  const script = normalizeScript(preview.script);
  const permissionText = script.permissions.length ? script.permissions.join("、") : "未声明额外权限";
  $("#dialog-content").innerHTML = `<p class="eyebrow">检查本地脚本</p><h2>${escapeHtml(file.name)}</h2><p class="dialog-section">后端已检查名称、大小并计算 SHA-256。确认安装只会把源码复制到加载器目录；脚本默认停用，本阶段也不会连接 Codex 执行它。</p><dl class="detail-grid"><dt>脚本 ID</dt><dd>${escapeHtml(script.id)}</dd><dt>大小</dt><dd>${Math.max(1, Math.round(file.size / 1024))} KB</dd><dt>完整性</dt><dd>${escapeHtml(script.hash)}</dd><dt>权限声明</dt><dd>${escapeHtml(permissionText)}</dd><dt>状态</dt><dd>等待用户确认</dd></dl><div class="dialog-actions"><button class="button secondary" value="cancel">取消</button><button class="button primary" id="confirm-install" type="button">复制并安装（保持停用）</button></div>`;
  $("#script-dialog").showModal();
  $("#confirm-install").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (api) {
        await api.installScript({ fileName: file.name, sourceText, enabled: false, overwrite: false });
        await refreshManagerData();
        $("#script-dialog").close();
        addActivity("脚本已安装但未启用", `${file.name}；源码未执行`, "＋");
        toast("安装完成", "脚本保持停用，尚未执行");
      } else {
        if (state.scripts.some(item => item.id === script.id)) throw new Error("脚本已存在");
        state.scripts.push(script);
        $("#script-dialog").close();
        addActivity("脚本已安装但未启用", file.name, "＋");
        renderScripts();
        toast("原型安装完成", "静态原型未写入本机文件");
      }
    } catch (error) {
      button.disabled = false;
      toast("安装失败", formatError(error));
    }
  }, { once: true });
}

async function inspectFile(file) {
  if (!file) return;
  if (!/\.js$/i.test(file.name)) return toast("不支持的文件", "当前版本请选择单个 .js 文件");
  if (file.size > 512 * 1024) return toast("文件过大", "单个脚本不能超过 512 KiB");
  try {
    const sourceText = await file.text();
    const preview = api
      ? await api.inspectScript({ fileName: file.name, sourceText })
      : { script: { id: `local.${file.name.toLowerCase().replace(/\.js$/i, "").replace(/[^a-z0-9]+/g, "-")}`, name: file.name.replace(/\.js$/i, ""), version: "local", enabled: false, status: "disabled", fingerprint: "prototype", permissions: [] } };
    showInstallPreview(preview, file, sourceText);
  } catch (error) {
    toast("脚本检查失败", formatError(error));
  } finally {
    $("#script-file").value = "";
  }
}

function showScriptDetails(script) {
  const [status, label] = scriptState(script);
  const permissionText = script.permissions.length ? script.permissions.join("、") : "未声明额外权限";
  const actionLabel = api && state.offline ? "验证加载计划" : "重新加载";
  const removeAction = `<button class="button secondary" id="remove-script" type="button">移入隔离区</button>`;
  $("#dialog-content").innerHTML = `<p class="eyebrow">脚本详情</p><h2>${escapeHtml(script.name)}</h2><p>${escapeHtml(script.id)}</p><dl class="detail-grid"><dt>版本</dt><dd>${escapeHtml(script.version)}</dd><dt>来源</dt><dd>${escapeHtml(script.source)}</dd><dt>状态</dt><dd><span class="state ${status}">${label}</span></dd><dt>SHA-256</dt><dd>${escapeHtml(script.hash)}</dd><dt>权限</dt><dd>${escapeHtml(permissionText)}</dd><dt>最近注入</dt><dd>${escapeHtml(script.last)}</dd></dl><div class="dialog-actions"><button class="button secondary" value="cancel">关闭</button>${removeAction}<button class="button primary" id="reload-script" type="button" ${!script.enabled || state.safeMode ? "disabled" : ""}>${actionLabel}</button></div>`;
  $("#script-dialog").showModal();
  $("#reload-script").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (api) {
        const result = await api.reload([script.id], { live: !state.offline });
        $("#script-dialog").close();
        $("#last-injection").textContent = state.offline ? "未执行（dry-run）" : "刚刚";
        addActivity(state.offline ? "脚本加载计划已验证" : "脚本已重新加载", `${result.summary?.length || 0} 个脚本；${result.targetCount || 0} 个 target`, "↻");
        toast(state.offline ? "验证完成" : "重新加载完成", state.offline ? "没有连接或修改当前 Codex" : script.name);
      } else {
        script.last = "刚刚";
        $("#script-dialog").close();
        addActivity(`${script.name} 已重新加载`, "原型操作完成");
        renderScripts();
        toast("重新加载完成", script.name);
      }
    } catch (error) {
      button.disabled = false;
      toast("验证失败", formatError(error));
    }
  });
  $("#remove-script")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    if (button.dataset.confirmed !== "true") {
      button.dataset.confirmed = "true";
      button.textContent = "再次点击确认移入隔离区";
      return;
    }
    button.disabled = true;
    try {
      if (api) {
        await api.removeScript(script.id);
        await refreshManagerData();
      } else {
        state.scripts = state.scripts.filter(item => item.id !== script.id);
        state.quarantine.unshift({ key: `demo-${Date.now()}`, scriptId: script.id, name: script.name, version: script.version, enabled: script.enabled, quarantinedAt: new Date().toISOString(), status: "quarantined" });
        applyState();
      }
      $("#script-dialog").close();
      addActivity("脚本已移入隔离区", `${script.name}；仍可恢复`, "−");
      toast("已安全移除", "没有永久删除脚本文件");
    } catch (error) {
      button.disabled = false;
      button.dataset.confirmed = "false";
      button.textContent = "移入隔离区";
      toast("移除失败", formatError(error));
    }
  });
}

$$(".nav-item").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));
$$(`[data-go]`).forEach(button => button.addEventListener("click", () => showPage(button.dataset.go)));
$("#script-search").addEventListener("input", renderScripts);
$("#script-filter").addEventListener("change", renderScripts);
$("#load-script").addEventListener("click", () => $("#script-file").click());
$("#script-file").addEventListener("change", event => inspectFile(event.target.files[0]));
$("#drop-zone").addEventListener("click", () => $("#script-file").click());
$("#drop-zone").addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") $("#script-file").click(); });
$("#drop-zone").addEventListener("dragover", event => { event.preventDefault(); event.currentTarget.classList.add("dragging"); });
$("#drop-zone").addEventListener("dragleave", event => event.currentTarget.classList.remove("dragging"));
$("#drop-zone").addEventListener("drop", event => { event.preventDefault(); event.currentTarget.classList.remove("dragging"); inspectFile(event.dataTransfer.files[0]); });

$("#script-list").addEventListener("change", async event => {
  if (!event.target.classList.contains("script-toggle")) return;
  const script = state.scripts.find(item => item.id === event.target.closest(".script-row").dataset.id);
  const previous = script.enabled;
  const enabled = event.target.checked;
  event.target.disabled = true;
  try {
    if (api) {
      await api.setScriptEnabled(script.id, enabled);
      await refreshManagerData();
      addActivity(`${script.name} 已${enabled ? "启用" : "停用"}`, state.offline ? "配置已保存；离线模式未注入" : "配置已保存并同步到受管 Codex", enabled ? "✓" : "Ⅱ");
    } else {
      script.enabled = enabled;
      script.status = enabled ? "running" : "disabled";
      script.last = enabled ? "刚刚" : script.last;
      addActivity(`${script.name} 已${enabled ? "启用" : "停用"}`, "浏览器原型状态", enabled ? "✓" : "Ⅱ");
      renderScripts();
    }
  } catch (error) {
    script.enabled = previous;
    renderScripts();
    toast("保存失败", formatError(error));
  }
});

$("#script-list").addEventListener("click", event => {
  const button = event.target.closest(".script-detail");
  if (!button) return;
  showScriptDetails(state.scripts.find(item => item.id === button.closest(".script-row").dataset.id));
});

$("#quarantine-list").addEventListener("click", async event => {
  const button = event.target.closest(".restore-script");
  if (!button) return;
  const item = button.closest(".quarantine-item");
  const record = state.quarantine.find(entry => entry.key === item.dataset.key);
  button.disabled = true;
  try {
    if (api) {
      await api.restoreScript(record.key);
      await refreshManagerData();
    } else {
      state.quarantine = state.quarantine.filter(entry => entry.key !== record.key);
      state.scripts.push({ id: record.scriptId, name: record.name, version: record.version, source: "原型隔离区", enabled: record.enabled, status: record.enabled ? "running" : "disabled", last: "—", hash: "原型记录", permissions: [] });
      applyState();
    }
    addActivity("脚本已从隔离区恢复", record.name, "↶");
    toast("恢复完成", "已恢复原来的启用配置，当前未执行脚本");
  } catch (error) {
    button.disabled = false;
    toast("恢复失败", formatError(error));
  }
});

$("#refresh-state").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (api) {
      await refreshManagerData();
      toast("状态已刷新", state.offline ? "只读取加载器数据，没有查询 Codex" : "已读取受管 Codex 与脚本状态");
    } else {
      applyState();
      toast("原型状态已刷新", "静态演示没有后端数据");
    }
  } catch (error) {
    state.managerMode = "error";
    state.managerError = formatError(error);
    applyState();
    toast("刷新失败", state.managerError);
  } finally {
    button.disabled = false;
  }
});

$("#reload-all").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (api) {
      const result = await api.reload(undefined, { live: !state.offline });
      $("#last-injection").textContent = state.offline ? "未执行（dry-run）" : "刚刚";
      $("#last-injection-detail").textContent = `${result.summary?.length || 0} 个脚本计划已验证`;
      addActivity(state.offline ? "全部加载计划已验证" : "全部脚本已重新加载", `${result.summary?.length || 0} 个脚本；${result.targetCount || 0} 个 target`, "↻");
      toast(state.offline ? "验证完成" : "重新加载完成", state.offline ? "没有脚本被执行" : "受管 renderer 已更新");
    } else {
      state.scripts.filter(script => script.enabled).forEach(script => { script.last = "刚刚"; });
      $("#last-injection").textContent = "刚刚";
      addActivity("全部脚本已重新加载", `${state.scripts.filter(script => script.enabled).length} 个原型脚本`, "↻");
      renderScripts();
    }
  } catch (error) {
    toast("验证失败", formatError(error));
  } finally {
    button.disabled = state.safeMode || (api && state.managerMode !== "connected");
  }
});

$("#codex-action").addEventListener("click", () => {
    if (api) return toast(state.offline ? "当前未启用 Codex 接管" : "Codex 已由加载器启动", state.offline ? "请使用 run --live 从关闭状态启动 Codex" : "加载器不会强制结束 Codex");
  toast("显示 Codex", "静态原型不会访问桌面应用");
});

$("#safe-mode-toggle").addEventListener("change", async event => {
  const enabled = event.target.checked;
  const previous = state.safeMode;
  event.target.disabled = true;
  try {
    if (api) await api.setSafeMode(enabled);
    state.safeMode = enabled;
    addActivity(`安全模式已${enabled ? "启用" : "关闭"}`, enabled ? "所有脚本已暂停" : state.offline ? "恢复脚本启用配置；离线模式未注入" : "恢复启用脚本并同步到受管 Codex", "!");
    applyState();
    toast(enabled ? "安全模式已启用" : "安全模式已关闭", enabled ? (state.offline ? "已暂停生成启用脚本的加载计划" : "启用脚本已从受管 renderer 清理") : state.offline ? "脚本仍需 live 模式才会执行" : "启用脚本已恢复");
  } catch (error) {
    state.safeMode = previous;
    applyState();
    toast("保存失败", formatError(error));
  }
});

$("#run-doctor").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  renderDoctor(true);
  try {
    if (api) {
      const report = await api.doctor();
      state.doctorChecks = report.checks;
      renderDoctor(false);
      const warnings = report.checks.filter(check => check.status === "warn" || check.status === "failed").length;
      addActivity("离线检查已完成", `${report.checks.length} 项；${warnings} 项警告；Codex/CDP 已跳过`, warnings ? "!" : "✓");
      toast("诊断完成", "未检查或修改当前 Codex");
    } else {
      await new Promise(resolve => setTimeout(resolve, 500));
      renderDoctor(false);
      addActivity("原型检查已完成", "仅演示界面交互", "✓");
    }
  } catch (error) {
    renderDoctor(false);
    toast("诊断失败", formatError(error));
  } finally {
    button.disabled = false;
  }
});

$("#clear-log").addEventListener("click", () => { state.logs = []; renderLogs(); });
$("#export-log").addEventListener("click", () => toast("尚未实现导出", "当前日志仅保存在此页面内存中"));
$("#migrate-button").addEventListener("click", () => toast("迁移功能尚未启用", "当前版本先完成安全的单文件加载流程"));
$$(`.open-folder`).forEach(button => button.addEventListener("click", () => toast("尚未实现打开目录", "本地 API 不接受任意文件系统路径")));
$("#theme-select").addEventListener("change", event => {
  const value = event.target.value;
  document.documentElement.dataset.theme = value === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : value;
});

async function initialize() {
  applyState();
  const requestedPage = new URLSearchParams(location.search).get("page");
  if (requestedPage && pages[requestedPage]) showPage(requestedPage);
  if (!api) return;
  try {
    await refreshManagerData({ announce: true });
  } catch (error) {
    state.managerMode = "error";
    state.managerError = formatError(error);
    state.activities = [{ icon: "×", title: "本地管理服务连接失败", detail: state.managerError, time: "刚刚" }];
    state.logs.push([new Date().toLocaleTimeString("zh-CN", { hour12: false }), "error", state.managerError]);
    applyState();
  }
}

initialize();
