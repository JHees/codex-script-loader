const SETTINGS_HOST_VERSION = "0.3.2";

/*
 * Renderer-only settings host inspired by b-nnett/codex-plusplus.
 * The loader owns navigation and page mounting; plugins only register a page.
 */
function installSettingsHost(version) {
  const runtime = globalThis.__codexScriptLoader;
  if (!runtime) return;
  const current = runtime.settingsHost;
  if (current?.version === version) {
    current.start();
    return;
  }
  try { current?.stop?.(); } catch {}
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    runtime.settingsHost = {
      version,
      start() {},
      registerPage() { throw new Error("settings pages require a renderer DOM"); },
      registerSection() { throw new Error("settings sections require a renderer DOM"); },
      snapshot() { return { version, pageCount: 0, sectionCount: 0, activeId: null, mounted: false }; },
      stop() {},
    };
    return;
  }

  const pages = new Map();
  const sections = new Map();
  let observer = null;
  let scanTimer = 0;
  let sidebarRoot = null;
  let pagesGroup = null;
  let panelHost = null;
  let activeId = null;
  let pendingActiveId = null;
  let restoreHandler = null;
  let activeTeardown = null;

  const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const normalize = (value) => compact(value).toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const coreLabels = ["general", "常规", "通用", "appearance", "外观", "configuration", "配置", "personalization", "个性化"];
  const extraLabels = ["account", "账户", "keyboard shortcuts", "usage", "computer use", "browser use", "mcp servers", "mcp 服务器", "git", "environments", "环境", "connections", "plugins", "skills"];
  const mainLabels = ["new chat", "quick chat", "search", "搜索", "automations", "自动化", "chats", "对话", "projects", "项目", "settings", "设置"];

  function visibleBox(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return null;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function labelsFrom(root) {
    return [...new Set(Array.from(root.querySelectorAll("button,a,[role='button'],[role='link']"))
      .map((node) => normalize(node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent))
      .filter(Boolean))];
  }

  function markerCount(labels, markers) {
    return markers.filter((marker) => labels.some((label) => label === marker || label.includes(marker))).length;
  }

  function isSettingsSidebar(element) {
    const rect = visibleBox(element);
    if (!rect || rect.width < 120 || rect.width > 620 || rect.height < 80 || rect.left > innerWidth * 0.65) return false;
    const labels = labelsFrom(element);
    const core = markerCount(labels, coreLabels);
    const total = markerCount(labels, coreLabels.concat(extraLabels));
    const main = markerCount(labels, mainLabels);
    return core >= 2 && total >= 3 && !(main >= 2 && markerCount(labels, ["keyboard shortcuts", "usage", "computer use", "mcp servers"]) === 0);
  }

  function findSidebar() {
    const explicit = document.querySelector("nav[aria-label='设置'],nav[aria-label='Settings']");
    if (explicit instanceof HTMLElement && visibleBox(explicit)) return explicit;
    let best = null;
    let bestScore = -1;
    let bestArea = Infinity;
    for (const candidate of document.querySelectorAll("aside,nav,[role='navigation'],div")) {
      if (!(candidate instanceof HTMLElement) || candidate.dataset.codexLoaderSettings) continue;
      if (!isSettingsSidebar(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      const score = markerCount(labelsFrom(candidate), coreLabels) * 100 + markerCount(labelsFrom(candidate), extraLabels);
      const area = rect.width * rect.height;
      if (score > bestScore || (score === bestScore && area < bestArea)) {
        best = candidate;
        bestScore = score;
        bestArea = area;
      }
    }
    return best;
  }

  function findContentArea(sidebar) {
    const explicitAside = sidebar.closest("aside");
    const explicitShell = explicitAside?.parentElement;
    if (explicitShell) {
      const explicitMain = Array.from(explicitShell.children).find((child) => child !== explicitAside && child instanceof HTMLElement);
      if (explicitMain instanceof HTMLElement) return explicitMain;
    }
    let parent = sidebar.parentElement;
    while (parent) {
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement) || child === sidebar || child.contains(sidebar)) continue;
        const rect = child.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 200) return child;
      }
      parent = parent.parentElement;
    }
    return null;
  }

  function pageIcon() {
    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 3v3a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.5"/><path d="M7 11h6M7 14h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  }

  function loaderIcon() {
    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M4 10a6 6 0 0 1 10.24-4.24L16 7.5M16 4v3.5h-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 10a6 6 0 0 1-10.24 4.24L4 12.5M4 16v-3.5h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function groupHeader(text) {
    const header = document.createElement("div");
    header.className = "px-row-x pt-3 pb-1 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wider text-token-description-foreground select-none";
    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = text;
    header.appendChild(label);
    return header;
  }

  function sidebarButton(entry) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.codexLoaderSettings = `nav:${entry.id}`;
    button.setAttribute("aria-label", entry.title);
    button.className = "focus-visible:outline-token-border relative px-row-x py-row-y cursor-interaction shrink-0 items-center overflow-hidden rounded-lg text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 gap-2 flex w-full hover:bg-token-list-hover-background font-normal";
    const inner = document.createElement("div");
    inner.className = "flex min-w-0 items-center text-base gap-2 flex-1 text-token-foreground";
    inner.innerHTML = `${entry.iconSvg || pageIcon()}<span class="truncate"></span>`;
    inner.lastElementChild.textContent = entry.title;
    button.appendChild(inner);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activate(entry.id);
    });
    entry.navButton = button;
    return button;
  }

  function pluginEntries() {
    const entries = [...pages.values()];
    const byOwner = new Map();
    for (const entry of sections.values()) {
      const list = byOwner.get(entry.ownerId) || [];
      list.push(entry);
      byOwner.set(entry.ownerId, list);
    }
    for (const [ownerId, list] of byOwner) {
      const manifest = list[0].manifest;
      entries.push({
        id: `${ownerId}:sections`,
        ownerId,
        title: manifest.name || ownerId,
        description: manifest.description || "",
        iconSvg: null,
        render(root) {
          const cleanups = [];
          for (const section of list) {
            const block = document.createElement("section");
            block.className = "flex flex-col gap-3 border-b border-token-border py-5 first:pt-0 last:border-b-0";
            const heading = document.createElement("div");
            heading.className = "text-sm font-medium text-token-text-primary";
            heading.textContent = section.title;
            block.appendChild(heading);
            if (section.description) {
              const description = document.createElement("div");
              description.className = "text-sm text-token-description-foreground";
              description.textContent = section.description;
              block.appendChild(description);
            }
            const body = document.createElement("div");
            block.appendChild(body);
            root.appendChild(block);
            const cleanup = section.render(body);
            if (typeof cleanup === "function") cleanups.push(cleanup);
          }
          return () => cleanups.reverse().forEach((cleanup) => { try { cleanup(); } catch {} });
        },
      });
    }
    return entries.sort((left, right) => left.title.localeCompare(right.title));
  }

  function loaderLabels() {
    const locale = String(document.documentElement.lang || globalThis.navigator?.language || "").toLowerCase();
    if (locale.startsWith("zh")) {
      return {
        runtime: "概览",
        diagnostics: "诊断",
        loaderGroup: "加载器",
        tweaksGroup: "插件",
        loader: "运行状态",
        loaderDescription: "Loader 已连接到 Codex，可以管理插件脚本。",
        targets: "Codex 页面",
        targetsDescription: "当前可以加载脚本的 Codex 页面数量",
        enabledScripts: "已加载脚本",
        enabledScriptsDescription: "当前由 Loader 管理并运行的脚本数量",
        lastReload: "上次重载",
        lastReloadDescription: "最近一次应用脚本更新的时间",
        safeMode: "安全模式",
        safeModeDescription: "开启后暂停加载所有插件脚本",
        recentError: "最近错误",
        recentErrorDescription: "本次运行中最近记录的错误",
        scripts: "脚本操作",
        reloadTitle: "重新加载插件脚本",
        reloadDescription: "应用最新脚本文件，不刷新 Codex，也不中断当前对话。",
        reload: "重新加载",
        reloading: "正在重新加载…",
        checking: "正在检查 Loader 连接…",
        ready: "可以重新加载。",
        connected: "已连接",
        disconnected: "未连接",
        unavailable: "不可用",
        unknown: "未知",
        active: "已启用",
        off: "关闭",
        none: "无",
        never: "从未",
        noTarget: "没有可用的 Codex 页面。",
        sidecarDisconnected: "Loader 后台服务未连接。",
        bridgeUnavailable: "Loader 控制连接不可用",
        sidecarUnavailable: "Loader 后台服务未连接",
        reloadingStatus: "正在重新加载已启用的脚本…",
        reloadFailed: "脚本重载失败",
        reloadComplete(scriptCount, targetCount) {
          return `已重新加载 ${scriptCount} 个脚本，已应用到 ${targetCount} 个 Codex 页面。`;
        },
      };
    }
    return {
      runtime: "Overview",
      diagnostics: "Diagnostics",
      loaderGroup: "Loader",
      tweaksGroup: "Tweaks",
      loader: "Status",
      loaderDescription: "Loader is connected to Codex and ready to manage plugin scripts.",
      targets: "Codex pages",
      targetsDescription: "Codex pages currently available for script loading",
      enabledScripts: "Loaded scripts",
      enabledScriptsDescription: "Scripts currently managed and running through Loader",
      lastReload: "Last reload",
      lastReloadDescription: "Most recent time script updates were applied",
      safeMode: "Safe mode",
      safeModeDescription: "Pauses all plugin scripts when enabled",
      recentError: "Recent error",
      recentErrorDescription: "Most recent error recorded during this run",
      scripts: "Script actions",
      reloadTitle: "Reload plugin scripts",
      reloadDescription: "Apply the latest script files without refreshing Codex or interrupting the current chat.",
      reload: "Reload",
      reloading: "Reloading…",
      checking: "Checking Loader connection…",
      ready: "Ready to reload.",
      connected: "Connected",
      disconnected: "Disconnected",
      unavailable: "Unavailable",
      unknown: "Unknown",
      active: "Active",
      off: "Off",
      none: "None",
      never: "Never",
      noTarget: "No Codex page is available.",
      sidecarDisconnected: "The Loader background service is not connected.",
      bridgeUnavailable: "The Loader control connection is unavailable",
      sidecarUnavailable: "The Loader background service is not connected",
      reloadingStatus: "Reloading enabled scripts…",
      reloadFailed: "Script reload failed",
      reloadComplete(scriptCount, targetCount) {
        return `Reloaded ${scriptCount} script${scriptCount === 1 ? "" : "s"} across ${targetCount} Codex page${targetCount === 1 ? "" : "s"}.`;
      },
    };
  }

  function formatTime(value, labels) {
    if (!value) return labels.never;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function settingsCard() {
    const card = document.createElement("div");
    card.className = "flex flex-col border";
    card.style.cssText = "overflow:hidden;border:1px solid var(--color-border-default,color-mix(in srgb,currentColor 14%,transparent));border-radius:14px;background:var(--color-background-primary,transparent);";
    return card;
  }

  function settingsSection(titleText) {
    const section = document.createElement("section");
    section.className = "flex flex-col";
    section.style.gap = "14px";
    const title = document.createElement("h2");
    title.className = "text-token-text-primary";
    title.style.cssText = "margin:0;font-size:16px;font-weight:600;line-height:1.4;";
    title.textContent = titleText;
    section.appendChild(title);
    return section;
  }

  function valueRow(titleText, description) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between";
    row.style.cssText = "min-height:76px;gap:28px;padding:15px 20px;border-bottom:1px solid var(--color-border-default,color-mix(in srgb,currentColor 11%,transparent));";
    const stack = document.createElement("div");
    stack.className = "flex min-w-0 flex-1 flex-col";
    const title = document.createElement("div");
    title.className = "text-sm text-token-text-primary";
    title.style.cssText = "font-size:14px;font-weight:600;line-height:1.35;";
    title.textContent = titleText;
    stack.appendChild(title);
    if (description) {
      const detail = document.createElement("div");
      detail.className = "text-token-description-foreground";
      detail.style.cssText = "margin-top:4px;font-size:13px;line-height:1.45;";
      detail.textContent = description;
      stack.appendChild(detail);
    }
    const value = document.createElement("div");
    value.className = "min-w-0 shrink-0 truncate text-right text-token-description-foreground";
    value.style.cssText = "max-width:46%;font-size:13px;line-height:1.45;";
    value.textContent = "—";
    row.append(stack, value);
    return { row, value };
  }

  function renderLoaderPage(root) {
    const labels = loaderLabels();
    let disposed = false;
    let reloading = false;
    let connected = false;
    root.className = "flex flex-col";
    root.style.gap = "36px";

    const runtimeSection = settingsSection(labels.runtime);
    const runtimeCard = settingsCard();
    const connection = valueRow(labels.loader, labels.loaderDescription);
    const scripts = valueRow(labels.enabledScripts, labels.enabledScriptsDescription);
    const lastReload = valueRow(labels.lastReload, labels.lastReloadDescription);
    runtimeCard.append(connection.row, scripts.row, lastReload.row);
    lastReload.row.style.borderBottom = "0";
    runtimeSection.appendChild(runtimeCard);

    const scriptsSection = settingsSection(labels.scripts);
    const scriptsCard = settingsCard();
    const actionRow = document.createElement("div");
    actionRow.className = "flex items-center justify-between";
    actionRow.style.cssText = "min-height:76px;gap:28px;padding:15px 20px;";
    const actionStack = document.createElement("div");
    actionStack.className = "flex min-w-0 flex-1 flex-col";
    const actionTitle = document.createElement("div");
    actionTitle.className = "text-sm text-token-text-primary";
    actionTitle.style.cssText = "font-size:14px;font-weight:600;line-height:1.35;";
    actionTitle.textContent = labels.reloadTitle;
    const actionDescription = document.createElement("div");
    actionDescription.className = "text-token-description-foreground";
    actionDescription.style.cssText = "margin-top:4px;font-size:13px;line-height:1.45;";
    actionDescription.textContent = labels.reloadDescription;
    const feedback = document.createElement("div");
    feedback.className = "text-token-description-foreground";
    feedback.style.cssText = "margin-top:4px;font-size:12px;line-height:1.4;";
    feedback.setAttribute("aria-live", "polite");
    feedback.textContent = labels.checking;
    actionStack.append(actionTitle, actionDescription, feedback);
    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.className = "border-token-border user-select-none no-drag cursor-interaction inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg border px-2 text-sm text-token-text-primary enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40";
    reloadButton.innerHTML = `<span>${labels.reload}</span>`;
    reloadButton.disabled = true;
    actionRow.append(actionStack, reloadButton);
    scriptsCard.appendChild(actionRow);
    scriptsSection.appendChild(scriptsCard);

    const diagnosticsSection = settingsSection(labels.diagnostics);
    const diagnosticsCard = settingsCard();
    const targets = valueRow(labels.targets, labels.targetsDescription);
    const safeMode = valueRow(labels.safeMode, labels.safeModeDescription);
    const lastError = valueRow(labels.recentError, labels.recentErrorDescription);
    diagnosticsCard.append(targets.row, safeMode.row, lastError.row);
    lastError.row.style.borderBottom = "0";
    diagnosticsSection.appendChild(diagnosticsCard);
    root.append(runtimeSection, scriptsSection, diagnosticsSection);

    function setButtonState() {
      reloadButton.disabled = disposed || reloading || !connected;
      const label = reloadButton.querySelector("span");
      if (label) label.textContent = reloading ? labels.reloading : labels.reload;
      reloadButton.setAttribute("aria-busy", reloading ? "true" : "false");
    }

    function markDisconnected(message) {
      connected = false;
      connection.value.textContent = labels.disconnected;
      connection.value.className = "min-w-0 shrink-0 truncate text-right text-token-charts-red";
      targets.value.textContent = "—";
      scripts.value.textContent = "—";
      lastReload.value.textContent = "—";
      safeMode.value.textContent = labels.unknown;
      lastError.value.textContent = message || labels.sidecarUnavailable;
      lastError.value.title = lastError.value.textContent;
      setButtonState();
    }

    function applyStatus(status) {
      connected = Boolean(status && status.loader === "healthy" && status.targetCount > 0 && status.cdp !== "stopped");
      connection.value.textContent = connected ? labels.connected : labels.unavailable;
      connection.value.className = connected
        ? "min-w-0 shrink-0 truncate text-right text-token-text-primary"
        : "min-w-0 shrink-0 truncate text-right text-token-charts-red";
      targets.value.textContent = String(status?.targetCount ?? 0);
      scripts.value.textContent = String(status?.enabledScripts ?? 0);
      lastReload.value.textContent = formatTime(status?.lastInjectionAt, labels);
      safeMode.value.textContent = status?.safeMode ? labels.active : labels.off;
      lastError.value.textContent = status?.lastError || labels.none;
      lastError.value.title = lastError.value.textContent;
      setButtonState();
    }

    async function refreshStatus({ preserveFeedback = false } = {}) {
      const bridge = globalThis.__codexScriptLoaderHostBridge;
      if (!bridge || typeof bridge.request !== "function") {
        markDisconnected(labels.bridgeUnavailable);
        if (!preserveFeedback) feedback.textContent = labels.sidecarDisconnected;
        return;
      }
      try {
        const status = await bridge.request("get_app_status", {});
        if (disposed) return;
        applyStatus(status);
        if (!preserveFeedback) feedback.textContent = connected ? "" : labels.noTarget;
      } catch (error) {
        if (disposed) return;
        markDisconnected(String(error?.message || error));
        if (!preserveFeedback) feedback.textContent = labels.sidecarDisconnected;
      }
    }

    reloadButton.addEventListener("click", async () => {
      if (reloading || !connected) return;
      reloading = true;
      feedback.className = "text-token-description-foreground";
      feedback.textContent = labels.reloadingStatus;
      setButtonState();
      try {
        const result = await globalThis.__codexScriptLoaderHostBridge.request("reload_scripts", {});
        if (disposed) return;
        const scriptCount = Number(result?.scriptCount || 0);
        const targetCount = Number(result?.targetCount || 0);
        feedback.className = "text-token-text-primary";
        feedback.textContent = labels.reloadComplete(scriptCount, targetCount);
        await refreshStatus({ preserveFeedback: true });
      } catch (error) {
        if (disposed) return;
        feedback.className = "text-token-charts-red";
        feedback.textContent = String(error?.message || error || labels.reloadFailed);
        await refreshStatus({ preserveFeedback: true });
      } finally {
        reloading = false;
        if (!disposed) setButtonState();
      }
    });

    void refreshStatus();
    return () => { disposed = true; };
  }

  const loaderEntry = {
    id: "loader:runtime",
    ownerId: "loader",
    title: "Loader",
    description: "",
    iconSvg: loaderIcon(),
    render: renderLoaderPage,
  };

  function combinedEntries() {
    return [loaderEntry, ...pluginEntries()];
  }

  function sync() {
    const sidebar = findSidebar();
    if (!sidebar) return;
    const outer = sidebar.parentElement && isSettingsSidebar(sidebar.parentElement) ? sidebar.parentElement : sidebar;
    sidebarRoot = outer;
    const plugins = pluginEntries();
    const entries = [loaderEntry, ...plugins];
    const mountedGroups = Array.from(document.querySelectorAll("[data-codex-loader-settings='pages-group']"));
    const existing = mountedGroups.find((node) => node.parentElement === outer) || null;
    for (const node of mountedGroups) {
      if (node !== existing) node.remove();
    }
    if (!entries.length) {
      existing?.remove();
      pagesGroup = null;
      return;
    }
    const desired = entries.map((entry) => `${entry.id}|${entry.title}`).join("\n");
    if (existing?.dataset.fingerprint === desired) {
      pagesGroup = existing;
      return;
    }
    existing?.remove();
    const group = document.createElement("div");
    group.dataset.codexLoaderSettings = "pages-group";
    group.dataset.fingerprint = desired;
    group.className = "flex flex-col gap-1";
    const loaderGroup = document.createElement("div");
    loaderGroup.className = "flex flex-col gap-px";
    const groupLabels = loaderLabels();
    loaderGroup.append(groupHeader(groupLabels.loaderGroup), sidebarButton(loaderEntry));
    group.appendChild(loaderGroup);
    if (plugins.length) {
      const tweaksGroup = document.createElement("div");
      tweaksGroup.className = "flex flex-col gap-px";
      tweaksGroup.appendChild(groupHeader(groupLabels.tweaksGroup));
      for (const entry of plugins) tweaksGroup.appendChild(sidebarButton(entry));
      group.appendChild(tweaksGroup);
    }
    outer.appendChild(group);
    pagesGroup = group;
    applyActive();
  }

  function applyActive() {
    if (!pagesGroup) return;
    for (const button of pagesGroup.querySelectorAll("button[data-codex-loader-settings]")) {
      const active = button.dataset.codexLoaderSettings === `nav:${activeId}`;
      button.classList.toggle("bg-token-list-hover-background", active);
      button.classList.toggle("hover:bg-token-list-hover-background", !active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (activeId && sidebarRoot) {
      for (const button of sidebarRoot.querySelectorAll("button[aria-current='page']")) {
        if (!button.closest("[data-codex-loader-settings='pages-group']")) button.removeAttribute("aria-current");
      }
    }
  }

  function restoreNative() {
    try { activeTeardown?.(); } catch {}
    activeTeardown = null;
    activeId = null;
    if (panelHost) panelHost.style.display = "none";
    const content = sidebarRoot ? findContentArea(sidebarRoot) : null;
    if (content) {
      for (const child of content.children) {
        if (!(child instanceof HTMLElement) || child === panelHost) continue;
        if (child.dataset.codexLoaderPreviousDisplay !== undefined) {
          child.style.display = child.dataset.codexLoaderPreviousDisplay;
          delete child.dataset.codexLoaderPreviousDisplay;
        }
      }
    }
    applyActive();
  }

  function activate(id) {
    const entry = combinedEntries().find((candidate) => candidate.id === id);
    if (!entry || !sidebarRoot) return;
    const content = findContentArea(sidebarRoot);
    if (!content) return;
    try { activeTeardown?.(); } catch {}
    activeTeardown = null;
    activeId = id;
    pendingActiveId = null;
    for (const child of content.children) {
      if (!(child instanceof HTMLElement) || child === panelHost) continue;
      if (child.dataset.codexLoaderPreviousDisplay === undefined) child.dataset.codexLoaderPreviousDisplay = child.style.display || "";
      child.style.display = "none";
    }
    if (!panelHost || panelHost.parentElement !== content) {
      panelHost?.remove();
      panelHost = document.createElement("div");
      panelHost.dataset.codexLoaderSettings = "panel-host";
      panelHost.style.cssText = "box-sizing:border-box;width:100%;height:100%;overflow:auto;";
      content.appendChild(panelHost);
    }
    panelHost.style.display = "block";
    panelHost.innerHTML = "";
    const shell = document.createElement("div");
    shell.dataset.codexLoaderSettings = "page-shell";
    shell.style.cssText = "box-sizing:border-box;width:calc(100% - 48px);max-width:48rem;margin:0 auto;padding:108px 0 64px;";
    const header = document.createElement("header");
    header.className = "flex flex-col";
    header.style.marginBottom = "40px";
    const title = document.createElement("h1");
    title.className = "min-w-0 break-words text-default heading-lg font-normal";
    title.style.cssText = "margin:0;font-size:24px;line-height:1.2;font-weight:400;letter-spacing:-0.015em;";
    title.textContent = entry.title;
    header.appendChild(title);
    if (entry.description) {
      const description = document.createElement("p");
      description.className = "text-sm text-token-description-foreground";
      description.style.cssText = "margin:8px 0 0;font-size:14px;line-height:1.45;";
      description.textContent = entry.description;
      header.appendChild(description);
    }
    const root = document.createElement("div");
    root.className = "flex flex-col";
    shell.append(header, root);
    panelHost.appendChild(shell);
    const cleanup = entry.render(root);
    if (typeof cleanup === "function") activeTeardown = cleanup;
    applyActive();
    if (restoreHandler) sidebarRoot.removeEventListener("click", restoreHandler, true);
    restoreHandler = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest("[data-codex-loader-settings='pages-group']")) return;
      pendingActiveId = null;
      restoreNative();
    };
    sidebarRoot.addEventListener("click", restoreHandler, true);
  }

  function scheduleSync() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      try { sync(); } catch (error) { console.warn("[codex-script-loader/settings] sync failed", error); }
    }, 80);
  }

  const host = {
    version,
    start() {
      if (!observer) {
        observer = new MutationObserver(scheduleSync);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      scheduleSync();
    },
    registerPage(ownerId, manifest, page) {
      if (!page || typeof page.id !== "string" || !page.id || typeof page.title !== "string" || !page.title || typeof page.render !== "function") {
        throw new Error("settings page requires id, title and render(root)");
      }
      const id = `${ownerId}:${page.id}`;
      pages.set(id, { ...page, id, ownerId, manifest });
      scheduleSync();
      if (pendingActiveId === id) setTimeout(() => activate(id), 100);
      return { unregister() { pages.delete(id); if (activeId === id) { pendingActiveId = id; restoreNative(); } scheduleSync(); } };
    },
    registerSection(ownerId, manifest, section) {
      if (!section || typeof section.id !== "string" || !section.id || typeof section.title !== "string" || !section.title || typeof section.render !== "function") {
        throw new Error("settings section requires id, title and render(root)");
      }
      const id = `${ownerId}:${section.id}`;
      sections.set(id, { ...section, id, ownerId, manifest });
      scheduleSync();
      return { unregister() { sections.delete(id); if (activeId === `${ownerId}:sections`) restoreNative(); scheduleSync(); } };
    },
    snapshot() {
      return { version, builtinPageCount: 1, pageCount: pages.size, sectionCount: sections.size, activeId, mounted: Boolean(pagesGroup?.isConnected) };
    },
    stop() {
      observer?.disconnect();
      observer = null;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = 0;
      restoreNative();
      document.querySelectorAll("[data-codex-loader-settings='pages-group']").forEach((node) => node.remove());
      panelHost?.remove();
      pagesGroup = null;
      panelHost = null;
      pages.clear();
      sections.clear();
      pendingActiveId = null;
    },
  };
  runtime.settingsHost = host;
  host.start();
}

export function buildSettingsHostSource() {
  return `(${installSettingsHost.toString()})(${JSON.stringify(SETTINGS_HOST_VERSION)});`;
}

export { SETTINGS_HOST_VERSION };
