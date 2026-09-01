const SETTINGS_HOST_VERSION = "0.5.8";

/*
 * Renderer-only settings host inspired by b-nnett/codex-plusplus.
 * The loader owns navigation and page mounting; plugins only register a page.
 */
function installSettingsHost(version) {
  const runtime = globalThis.__codexScriptLoader;
  if (!runtime) return;
  // Monochrome mask derived from windows/branding/png/CodexScriptLoader-512.png.
  // Using the approved mark as a mask keeps the sidebar icon aligned with
  // Codex's currentColor-based system settings icons in light and dark themes.
  const loaderBrandMask = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAEYSURBVDhP7dK9K4ZhFMfxj1LkJQMp5CULEjYZFH+ASZn8DwaDyWSRySSLyWgQk1UGYhIZDLIgWQwmyUtXnXJ39eh5PKN8l7vfOdc517nu3+GvUIs21OeJakmNrnCD1jxZLUd4w2ye+C018d3GA2ayfMX04hIDoQ9whjE0ZWfL0oNn7IZewCO6sYFrNGQ1P9KBJ+yEnsI7JkM34xgXaCnUlSS5eYu9Qmwd94WGibRGpzgp/OOSpGe8YLMQm48Ji7HEFu7KNUyM4BUroeuwhg8MRyxd8hkGVcR4FCyFTk9M06xiKHJzWU1ZkhmpcCImSUYt4jAaV8VgOLmPczSiMz/0G7owGnu3jOnYxapJ0/ShHf1hWNrTf775Amv8Ll/zMvAfAAAAAElFTkSuQmCC";
  const implementationRevision = "0.5.6-native-plugin-list-metadata-tooltip-final";
  const current = runtime.settingsHost;
  if (current?.version === version && current?.implementationRevision === implementationRevision) {
    current.start();
    return;
  }
  try { current?.stop?.(); } catch {}
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    runtime.settingsHost = {
      version,
      implementationRevision,
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
  const restoredUiState = runtime.settingsUiState && typeof runtime.settingsUiState === "object" ? runtime.settingsUiState : null;
  let pendingActiveId = typeof restoredUiState?.activeId === "string" ? restoredUiState.activeId : null;
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

  function moreActionsIcon() {
    return '<svg width="21" height="21" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs" aria-hidden="true"><path d="M15.6981 9.04712C16.5255 9.04712 17.1959 9.71781 17.1961 10.5452C17.1961 11.3727 16.5256 12.0442 15.6981 12.0442C14.8706 12.0442 14.2 11.3727 14.2 10.5452C14.2002 9.71781 14.8707 9.04712 15.6981 9.04712Z" fill="currentColor"></path><path d="M4.69806 9.04712C5.52546 9.04712 6.19691 9.71781 6.19708 10.5452C6.19708 11.3727 5.52557 12.0442 4.69806 12.0442C3.8707 12.044 3.20001 11.3726 3.20001 10.5452C3.20019 9.71792 3.87081 9.04729 4.69806 9.04712Z" fill="currentColor"></path><path d="M10.2003 9.04712C11.0276 9.0473 11.6982 9.71792 11.6984 10.5452C11.6984 11.3726 11.0277 12.044 10.2003 12.0442C9.37284 12.0442 8.70132 11.3727 8.70132 10.5452C8.7015 9.71781 9.37295 9.04712 10.2003 9.04712Z" fill="currentColor"></path></svg>';
  }

  function helpIcon() {
    return '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs" aria-hidden="true"><path d="M16.585 10C16.585 6.3632 13.6368 3.41504 10 3.41504C6.3632 3.41504 3.41504 6.3632 3.41504 10C3.41504 13.6368 6.3632 16.585 10 16.585C13.6368 16.585 16.585 13.6368 16.585 10ZM17.915 10C17.915 14.3713 14.3713 17.915 10 17.915C5.62867 17.915 2.08496 14.3713 2.08496 10C2.08496 5.62867 5.62867 2.08496 10 2.08496C14.3713 2.08496 17.915 5.62867 17.915 10Z" fill="currentColor"></path><path d="M9.81735 11.5962C9.3582 11.5962 9.08812 11.2829 9.08812 10.84V10.7643C9.08812 10.1269 9.41762 9.7056 10.055 9.33288C10.7519 8.91695 10.9625 8.64686 10.9625 8.1499C10.9625 7.62053 10.552 7.25321 9.9578 7.25321C9.42843 7.25321 9.07191 7.51249 8.89906 7.99325C8.76401 8.33896 8.52093 8.49021 8.19142 8.49021C7.76469 8.49021 7.5 8.22552 7.5 7.81499C7.5 7.58271 7.55402 7.37745 7.66205 7.17218C8.00776 6.45915 8.87205 6 10.0334 6C11.5675 6 12.5993 6.84267 12.5993 8.10128C12.5993 8.91695 12.2049 9.47333 11.4433 9.92167C10.7248 10.3376 10.5628 10.5699 10.4926 11.0236C10.4115 11.3856 10.2009 11.5962 9.81735 11.5962ZM9.82816 14C9.342 14 8.94767 13.6273 8.94767 13.1519C8.94767 12.6766 9.342 12.3038 9.82816 12.3038C10.3197 12.3038 10.714 12.6766 10.714 13.1519C10.714 13.6273 10.3197 14 9.82816 14Z" fill="currentColor"></path></svg>';
  }

  function loaderIcon() {
    return `<span data-codex-loader-brand-icon class="icon-sm inline-block shrink-0 align-middle" style="width:20px;height:20px;background-color:currentColor;mask-image:url(&quot;${loaderBrandMask}&quot;);-webkit-mask-image:url(&quot;${loaderBrandMask}&quot;);mask-position:center;-webkit-mask-position:center;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat;mask-size:20px 20px;-webkit-mask-size:20px 20px" aria-hidden="true"></span>`;
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
    const enabledOwners = new Set(managedPlugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id));
    const entries = [...pages.values()].filter((entry) => enabledOwners.has(entry.ownerId));
    const byOwner = new Map();
    for (const entry of sections.values()) {
      if (!enabledOwners.has(entry.ownerId)) continue;
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
      if (!plugin.enabled || plugin.settingsMode !== "page" || representedOwners.has(plugin.id)) continue;
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
        updates: "更新",
        updateDescription: "从稳定通道检查并后台升级 Script-Loader；Codex、当前任务和页面保持打开。",
        currentVersion: "当前版本",
        channel: "更新通道",
        stable: "稳定版",
        lastChecked: "上次检查",
        availableVersion: "可用版本",
        updateState: "更新状态",
        autoUpdate: "自动升级",
        autoUpdateDescription: "启动并进入可用状态后自动检查、校验和切换 Loader 宿主。",
        checkUpdate: "检查更新",
        installUpdate: "立即升级",
        cancelUpdate: "取消下载",
        installerRequired: "此版本需要安装器升级",
        updateNotice(version) { return `正在升级 Script-Loader 到 ${version}，Codex 将保持打开。`; },
        updateSucceeded(version) { return `Script-Loader 已升级到 ${version}。`; },
        updateRolledBack(version) { return `升级失败，已继续使用 ${version}。`; },
        updateError(code, fallback) {
          return ({
            windowsTlsCredentials: "Windows 安全网络连接不可用；请检查卡巴斯基的加密连接扫描或 GitHub 例外规则。",
            timeout: "连接 GitHub 超时，请稍后重试。",
            networkOrPackage: "无法检查或校验更新，请查看 Loader 日志后重试。",
            handoffRolledBack: "新宿主接管失败，当前版本已恢复运行。",
          })[code] || fallback || "更新失败。";
        },
        updateStatus(status) {
          return ({ idle: "已是最新", checking: "正在检查", available: "有可用更新", downloading: "正在下载", verifying: "正在校验", staging: "正在准备", switching: "正在切换宿主", succeeded: "升级成功", failed: "升级失败", rolledBack: "已回滚" })[status] || "未知";
        },
        scripts: "脚本操作",
        plugins: "插件",
        pluginsDescription: "添加、启用、重载和移除本地 renderer 插件。",
        addArchive: "安装插件 ZIP",
        reloadAll: "重载插件",
        checkPluginUpdates: "检查插件更新",
        pluginAutoUpdate: "自动更新",
        pluginAutoUpdateDescription: "发现新版本后自动下载、校验并更新此插件。",
        pluginUpdates: "插件更新",
        pluginEnableDescription: "决定插件是否随 Loader 加载，并显示它提供的设置页面。",
        pluginCheckUpdate: "检查更新",
        pluginRetryUpdate: "检查更新",
        pluginCheckingUpdate: "检查中…",
        pluginUpdating: "更新中…",
        pluginBundledUpdate: "随 Loader 更新",
        pluginUnsupportedUpdate: "未提供更新源",
        moreActions: "更多操作",
        pluginAutoUpdateEnabled: "已开启",
        pluginAutoUpdateDisabled: "已关闭",
        pluginAutoUpdateInline(value) { return `自动更新：${value}`; },
        enablePluginAutoUpdate: "开启自动更新",
        disablePluginAutoUpdate: "关闭自动更新",
        pluginRuntimeEnabled: "已启用",
        pluginRuntimeDisabled: "已禁用",
        pluginRunning: "运行中",
        pluginNotRunning: "未运行",
        pluginUpdateFailedTitle: "无法连接 GitHub Release",
        pluginLastChecked(value) { return `上次检查：${value}`; },
        pluginCheckingAll(count) { return `正在检查 ${count} 个插件…`; },
        pluginCheckingOne(name) { return `正在检查 ${name}…`; },
        pluginUpdateSummary(checked, available, failed) {
          if (!checked) return "没有声明更新源的插件。";
          if (failed) return `插件更新检查完成：${available} 个可更新，${failed} 个检查失败。`;
          if (available) return `插件更新检查完成：${available} 个插件可以更新。`;
          return `插件更新检查完成：${checked} 个插件均为最新。`;
        },
        pluginUpdateNow: "更新",
        pluginUpdateCancel: "取消下载",
        pluginUpdateConfirmTitle: "确认插件更新",
        pluginUpdateConfirm: "确认更新",
        pluginUpdateAvailable(version) { return `可更新至 ${version}`; },
        pluginUpdateState(status) {
          return ({ unsupported: "不支持", idle: "尚未检查", checking: "检查中", upToDate: "已是最新", available: "有新版本", downloading: "下载中", verifying: "校验中", awaitingConfirmation: "等待确认", waitingForEnable: "等待启用", waitingForRenderer: "等待 Codex 页面", installing: "替换中", reloading: "重载中", succeeded: "更新成功", rolledBack: "已回滚", failed: "更新失败" })[status] || "未知";
        },
        pluginPermissionIncrease(values) { return `新增权限：${values.join(", ")}`; },
        pluginLocalChanges: "检测到本地修改；继续会覆盖本地文件。",
        pluginEnableFirst: "请先启用插件，以便更新后验证运行状态。",
        noPlugins: "还没有安装插件。",
        builtIn: "内置",
        local: "本地",
        legacy: "旧版规范",
        version: "版本",
        reloadOne: "重新加载",
        documentation: "说明",
        remove: "移除",
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
        removeDescription: "插件将停止运行，并从已安装插件列表中移除。",
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
        enable: "启用插件",
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
      updates: "Updates",
      updateDescription: "Check the stable channel and upgrade Script-Loader in the background while Codex, this task, and the current page stay open.",
      currentVersion: "Current version",
      channel: "Channel",
      stable: "Stable",
      lastChecked: "Last checked",
      availableVersion: "Available version",
      updateState: "Update status",
      autoUpdate: "Automatic updates",
      autoUpdateDescription: "Check, verify, and switch the Loader host after startup reaches a usable state.",
      checkUpdate: "Check for updates",
      installUpdate: "Update now",
      cancelUpdate: "Cancel download",
      installerRequired: "This version requires an installer upgrade",
      updateNotice(version) { return `Updating Script-Loader to ${version}. Codex will stay open.`; },
      updateSucceeded(version) { return `Script-Loader was updated to ${version}.`; },
      updateRolledBack(version) { return `The update failed. Script-Loader is still using ${version}.`; },
      updateError(code, fallback) {
        return ({
          windowsTlsCredentials: "Windows secure networking is unavailable. Check Kaspersky encrypted-connection scanning or its GitHub exclusions.",
          timeout: "The GitHub connection timed out. Try again later.",
          networkOrPackage: "The update could not be checked or verified. Review the Loader log and try again.",
          handoffRolledBack: "The new host could not take over, so the current version was restored.",
        })[code] || fallback || "The update failed.";
      },
      updateStatus(status) {
        return ({ idle: "Up to date", checking: "Checking", available: "Update available", downloading: "Downloading", verifying: "Verifying", staging: "Preparing", switching: "Switching host", succeeded: "Updated", failed: "Update failed", rolledBack: "Rolled back" })[status] || "Unknown";
      },
      scripts: "Script actions",
      plugins: "Plugins",
      pluginsDescription: "Add, enable, reload, and remove local renderer plugins.",
      addArchive: "Install plugin ZIP",
      reloadAll: "Reload plugins",
      checkPluginUpdates: "Check plugin updates",
      pluginAutoUpdate: "Automatic update",
      pluginAutoUpdateDescription: "Download, verify, and install new versions of this plugin automatically.",
      pluginUpdates: "Plugin updates",
      pluginEnableDescription: "Load this plugin with Loader and show any settings page it provides.",
      pluginCheckUpdate: "Check for updates",
      pluginRetryUpdate: "Check for updates",
      pluginCheckingUpdate: "Checking…",
      pluginUpdating: "Updating…",
      pluginBundledUpdate: "Updated with Loader",
      pluginUnsupportedUpdate: "No update source",
      moreActions: "More actions",
      pluginAutoUpdateEnabled: "On",
      pluginAutoUpdateDisabled: "Off",
      pluginAutoUpdateInline(value) { return `Automatic update: ${value}`; },
      enablePluginAutoUpdate: "Turn on automatic updates",
      disablePluginAutoUpdate: "Turn off automatic updates",
      pluginRuntimeEnabled: "Enabled",
      pluginRuntimeDisabled: "Disabled",
      pluginRunning: "Running",
      pluginNotRunning: "Not running",
      pluginUpdateFailedTitle: "Could not reach GitHub Release",
      pluginLastChecked(value) { return `Last checked: ${value}`; },
      pluginCheckingAll(count) { return `Checking ${count} plugin${count === 1 ? "" : "s"}…`; },
      pluginCheckingOne(name) { return `Checking ${name}…`; },
      pluginUpdateSummary(checked, available, failed) {
        if (!checked) return "No installed plugin declares an update source.";
        if (failed) return `Plugin check complete: ${available} update${available === 1 ? "" : "s"} available, ${failed} failed.`;
        if (available) return `Plugin check complete: ${available} update${available === 1 ? "" : "s"} available.`;
        return `Plugin check complete: ${checked} plugin${checked === 1 ? " is" : "s are"} up to date.`;
      },
      pluginUpdateNow: "Update",
      pluginUpdateCancel: "Cancel download",
      pluginUpdateConfirmTitle: "Confirm plugin update",
      pluginUpdateConfirm: "Confirm update",
      pluginUpdateAvailable(version) { return `Update available: ${version}`; },
      pluginUpdateState(status) {
        return ({ unsupported: "Unsupported", idle: "Not checked", checking: "Checking", upToDate: "Up to date", available: "Update available", downloading: "Downloading", verifying: "Verifying", awaitingConfirmation: "Confirmation required", waitingForEnable: "Waiting for enable", waitingForRenderer: "Waiting for Codex renderer", installing: "Replacing", reloading: "Reloading", succeeded: "Updated", rolledBack: "Rolled back", failed: "Update failed" })[status] || "Unknown";
      },
      pluginPermissionIncrease(values) { return `New permissions: ${values.join(", ")}`; },
      pluginLocalChanges: "Local changes were detected. Continuing will overwrite local files.",
      pluginEnableFirst: "Enable the plugin first so Loader can verify the updated runtime.",
      noPlugins: "No plugins are installed yet.",
      builtIn: "Built in",
      local: "Local",
      legacy: "Legacy contract",
      version: "Version",
      reloadOne: "Reload",
      documentation: "Readme",
      remove: "Remove",
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
      removeDescription: "The plugin will stop and be removed from the installed plugin list.",
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
      enable: "Enable plugin",
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

  function actionButton(label, { danger = false, primary = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `border-token-border user-select-none no-drag cursor-interaction inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border px-2 text-sm ${primary ? "text-white" : "text-token-text-primary"} enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40`;
    if (primary) button.style.cssText = "border-color:transparent;background:var(--color-text-primary,#1a1c1f);color:white;";
    else if (danger) button.style.color = "var(--color-text-danger)";
    button.textContent = label;
    return button;
  }

  function pluginRepository(plugin) {
    const values = [plugin.repository, plugin.update?.repository, plugin.update?.releaseUrl, plugin.documentationExcerpt];
    for (const value of values) {
      const source = typeof value === "string" ? value : typeof value?.url === "string" ? value.url : "";
      const match = source.match(/github\.com[/:]([^/\s)]+)\/([^/\s)#?]+?)(?:\.git)?(?:[/\s)#?]|$)/i);
      if (match) return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
    }
    return plugin.bundled ? "JHees/codex-script-loader" : "";
  }

  function pluginAuthor(plugin, repository) {
    const author = typeof plugin.author === "string" ? plugin.author.trim() : "";
    return author || repository.split("/")[0] || plugin.name || plugin.id;
  }

  function pluginDocumentationSummary(plugin) {
    if (typeof plugin.description === "string" && plugin.description.trim()) return plugin.description.trim();
    const excerpt = typeof plugin.documentationExcerpt === "string" ? plugin.documentationExcerpt : "";
    const clean = (value) => value
      .replace(/<[^>]*>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_#>-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const emphasized = [...excerpt.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => clean(match[1])).find((value) => value.length >= 20);
    let cleaned = emphasized || clean(excerpt);
    const pluginName = String(plugin.name || "").trim();
    if (pluginName && cleaned.toLocaleLowerCase().startsWith(pluginName.toLocaleLowerCase())) cleaned = cleaned.slice(pluginName.length).trim();
    const firstSentence = cleaned.match(/^(.+?[.!?。！？])(?:\s|$)/u)?.[1];
    if (firstSentence && firstSentence.length >= 20) cleaned = firstSentence;
    return cleaned.length > 240 ? `${cleaned.slice(0, 237).trimEnd()}…` : cleaned;
  }

  function pluginDocumentationHelp(plugin, summary, documentationLabel) {
    const wrapper = document.createElement("span");
    wrapper.className = "relative inline-flex shrink-0";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.codexLoaderSettings = "plugin-documentation-help";
    button.className = "no-drag flex h-5 w-5 cursor-help items-center justify-center rounded-md border border-transparent p-0 text-tertiary hover:bg-primary-ghost-hover hover:text-token-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
    button.setAttribute("aria-label", `${plugin.name || plugin.id}: ${documentationLabel}`);
    button.innerHTML = helpIcon();
    const tooltip = document.createElement("span");
    tooltip.id = `codex-loader-plugin-help-${String(plugin.id).replace(/[^a-z0-9_-]/gi, "-")}`;
    tooltip.dataset.codexLoaderSettings = "plugin-documentation-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.className = "pointer-events-none absolute left-1/2 top-6 z-30 hidden w-72 -translate-x-1/2 whitespace-normal rounded-lg border border-default bg-token-main-surface-primary px-2 py-1.5 text-xs leading-4 text-token-text-primary shadow-lg";
    tooltip.textContent = summary;
    button.setAttribute("aria-describedby", tooltip.id);
    const show = () => { tooltip.classList.remove("hidden"); };
    const hide = () => { tooltip.classList.add("hidden"); };
    button.addEventListener("mouseenter", show);
    button.addEventListener("mouseleave", hide);
    button.addEventListener("focus", show);
    button.addEventListener("blur", hide);
    wrapper.append(button, tooltip);
    return wrapper;
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
    let updateStatus = null;
    let updateRefreshTimer = 0;
    let pluginUpdateRefreshTimer = 0;
    let pluginUpdateRefreshGrace = 0;
    const pluginOperationIds = new Set();
    let openPluginMenuId = null;
    let renderedUpdateSnapshot = "";
    root.className = "flex flex-col gap-10";
    root.style.cssText = "";

    const overviewSection = settingsSection(labels.runtime);
    const overviewCard = settingsCard();
    const connection = valueRow(labels.loader, labels.loaderDescription);
    const pluginCount = valueRow(labels.enabledScripts, labels.enabledScriptsDescription);
    const lastReload = valueRow(labels.lastReload, labels.lastReloadDescription);
    overviewCard.append(connection.row, pluginCount.row, lastReload.row);
    overviewSection.appendChild(overviewCard);

    const updateSection = settingsSection(labels.updates);
    const updateHeader = updateSection.querySelector('[data-codex-loader-settings="section-header"]');
    const updateHeaderStack = updateSection.querySelector('[data-codex-loader-settings="section-title-stack"]');
    const updateDescription = document.createElement("div");
    updateDescription.className = "text-sm text-secondary";
    updateDescription.textContent = labels.updateDescription;
    updateHeaderStack.appendChild(updateDescription);
    const updateFeedback = document.createElement("div");
    updateFeedback.className = "min-h-4 text-xs text-secondary";
    updateFeedback.setAttribute("aria-live", "polite");
    updateHeaderStack.appendChild(updateFeedback);
    const updateActions = document.createElement("div");
    updateActions.className = "flex items-center gap-2";
    const checkUpdateButton = actionButton(labels.checkUpdate);
    const installUpdateButton = actionButton(labels.installUpdate);
    const cancelUpdateButton = actionButton(labels.cancelUpdate);
    updateActions.append(checkUpdateButton, installUpdateButton, cancelUpdateButton);
    updateHeader.appendChild(updateActions);
    const updateCard = settingsCard();
    const currentVersion = valueRow(labels.currentVersion);
    const updateChannel = valueRow(labels.channel);
    const updateLastChecked = valueRow(labels.lastChecked);
    const availableVersion = valueRow(labels.availableVersion);
    const updateState = valueRow(labels.updateState);
    const updateError = valueRow(labels.recentError);
    const autoUpdateRow = document.createElement("div");
    autoUpdateRow.className = "flex items-center justify-between px-4 gap-6 py-3";
    const autoUpdateStack = document.createElement("div");
    autoUpdateStack.className = "flex min-w-0 flex-1 flex-col gap-0.5";
    const autoUpdateTitle = document.createElement("div");
    autoUpdateTitle.className = "min-w-0 text-sm text-default font-medium";
    autoUpdateTitle.textContent = labels.autoUpdate;
    const autoUpdateDescription = document.createElement("div");
    autoUpdateDescription.className = "text-sm text-secondary";
    autoUpdateDescription.textContent = labels.autoUpdateDescription;
    autoUpdateStack.append(autoUpdateTitle, autoUpdateDescription);
    const autoUpdateToggle = document.createElement("button");
    autoUpdateToggle.type = "button";
    autoUpdateToggle.setAttribute("role", "switch");
    autoUpdateToggle.setAttribute("aria-label", labels.autoUpdate);
    const autoUpdateKnob = document.createElement("span");
    autoUpdateToggle.appendChild(autoUpdateKnob);
    autoUpdateRow.append(autoUpdateStack, autoUpdateToggle);
    updateCard.append(currentVersion.row, updateChannel.row, updateLastChecked.row, availableVersion.row, updateState.row, updateError.row, autoUpdateRow);
    updateSection.appendChild(updateCard);

    const pluginsSection = settingsSection(labels.plugins);
    const pluginsHeaderRow = pluginsSection.querySelector('[data-codex-loader-settings="section-header"]');
    pluginsHeaderRow.className += " flex-wrap";
    const pluginsHeaderStack = pluginsSection.querySelector('[data-codex-loader-settings="section-title-stack"]');
    const pluginHeaderActions = document.createElement("div");
    pluginHeaderActions.className = "flex flex-wrap items-center justify-end gap-2";
    const addArchiveButton = actionButton(labels.addArchive, { primary: true });
    const reloadAllButton = actionButton(labels.reloadAll);
    const checkPluginUpdatesButton = actionButton(labels.checkPluginUpdates);
    pluginHeaderActions.append(checkPluginUpdatesButton, reloadAllButton, addArchiveButton);
    pluginsHeaderRow.appendChild(pluginHeaderActions);
    const pluginDescription = document.createElement("div");
    pluginDescription.className = "text-sm text-secondary";
    pluginDescription.textContent = labels.pluginsDescription;
    pluginsHeaderStack.appendChild(pluginDescription);
    const feedback = document.createElement("div");
    feedback.className = "min-h-4 text-xs text-secondary";
    feedback.setAttribute("aria-live", "polite");
    pluginsHeaderStack.appendChild(feedback);
    const pluginList = document.createElement("div");
    pluginList.dataset.codexLoaderSettings = "plugin-native-list";
    pluginList.className = "mt-5 w-full";
    const pluginsCard = document.createElement("div");
    pluginsCard.dataset.codexLoaderSettings = "plugin-market-list";
    pluginsCard.setAttribute("role", "list");
    pluginsCard.className = "flex flex-col gap-1";
    pluginList.appendChild(pluginsCard);
    pluginsSection.appendChild(pluginList);

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

    root.append(overviewSection, updateSection, pluginsSection, restartSection, diagnosticsSection);

    function setBusy(next, message = "") {
      busy = next;
      feedback.textContent = message;
      for (const button of [checkPluginUpdatesButton, addArchiveButton, reloadAllButton, restartButton]) button.disabled = next || !connected;
      renderPlugins();
    }

    function renderUpdateStatus() {
      const status = updateStatus || {};
      const state = String(status.state || "idle");
      const updating = ["checking", "downloading", "verifying", "staging", "switching"].includes(state);
      const progress = typeof status.progress === "number" ? ` · ${Math.max(0, Math.min(100, Math.round(status.progress * 100)))}%` : "";
      currentVersion.value.textContent = status.currentVersion || "—";
      updateChannel.value.textContent = status.channel === "stable" ? labels.stable : (status.channel || labels.stable);
      updateLastChecked.value.textContent = formatTime(status.lastCheckedAt, labels);
      availableVersion.value.textContent = status.availableVersion || labels.none;
      updateState.value.textContent = status.requiresInstaller ? labels.installerRequired : `${labels.updateStatus(state)}${progress}`;
      updateState.value.title = state === "failed" ? labels.updateError(status.errorCode, status.error) : updateState.value.textContent;
      updateState.value.className = state === "failed" || state === "rolledBack" ? "min-w-0 max-w-[46%] shrink-0 truncate text-right text-sm text-token-charts-red" : "min-w-0 max-w-[46%] shrink-0 truncate text-right text-sm text-secondary";
      const errorText = state === "failed" || state === "rolledBack" ? labels.updateError(status.errorCode, status.error) : labels.none;
      updateError.value.textContent = errorText;
      updateError.value.title = errorText;
      updateError.value.className = state === "failed" || state === "rolledBack" ? "min-w-0 max-w-[62%] shrink-0 truncate text-right text-sm text-token-charts-red" : "min-w-0 max-w-[46%] shrink-0 truncate text-right text-sm text-secondary";
      const enabled = status.autoUpdate !== false;
      autoUpdateToggle.setAttribute("aria-checked", enabled ? "true" : "false");
      autoUpdateToggle.disabled = updating || status.requiresInstaller || !connected;
      autoUpdateToggle.style.cssText = `box-sizing:border-box;position:relative;width:34px;height:20px;padding:2px;border:0;border-radius:999px;background:${enabled ? "var(--color-accent-blue,#2f9bf4)" : "var(--color-background-tertiary,#d8d8dc)"};cursor:pointer;`;
      autoUpdateKnob.style.cssText = `display:block;width:16px;height:16px;border-radius:50%;background:white;box-shadow:0 1px 2px color-mix(in srgb,black 28%,transparent);transform:translateX(${enabled ? "14px" : "0"});transition:transform .15s ease;`;
      checkUpdateButton.disabled = updating || !connected;
      installUpdateButton.disabled = state !== "available" || status.requiresInstaller || !connected;
      cancelUpdateButton.disabled = state !== "downloading" || !connected;
      cancelUpdateButton.style.display = state === "downloading" ? "inline-flex" : "none";
      updateFeedback.className = state === "failed" || state === "rolledBack" ? "min-h-4 text-xs text-token-charts-red" : "min-h-4 text-xs text-secondary";
      if (state === "switching") updateFeedback.textContent = labels.updateNotice(status.availableVersion || "");
      else if (state === "succeeded") updateFeedback.textContent = labels.updateSucceeded(status.currentVersion || "");
      else if (state === "rolledBack") updateFeedback.textContent = labels.updateRolledBack(status.currentVersion || "");
      else updateFeedback.textContent = "";
    }

    function showUpdateError(error, code = "networkOrPackage") {
      const errorText = labels.updateError(code, String(error?.message || error || ""));
      updateError.value.textContent = errorText;
      updateError.value.title = errorText;
      updateError.value.className = "min-w-0 max-w-[62%] shrink-0 truncate text-right text-sm text-token-charts-red";
      updateFeedback.textContent = "";
    }

    async function refreshUpdateStatus(force = false) {
      try {
        const nextStatus = await requestBridge("get_update_status", {});
        const serialized = JSON.stringify(nextStatus || {});
        updateStatus = nextStatus;
        if (!disposed && (force || serialized !== renderedUpdateSnapshot)) {
          renderedUpdateSnapshot = serialized;
          renderUpdateStatus();
        }
      } catch (error) {
        if (!disposed && updateStatus?.state !== "switching") {
          updateState.value.textContent = labels.updateStatus("failed");
          updateState.value.className = "min-w-0 max-w-[46%] shrink-0 truncate text-right text-sm text-token-charts-red";
          const errorText = labels.updateError("networkOrPackage", String(error?.message || error));
          updateError.value.textContent = errorText;
          updateError.value.title = errorText;
          updateError.value.className = "min-w-0 max-w-[62%] shrink-0 truncate text-right text-sm text-token-charts-red";
        }
      }
    }

    function scheduleUpdateRefresh(delay) {
      if (updateRefreshTimer) clearTimeout(updateRefreshTimer);
      updateRefreshTimer = setTimeout(async () => {
        updateRefreshTimer = 0;
        await refreshUpdateStatus();
        if (disposed) return;
        const active = ["checking", "downloading", "verifying", "staging", "switching"].includes(String(updateStatus?.state || "idle"));
        scheduleUpdateRefresh(active ? 750 : 15000);
      }, delay);
    }

    function switchControl(plugin) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", `${plugin.name}: ${labels.enable}`);
      toggle.setAttribute("aria-checked", plugin.enabled ? "true" : "false");
      toggle.disabled = busy || pluginOperationIds.has(plugin.id) || plugin.status === "invalid" || !connected;
      toggle.style.cssText = `box-sizing:border-box;position:relative;width:32px;height:20px;padding:2px;border:0;border-radius:999px;background:${plugin.enabled ? "var(--color-accent-blue,#2f9bf4)" : "var(--color-background-tertiary,#d8d8dc)"};cursor:pointer;`;
      const knob = document.createElement("span");
      knob.style.cssText = `display:block;width:16px;height:16px;border-radius:50%;background:white;box-shadow:0 1px 2px color-mix(in srgb,black 28%,transparent);transform:translateX(${plugin.enabled ? "12px" : "0"});transition:transform .15s ease;`;
      toggle.appendChild(knob);
      toggle.addEventListener("click", () => runPluginAction(plugin, "toggle"));
      return toggle;
    }

    function pluginUpdateIsActive(plugin) {
      return ["checking", "downloading", "verifying", "installing", "reloading"].includes(String(plugin.update?.state || ""));
    }

    function pluginUpdateSummary(snapshots) {
      const checked = Array.isArray(snapshots) ? snapshots : [];
      const available = checked.filter((snapshot) => ["available", "awaitingConfirmation", "waitingForEnable", "waitingForRenderer"].includes(String(snapshot?.state || ""))).length;
      const failed = checked.filter((snapshot) => ["failed", "rolledBack"].includes(String(snapshot?.state || ""))).length;
      return labels.pluginUpdateSummary(checked.length, available, failed);
    }

    function pluginUpdateActionLabel(plugin) {
      if (plugin.bundled) return labels.pluginBundledUpdate;
      if (!plugin.update?.supported) return labels.pluginUnsupportedUpdate;
      const state = String(plugin.update.state || "idle");
      if (state === "downloading") return labels.pluginUpdateCancel;
      if (state === "checking") return labels.pluginCheckingUpdate;
      if (["verifying", "installing", "reloading"].includes(state)) return labels.pluginUpdating;
      if (["available", "awaitingConfirmation", "waitingForEnable", "waitingForRenderer"].includes(state)) return labels.pluginUpdateNow;
      if (state === "failed" || state === "rolledBack") return labels.pluginRetryUpdate;
      return labels.pluginCheckUpdate;
    }

    function schedulePluginUpdateRefresh() {
      if (pluginUpdateRefreshTimer) clearTimeout(pluginUpdateRefreshTimer);
      pluginUpdateRefreshTimer = 0;
      const active = plugins.some(pluginUpdateIsActive);
      if (active) pluginUpdateRefreshGrace = 0;
      else if (pluginUpdateRefreshGrace > 0) pluginUpdateRefreshGrace--;
      if (disposed || (!active && pluginUpdateRefreshGrace <= 0)) return;
      pluginUpdateRefreshTimer = setTimeout(async () => {
        pluginUpdateRefreshTimer = 0;
        await refresh();
      }, 750);
    }

    function pluginActionsMenu(plugin) {
      const wrapper = document.createElement("div");
      wrapper.className = "relative shrink-0";
      wrapper.dataset.codexLoaderPluginMenu = plugin.id;
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.dataset.codexLoaderSettings = "plugin-more-actions";
      trigger.className = "no-drag flex h-7 w-7 shrink-0 cursor-interaction items-center justify-center rounded-lg border border-transparent p-0 text-tertiary hover:bg-primary-ghost-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40";
      trigger.setAttribute("aria-label", labels.moreActions);
      trigger.innerHTML = moreActionsIcon();
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", openPluginMenuId === plugin.id ? "true" : "false");
      trigger.disabled = busy;
      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPluginMenuId = openPluginMenuId === plugin.id ? null : plugin.id;
        renderPlugins();
      });
      wrapper.appendChild(trigger);
      if (openPluginMenuId !== plugin.id) return wrapper;
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.className = "absolute right-0 top-8 z-20 flex min-w-36 flex-col gap-1 rounded-xl border border-default bg-token-main-surface-primary p-1 shadow-lg";
      const appendItem = (label, handler, { danger = false, disabled = false } = {}) => {
        const item = document.createElement("button");
        item.type = "button";
        item.textContent = label;
        item.setAttribute("role", "menuitem");
        item.className = "no-drag flex h-7 w-full cursor-interaction select-none items-center justify-start rounded-lg border border-transparent px-2 text-left text-sm text-token-text-primary enabled:hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40";
        if (danger) item.style.color = "var(--color-text-danger)";
        item.disabled = disabled;
        item.addEventListener("click", () => {
          openPluginMenuId = null;
          renderPlugins();
          handler();
        });
        menu.appendChild(item);
      };
      if (!plugin.bundled && plugin.update?.supported) {
        appendItem(
          plugin.update?.automatic === true ? labels.disablePluginAutoUpdate : labels.enablePluginAutoUpdate,
          () => runPluginAction(plugin, "auto-update"),
          { disabled: pluginOperationIds.has(plugin.id) || !connected },
        );
      }
      appendItem(labels.reloadOne, () => runPluginAction(plugin, "reload"), {
        disabled: pluginOperationIds.has(plugin.id) || !plugin.enabled || plugin.status === "invalid" || !connected,
      });
      if (!plugin.bundled) appendItem(labels.remove, () => runPluginAction(plugin, "remove"), { danger: true, disabled: !connected });
      wrapper.appendChild(menu);
      return wrapper;
    }

    function pluginUpdatePanel(plugin) {
      const state = plugin.bundled ? "bundled" : String(plugin.update?.state || "unsupported");
      const failed = state === "failed" || state === "rolledBack";
      const stateText = plugin.bundled ? labels.pluginBundledUpdate : plugin.update?.supported ? labels.pluginUpdateState(state) : labels.pluginUnsupportedUpdate;
      const available = plugin.update?.availableVersion ? labels.pluginUpdateAvailable(plugin.update.availableVersion) : "";
      const progress = typeof plugin.update?.progress === "number" && pluginUpdateIsActive(plugin) ? `${Math.max(0, Math.min(100, Math.round(plugin.update.progress * 100)))}%` : "";
      const primaryText = failed ? labels.pluginUpdateFailedTitle : [stateText, available, progress].filter(Boolean).join(" · ");
      let updateAction = null;
      if (!plugin.bundled && plugin.update?.supported) {
        updateAction = actionButton(pluginUpdateActionLabel(plugin));
        updateAction.className += " shrink-0";
        const updateStateForAction = String(plugin.update?.state || "unsupported");
        const updateIsActive = pluginUpdateIsActive(plugin);
        const updateActionKind = updateStateForAction === "downloading"
          ? "cancel-update"
          : ["available", "awaitingConfirmation", "waitingForEnable", "waitingForRenderer"].includes(updateStateForAction)
            ? "update"
            : "check-update";
        updateAction.disabled = busy || pluginOperationIds.has(plugin.id) || !connected ||
          (updateIsActive && updateStateForAction !== "downloading") || (updateActionKind === "update" && !plugin.enabled);
        if (updateActionKind === "update" && !plugin.enabled) updateAction.title = labels.pluginEnableFirst;
        updateAction.addEventListener("click", () => runPluginAction(plugin, updateActionKind));
      }
      const detailParts = [primaryText];
      if (failed && plugin.update?.lastCheckedAt) detailParts.push(labels.pluginLastChecked(formatTime(plugin.update.lastCheckedAt, labels)));
      if (!plugin.bundled) detailParts.push(labels.pluginAutoUpdateInline(pluginAutoUpdateStatus(plugin)));
      const summary = document.createElement("div");
      summary.className = failed ? "truncate text-xs text-token-charts-red" : "truncate text-xs text-secondary";
      summary.setAttribute("aria-live", pluginUpdateIsActive(plugin) ? "polite" : "off");
      summary.textContent = detailParts.join(" · ");
      summary.title = plugin.update?.error || summary.textContent;
      return { summary, action: updateAction };
    }

    function pluginAutoUpdateStatus(plugin) {
      if (plugin.bundled) return labels.pluginBundledUpdate;
      if (!plugin.update?.supported) return labels.pluginUnsupportedUpdate;
      return plugin.update?.automatic === true ? labels.pluginAutoUpdateEnabled : labels.pluginAutoUpdateDisabled;
    }

    function renderPlugins() {
      const existingRows = new Map(Array.from(pluginsCard.children)
        .filter((row) => row instanceof HTMLElement && row.dataset.pluginId)
        .map((row) => [row.dataset.pluginId, row]));
      const renderedRows = [];
      if (!plugins.length) {
        const empty = document.createElement("div");
        empty.className = "px-4 py-6 text-sm text-secondary";
        empty.textContent = labels.noPlugins;
        pluginsCard.replaceChildren(empty);
        return;
      }
      for (const plugin of plugins) {
        const rowFingerprint = JSON.stringify([plugin, busy, connected, pluginOperationIds.has(plugin.id), openPluginMenuId]);
        const existingRow = existingRows.get(plugin.id);
        if (existingRow?.dataset.pluginFingerprint === rowFingerprint) {
          renderedRows.push(existingRow);
          continue;
        }
        const row = document.createElement("div");
        row.dataset.pluginId = plugin.id;
        row.dataset.pluginFingerprint = rowFingerprint;
        row.dataset.codexLoaderSettings = "plugin-market-row";
        row.setAttribute("role", "listitem");
        row.className = "group flex min-h-[68px] min-w-0 items-center gap-3 rounded-2xl p-2 hover:bg-token-list-hover-background";
        row.style.overflow = "visible";

        const info = document.createElement("div");
        info.className = "flex min-w-0 flex-1 flex-col gap-0.5";
        const titleRow = document.createElement("div");
        titleRow.className = "flex min-w-0 items-center gap-2";
        const title = document.createElement("div");
        title.className = "min-w-0 truncate text-sm font-medium text-token-text-primary";
        title.textContent = plugin.name || plugin.id;
        const documentationSummary = pluginDocumentationSummary(plugin);
        const origin = document.createElement("span");
        origin.className = "shrink-0 rounded-md border border-default px-1.5 py-0.5 text-[11px] text-secondary";
        origin.textContent = plugin.bundled ? labels.builtIn : labels.local;
        titleRow.appendChild(title);
        if (documentationSummary) titleRow.appendChild(pluginDocumentationHelp(plugin, documentationSummary, labels.documentation));
        titleRow.appendChild(origin);
        const meta = document.createElement("div");
        meta.className = "truncate text-sm text-secondary";
        const repository = pluginRepository(plugin);
        const author = pluginAuthor(plugin, repository);
        const repositoryAddress = repository ? `github.com/${repository}` : "—";
        meta.textContent = `${author} · ${repositoryAddress} · ${labels.version} ${plugin.version} · ${labels.statusLabel(plugin.status)}${plugin.legacy ? ` · ${labels.legacy}` : ""}`;
        info.append(titleRow, meta);
        const updateView = pluginUpdatePanel(plugin);
        info.appendChild(updateView.summary);
        if (plugin.error) {
          const error = document.createElement("div");
          error.className = "truncate text-xs text-token-charts-red";
          error.textContent = plugin.error;
          error.title = plugin.error;
          info.appendChild(error);
        }

        const actions = document.createElement("div");
        actions.className = "flex shrink-0 items-center gap-2";
        if (updateView.action) actions.appendChild(updateView.action);
        actions.append(switchControl(plugin), pluginActionsMenu(plugin));
        row.append(info, actions);
        renderedRows.push(row);
      }
      pluginsCard.replaceChildren(...renderedRows);
    }

    const dismissPluginMenu = (event) => {
      if (!openPluginMenuId) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-codex-loader-plugin-menu]")) return;
      openPluginMenuId = null;
      renderPlugins();
    };
    const dismissPluginMenuOnEscape = (event) => {
      if (event.key !== "Escape" || !openPluginMenuId) return;
      openPluginMenuId = null;
      renderPlugins();
    };
    document.addEventListener("click", dismissPluginMenu);
    document.addEventListener("keydown", dismissPluginMenuOnEscape);

    async function runPluginUpdateAction(plugin, action) {
      if (busy || pluginOperationIds.has(plugin.id) || plugin.bundled || !plugin.update?.supported) return;
      if (action === "update" && plugin.update?.state === "awaitingConfirmation") {
        const warnings = [
          `${plugin.name}: ${plugin.version} → ${plugin.update.availableVersion || labels.unknown}`,
          plugin.update.releaseUrl || "",
          Array.isArray(plugin.update.newPermissions) && plugin.update.newPermissions.length ? labels.pluginPermissionIncrease(plugin.update.newPermissions) : "",
          plugin.update.localChanges ? labels.pluginLocalChanges : "",
        ].filter(Boolean).join("\n\n");
        const choice = await showDialog({ title: labels.pluginUpdateConfirmTitle, body: warnings, buttons: [{ label: labels.cancel, value: "cancel" }, { label: labels.pluginUpdateConfirm, value: "confirm", primary: true }] });
        if (choice !== "confirm") return;
      }
      pluginOperationIds.add(plugin.id);
      feedback.className = "min-h-4 text-xs text-secondary";
      try {
        if (action === "check-update") {
          plugin.update = { ...plugin.update, state: "checking", progress: null, error: null };
          feedback.textContent = labels.pluginCheckingOne(plugin.name || plugin.id);
          renderPlugins();
          const snapshots = await requestBridge("check_plugin_updates", { ids: [plugin.id] });
          feedback.textContent = pluginUpdateSummary(snapshots);
        } else if (action === "cancel-update") {
          await requestBridge("cancel_plugin_update", { id: plugin.id });
        } else if (plugin.update?.state === "awaitingConfirmation") {
          plugin.update = { ...plugin.update, state: "installing", progress: null, error: null };
          renderPlugins();
          await requestBridge("confirm_plugin_update", { id: plugin.id, token: plugin.update.confirmationToken });
        } else {
          plugin.update = { ...plugin.update, state: "downloading", progress: 0, error: null };
          renderPlugins();
          await requestBridge("start_plugin_update", { id: plugin.id });
        }
        pluginUpdateRefreshGrace = 8;
        await refresh({ preserveFeedback: true });
      } catch (error) {
        plugin.update = { ...plugin.update, state: "failed", progress: null, error: String(error?.message || error) };
        feedback.className = "min-h-4 text-xs text-token-charts-red";
        feedback.textContent = String(error?.message || error);
      } finally {
        pluginOperationIds.delete(plugin.id);
        if (!disposed) {
          renderPlugins();
          schedulePluginUpdateRefresh();
        }
      }
    }

    async function runPluginAction(plugin, action) {
      if (["check-update", "update", "cancel-update"].includes(action)) return runPluginUpdateAction(plugin, action);
      if (busy) return;
      if (action === "remove") {
        const choice = await showDialog({ title: labels.removeTitle, body: `${plugin.name}\n\n${labels.removeDescription}`, buttons: [{ label: labels.cancel, value: "cancel" }, { label: labels.remove, value: "remove", danger: true }] });
        if (choice !== "remove") return;
      }
      setBusy(true, action === "reload" ? labels.reloadingStatus : labels.checking);
      try {
        if (action === "toggle") await requestBridge("set_plugin_enabled", { id: plugin.id, enabled: !plugin.enabled });
        else if (action === "auto-update") await requestBridge("set_plugin_auto_update", { id: plugin.id, enabled: plugin.update?.automatic !== true });
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
      setBusy(true);
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
        const [status, nextPlugins] = await Promise.all([
          requestBridge("get_app_status", {}),
          requestBridge("list_plugins", {}),
        ]);
        let nextUpdateStatus = null;
        let updateStatusError = null;
        try { nextUpdateStatus = await requestBridge("get_update_status", {}); }
        catch (error) { updateStatusError = error; }
        if (disposed) return;
        connected = Boolean(status && status.loader === "healthy" && status.targetCount > 0 && status.cdp !== "stopped");
        plugins = Array.isArray(nextPlugins) ? nextPlugins : [];
        managedPlugins = plugins;
        updateStatus = nextUpdateStatus || updateStatus;
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
        schedulePluginUpdateRefresh();
        if (updateStatusError) {
          updateState.value.textContent = labels.updateStatus("failed");
          updateState.value.className = "min-w-0 max-w-[46%] shrink-0 truncate text-right text-sm text-token-charts-red";
          const errorText = labels.updateError("networkOrPackage", String(updateStatusError?.message || updateStatusError));
          updateError.value.textContent = errorText;
          updateError.value.title = errorText;
          updateError.value.className = "min-w-0 max-w-[62%] shrink-0 truncate text-right text-sm text-token-charts-red";
        } else {
          renderUpdateStatus();
        }
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
      for (const button of [checkPluginUpdatesButton, addArchiveButton, reloadAllButton, restartButton]) button.disabled = busy || !connected;
    }

    checkPluginUpdatesButton.addEventListener("click", async () => {
      if (busy) return;
      const candidates = plugins.filter((plugin) => !plugin.bundled && plugin.update?.supported);
      for (const plugin of candidates) plugin.update = { ...plugin.update, state: "checking", progress: null, error: null };
      setBusy(true, labels.pluginCheckingAll(candidates.length));
      try {
        const snapshots = await requestBridge("check_plugin_updates", {});
        feedback.textContent = pluginUpdateSummary(snapshots);
        await refresh({ preserveFeedback: true });
      } catch (error) {
        feedback.className = "min-h-4 text-xs text-token-charts-red";
        feedback.textContent = String(error?.message || error);
      } finally {
        if (!disposed) setBusy(false, feedback.textContent);
      }
    });
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
    autoUpdateToggle.addEventListener("click", async () => {
      if (!connected || autoUpdateToggle.disabled) return;
      autoUpdateToggle.disabled = true;
      try {
        updateStatus = await requestBridge("set_auto_update", { enabled: updateStatus?.autoUpdate === false });
        renderedUpdateSnapshot = JSON.stringify(updateStatus || {});
        renderUpdateStatus();
      } catch (error) {
        showUpdateError(error);
      }
    });
    checkUpdateButton.addEventListener("click", async () => {
      checkUpdateButton.disabled = true;
      try {
        updateStatus = await requestBridge("check_for_updates", {});
        renderedUpdateSnapshot = JSON.stringify(updateStatus || {});
        renderUpdateStatus();
      } catch (error) {
        showUpdateError(error, updateStatus?.errorCode || "networkOrPackage");
      }
    });
    installUpdateButton.addEventListener("click", async () => {
      installUpdateButton.disabled = true;
      updateFeedback.textContent = labels.updateNotice(updateStatus?.availableVersion || "");
      try {
        await requestBridge("start_update", {});
        await refreshUpdateStatus();
      } catch (error) {
        showUpdateError(error, updateStatus?.errorCode || "networkOrPackage");
      }
    });
    cancelUpdateButton.addEventListener("click", async () => {
      cancelUpdateButton.disabled = true;
      try { await requestBridge("cancel_update", {}); }
      catch (error) { showUpdateError(error); }
      await refreshUpdateStatus();
    });

    void refresh();
    scheduleUpdateRefresh(1000);
    return () => {
      disposed = true;
      if (updateRefreshTimer) clearTimeout(updateRefreshTimer);
      updateRefreshTimer = 0;
      if (pluginUpdateRefreshTimer) clearTimeout(pluginUpdateRefreshTimer);
      pluginUpdateRefreshTimer = 0;
      document.removeEventListener("click", dismissPluginMenu);
      document.removeEventListener("keydown", dismissPluginMenuOnEscape);
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
    const activeEntryExists = !activeId || entries.some((entry) => entry.id === activeId);
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
    if (!activeEntryExists) setTimeout(() => activate(loaderEntry.id), 0);
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
    if (restoredUiState?.activeId === id && Number.isFinite(restoredUiState.scrollTop)) {
      requestAnimationFrame(() => { if (panelSurface?.isConnected) panelSurface.scrollTop = restoredUiState.scrollTop; });
    }
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
    implementationRevision,
    start() {
      if (!observer) {
        observer = new MutationObserver(scheduleSync);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      scheduleSync();
      void refreshManagedPlugins();
      if (!managementRefreshTimer) managementRefreshTimer = setInterval(() => { void refreshManagedPlugins(); }, 4000);
      if (pendingActiveId === loaderEntry.id) setTimeout(() => activate(loaderEntry.id), 140);
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
      runtime.settingsUiState = { activeId: activeId || pendingActiveId, scrollTop: panelSurface?.scrollTop || 0 };
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
