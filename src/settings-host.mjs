const SETTINGS_HOST_VERSION = "0.4.1";

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
  let panelSurface = null;
  let activeId = null;
  let pendingActiveId = null;
  let restoreHandler = null;
  let activeTeardown = null;
  let managedPlugins = [];
  let managementRefreshTimer = 0;

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

  function findNativePageSurface(content) {
    if (panelSurface?.isConnected && content.contains(panelSurface)) return panelSurface;
    const candidates = Array.from(content.querySelectorAll("div")).filter((node) => {
      if (!(node instanceof HTMLElement) || node.dataset.codexLoaderSettings) return false;
      const className = String(node.className || "");
      return className.includes("overflow-y-auto") && className.includes("p-panel") && node.querySelector("h1");
    });
    return candidates.find((node) => visibleBox(node)) || candidates[0] || null;
  }

  function findNativePageTemplate(surface) {
    return Array.from(surface?.children || []).find((node) => node instanceof HTMLElement && !node.dataset.codexLoaderSettings && node.querySelector("h1")) || null;
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
            root.className = "flex flex-col gap-10";
            for (const section of list) {
              const block = settingsSection(section.title);
              const titleStack = block.querySelector('[data-codex-loader-settings="section-title-stack"]');
              if (section.description) {
                const description = document.createElement("div");
                description.className = "text-sm text-secondary";
                description.textContent = section.description;
                titleStack?.appendChild(description);
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
    const representedOwners = new Set(entries.map((entry) => entry.ownerId));
    for (const plugin of managedPlugins) {
      if (plugin.settingsMode !== "page" || representedOwners.has(plugin.id)) continue;
      const pageId = plugin.settingsPageId || "main";
      const id = `${plugin.id}:${pageId}`;
      entries.push({
        id,
        ownerId: plugin.id,
        title: plugin.settingsPageTitle || plugin.name || plugin.id,
        description: plugin.description || "",
        iconSvg: null,
        render(root) {
          const labels = loaderLabels();
          root.className = "flex flex-col";
          root.style.gap = "20px";
          const card = settingsCard();
          const row = valueRow(labels.pluginUnavailableTitle, labels.pluginUnavailableDescription);
          row.value.textContent = labels.statusLabel(plugin.status);
          card.appendChild(row.row);
          const actions = document.createElement("div");
          actions.className = "flex items-center justify-end gap-2";
          actions.style.cssText = "padding:15px 20px;border-top:1px solid var(--color-border-default,color-mix(in srgb,currentColor 11%,transparent));";
          const action = actionButton(plugin.enabled ? labels.reload : labels.enable);
          action.addEventListener("click", async () => {
            action.disabled = true;
            pendingActiveId = id;
            try {
              if (plugin.enabled) await requestBridge("reload_plugins", { ids: [plugin.id] });
              else await requestBridge("set_plugin_enabled", { id: plugin.id, enabled: true });
              await refreshManagedPlugins();
              setTimeout(() => activate(id), 120);
            } catch (error) {
              row.value.textContent = String(error?.message || error);
              row.value.className = "min-w-0 shrink-0 truncate text-right text-token-charts-red";
            } finally {
              action.disabled = false;
            }
          });
          actions.appendChild(action);
          card.appendChild(actions);
          root.appendChild(card);
        },
      });
    }
    return entries.sort((left, right) => left.title.localeCompare(right.title));
  }

  async function requestBridge(command, payload = {}) {
    const bridge = globalThis.__codexScriptLoaderHostBridge;
    if (!bridge || typeof bridge.request !== "function") throw new Error(loaderLabels().bridgeUnavailable);
    return bridge.request(command, payload);
  }

  async function refreshManagedPlugins() {
    try {
      const plugins = await requestBridge("list_plugins", {});
      managedPlugins = Array.isArray(plugins) ? plugins : [];
      scheduleSync();
      return managedPlugins;
    } catch {
      managedPlugins = [];
      scheduleSync();
      return managedPlugins;
    }
  }

  function loaderLabels() {
    const locale = String(document.documentElement.lang || globalThis.navigator?.language || "").toLowerCase();
    if (locale.startsWith("zh")) {
      return {
        runtime: "概览",
        diagnostics: "诊断",
        loaderGroup: "Script-Loader",
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
        plugins: "插件",
        pluginsDescription: "添加、启用、重载和移除本地 renderer 插件。",
        addFolder: "添加文件夹",
        addArchive: "添加 ZIP",
        reloadAll: "全部重新加载",
        noPlugins: "还没有安装插件。",
        builtIn: "内置",
        local: "本地",
        legacy: "旧版规范",
        version: "版本",
        reloadOne: "重新加载",
        documentation: "说明",
        remove: "移除",
        restore: "恢复",
        removedPlugins: "最近移除",
        installTitle: "安装插件",
        installEnabled: "安装并启用",
        installDisabled: "仅安装",
        cancel: "取消",
        permissions: "权限",
        settingsSupport: "设置页面",
        settingsPage: "提供设置页面",
        settingsNone: "没有设置页面",
        settingsLegacy: "未声明",
        removeTitle: "移除插件？",
        removeDescription: "插件会停止运行并移入隔离区，之后仍可恢复。",
        restartSection: "Codex",
        restartTitle: "重启 Codex",
        restartDescription: "关闭并重新打开由 Loader 管理的 Codex，然后重新加载已启用插件。未发送的输入可能丢失。",
        restart: "重启",
        restartConfirm: "重启并重新打开",
        restartDialogTitle: "现在重启 Codex？",
        restarting: "正在重启 Codex…",
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
        settings: "设置",
        enable: "启用",
        pluginUnavailableTitle: "插件设置当前不可用",
        pluginUnavailableDescription: "插件已禁用或启动失败。启用或重载插件后会显示它提供的设置页面。",
        statusLabel(status) {
          return ({ running: "运行中", disabled: "已禁用", ready: "等待加载", failed: "启动失败", invalid: "包无效" })[status] || "未知";
        },
        reloadComplete(scriptCount, targetCount) {
          return `已重新加载 ${scriptCount} 个插件，已应用到 ${targetCount} 个 Codex 页面。`;
        },
      };
    }
    return {
      runtime: "Overview",
      diagnostics: "Diagnostics",
      loaderGroup: "Script-Loader",
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
      plugins: "Plugins",
      pluginsDescription: "Add, enable, reload, and remove local renderer plugins.",
      addFolder: "Add folder",
      addArchive: "Add ZIP",
      reloadAll: "Reload all",
      noPlugins: "No plugins are installed yet.",
      builtIn: "Built in",
      local: "Local",
      legacy: "Legacy contract",
      version: "Version",
      reloadOne: "Reload",
      documentation: "Readme",
      remove: "Remove",
      restore: "Restore",
      removedPlugins: "Recently removed",
      installTitle: "Install plugin",
      installEnabled: "Install and enable",
      installDisabled: "Install only",
      cancel: "Cancel",
      permissions: "Permissions",
      settingsSupport: "Settings",
      settingsPage: "Provides a settings page",
      settingsNone: "No settings page",
      settingsLegacy: "Not declared",
      removeTitle: "Remove plugin?",
      removeDescription: "The plugin will stop and move to quarantine, where it can still be restored.",
      restartSection: "Codex",
      restartTitle: "Restart Codex",
      restartDescription: "Close and reopen the Loader-managed Codex, then load enabled plugins again. Unsent input may be lost.",
      restart: "Restart",
      restartConfirm: "Restart and reopen",
      restartDialogTitle: "Restart Codex now?",
      restarting: "Restarting Codex…",
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
      settings: "Settings",
      enable: "Enable",
      pluginUnavailableTitle: "Plugin settings are unavailable",
      pluginUnavailableDescription: "The plugin is disabled or failed to start. Enable or reload it to show the settings page it provides.",
      statusLabel(status) {
        return ({ running: "Running", disabled: "Disabled", ready: "Waiting", failed: "Failed", invalid: "Invalid package" })[status] || "Unknown";
      },
      reloadComplete(scriptCount, targetCount) {
        return `Reloaded ${scriptCount} plugin${scriptCount === 1 ? "" : "s"} across ${targetCount} Codex page${targetCount === 1 ? "" : "s"}.`;
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
    card.className = "flex flex-col [&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none [&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-4 [&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-[0.5px] [&>*:not(:last-child)]:after:bg-border [&>*:not(:last-child)]:after:content-[''] rounded-2xl overflow-hidden border border-default";
    return card;
  }

  function actionButton(label, { danger = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `border-token-border user-select-none no-drag cursor-interaction inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg border px-2 text-sm ${danger ? "text-token-charts-red" : "text-token-text-primary"} enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40`;
    button.textContent = label;
    return button;
  }

  function settingsSection(titleText) {
    const section = document.createElement("section");
    section.className = "flex flex-col";
    const headingRow = document.createElement("div");
    headingRow.dataset.codexLoaderSettings = "section-header";
    headingRow.className = "flex justify-between gap-4 min-h-toolbar items-center pb-1.5";
    const titleStack = document.createElement("div");
    titleStack.dataset.codexLoaderSettings = "section-title-stack";
    titleStack.className = "flex min-w-0 flex-1 flex-col gap-0.5";
    const title = document.createElement("div");
    title.className = "font-medium text-default text-base";
    title.textContent = titleText;
    titleStack.appendChild(title);
    headingRow.appendChild(titleStack);
    section.appendChild(headingRow);
    return section;
  }

  function valueRow(titleText, description) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between px-4 gap-6 py-3";
    const stack = document.createElement("div");
    stack.className = "flex min-w-0 flex-1 flex-col gap-0.5";
    const title = document.createElement("div");
    title.className = "min-w-0 text-sm text-default font-medium";
    title.textContent = titleText;
    stack.appendChild(title);
    if (description) {
      const detail = document.createElement("div");
      detail.className = "text-sm text-secondary";
      detail.textContent = description;
      stack.appendChild(detail);
    }
    const value = document.createElement("div");
    value.className = "min-w-0 max-w-[46%] shrink-0 truncate text-right text-sm text-secondary";
    value.textContent = "—";
    row.append(stack, value);
    return { row, value };
  }

  function renderLoaderPage(root) {
    const labels = loaderLabels();
    let disposed = false;
    let connected = false;
    let busy = false;
    let plugins = [];
    let quarantined = [];
    root.className = "flex flex-col gap-10";
    root.style.cssText = "";

    const overviewSection = settingsSection(labels.runtime);
    const overviewCard = settingsCard();
    const connection = valueRow(labels.loader, labels.loaderDescription);
    const pluginCount = valueRow(labels.enabledScripts, labels.enabledScriptsDescription);
    const lastReload = valueRow(labels.lastReload, labels.lastReloadDescription);
    overviewCard.append(connection.row, pluginCount.row, lastReload.row);
    overviewSection.appendChild(overviewCard);

    const pluginsSection = settingsSection(labels.plugins);
    const pluginsHeaderRow = pluginsSection.querySelector('[data-codex-loader-settings="section-header"]');
    const pluginsHeaderStack = pluginsSection.querySelector('[data-codex-loader-settings="section-title-stack"]');
    const pluginHeaderActions = document.createElement("div");
    pluginHeaderActions.className = "flex items-center gap-2";
    const addFolderButton = actionButton(labels.addFolder);
    const addArchiveButton = actionButton(labels.addArchive);
    const reloadAllButton = actionButton(labels.reloadAll);
    pluginHeaderActions.append(addFolderButton, addArchiveButton, reloadAllButton);
    pluginsHeaderRow.appendChild(pluginHeaderActions);
    const pluginDescription = document.createElement("div");
    pluginDescription.className = "text-sm text-secondary";
    pluginDescription.textContent = labels.pluginsDescription;
    pluginsHeaderStack.appendChild(pluginDescription);
    const feedback = document.createElement("div");
    feedback.className = "min-h-4 text-xs text-secondary";
    feedback.setAttribute("aria-live", "polite");
    pluginsHeaderStack.appendChild(feedback);
    const pluginsCard = settingsCard();
    pluginsSection.appendChild(pluginsCard);

    const removedSection = settingsSection(labels.removedPlugins);
    const removedCard = settingsCard();
    removedSection.appendChild(removedCard);
    removedSection.style.display = "none";

    const restartSection = settingsSection(labels.restartSection);
    const restartCard = settingsCard();
    const restartRow = document.createElement("div");
    restartRow.className = "flex items-center justify-between px-4 gap-6 py-3";
    const restartStack = document.createElement("div");
    restartStack.className = "flex min-w-0 flex-1 flex-col gap-0.5";
    const restartTitle = document.createElement("div");
    restartTitle.className = "min-w-0 text-sm text-default font-medium";
    restartTitle.textContent = labels.restartTitle;
    const restartDescription = document.createElement("div");
    restartDescription.className = "text-sm text-secondary";
    restartDescription.textContent = labels.restartDescription;
    restartStack.append(restartTitle, restartDescription);
    const restartButton = actionButton(labels.restart);
    restartRow.append(restartStack, restartButton);
    restartCard.appendChild(restartRow);
    restartSection.appendChild(restartCard);

    const diagnosticsSection = settingsSection(labels.diagnostics);
    const diagnosticsCard = settingsCard();
    const targets = valueRow(labels.targets, labels.targetsDescription);
    const safeMode = valueRow(labels.safeMode, labels.safeModeDescription);
    const lastError = valueRow(labels.recentError, labels.recentErrorDescription);
    diagnosticsCard.append(targets.row, safeMode.row, lastError.row);
    diagnosticsSection.appendChild(diagnosticsCard);

    root.append(overviewSection, pluginsSection, removedSection, restartSection, diagnosticsSection);

    function setBusy(next, message = "") {
      busy = next;
      feedback.textContent = message;
      for (const button of [addFolderButton, addArchiveButton, reloadAllButton, restartButton]) button.disabled = next || !connected;
      renderPlugins();
    }

    function statusBadge(plugin) {
      const badge = document.createElement("span");
      badge.className = plugin.status === "failed" || plugin.status === "invalid" ? "text-token-charts-red" : "text-token-description-foreground";
      badge.style.cssText = "display:inline-flex;align-items:center;min-height:20px;padding:1px 7px;border:1px solid var(--color-border-default,color-mix(in srgb,currentColor 14%,transparent));border-radius:999px;font-size:11px;line-height:1.35;";
      badge.textContent = labels.statusLabel(plugin.status);
      return badge;
    }

    function switchControl(plugin) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", `${plugin.name}: ${labels.enable}`);
      toggle.setAttribute("aria-checked", plugin.enabled ? "true" : "false");
      toggle.disabled = busy || plugin.status === "invalid" || !connected;
      toggle.style.cssText = `box-sizing:border-box;position:relative;width:34px;height:20px;padding:2px;border:0;border-radius:999px;background:${plugin.enabled ? "var(--color-accent-blue,#2f9bf4)" : "var(--color-background-tertiary,#d8d8dc)"};cursor:pointer;`;
      const knob = document.createElement("span");
      knob.style.cssText = `display:block;width:16px;height:16px;border-radius:50%;background:white;box-shadow:0 1px 2px color-mix(in srgb,black 28%,transparent);transform:translateX(${plugin.enabled ? "14px" : "0"});transition:transform .15s ease;`;
      toggle.appendChild(knob);
      toggle.addEventListener("click", () => runPluginAction(plugin, "toggle"));
      return toggle;
    }

    function renderPlugins() {
      pluginsCard.innerHTML = "";
      if (!plugins.length) {
        const empty = document.createElement("div");
        empty.className = "px-4 py-3 text-sm text-secondary";
        empty.textContent = labels.noPlugins;
        pluginsCard.appendChild(empty);
        return;
      }
      plugins.forEach((plugin, index) => {
        const row = document.createElement("div");
        row.className = "flex items-center justify-between px-4 gap-6 py-3";
        const info = document.createElement("div");
        info.className = "flex min-w-0 flex-1 flex-col gap-0.5";
        const titleRow = document.createElement("div");
        titleRow.className = "flex min-w-0 items-center gap-2";
        const title = document.createElement("div");
        title.className = "min-w-0 truncate text-sm text-default font-medium";
        title.textContent = plugin.name || plugin.id;
        titleRow.append(title, statusBadge(plugin));
        const meta = document.createElement("div");
        meta.className = "truncate text-sm text-secondary";
        meta.textContent = `${plugin.id} · ${labels.version} ${plugin.version} · ${plugin.bundled ? labels.builtIn : labels.local}${plugin.legacy ? ` · ${labels.legacy}` : ""}`;
        info.append(titleRow, meta);
        if (plugin.error) {
          const error = document.createElement("div");
          error.className = "truncate text-xs text-token-charts-red";
          error.textContent = plugin.error;
          error.title = plugin.error;
          info.appendChild(error);
        }
        const actions = document.createElement("div");
        actions.className = "flex shrink-0 items-center gap-2";
        if (plugin.documentationExcerpt) {
          const docs = actionButton(labels.documentation);
          docs.disabled = busy;
          docs.addEventListener("click", () => showDialog({ title: plugin.name, body: plugin.documentationExcerpt, buttons: [{ label: labels.cancel, value: "close" }] }));
          actions.appendChild(docs);
        }
        const reload = actionButton(labels.reloadOne);
        reload.disabled = busy || !plugin.enabled || plugin.status === "invalid" || !connected;
        reload.addEventListener("click", () => runPluginAction(plugin, "reload"));
        actions.appendChild(reload);
        if (!plugin.bundled) {
          const remove = actionButton(labels.remove, { danger: true });
          remove.disabled = busy || !connected;
          remove.addEventListener("click", () => runPluginAction(plugin, "remove"));
          actions.appendChild(remove);
        }
        actions.appendChild(switchControl(plugin));
        row.append(info, actions);
        pluginsCard.appendChild(row);
      });
    }

    function renderQuarantined() {
      removedCard.innerHTML = "";
      removedSection.style.display = quarantined.length ? "flex" : "none";
      quarantined.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "flex items-center justify-between px-4 gap-6 py-3";
        const label = document.createElement("div");
        label.className = "min-w-0 truncate text-sm text-token-text-primary";
        label.textContent = `${item.name} · ${item.version}`;
        const restore = actionButton(labels.restore);
        restore.disabled = busy || !connected;
        restore.addEventListener("click", async () => {
          setBusy(true, labels.checking);
          try { await requestBridge("restore_plugin", { key: item.key }); await refresh(); }
          catch (error) { feedback.textContent = String(error?.message || error); }
          finally { if (!disposed) setBusy(false, feedback.textContent); }
        });
        row.append(label, restore);
        removedCard.appendChild(row);
      });
    }

    async function runPluginAction(plugin, action) {
      if (busy) return;
      if (action === "remove") {
        const choice = await showDialog({ title: labels.removeTitle, body: `${plugin.name}\n\n${labels.removeDescription}`, buttons: [{ label: labels.cancel, value: "cancel" }, { label: labels.remove, value: "remove", danger: true }] });
        if (choice !== "remove") return;
      }
      setBusy(true, action === "reload" ? labels.reloadingStatus : labels.checking);
      try {
        if (action === "toggle") await requestBridge("set_plugin_enabled", { id: plugin.id, enabled: !plugin.enabled });
        else if (action === "reload") {
          const result = await requestBridge("reload_plugins", { ids: [plugin.id] });
          if (Array.isArray(result?.failed) && result.failed.length) throw new Error(`${labels.reloadFailed}: ${result.failed.join(", ")}`);
          feedback.textContent = labels.reloadComplete(Number(result?.scriptCount || 0), Number(result?.targetCount || 0));
        } else if (action === "remove") await requestBridge("remove_plugin", { id: plugin.id });
        await refresh({ preserveFeedback: action === "reload" });
      } catch (error) {
        feedback.className = "text-token-charts-red";
        feedback.textContent = String(error?.message || error || labels.reloadFailed);
      } finally {
        if (!disposed) setBusy(false, feedback.textContent);
      }
    }

    async function addPlugin(command) {
      if (busy) return;
      setBusy(true, labels.checking);
      try {
        const preview = await requestBridge(command, {});
        if (preview?.cancelled) return;
        const settingsText = preview.settingsMode === "page" ? labels.settingsPage : preview.settingsMode === "none" ? labels.settingsNone : labels.settingsLegacy;
        const body = [preview.description || preview.id, `${labels.version}: ${preview.version}`, `${labels.permissions}: ${(preview.permissions || []).join(", ") || labels.none}`, `${labels.settingsSupport}: ${settingsText}`, preview.documentationExcerpt || ""].filter(Boolean).join("\n\n");
        const choice = await showDialog({ title: `${labels.installTitle}: ${preview.name}`, body, buttons: [{ label: labels.cancel, value: "cancel" }, { label: labels.installDisabled, value: "disabled" }, { label: labels.installEnabled, value: "enabled", primary: true }] });
        if (choice === "cancel" || !choice) {
          await requestBridge("cancel_plugin_install", { token: preview.token });
          return;
        }
        await requestBridge("install_plugin", { token: preview.token, enabled: choice === "enabled" });
        await refresh();
      } catch (error) {
        feedback.className = "text-token-charts-red";
        feedback.textContent = String(error?.message || error);
      } finally {
        if (!disposed) setBusy(false, feedback.textContent);
      }
    }

    function showDialog({ title, body, buttons }) {
      return new Promise((resolve) => {
        const previouslyFocused = document.activeElement;
        const overlay = document.createElement("div");
        overlay.dataset.codexLoaderSettings = "dialog";
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,black 42%,transparent);";
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.style.cssText = "box-sizing:border-box;width:min(520px,100%);max-height:min(680px,calc(100vh - 48px));overflow:auto;padding:22px;border:1px solid var(--color-border-default,color-mix(in srgb,currentColor 14%,transparent));border-radius:16px;background:var(--color-background-primary,#fff);box-shadow:0 18px 60px color-mix(in srgb,black 28%,transparent);";
        const heading = document.createElement("h2");
        heading.id = `codex-loader-dialog-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        dialog.setAttribute("aria-labelledby", heading.id);
        heading.className = "text-token-text-primary";
        heading.style.cssText = "margin:0;font-size:18px;font-weight:600;line-height:1.35;";
        heading.textContent = title;
        const content = document.createElement("div");
        content.className = "text-token-description-foreground";
        content.style.cssText = "margin-top:12px;white-space:pre-wrap;font-size:13px;line-height:1.55;";
        content.textContent = body;
        const actions = document.createElement("div");
        actions.className = "flex flex-wrap items-center justify-end gap-2";
        actions.style.marginTop = "22px";
        let finished = false;
        const finish = (value) => {
          if (finished) return;
          finished = true;
          overlay.remove();
          if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
          resolve(value);
        };
        const onKeyDown = (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          finish(null);
        };
        for (const spec of buttons) {
          const button = actionButton(spec.label, { danger: Boolean(spec.danger) });
          if (spec.primary) button.style.background = "var(--color-accent-blue,#2f9bf4)", button.style.color = "white";
          button.addEventListener("click", () => finish(spec.value));
          actions.appendChild(button);
        }
        dialog.append(heading, content, actions);
        overlay.appendChild(dialog);
        overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
        overlay.addEventListener("keydown", onKeyDown, true);
        document.body.appendChild(overlay);
        actions.lastElementChild?.focus();
      });
    }

    async function refresh({ preserveFeedback = false } = {}) {
      try {
        const [status, nextPlugins, nextQuarantined] = await Promise.all([
          requestBridge("get_app_status", {}),
          requestBridge("list_plugins", {}),
          requestBridge("list_quarantined", {}),
        ]);
        if (disposed) return;
        connected = Boolean(status && status.loader === "healthy" && status.targetCount > 0 && status.cdp !== "stopped");
        plugins = Array.isArray(nextPlugins) ? nextPlugins : [];
        managedPlugins = plugins;
        quarantined = Array.isArray(nextQuarantined) ? nextQuarantined : [];
        connection.value.textContent = connected ? labels.connected : labels.unavailable;
        connection.value.className = connected ? "min-w-0 shrink-0 truncate text-right text-token-text-primary" : "min-w-0 shrink-0 truncate text-right text-token-charts-red";
        pluginCount.value.textContent = String(plugins.filter((plugin) => plugin.status === "running").length);
        lastReload.value.textContent = formatTime(status?.lastInjectionAt, labels);
        targets.value.textContent = String(status?.targetCount ?? 0);
        safeMode.value.textContent = status?.safeMode ? labels.active : labels.off;
        lastError.value.textContent = status?.lastError || labels.none;
        lastError.value.title = lastError.value.textContent;
        if (!preserveFeedback) feedback.textContent = connected ? "" : labels.noTarget;
        feedback.className = "text-token-description-foreground";
        renderPlugins();
        renderQuarantined();
        scheduleSync();
      } catch (error) {
        if (disposed) return;
        connected = false;
        connection.value.textContent = labels.disconnected;
        connection.value.className = "min-w-0 shrink-0 truncate text-right text-token-charts-red";
        feedback.className = "text-token-charts-red";
        feedback.textContent = String(error?.message || error || labels.sidecarUnavailable);
        renderPlugins();
      }
      for (const button of [addFolderButton, addArchiveButton, reloadAllButton, restartButton]) button.disabled = busy || !connected;
    }

    addFolderButton.addEventListener("click", () => addPlugin("pick_plugin_folder"));
    addArchiveButton.addEventListener("click", () => addPlugin("pick_plugin_archive"));
    reloadAllButton.addEventListener("click", async () => {
      if (busy) return;
      setBusy(true, labels.reloadingStatus);
      try {
        const result = await requestBridge("reload_plugins", {});
        if (Array.isArray(result?.failed) && result.failed.length) throw new Error(`${labels.reloadFailed}: ${result.failed.join(", ")}`);
        feedback.textContent = labels.reloadComplete(Number(result?.scriptCount || 0), Number(result?.targetCount || 0));
        await refresh({ preserveFeedback: true });
      } catch (error) {
        feedback.className = "text-token-charts-red";
        feedback.textContent = String(error?.message || error || labels.reloadFailed);
      } finally {
        if (!disposed) setBusy(false, feedback.textContent);
      }
    });
    restartButton.addEventListener("click", async () => {
      const choice = await showDialog({ title: labels.restartDialogTitle, body: labels.restartDescription, buttons: [{ label: labels.cancel, value: "cancel" }, { label: labels.restartConfirm, value: "restart", primary: true }] });
      if (choice !== "restart") return;
      restartButton.disabled = true;
      feedback.textContent = labels.restarting;
      try { await requestBridge("restart_codex", {}); }
      catch (error) { feedback.textContent = String(error?.message || error); restartButton.disabled = false; }
    });

    void refresh();
    return () => {
      disposed = true;
      document.querySelectorAll('[data-codex-loader-settings="dialog"]').forEach((node) => node.remove());
    };
  }

  const loaderEntry = {
    id: "loader:runtime",
    ownerId: "loader",
    title: loaderLabels().settings,
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
    for (const entry of plugins) loaderGroup.appendChild(sidebarButton(entry));
    group.appendChild(loaderGroup);
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
    if (panelSurface?.isConnected) {
      for (const child of panelSurface.children) {
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
    const surface = findNativePageSurface(content);
    if (!surface) return;
    try { activeTeardown?.(); } catch {}
    activeTeardown = null;
    activeId = id;
    pendingActiveId = null;
    const template = findNativePageTemplate(surface);
    panelSurface = surface;
    for (const child of surface.children) {
      if (!(child instanceof HTMLElement) || child === panelHost) continue;
      if (child.dataset.codexLoaderPreviousDisplay === undefined) child.dataset.codexLoaderPreviousDisplay = child.style.display || "";
      child.style.display = "none";
    }
    if (!panelHost || panelHost.parentElement !== surface) {
      panelHost?.remove();
      panelHost = document.createElement("div");
      panelHost.dataset.codexLoaderSettings = "panel-host";
      panelHost.className = template?.className || "mx-auto flex w-full flex-col max-w-3xl electron:min-w-[calc(320px*var(--codex-window-zoom))]";
      surface.appendChild(panelHost);
    }
    panelHost.style.cssText = "";
    panelHost.style.display = "flex";
    panelHost.innerHTML = "";
    const shell = document.createElement("div");
    shell.dataset.codexLoaderSettings = "page-shell";
    shell.className = "flex w-full flex-col";
    const headerWrap = document.createElement("div");
    headerWrap.className = "pb-8";
    const header = document.createElement("header");
    header.className = "flex flex-col gap-4 px-[var(--detail-page-inline-inset,0px)]";
    const headerRow = document.createElement("div");
    headerRow.className = "flex min-w-0 items-start justify-between gap-4 flex-wrap";
    const titleStack = document.createElement("div");
    titleStack.className = "flex min-w-0 flex-1 basis-64 flex-col gap-1.5";
    const title = document.createElement("h1");
    title.className = "min-w-0 break-words text-default heading-lg font-normal";
    title.textContent = entry.title;
    titleStack.appendChild(title);
    if (entry.description) {
      const description = document.createElement("p");
      description.className = "text-sm text-secondary";
      description.textContent = entry.description;
      titleStack.appendChild(description);
    }
    headerRow.appendChild(titleStack);
    header.appendChild(headerRow);
    headerWrap.appendChild(header);
    const root = document.createElement("div");
    root.className = "flex flex-col gap-10";
    shell.append(headerWrap, root);
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
      void refreshManagedPlugins();
      if (!managementRefreshTimer) managementRefreshTimer = setInterval(() => { void refreshManagedPlugins(); }, 4000);
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
      if (managementRefreshTimer) clearInterval(managementRefreshTimer);
      managementRefreshTimer = 0;
      restoreNative();
      document.querySelectorAll("[data-codex-loader-settings='pages-group']").forEach((node) => node.remove());
      panelHost?.remove();
      pagesGroup = null;
      panelHost = null;
      panelSurface = null;
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
