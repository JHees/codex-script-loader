/*
 * Bennett UI Improvements for BigPizzaV3 Codex++
 *
 * Source project: https://github.com/b-nnett/codex-plusplus-bennett-ui
 * Original tweak id: co.bennett.ui-improvements
 * Original author: bennett
 * Original license: MIT License, Copyright (c) 2026 Bennett
 *
 * This file is a compatibility migration from the b-nnett Codex++ tweak
 * runtime to the BigPizzaV3 Codex++ renderer-only user script runtime.
 * The UI implementation below is not original work by the migrator; the
 * wrapper only adapts storage/logging/renderer lifecycle assumptions.
 *
 * MIT permission notice from the source project applies: permission is
 * granted to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies, provided the copyright notice and permission notice
 * are included in all copies or substantial portions of the Software.
 */

(() => {
  "use strict";

  const INSTALL_KEY = "__bennettUiImprovementsBigPizza";
  const VERSION = "1.4.5";
  const PROJECT_COLOR_STORAGE_KEY = "sidebar-project-backgrounds:colors";
  const LEGACY_STORAGE_PREFIX = "bennett-ui-improvements:";
  const LOADER_STORAGE_PREFIX = "codex-script-loader:co.bennett.ui-improvements:";
  const SCRIPT_LOAD_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lifecycleTimers = new Set();
  const lifecycleSignatures = new Set();
  const FEATURE_DEFINITIONS = Object.freeze([
    {
      id: "hide-upgrade-prompts",
      title: "隐藏升级提示",
      detail: "隐藏套餐升级提示，保留 Codex 软件更新通知。",
      defaultEnabled: true,
      status: "可用",
    },
    {
      id: "show-usage-in-sidebar",
      title: "侧栏额度显示",
      detail: "在侧栏显示 5 小时和每周额度；点击额度可切换周期，有 Credit 数据时一并显示。",
      defaultEnabled: true,
      status: "当前页面暴露额度信号时可用",
    },
    {
      id: "hide-usage-alert",
      title: "隐藏额度耗尽提示",
      detail: "隐藏额度用尽后的弹窗、重置提示和额度卡片。",
      defaultEnabled: true,
      status: "可用",
    },
    {
      id: "sidebar-project-backgrounds",
      title: "项目分组与颜色",
      detail: "为项目行添加分组背景，并保留已有的项目颜色。",
      defaultEnabled: true,
      status: "可用",
    },
    {
      id: "sidebar-conversation-colors",
      title: "会话按项目着色",
      detail: "让会话沿用所属项目颜色，未归属项目的会话保持默认样式。",
      defaultEnabled: true,
      status: "可用",
    },
    {
      id: "render-markdown-preview-math",
      title: "公式与图片预览",
      detail: "在 .md 预览中补充 LaTeX 和本地图片渲染；表格、链接与排版继续使用 Codex 原生能力。",
      defaultEnabled: true,
      status: "支持 $…$、$$…$$、\\(…\\) 和 \\[…\\]",
    },
    {
      id: "slash-menu-polish",
      title: "斜杠菜单优化",
      detail: "收紧斜杠菜单间距，并突出当前选项。",
      defaultEnabled: true,
      status: "可用",
    },
    {
      id: "thread-markdown-export",
      title: "会话 Markdown 导出",
      detail: "在会话右键菜单中导出用户与助手消息，不包含工具数据或隐藏上下文。",
      defaultEnabled: true,
      status: "本地普通会话可用；直接使用 Codex 原生 App Server",
    },
    {
      id: "thread-permanent-delete",
      title: "会话永久删除",
      detail: "在 Codex 原生会话右键菜单底部增加永久删除；确认后不可恢复。",
      defaultEnabled: true,
      status: "本地普通会话可用；不提供撤销或 Codex++ 备份",
    },
  ]);
  const FEATURE_IDS = Object.freeze(FEATURE_DEFINITIONS.map(({ id }) => id));
  const FEATURE_DEFAULTS = Object.freeze(Object.fromEntries(
    FEATURE_DEFINITIONS.map(({ id, defaultEnabled }) => [id, defaultEnabled]),
  ));

  function reportLifecycle(event, detail = {}) {
    const signature = `${event}:${JSON.stringify(detail)}`;
    if (event === "usage-mounted" && lifecycleSignatures.has(signature)) return;
    lifecycleSignatures.add(signature);
    const payload = {
      event: `bennett-ui.${event}`,
      version: VERSION,
      scriptLoadId: SCRIPT_LOAD_ID,
      ...detail,
    };
    window.__bennettUiLastLifecycle = payload;
    try {
      window.dispatchEvent(new CustomEvent("bennett-ui-lifecycle", { detail: payload }));
    } catch (_) {}
  }

  function scheduleLifecycle(callback, delay) {
    const timer = window.setTimeout(() => {
      lifecycleTimers.delete(timer);
      callback();
    }, delay);
    lifecycleTimers.add(timer);
    return timer;
  }

  const previous = window[INSTALL_KEY];
  if (previous && typeof previous.stop === "function") {
    try {
      previous.stop();
    } catch (error) {
      console.warn("[Bennett UI/BigPizza] previous stop failed", error);
    }
  }

  const module = { exports: {} };
  const exports = module.exports;
/**
 * Bennett's UI Improvements
 *
 * A bag of small, individually-toggleable UI tweaks for Codex. Settings
 * live on a dedicated sidebar entry under the "Tweaks" group.
 *
 * Features
 * --------
 *  • hide-upgrade-prompts  Hides the sidebar "Upgrade" pill and the
 *                          top-bar "Get Plus" button. Pure DOM filter,
 *                          fully reversible.
 *  • show-usage-in-sidebar (experimental) Renders a single usage box where
 *                          the upgrade pill was. Click toggles between
 *                          5h and Weekly; hover replaces content with
 *                          "Resets: HH:MM" or "Resets: Wed, HH:MM".
 *                          Red when <15% remaining.
 *                          Sources data from Codex's authenticated
 *                          /wham/usage app-server endpoint.
 *  • sidebar-project-backgrounds  Add subtle grouped backgrounds behind
 *                                 project rows in the main sidebar.
 *  • sidebar-conversation-colors Color conversation rows by their native
 *                                 project association.
 *  • thread-markdown-export Export user and assistant messages from the
 *                            native thread menu through Codex App Server.
 *  • thread-permanent-delete Permanently delete a local thread after an
 *                             explicit irreversible-action confirmation.
 *  • slash-menu-polish  Tightens the composer slash menu with denser rows,
 *                       clearer active state, and calmer section headers.
 *
 * Authoring notes
 * ---------------
 *  • Renderer-first implementation with reversible feature cleanup.
 *  • Each feature returns a `dispose()` so toggling off is clean.
 *  • Match-by-text-content for resilience: Codex's main shell has no
 *    stable testids/aria-labels for these widgets.
 */

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  start(api) {
    const state = {
      api,
      features: new Map(/* id -> { dispose } */),
      defaults: FEATURE_DEFAULTS,
    };
    this._state = state;

    // ── activate features per stored prefs ─────────────────────────────
    for (const id of Object.keys(state.defaults)) {
      const enabled = readFlag(api, id, state.defaults[id]);
      if (enabled && FEATURES[id]) activateFeature(state, id);
    }
  },

  stop() {
    const s = this._state;
    if (!s) return;
    for (const [, f] of s.features) {
      try {
        f.dispose?.();
      } catch (e) {
        s.api.log.warn("dispose failed", e);
      }
    }
    s.features.clear();
  },
};

// ─────────────────────────────────────────────────────────── feature reg ──

function activateFeature(state, id) {
  if (state.features.has(id)) return;
  const fn = FEATURES[id];
  if (!fn) {
    state.api.log.warn("unknown feature", id);
    return;
  }
  try {
    const dispose = fn(state.api);
    state.features.set(id, { dispose });
    state.api.log.info("activated", id);
  } catch (e) {
    state.api.log.error("activate failed", id, e);
    if (typeof reportLifecycle === "function") {
      reportLifecycle("feature-activation-failed", {
        feature: id,
        error: String(e?.stack || e),
      });
    }
  }
}

function deactivateFeature(state, id) {
  const f = state.features.get(id);
  if (!f) return;
  try {
    f.dispose?.();
  } finally {
    state.features.delete(id);
    state.api.log.info("deactivated", id);
  }
}

const SESSION_ACTION_EXPORT = "export";
const SESSION_ACTION_DELETE = "delete";
const sessionThreadActions = createSessionThreadActionsManager();

function createSessionThreadActionsManager() {
  const THREAD_SELECTOR = "[data-app-action-sidebar-thread-row]";
  const STYLE_ID = "bennett-thread-context-actions-style";
  const TOAST_ID = "bennett-thread-context-actions-toasts";
  const DIALOG_ATTR = "data-bennett-thread-delete-dialog";
  const EXPORT_ITEM_ID = "bennett-thread-export-markdown";
  const DELETE_SEPARATOR_ID = "bennett-thread-danger-separator";
  const DELETE_ITEM_ID = "bennett-thread-delete-permanently";
  const MENU_SOURCE_MARKERS = [
    "rename-thread",
    "archive-thread",
    "move-thread-to-project",
    "copy-thread-actions",
  ];
  const enabledActions = new Set();
  const patchedMenuRefs = new Map();
  const uiTimers = new Set();
  const retryTimers = new Set();
  const inFlight = new Set();
  let api = null;
  let observer = null;
  let scanTimer = 0;
  let resolverPromise = null;
  let onThreadPointerDown = null;
  let onWindowFocus = null;

  const log = (level, ...args) => {
    const target = api?.log?.[level] || console[level] || console.log;
    try {
      target.call(api?.log || console, ...args);
    } catch {}
  };

  const isChinese = () => /^zh(?:-|$)/i.test(
    document.documentElement.lang || navigator.language || "",
  );

  const labels = () => isChinese()
    ? {
        export: "导出 Markdown",
        delete: "永久删除",
        deleteTitle: "永久删除会话？",
        deleteBody: "此操作会永久删除“{title}”及其本地数据，且无法撤销。",
        cancel: "取消",
        confirmDelete: "永久删除",
        exporting: "正在导出会话…",
        exported: "Markdown 已导出",
        deleting: "正在永久删除会话…",
        deleted: "会话已永久删除",
        staleDelete: "删除请求已完成；如果侧栏仍显示该会话，请稍后刷新 Codex。",
        unavailable: "Codex 原生会话接口暂不可用",
      }
    : {
        export: "Export Markdown",
        delete: "Delete permanently",
        deleteTitle: "Delete this chat permanently?",
        deleteBody: "This permanently deletes “{title}” and its local data. This cannot be undone.",
        cancel: "Cancel",
        confirmDelete: "Delete permanently",
        exporting: "Exporting chat…",
        exported: "Markdown exported",
        deleting: "Deleting chat permanently…",
        deleted: "Chat deleted permanently",
        staleDelete: "The delete request completed. Refresh Codex later if the chat remains in the sidebar.",
        unavailable: "The native Codex chat service is unavailable",
      };

  const nativeMessage = (id, defaultMessage) => ({
    id: `bennettUi.threadActions.${id}`,
    defaultMessage,
    description: "Bennett UI native thread context action",
  });

  const svgIcon = (path) => {
    const svg = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="${path}" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };

  const EXPORT_ICON = svgIcon("M10 2.75v9.5m0 0 3.25-3.25M10 12.25 6.75 9M4 13.75v1.5A2 2 0 0 0 6 17.25h8a2 2 0 0 0 2-2v-1.5");
  const DELETE_ICON = svgIcon("M3.75 5.25h12.5M8 2.75h4l.75 2.5M6 7.5l.5 8.25h7L14 7.5M8.5 9.25v4.5m3-4.5v4.5");

  function ensureStyle() {
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      ${THREAD_SELECTOR} .codex-session-more-button,
      ${THREAD_SELECTOR} .codex-delete-button,
      ${THREAD_SELECTOR} .codex-session-action-group,
      ${THREAD_SELECTOR} .codex-session-action-button {
        display: none !important;
      }

      #${TOAST_ID} {
        position: fixed;
        z-index: 2147483646;
        right: 20px;
        bottom: 20px;
        display: flex;
        width: min(380px, calc(100vw - 32px));
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }

      #${TOAST_ID} .bennett-thread-toast {
        box-sizing: border-box;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 10px;
        background: var(--color-token-bg-primary, #202020);
        box-shadow: 0 10px 35px rgba(0, 0, 0, 0.3);
        color: var(--color-token-text-primary, #f4f4f4);
        font-size: 13px;
        line-height: 1.4;
        padding: 10px 12px;
        pointer-events: auto;
      }

      #${TOAST_ID} .bennett-thread-toast[data-tone="error"] {
        border-color: color-mix(in srgb, var(--red-400, #fa423e) 55%, transparent);
      }

      [${DIALOG_ATTR}] {
        position: fixed;
        z-index: 2147483647;
        inset: 0;
        display: grid;
        box-sizing: border-box;
        width: 100vw;
        max-width: none;
        height: 100vh;
        max-height: none;
        margin: 0;
        border: 0;
        place-items: center;
        background: rgba(0, 0, 0, 0.56);
        padding: 20px;
      }

      [${DIALOG_ATTR}]::backdrop {
        background: transparent;
      }

      [${DIALOG_ATTR}] .bennett-thread-delete-card {
        box-sizing: border-box;
        width: min(440px, 100%);
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 14px;
        background: var(--color-token-bg-primary, #202020);
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
        color: var(--color-token-text-primary, #f4f4f4);
        padding: 20px;
      }

      [${DIALOG_ATTR}] h2 {
        margin: 0 0 8px;
        font-size: 18px;
        line-height: 1.35;
      }

      [${DIALOG_ATTR}] p {
        margin: 0;
        color: var(--color-token-text-secondary, #b4b4b4);
        font-size: 13px;
        line-height: 1.55;
      }

      [${DIALOG_ATTR}] .bennett-thread-delete-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 20px;
      }

      [${DIALOG_ATTR}] button {
        min-height: 34px;
        border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        border-radius: 8px;
        background: color-mix(in srgb, currentColor 8%, transparent);
        color: inherit;
        cursor: pointer;
        padding: 6px 12px;
      }

      [${DIALOG_ATTR}] button:hover {
        background: color-mix(in srgb, currentColor 13%, transparent);
      }

      [${DIALOG_ATTR}] .bennett-thread-delete-confirm {
        border-color: var(--red-400, #fa423e);
        background: var(--red-400, #fa423e);
        color: white;
      }
    `;
    document.head.appendChild(style);
  }

  function showToast(message, tone = "info", timeout = 3800) {
    let root = document.getElementById(TOAST_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = TOAST_ID;
      root.setAttribute("aria-live", "polite");
      document.body.appendChild(root);
    }
    const toast = document.createElement("div");
    toast.className = "bennett-thread-toast";
    toast.dataset.tone = tone;
    toast.textContent = String(message || "");
    root.appendChild(toast);
    const timer = window.setTimeout(() => {
      uiTimers.delete(timer);
      toast.remove();
      if (!root.childElementCount) root.remove();
    }, timeout);
    uiTimers.add(timer);
  }

  function reactFiberFor(node) {
    if (!(node instanceof HTMLElement)) return null;
    const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactFiber$"));
    return key ? node[key] : null;
  }

  function threadContextFor(row) {
    if (!(row instanceof HTMLElement)) return null;
    const hostId = row.getAttribute("data-app-action-sidebar-thread-host-id") || "";
    const kind = row.getAttribute("data-app-action-sidebar-thread-kind") || "";
    const threadKey = row.getAttribute("data-app-action-sidebar-thread-id") || "";
    const title = row.getAttribute("data-app-action-sidebar-thread-title") ||
      row.getAttribute("aria-label") || "Untitled chat";
    let ephemeral = /^(?:true|1)$/i.test(
      row.getAttribute("data-app-action-sidebar-thread-ephemeral") || "",
    );
    for (let fiber = reactFiberFor(row), depth = 0; fiber && depth < 18; depth += 1, fiber = fiber.return) {
      for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
        if (props?.isAeonThread === true || props?.isEphemeral === true) ephemeral = true;
      }
    }
    if (hostId !== "local" || kind !== "local" || !threadKey || ephemeral) return null;
    return {
      row,
      hostId,
      kind,
      threadKey,
      threadId: threadKey.replace(/^local:/, ""),
      title: String(title).trim() || "Untitled chat",
    };
  }

  function threadMenuRefFor(row) {
    const fibers = [];
    for (let fiber = reactFiberFor(row), depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
      fibers.push(fiber, fiber.alternate);
    }
    const visited = new Set();
    for (const fiber of fibers) {
      if (!fiber || visited.has(fiber)) continue;
      visited.add(fiber);
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 160; index += 1, hook = hook.next) {
        const ref = hook.memoizedState;
        const candidate = ref?.current;
        if (typeof candidate !== "function") continue;
        let source = "";
        try {
          source = Function.prototype.toString.call(candidate);
        } catch {}
        if (MENU_SOURCE_MARKERS.every((marker) => source.includes(marker))) return ref;
      }
    }
    return null;
  }

  function restoreMenuRef(ref, record) {
    if (ref?.current === record.wrapped) ref.current = record.original;
    patchedMenuRefs.delete(ref);
  }

  function appendThreadActions(items, context) {
    if (!Array.isArray(items) || !context) return items;
    const next = items.filter((item) => ![
      EXPORT_ITEM_ID,
      DELETE_SEPARATOR_ID,
      DELETE_ITEM_ID,
    ].includes(item?.id));
    const text = labels();

    if (enabledActions.has(SESSION_ACTION_EXPORT)) {
      const exportItem = {
        id: EXPORT_ITEM_ID,
        icon: EXPORT_ICON,
        message: nativeMessage("exportMarkdown", text.export),
        onSelect: () => void exportThread(context),
      };
      const copyIndex = next.findIndex((item) => item?.id === "copy-thread-actions");
      const newWindowIndex = next.findIndex((item) => item?.id === "new-window-separator");
      const insertAt = copyIndex >= 0 ? copyIndex : newWindowIndex >= 0 ? newWindowIndex : next.length;
      next.splice(insertAt, 0, exportItem);
    }

    if (enabledActions.has(SESSION_ACTION_DELETE)) {
      if (next.length && next[next.length - 1]?.type !== "separator") {
        next.push({ id: DELETE_SEPARATOR_ID, type: "separator" });
      }
      next.push({
        id: DELETE_ITEM_ID,
        icon: DELETE_ICON,
        message: nativeMessage("deletePermanently", text.delete),
        destructive: true,
        danger: true,
        tone: "danger",
        onSelect: () => void deleteThreadPermanently(context),
      });
    }
    return next;
  }

  function patchMenus() {
    const activeRefs = new Set();
    for (const row of document.querySelectorAll(THREAD_SELECTOR)) {
      const context = threadContextFor(row);
      if (!context) continue;
      const ref = threadMenuRefFor(row);
      if (!ref) continue;
      activeRefs.add(ref);
      let record = patchedMenuRefs.get(ref);
      if (record && ref.current === record.wrapped) {
        record.context = context;
        continue;
      }
      if (record) patchedMenuRefs.delete(ref);
      let original = ref.current;
      if (typeof original !== "function") continue;
      if (original.__bennettThreadMenuOriginal) original = original.__bennettThreadMenuOriginal;
      record = { context, original, wrapped: null };
      record.wrapped = function bennettThreadContextItems(...args) {
        const result = record.original.apply(this, args);
        if (result && typeof result.then === "function") {
          return result.then((items) => appendThreadActions(items, record.context));
        }
        return appendThreadActions(result, record.context);
      };
      record.wrapped.__bennettThreadMenuOriginal = original;
      try {
        ref.current = record.wrapped;
        if (ref.current === record.wrapped) patchedMenuRefs.set(ref, record);
      } catch (error) {
        log("warn", "thread native menu hook unavailable", error);
      }
    }
    for (const [ref, record] of patchedMenuRefs) {
      if (!activeRefs.has(ref)) restoreMenuRef(ref, record);
    }
  }

  function schedulePatch(delay = 80) {
    if (!enabledActions.size) return;
    if (scanTimer) window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      patchMenus();
    }, delay);
  }

  function scopeFromRow(row) {
    const requiredFunctions = ["get", "set", "watch", "when"];
    const candidates = [];
    for (let fiber = reactFiberFor(row), depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
      for (const candidateFiber of [fiber, fiber.alternate]) {
        let hook = candidateFiber?.memoizedState;
        for (let index = 0; hook && index < 160; index += 1, hook = hook.next) {
          const state = hook.memoizedState;
          candidates.push(state?.current, state?.scope, state);
        }
      }
    }
    return candidates.find((candidate) =>
      candidate && typeof candidate === "object" &&
      "query" in candidate && "queryClient" in candidate &&
      requiredFunctions.every((key) => typeof candidate[key] === "function"),
    ) || null;
  }

  function localModuleUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw, document.baseURI);
      return url.protocol === "app:" && url.host === new URL(document.baseURI).host ? url.href : "";
    } catch {
      return "";
    }
  }

  async function discoverAppInitialUrls() {
    const urls = new Set();
    const collect = (value, base = document.baseURI) => {
      const match = String(value || "").match(
        /(?:\.\/|\/)?(?:assets\/)?app-initial-[A-Za-z0-9_-]+\.js/,
      );
      if (match) {
        let resolved = match[0];
        try {
          resolved = new URL(match[0], base).href;
        } catch {}
        const url = localModuleUrl(resolved);
        if (url) urls.add(url);
      }
    };
    for (const script of document.querySelectorAll("script[src]")) collect(script.src);
    try {
      for (const resource of performance.getEntriesByType("resource")) collect(resource.name);
    } catch {}
    for (const script of document.querySelectorAll("script[src]")) {
      const src = localModuleUrl(script.src);
      if (!src) continue;
      try {
        const response = await fetch(src);
        if (response.ok) collect(await response.text(), src);
      } catch {}
    }
    return Array.from(urls);
  }

  function resolverFromModule(mod) {
    for (const value of Object.values(mod || {})) {
      if (typeof value !== "function") continue;
      try {
        const source = Function.prototype.toString.call(value);
        if (source.includes("AppServerManager RPC is not connected") && source.includes(".forHost(")) {
          return value;
        }
      } catch {}
    }
    return null;
  }

  async function loadResolver() {
    if (!resolverPromise) {
      resolverPromise = (async () => {
        let lastError = null;
        for (const url of await discoverAppInitialUrls()) {
          try {
            const mod = await import(url);
            const resolver = resolverFromModule(mod);
            if (resolver) return resolver;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error(labels().unavailable);
      })().catch((error) => {
        resolverPromise = null;
        throw error;
      });
    }
    return resolverPromise;
  }

  async function sendNativeRequest(context, method, payload) {
    const scope = scopeFromRow(context.row);
    if (!scope) throw new Error(labels().unavailable);
    const resolver = await loadResolver();
    const client = resolver(scope, context.hostId);
    if (!client || typeof client.sendRequest !== "function") {
      throw new Error(labels().unavailable);
    }
    return client.sendRequest(method, payload);
  }

  function threadFromResponse(response) {
    return response?.thread || response?.result?.thread || response?.result || response;
  }

  function timestampValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function displayTimestamp(value) {
    const timestamp = timestampValue(value);
    if (!timestamp) return "Unknown time";
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(timestamp));
    } catch {
      return new Date(timestamp).toISOString();
    }
  }

  function oneLine(value, fallback = "") {
    return String(value ?? fallback).replace(/[\r\n]+/g, " ").trim();
  }

  function codeSpan(value) {
    return `\`${String(value ?? "").replace(/`/g, "\\`")}\``;
  }

  function markdownForThread(thread, fallbackContext) {
    const title = oneLine(thread?.name || thread?.title || fallbackContext.title, "Untitled chat");
    const exportedAt = new Date().toISOString();
    const cwd = thread?.cwd || thread?.workspace?.cwd || "";
    const lines = [
      `# ${title}`,
      "",
      `- Exported: ${exportedAt}`,
      `- Thread ID: ${codeSpan(thread?.id || fallbackContext.threadId)}`,
    ];
    if (cwd) lines.push(`- Working directory: ${codeSpan(cwd)}`);
    lines.push("");

    const turns = Array.isArray(thread?.turns)
      ? thread.turns.map((turn, index) => ({ turn, index })).sort((a, b) => {
          const delta = timestampValue(a.turn?.startedAt || a.turn?.createdAt) -
            timestampValue(b.turn?.startedAt || b.turn?.createdAt);
          return delta || a.index - b.index;
        })
      : [];
    let messageCount = 0;
    for (const { turn } of turns) {
      const time = displayTimestamp(turn?.startedAt || turn?.createdAt);
      const items = Array.isArray(turn?.items) ? turn.items : [];
      for (const item of items) {
        if (item?.type === "userMessage") {
          const parts = [];
          const content = Array.isArray(item.content) ? item.content : [];
          for (const part of content) {
            if (typeof part === "string" && part.trim()) parts.push(part.trim());
            else if (part?.type === "text" && String(part.text || "").trim()) parts.push(String(part.text).trim());
            else if (part?.type === "localImage" && part.path) {
              parts.push(`*[Local image: ${codeSpan(part.path)}]*`);
            }
          }
          if (!parts.length && String(item.text || "").trim()) parts.push(String(item.text).trim());
          if (!parts.length) continue;
          lines.push(`## User — ${time}`, "", parts.join("\n\n"), "");
          messageCount += 1;
          continue;
        }
        if (item?.type !== "agentMessage") continue;
        const phase = String(item.phase || "").toLowerCase();
        if (phase === "analysis" || phase === "reasoning") continue;
        const text = String(item.text || "").trim();
        if (!text) continue;
        lines.push(`## Assistant — ${time}`, "", text, "");
        messageCount += 1;
      }
    }
    if (!messageCount) lines.push("*No exportable user or assistant messages were found.*", "");
    return `${lines.join("\n").trim()}\n`;
  }

  function safeFilename(title) {
    const date = new Date().toISOString().slice(0, 10);
    const base = oneLine(title, "Codex chat")
      .replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/g, "")
      .slice(0, 96) || "Codex chat";
    return `${base}-${date}.md`;
  }

  async function saveMarkdown(filename, markdown) {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: "Markdown",
            accept: { "text/markdown": [".md"] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (error) {
        if (error?.name === "AbortError") return false;
        throw error;
      }
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  async function exportThread(context) {
    const key = `${SESSION_ACTION_EXPORT}:${context.threadKey}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    showToast(labels().exporting, "info", 1800);
    try {
      const response = await sendNativeRequest(context, "thread/read", {
        threadId: context.threadId,
        includeTurns: true,
      });
      const thread = threadFromResponse(response);
      const markdown = markdownForThread(thread, context);
      const saved = await saveMarkdown(safeFilename(thread?.name || context.title), markdown);
      if (saved) showToast(labels().exported);
    } catch (error) {
      log("error", "thread Markdown export failed", error);
      showToast(error?.message || String(error), "error", 6000);
    } finally {
      inFlight.delete(key);
    }
  }

  function confirmPermanentDelete(context) {
    document.querySelector(`[${DIALOG_ATTR}]`)?.remove();
    const text = labels();
    const overlay = document.createElement("dialog");
    overlay.setAttribute(DIALOG_ATTR, "true");
    overlay.innerHTML = `
      <div class="bennett-thread-delete-card" role="dialog" aria-modal="true" aria-labelledby="bennett-thread-delete-title">
        <h2 id="bennett-thread-delete-title"></h2>
        <p></p>
        <div class="bennett-thread-delete-actions">
          <button type="button" data-bennett-delete-cancel="true"></button>
          <button type="button" class="bennett-thread-delete-confirm" data-bennett-delete-confirm="true"></button>
        </div>
      </div>
    `;
    overlay.querySelector("h2").textContent = text.deleteTitle;
    overlay.querySelector("p").textContent = text.deleteBody.replace("{title}", context.title);
    const cancel = overlay.querySelector("[data-bennett-delete-cancel]");
    const confirm = overlay.querySelector("[data-bennett-delete-confirm]");
    cancel.textContent = text.cancel;
    confirm.textContent = text.confirmDelete;
    const previousFocus = document.activeElement;
    document.body.appendChild(overlay);
    if (typeof overlay.showModal === "function") overlay.showModal();
    else overlay.setAttribute("open", "");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("keyup", onKeyDown, true);
        overlay.remove();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      };
      cancel.addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(false);
      });
      overlay.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(false);
      });
      // Listen on window so Codex's document-level shortcuts cannot consume
      // Escape before the irreversible-action dialog sees it.
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("keyup", onKeyDown, true);
      window.queueMicrotask(() => cancel.focus());
    });
  }

  async function deleteThreadPermanently(context) {
    const key = `${SESSION_ACTION_DELETE}:${context.threadKey}`;
    if (inFlight.has(key)) return;
    if (!await confirmPermanentDelete(context)) return;
    inFlight.add(key);
    showToast(labels().deleting, "info", 1800);
    try {
      const readResponse = await sendNativeRequest(context, "thread/read", {
        threadId: context.threadId,
        includeTurns: false,
      });
      const thread = threadFromResponse(readResponse);
      if (thread?.ephemeral === true || thread?.isEphemeral === true) {
        throw new Error("Ephemeral chats cannot be permanently deleted");
      }
      await sendNativeRequest(context, "thread/delete", { threadId: context.threadId });
      showToast(labels().deleted);
      const timer = window.setTimeout(() => {
        uiTimers.delete(timer);
        if (context.row?.isConnected) showToast(labels().staleDelete, "info", 6000);
      }, 2200);
      uiTimers.add(timer);
    } catch (error) {
      log("error", "thread permanent delete failed", error);
      showToast(error?.message || String(error), "error", 6000);
    } finally {
      inFlight.delete(key);
    }
  }

  function start() {
    ensureStyle();
    observer = new MutationObserver(() => schedulePatch());
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [
        "data-app-action-sidebar-thread-host-id",
        "data-app-action-sidebar-thread-id",
        "data-app-action-sidebar-thread-kind",
        "data-app-action-sidebar-thread-row",
      ],
      childList: true,
      subtree: true,
    });
    onThreadPointerDown = (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!target?.closest?.(THREAD_SELECTOR)) return;
      // React can replace a row's hook ref without changing the DOM. Re-wrap
      // immediately before Codex's own handler reads it; do not prevent or
      // replace the native pointer/context-menu event.
      patchMenus();
    };
    onWindowFocus = () => schedulePatch(0);
    document.addEventListener("pointerdown", onThreadPointerDown, true);
    document.addEventListener("contextmenu", onThreadPointerDown, true);
    window.addEventListener("focus", onWindowFocus);
    patchMenus();
    schedulePatch(300);
    for (const delay of [800, 1800, 3500]) {
      const timer = window.setTimeout(() => {
        retryTimers.delete(timer);
        patchMenus();
      }, delay);
      retryTimers.add(timer);
    }
    log("info", "native thread context actions active", Array.from(enabledActions));
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (onThreadPointerDown) {
      document.removeEventListener("pointerdown", onThreadPointerDown, true);
      document.removeEventListener("contextmenu", onThreadPointerDown, true);
      onThreadPointerDown = null;
    }
    if (onWindowFocus) {
      window.removeEventListener("focus", onWindowFocus);
      onWindowFocus = null;
    }
    if (scanTimer) window.clearTimeout(scanTimer);
    scanTimer = 0;
    for (const timer of retryTimers) window.clearTimeout(timer);
    retryTimers.clear();
    for (const [ref, record] of patchedMenuRefs) restoreMenuRef(ref, record);
    for (const timer of uiTimers) window.clearTimeout(timer);
    uiTimers.clear();
    inFlight.clear();
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(TOAST_ID)?.remove();
    document.querySelector(`[${DIALOG_ATTR}] [data-bennett-delete-cancel]`)?.click();
    document.querySelector(`[${DIALOG_ATTR}]`)?.remove();
    resolverPromise = null;
  }

  return {
    enable(action, nextApi) {
      api = nextApi || api;
      const wasEmpty = enabledActions.size === 0;
      enabledActions.add(action);
      if (wasEmpty) start();
      else schedulePatch(0);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        enabledActions.delete(action);
        if (!enabledActions.size) stop();
        else schedulePatch(0);
      };
    },
    status() {
      const rows = Array.from(document.querySelectorAll(THREAD_SELECTOR));
      return {
        enabledActions: Array.from(enabledActions),
        patchedMenuCount: patchedMenuRefs.size,
        inFlightCount: inFlight.size,
        rowCount: rows.length,
        supportedRowCount: rows.filter((row) => Boolean(threadContextFor(row))).length,
        discoverableMenuCount: rows.filter((row) => Boolean(threadMenuRefFor(row))).length,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────── features ──

const FEATURES = {
  "thread-markdown-export"(api) {
    return sessionThreadActions.enable(SESSION_ACTION_EXPORT, api);
  },

  "thread-permanent-delete"(api) {
    return sessionThreadActions.enable(SESSION_ACTION_DELETE, api);
  },

  /**
   * Render LaTeX inside Codex's right-side Markdown file preview.
   *
   * The preview is a CodeMirror editor. Formula source ranges are replaced by
   * native CodeMirror widgets so math participates in the editor's own layout,
   * scrolling, clipping, selection, and lifecycle.
   */
  "render-markdown-preview-math"(api) {
    const STYLE_ID = "bennett-markdown-preview-math-style";
    const FORMULA_ATTR = "data-bennett-markdown-preview-math";
    const EDITOR_ATTR = "data-bennett-markdown-preview-math-editor";
    const EDITING_ATTR = "data-bennett-markdown-preview-math-editing";
    const IMAGE_ATTR = "data-bennett-markdown-preview-image";
    const IMAGE_STATUS_ATTR = "data-bennett-markdown-preview-image-status";
    const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
    const IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
    const IMAGE_READ_CONCURRENCY = 2;
    const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdown|mkd)$/i;
    const states = new Map();
    const imageCache = new Map();
    let imageCacheBytes = 0;
    const imageReadQueue = [];
    let activeImageReads = 0;
    let disposed = false;
    let scanFrame = 0;
    let scanning = false;
    let scanRequested = false;
    let katexPromise = null;
    let mainModuleUrl = null;
    let lastError = null;
    let imageRequestSequence = 0;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${FORMULA_ATTR}] {
        box-sizing: border-box;
        color: var(--color-token-text-primary, currentColor);
        vertical-align: baseline;
      }
      [${FORMULA_ATTR}="inline"] {
        display: inline-block;
        max-width: 100%;
        padding-inline: 1px;
        white-space: nowrap;
      }
      [${FORMULA_ATTR}="display-inline"] {
        display: inline-block;
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        vertical-align: middle;
      }
      [${FORMULA_ATTR}="display-block"] {
        display: block;
        width: 100%;
        max-width: 100%;
        min-height: 1.5em;
        margin: 0.35em 0;
        overflow-x: auto;
        overflow-y: hidden;
        text-align: center;
      }
      [${FORMULA_ATTR}] > .katex-display {
        width: 100%;
        margin: 0;
      }
      [${FORMULA_ATTR}] {
        cursor: text;
      }
      [${FORMULA_ATTR}][${EDITING_ATTR}] {
        width: 100%;
        min-width: 0;
        overflow: visible;
      }
      [${EDITOR_ATTR}] {
        display: block;
        box-sizing: border-box;
        width: 100%;
        min-width: 6em;
        margin: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        line-height: inherit;
      }
      textarea[${EDITOR_ATTR}] {
        min-height: 4.5em;
        overflow-x: hidden;
        overflow-y: hidden;
        resize: vertical;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      [${IMAGE_ATTR}] {
        display: inline-block;
        box-sizing: border-box;
        max-width: 100%;
        vertical-align: middle;
        cursor: text;
      }
      [${IMAGE_ATTR}="block"] {
        display: block;
        width: 100%;
        margin: 0.5em 0;
      }
      [${IMAGE_ATTR}] img {
        display: block;
        max-width: 100%;
        height: auto;
        border-radius: var(--radius-md, 0.375rem);
      }
      [${IMAGE_ATTR}="inline"] img {
        max-height: 12em;
      }
      [${IMAGE_STATUS_ATTR}] {
        display: inline-flex;
        min-height: 2em;
        max-width: 100%;
        align-items: center;
        padding: 0.35em 0.6em;
        border: 1px solid var(
          --color-token-border-default,
          color-mix(in srgb, currentColor 12%, transparent)
        );
        border-radius: var(--radius-md, 0.375rem);
        color: var(--color-token-text-secondary, currentColor);
        font-size: 0.875em;
        overflow-wrap: anywhere;
      }
    `;
    document.head.appendChild(style);

    function escapedAt(text, index) {
      let slashes = 0;
      for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
      return slashes % 2 === 1;
    }

    function blankRange(chars, start, end) {
      for (let i = start; i < end; i += 1) {
        if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
      }
    }

    function maskCode(text) {
      const chars = text.split("");
      const linePattern = /.*(?:\r\n|\n|\r|$)/g;
      let fence = null;
      for (const match of text.matchAll(linePattern)) {
        if (!match[0]) continue;
        const start = match.index;
        const end = start + match[0].length;
        const body = match[0].replace(/(?:\r\n|\n|\r)$/, "");
        const opener = body.match(/^(?: {0,3})(`{3,}|~{3,})/);
        if (fence) {
          blankRange(chars, start, end);
          const closer = body.match(/^(?: {0,3})(`{3,}|~{3,})\s*$/);
          if (
            closer &&
            closer[1][0] === fence.character &&
            closer[1].length >= fence.length
          ) {
            fence = null;
          }
          continue;
        }
        if (opener) {
          fence = { character: opener[1][0], length: opener[1].length };
          blankRange(chars, start, end);
          continue;
        }
        if (/^(?: {4}|\t)/.test(body)) blankRange(chars, start, end);
      }

      const fencedMasked = chars.join("");
      for (let i = 0; i < chars.length; i += 1) {
        if (
          fencedMasked[i] !== "`" ||
          fencedMasked[i] === " " ||
          escapedAt(fencedMasked, i)
        ) {
          continue;
        }
        let ticks = 1;
        while (fencedMasked[i + ticks] === "`") ticks += 1;
        const delimiter = "`".repeat(ticks);
        const close = fencedMasked.indexOf(delimiter, i + ticks);
        if (close < 0) break;
        blankRange(chars, i, close + ticks);
        i = close + ticks - 1;
      }
      return chars.join("");
    }

    function findClosing(text, delimiter, from, allowNewline) {
      for (let i = from; i <= text.length - delimiter.length; i += 1) {
        if (!allowNewline && (text[i] === "\n" || text[i] === "\r")) return -1;
        if (text.startsWith(delimiter, i) && !escapedAt(text, i)) return i;
      }
      return -1;
    }

    function looksLikeCurrencySpan(text, closeIndex, content) {
      if (!/^\d/u.test(content)) return false;
      if (/\d/u.test(text[closeIndex + 1] || "")) return true;
      if (content.length > 160) return true;
      return /(?:https?:\/\/|\]\(|[|；;]|\b(?:usd|rmb|cny|ku)\b|[\u3400-\u9fff])/iu.test(content);
    }

    function parseMath(text) {
      const masked = maskCode(text);
      const formulas = [];
      for (let i = 0; i < masked.length; i += 1) {
        if (masked[i] === " " || masked[i] === "\n" || escapedAt(masked, i)) continue;

        let opener = null;
        let closer = null;
        let display = false;
        let allowNewline = false;

        if (masked.startsWith("$$", i)) {
          opener = "$$";
          closer = "$$";
          display = true;
          allowNewline = true;
        } else if (masked.startsWith("\\[", i)) {
          opener = "\\[";
          closer = "\\]";
          display = true;
          allowNewline = true;
        } else if (masked.startsWith("\\(", i)) {
          opener = "\\(";
          closer = "\\)";
        } else if (masked[i] === "$" && masked[i + 1] !== "$") {
          const next = masked[i + 1];
          if (next == null || /\s/.test(next)) continue;
          opener = "$";
          closer = "$";
        }

        if (!opener) continue;
        const contentStart = i + opener.length;
        const close = findClosing(masked, closer, contentStart, allowNewline);
        if (close < 0) continue;
        if (opener === "$" && (masked[close - 1] == null || /\s/.test(masked[close - 1]))) {
          continue;
        }

        const content = text.slice(contentStart, close).trim();
        if (!content) {
          i = close + closer.length - 1;
          continue;
        }
        if (opener === "$" && looksLikeCurrencySpan(text, close, content)) {
          i = close + closer.length - 1;
          continue;
        }

        formulas.push({
          start: i,
          end: close + closer.length,
          content,
          display,
        });
        i = close + closer.length - 1;
      }
      return formulas;
    }

    function dispatchDesktopViewMessage(message) {
      let forwarded = false;
      let pending = null;
      const bridge = window.electronBridge;
      if (typeof bridge?.sendMessageFromView === "function") {
        forwarded = true;
        try {
          pending = Promise.resolve(bridge.sendMessageFromView(message));
        } catch (error) {
          pending = Promise.reject(error);
        }
      }
      const event = new CustomEvent("codex-message-from-view", {
        detail: message,
      });
      if (forwarded) event.__codexForwardedViaBridge = true;
      window.dispatchEvent(event);
      return pending;
    }

    function requestDesktopJson(command, params, timeoutMs = 15_000) {
      const requestSequence = ++imageRequestSequence;
      const randomSuffix =
        typeof window.crypto?.randomUUID === "function"
          ? window.crypto.randomUUID()
          : typeof window.crypto?.getRandomValues === "function"
            ? Array.from(window.crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join("-")
            : `${Date.now()}-${requestSequence}-${Math.random().toString(36).slice(2)}`;
      const requestId = `bennett-preview-${randomSuffix}`;
      return new Promise((resolve, reject) => {
        let finished = false;
        const cleanup = () => {
          if (finished) return;
          finished = true;
          window.removeEventListener("message", onMessage);
          window.clearTimeout(timer);
        };
        const finish = (callback, value) => {
          if (finished) return;
          cleanup();
          callback(value);
        };
        const onMessage = (event) => {
          if (event.source !== window) return;
          const data = event.data;
          if (
            !data ||
            typeof data !== "object" ||
            data.type !== "fetch-response" ||
            data.requestId !== requestId
          ) {
            return;
          }
          if (data.responseType !== "success") {
            finish(reject, new Error(data.error || `${command} failed`));
            return;
          }
          try {
            const body = JSON.parse(data.bodyJsonString);
            if (data.status >= 200 && data.status < 300) {
              finish(resolve, body);
            } else {
              finish(reject, new Error(`HTTP ${data.status}`));
            }
          } catch (error) {
            finish(reject, error);
          }
        };
        const timer = window.setTimeout(() => {
          dispatchDesktopViewMessage({ type: "cancel-fetch", requestId });
          finish(reject, new Error(`${command} timed out`));
        }, timeoutMs);
        window.addEventListener("message", onMessage);
        const pending = dispatchDesktopViewMessage({
          type: "fetch",
          requestId,
          method: "POST",
          url: `vscode://codex/${command}`,
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(params),
        });
        pending?.catch((error) => finish(reject, error));
      });
    }

    function pumpImageReadQueue() {
      while (
        !disposed &&
        activeImageReads < IMAGE_READ_CONCURRENCY &&
        imageReadQueue.length
      ) {
        const entry = imageReadQueue.shift();
        activeImageReads += 1;
        Promise.resolve()
          .then(entry.task)
          .then(entry.resolve, entry.reject)
          .finally(() => {
            activeImageReads -= 1;
            pumpImageReadQueue();
          });
      }
    }

    function enqueueImageRead(task) {
      return new Promise((resolve, reject) => {
        imageReadQueue.push({ task, resolve, reject });
        pumpImageReadQueue();
      });
    }

    function parseImageTarget(inner) {
      const value = inner.trim();
      if (!value) return null;
      if (value.startsWith("<")) {
        const close = value.indexOf(">");
        if (close <= 1) return null;
        const target = value.slice(1, close).trim();
        const remainder = value.slice(close + 1).trim();
        const title = remainder.match(/^(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/);
        return {
          target,
          title: title ? title[1] ?? title[2] ?? title[3] ?? "" : "",
        };
      }
      const titled = value.match(
        /^(.*?)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))\s*$/,
      );
      if (!titled) return { target: value, title: "" };
      return {
        target: titled[1].trim(),
        title: titled[2] ?? titled[3] ?? titled[4] ?? "",
      };
    }

    function parseMarkdownImages(text) {
      const masked = maskCode(text);
      const images = [];
      for (let start = 0; start < masked.length - 4; start += 1) {
        if (
          masked[start] !== "!" ||
          masked[start + 1] !== "[" ||
          escapedAt(masked, start)
        ) {
          continue;
        }

        let bracketDepth = 1;
        let bracketClose = -1;
        for (let index = start + 2; index < masked.length; index += 1) {
          if (escapedAt(masked, index)) continue;
          if (masked[index] === "[") bracketDepth += 1;
          if (masked[index] === "]") {
            bracketDepth -= 1;
            if (!bracketDepth) {
              bracketClose = index;
              break;
            }
          }
          if (masked[index] === "\n" || masked[index] === "\r") break;
        }
        if (bracketClose < 0 || masked[bracketClose + 1] !== "(") continue;

        let parenthesisDepth = 1;
        let quote = null;
        let parenthesisClose = -1;
        for (let index = bracketClose + 2; index < masked.length; index += 1) {
          const character = masked[index];
          if (escapedAt(masked, index)) continue;
          if (quote) {
            if (character === quote) quote = null;
            continue;
          }
          if (character === '"' || character === "'") {
            quote = character;
            continue;
          }
          if (character === "(") parenthesisDepth += 1;
          if (character === ")") {
            parenthesisDepth -= 1;
            if (!parenthesisDepth) {
              parenthesisClose = index;
              break;
            }
          }
          if (character === "\n" || character === "\r") break;
        }
        if (parenthesisClose < 0) continue;

        const parsed = parseImageTarget(
          text.slice(bracketClose + 2, parenthesisClose),
        );
        if (!parsed?.target) continue;
        images.push({
          start,
          end: parenthesisClose + 1,
          alt: text.slice(start + 2, bracketClose),
          target: parsed.target,
          title: parsed.title,
          source: text.slice(start, parenthesisClose + 1),
        });
        start = parenthesisClose;
      }
      return images;
    }

    function normalizeFilePath(path, separator) {
      let value = path;
      let prefix = "";
      if (/^[A-Za-z]:[\\/]/.test(value)) {
        prefix = `${value.slice(0, 2)}${separator}`;
        value = value.slice(3);
      } else if (/^[\\/]{2}/.test(value)) {
        prefix = separator.repeat(2);
        value = value.replace(/^[\\/]+/, "");
      } else if (/^[\\/]/.test(value)) {
        prefix = separator;
        value = value.replace(/^[\\/]+/, "");
      }
      const parts = [];
      for (const part of value.split(/[\\/]+/)) {
        if (!part || part === ".") continue;
        if (part === "..") {
          if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
          else if (!prefix) parts.push(part);
          continue;
        }
        parts.push(part);
      }
      return `${prefix}${parts.join(separator)}`;
    }

    function resolveImageTarget(target, filePath) {
      let reference = target.trim();
      if (!reference) return null;
      if (/^(?:data|blob):/i.test(reference)) return reference;
      if (/^https?:\/\//i.test(reference)) return reference;
      if (/^file:\/\//i.test(reference)) {
        try {
          const url = new URL(reference);
          reference = decodeURIComponent(url.pathname);
          if (/^\/[A-Za-z]:\//.test(reference)) reference = reference.slice(1);
        } catch {
          return null;
        }
      } else {
        try {
          reference = decodeURIComponent(reference);
        } catch {
          // Keep the literal Markdown destination.
        }
      }

      const windowsPath = /^[A-Za-z]:[\\/]/.test(filePath)
        || filePath.includes("\\");
      const separator = windowsPath ? "\\" : "/";
      if (
        /^[A-Za-z]:[\\/]/.test(reference) ||
        /^[\\/]{2}/.test(reference) ||
        (!windowsPath && reference.startsWith("/"))
      ) {
        return normalizeFilePath(reference, separator);
      }
      const lastSlash = Math.max(
        filePath.lastIndexOf("/"),
        filePath.lastIndexOf("\\"),
      );
      const directory = lastSlash >= 0 ? filePath.slice(0, lastSlash) : "";
      return normalizeFilePath(
        directory ? `${directory}${separator}${reference}` : reference,
        separator,
      );
    }

    function imageMimeType(target, provided) {
      if (typeof provided === "string" && provided.startsWith("image/")) {
        return provided;
      }
      const extension = target.split(/[?#]/)[0].match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
      return {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        ico: "image/x-icon",
        avif: "image/avif",
      }[extension] || null;
    }

    function codexLocalMediaUrl(path) {
      if (
        !/^[A-Za-z]:[\\/]/.test(path) &&
        !/^[\\/]{2}/.test(path) &&
        !path.startsWith("/")
      ) {
        return null;
      }
      const normalized = path.replace(/\\/g, "/");
      const encoded = encodeURI(normalized)
        .replaceAll("#", "%23")
        .replaceAll("?", "%3F");
      return `app://fs/@fs${encoded}`;
    }

    function loadImageSource(target, filePath, hostId) {
      const resolved = resolveImageTarget(target, filePath);
      if (!resolved) return Promise.reject(new Error("图片路径为空"));
      if (/^(?:data|https?):/i.test(resolved)) return Promise.resolve(resolved);
      if (!hostId || hostId === "local") {
        const localMediaUrl = codexLocalMediaUrl(resolved);
        if (localMediaUrl) return Promise.resolve(localMediaUrl);
      }
      const key = `${hostId || "local"}\n${resolved}`;
      const cached = imageCache.get(key);
      if (cached) {
        imageCache.delete(key);
        imageCache.set(key, cached);
        return cached.promise;
      }
      const entry = { promise: null, bytes: 0 };
      entry.promise = enqueueImageRead(() => requestDesktopJson("read-file-binary", {
        hostId: hostId || "local",
        path: resolved,
        maxBytes: IMAGE_MAX_BYTES,
      }, 60_000))
        .then((result) => {
          if (disposed) throw new Error("图片预览已停止");
          if (!result?.contentsBase64) {
            if (/^https?:\/\//i.test(resolved)) return resolved;
            throw new Error("图片不存在、格式不受支持或超过 20 MB");
          }
          const mimeType = imageMimeType(resolved, result.mimeType);
          if (!mimeType) throw new Error("文件不是支持的图片格式");
          if (imageCache.get(key) === entry) {
            entry.bytes = Math.ceil(result.contentsBase64.length * 0.75);
            imageCacheBytes += entry.bytes;
            while (imageCacheBytes > IMAGE_CACHE_MAX_BYTES && imageCache.size > 1) {
              const oldestKey = imageCache.keys().next().value;
              const oldest = imageCache.get(oldestKey);
              imageCache.delete(oldestKey);
              imageCacheBytes = Math.max(0, imageCacheBytes - (oldest?.bytes || 0));
            }
          }
          return `data:${mimeType};base64,${result.contentsBase64}`;
        })
        .catch((error) => {
          if (imageCache.get(key) === entry) {
            imageCache.delete(key);
            imageCacheBytes = Math.max(0, imageCacheBytes - entry.bytes);
          }
          throw error;
        });
      imageCache.set(key, entry);
      return entry.promise;
    }

    function currentMainModuleUrl() {
      if (mainModuleUrl) return mainModuleUrl;
      const scripts = Array.from(document.scripts);
      const script = scripts.find((item) => /\/app-initial-[^/]+\.js(?:$|[?#])/.test(item.src));
      if (script?.src) {
        mainModuleUrl = script.src;
        return mainModuleUrl;
      }
      const preload = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]'))
        .find((item) => /\/app-initial-[^/]+\.js(?:$|[?#])/.test(item.href));
      if (preload?.href) {
        mainModuleUrl = preload.href;
        return mainModuleUrl;
      }
      const resource = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => /\/app-initial-[^/]+\.js(?:$|[?#])/.test(url));
      mainModuleUrl = resource || null;
      return mainModuleUrl;
    }

    async function discoverKatexUrl() {
      const loaded = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => /\/katex-[^/]+\.js(?:$|[?#])/.test(url));
      if (loaded) return loaded;

      const mainUrl = currentMainModuleUrl();
      if (!mainUrl) throw new Error("Codex main renderer module was not found");
      const response = await fetch(mainUrl);
      if (!response.ok) throw new Error(`Could not inspect Codex renderer (${response.status})`);
      const source = await response.text();
      const match = source.match(/import\((?:`|"|')\.\/(katex-[^"'`]+\.js)(?:`|"|')\)/);
      if (!match) throw new Error("Codex native KaTeX chunk was not found");
      return new URL(match[1], mainUrl).href;
    }

    function loadNativeKatex() {
      if (katexPromise) return katexPromise;
      if (typeof window.katex?.renderToString === "function") {
        katexPromise = Promise.resolve(window.katex);
        return katexPromise;
      }
      katexPromise = discoverKatexUrl()
        .then((url) => import(url))
        .then((module) => module?.default || module)
        .then((katex) => {
          if (typeof katex?.renderToString !== "function") {
            throw new Error("Codex KaTeX module has no renderToString export");
          }
          return katex;
        })
        .catch((error) => {
          lastError = String(error?.message || error);
          katexPromise = null;
          throw error;
        });
      return katexPromise;
    }

    function markdownFileNameFor(root) {
      let current = root;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const nav = Array.from(current.children || []).find(
          (child) => child instanceof HTMLElement && child.tagName === "NAV",
        ) || current.querySelector(":scope > nav");
        const lastCrumb = nav?.querySelector("ol > li:last-child");
        const fileName = (lastCrumb?.textContent || "").replace(/\s+/g, " ").trim();
        if (fileName) return fileName;
      }
      return "";
    }

    function findPreviewEditors() {
      const editors = [];
      for (const surface of document.querySelectorAll("[data-editor-search-surface]")) {
        const editor = surface.querySelector(":scope > .cm-editor, .cm-editor");
        if (!(editor instanceof HTMLElement)) continue;
        const fileName = markdownFileNameFor(surface);
        if (!MARKDOWN_EXTENSION.test(fileName)) continue;
        editors.push(editor);
      }
      return editors;
    }

    function controllerFromValue(value, editor) {
      if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
      if (value.editorView?.dom === editor) return value;
      if (value.current?.editorView?.dom === editor) return value.current;
      return null;
    }

    function findEditorController(editor) {
      const fibers = [];
      let node = editor;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (key.startsWith("__reactFiber$")) fibers.push(node[key]);
        }
      }

      const visited = new Set();
      for (const initialFiber of fibers) {
        for (let fiber = initialFiber, depth = 0; fiber && depth < 24; fiber = fiber.return, depth += 1) {
          if (visited.has(fiber)) continue;
          visited.add(fiber);
          let hook = fiber.memoizedState;
          for (let index = 0; hook && index < 120; hook = hook.next, index += 1) {
            const direct = controllerFromValue(hook.memoizedState, editor)
              || controllerFromValue(hook.baseState, editor);
            if (direct) return direct;
            const memo = hook.memoizedState;
            if (Array.isArray(memo)) {
              for (const item of memo) {
                const nested = controllerFromValue(item, editor);
                if (nested) return nested;
              }
            }
          }
        }
      }
      return null;
    }

    function decorationClassFromValue(value) {
      let constructor = value?.constructor;
      for (let depth = 0; constructor && depth < 6; depth += 1) {
        if (
          typeof constructor.replace === "function" &&
          typeof constructor.set === "function"
        ) {
          return constructor;
        }
        constructor = Object.getPrototypeOf(constructor);
      }
      return null;
    }

    function discoverDecorationClass(view) {
      const sets = [
        ...(Array.isArray(view.viewState?.stateDeco) ? view.viewState.stateDeco : []),
        ...view.plugins.map((wrapper) => wrapper?.value?.decorations).filter(Boolean),
      ];
      let found = null;
      const end = view.state.doc.length;
      for (const set of sets) {
        if (typeof set?.between !== "function") continue;
        try {
          set.between(0, end, (_from, _to, value) => {
            found ||= decorationClassFromValue(value);
          });
        } catch {
          // Continue with the other decoration providers.
        }
        if (found) return found;
      }
      return null;
    }

    function extensionValues(root) {
      const values = [];
      const queue = [root];
      const visited = new Set();
      while (queue.length && visited.size < 5000) {
        const value = queue.shift();
        if (
          value == null ||
          (typeof value !== "object" && typeof value !== "function") ||
          visited.has(value)
        ) {
          continue;
        }
        visited.add(value);
        values.push(value);
        if (Array.isArray(value)) {
          queue.push(...value);
          continue;
        }
        if (value.inner && value.inner !== value) queue.push(value.inner);
        if (value.extension && value.extension !== value) queue.push(value.extension);
        if (Array.isArray(value.baseExtensions)) queue.push(...value.baseExtensions);
      }
      return values;
    }

    function discoverStateFieldClass(view) {
      for (const value of extensionValues(view.state.config?.base)) {
        const StateField = value?.constructor;
        if (
          typeof StateField?.define === "function" &&
          typeof value?.create === "function" &&
          typeof value?.slot === "function" &&
          typeof value?.init === "function" &&
          value.extension === value
        ) {
          return StateField;
        }
      }
      return null;
    }

    function discoverDecorationsFacet(view) {
      for (const wrapper of view.plugins) {
        const decorationSet = wrapper?.value?.decorations;
        if (!decorationSet) continue;
        for (const extension of extensionValues(wrapper.plugin?.baseExtensions)) {
          if (!extension?.facet || typeof extension.value !== "function") continue;
          try {
            if (extension.value(view) === decorationSet) return extension.facet;
          } catch {
            // This provider belongs to another view-plugin capability.
          }
        }
      }
      return null;
    }

    function discoverCodeMirrorRuntime(controller) {
      const view = controller?.editorView;
      if (!view?.state?.doc || !view.dom) return null;
      const Decoration = discoverDecorationClass(view);
      const StateField = discoverStateFieldClass(view);
      const DecorationsFacet = discoverDecorationsFacet(view);
      const existingCompartment = controller.readOnlyCompartment
        || controller.selectionEditCompartment
        || Array.from(view.state.config?.compartments?.keys?.() || [])[0];
      if (!Decoration || !StateField || !DecorationsFacet || !existingCompartment) return null;

      const Compartment = existingCompartment.constructor;
      const StateEffect = existingCompartment.reconfigure([]).constructor;
      if (
        typeof Compartment !== "function" ||
        typeof StateEffect?.appendConfig?.of !== "function"
      ) {
        return null;
      }
      return {
        view,
        Decoration,
        StateField,
        DecorationsFacet,
        Compartment,
        StateEffect,
      };
    }

    function formulaRange(formula, state) {
      if (!formula.display) return { from: formula.start, to: formula.end, block: false };
      const firstLine = state.doc.lineAt(formula.start);
      const lastLine = state.doc.lineAt(Math.max(formula.start, formula.end - 1));
      const before = state.sliceDoc(firstLine.from, formula.start);
      const after = state.sliceDoc(formula.end, lastLine.to);
      if (!before.trim() && !after.trim()) {
        return { from: firstLine.from, to: lastLine.to, block: true };
      }
      return { from: formula.start, to: formula.end, block: false };
    }

    function imageRange(image, state) {
      const firstLine = state.doc.lineAt(image.start);
      const lastLine = state.doc.lineAt(Math.max(image.start, image.end - 1));
      const before = state.sliceDoc(firstLine.from, image.start);
      const after = state.sliceDoc(image.end, lastLine.to);
      if (!before.trim() && !after.trim()) {
        return { from: firstLine.from, to: lastLine.to, block: true };
      }
      return { from: image.start, to: image.end, block: false };
    }

    function selectionTouches(range, state) {
      return state.selection.ranges.some((selection) => (
        selection.empty
          ? selection.from >= range.from && selection.from <= range.to
          : selection.from < range.to && selection.to > range.from
      ));
    }

    function createFormulaWidgetClass(katex) {
      return class FormulaWidget {
        constructor(content, display, block, source, editFrom, editTo) {
          this.content = content;
          this.display = display;
          this.block = block;
          this.source = source;
          this.editFrom = editFrom;
          this.editTo = editTo;
        }

        eq(other) {
          return (
            other instanceof this.constructor &&
            other.content === this.content &&
            other.display === this.display &&
            other.block === this.block &&
            other.source === this.source &&
            other.editFrom === this.editFrom &&
            other.editTo === this.editTo
          );
        }

        updateDOM() {
          return false;
        }

        compare(other) {
          return this === other || (
            this.constructor === other?.constructor &&
            this.eq(other)
          );
        }

        get estimatedHeight() {
          if (!this.block) return -1;
          const contentLines = this.content
            .split(/\r\n|\n|\r/)
            .filter((line) => line.trim()).length;
          return Math.max(40, contentLines * 18 + 16);
        }

        get lineBreaks() {
          return 0;
        }

        ignoreEvent() {
          return true;
        }

        coordsAt() {
          return null;
        }

        get isHidden() {
          return false;
        }

        get editable() {
          return false;
        }

        destroy() {}

        toDOM(view) {
          const ownerDocument = view.dom.ownerDocument;
          const element = ownerDocument.createElement(this.block ? "div" : "span");
          element.setAttribute(
            FORMULA_ATTR,
            this.block ? "display-block" : this.display ? "display-inline" : "inline",
          );
          element.setAttribute("contenteditable", "false");
          element.setAttribute("role", "math");
          element.setAttribute("aria-label", this.content);
          element.tabIndex = 0;
          element.title = "单击编辑公式，Enter 或 Ctrl+Enter 提交，Esc 取消";

          const renderFormula = () => {
            element.removeAttribute(EDITING_ATTR);
            element.replaceChildren();
            try {
              element.innerHTML = katex.renderToString(this.content, {
                displayMode: this.display,
                strict: "ignore",
                throwOnError: false,
              });
            } catch {
              element.textContent = this.content;
            }
          };
          const beginEdit = (event) => {
            if (event?.button != null && event.button !== 0) return;
            if (element.hasAttribute(EDITING_ATTR)) return;
            event?.preventDefault();
            event?.stopPropagation();

            const multiline = this.display || this.block || /[\r\n]/.test(this.source);
            const editor = ownerDocument.createElement(multiline ? "textarea" : "input");
            if (!multiline) editor.type = "text";
            editor.value = this.source;
            editor.setAttribute(EDITOR_ATTR, "");
            editor.setAttribute("aria-label", "公式 LaTeX 源码");
            editor.spellcheck = false;
            element.setAttribute(EDITING_ATTR, "");
            element.replaceChildren(editor);

            const resizeEditor = () => {
              if (!(editor instanceof HTMLTextAreaElement)) return;
              editor.style.height = "auto";
              editor.style.height = `${Math.max(editor.scrollHeight, 72)}px`;
              view.requestMeasure?.();
            };
            let finished = false;
            const finish = (commit) => {
              if (finished) return;
              finished = true;
              const nextSource = editor.value;
              if (
                commit &&
                nextSource !== this.source &&
                !view.destroyed
              ) {
                view.dispatch({
                  changes: {
                    from: this.editFrom,
                    to: this.editTo,
                    insert: nextSource,
                  },
                });
                return;
              }
              renderFormula();
            };
            editor.addEventListener("mousedown", (inputEvent) => {
              inputEvent.stopPropagation();
            });
            editor.addEventListener("input", resizeEditor);
            editor.addEventListener("keydown", (inputEvent) => {
              if (inputEvent.key === "Escape") {
                inputEvent.preventDefault();
                finish(false);
                return;
              }
              if (
                inputEvent.key === "Enter" &&
                (!multiline || inputEvent.ctrlKey || inputEvent.metaKey)
              ) {
                inputEvent.preventDefault();
                finish(true);
              }
            });
            editor.addEventListener("blur", () => finish(true), { once: true });
            ownerDocument.defaultView?.setTimeout(() => {
              resizeEditor();
              editor.focus();
              editor.select();
            }, 0);
          };
          element.addEventListener("mousedown", beginEdit);
          element.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") beginEdit(event);
          });
          renderFormula();
          return element;
        }
      };
    }

    function createImageWidgetClass(context) {
      return class ImageWidget {
        constructor(image, range) {
          this.alt = image.alt;
          this.target = image.target;
          this.title = image.title;
          this.source = image.source;
          this.editFrom = image.start;
          this.editTo = image.end;
          this.block = range.block;
          this.filePath = context.filePath;
          this.hostId = context.hostId;
        }

        eq(other) {
          return (
            other instanceof this.constructor &&
            other.alt === this.alt &&
            other.target === this.target &&
            other.title === this.title &&
            other.source === this.source &&
            other.editFrom === this.editFrom &&
            other.editTo === this.editTo &&
            other.block === this.block &&
            other.filePath === this.filePath &&
            other.hostId === this.hostId
          );
        }

        updateDOM() {
          return false;
        }

        compare(other) {
          return this === other || (
            this.constructor === other?.constructor &&
            this.eq(other)
          );
        }

        get estimatedHeight() {
          return this.block ? 240 : -1;
        }

        get lineBreaks() {
          return 0;
        }

        ignoreEvent() {
          return true;
        }

        coordsAt() {
          return null;
        }

        get isHidden() {
          return false;
        }

        get editable() {
          return false;
        }

        destroy(dom) {
          if (!dom) return;
          dom.__bennettImageActive = false;
          dom.__bennettImageObserver?.disconnect();
        }

        toDOM(view) {
          const ownerDocument = view.dom.ownerDocument;
          const element = ownerDocument.createElement(this.block ? "div" : "span");
          element.__bennettImageActive = true;
          element.setAttribute(IMAGE_ATTR, this.block ? "block" : "inline");
          element.setAttribute("contenteditable", "false");
          element.setAttribute("role", "img");
          element.setAttribute("aria-label", this.alt || this.title || this.target);
          element.tabIndex = 0;
          element.title = "单击编辑图片语法，Enter 提交，Esc 取消";
          const loadingMessage = this.alt.trim()
            ? `正在加载${this.alt.trim()}图片`
            : "正在加载图片";

          let imageObserver = null;
          let loadingStarted = false;

          const renderStatus = (status, message, measure = true) => {
            element.removeAttribute(EDITING_ATTR);
            const statusElement = ownerDocument.createElement("span");
            statusElement.setAttribute(IMAGE_STATUS_ATTR, status);
            statusElement.textContent = message;
            element.replaceChildren(statusElement);
            if (measure) view.requestMeasure?.();
          };

          const renderImage = () => {
            if (!element.__bennettImageActive) return;
            renderStatus("loading", loadingMessage);
            loadImageSource(this.target, this.filePath, this.hostId)
              .then((source) => {
                if (
                  !element.__bennettImageActive ||
                  element.hasAttribute(EDITING_ATTR)
                ) {
                  return;
                }
                const image = ownerDocument.createElement("img");
                image.alt = this.alt;
                if (this.title) image.title = this.title;
                image.addEventListener("load", () => view.requestMeasure?.(), {
                  once: true,
                });
                image.addEventListener("error", () => {
                  if (!element.__bennettImageActive) return;
                  renderStatus(
                    "error",
                    `无法显示图片：${this.alt || this.target}`,
                  );
                }, { once: true });
                image.src = source;
                element.replaceChildren(image);
                view.requestMeasure?.();
              })
              .catch((error) => {
                if (
                  !element.__bennettImageActive ||
                  element.hasAttribute(EDITING_ATTR)
                ) {
                  return;
                }
                const detail = String(error?.message || error || "").trim();
                renderStatus(
                  "error",
                  `无法加载图片：${this.alt || this.target}${detail ? `（${detail}）` : ""}`,
                );
              });
          };

          const beginEdit = (event) => {
            if (event?.button != null && event.button !== 0) return;
            if (element.hasAttribute(EDITING_ATTR)) return;
            event?.preventDefault();
            event?.stopPropagation();
            imageObserver?.disconnect();

            const editor = ownerDocument.createElement("input");
            editor.type = "text";
            editor.value = this.source;
            editor.setAttribute(EDITOR_ATTR, "");
            editor.setAttribute("aria-label", "Markdown 图片语法");
            editor.spellcheck = false;
            element.setAttribute(EDITING_ATTR, "");
            element.replaceChildren(editor);

            let finished = false;
            const finish = (commit) => {
              if (finished) return;
              finished = true;
              const nextSource = editor.value;
              if (
                commit &&
                nextSource !== this.source &&
                !view.destroyed
              ) {
                view.dispatch({
                  changes: {
                    from: this.editFrom,
                    to: this.editTo,
                    insert: nextSource,
                  },
                });
                return;
              }
              loadingStarted = true;
              renderImage();
            };
            editor.addEventListener("mousedown", (inputEvent) => {
              inputEvent.stopPropagation();
            });
            editor.addEventListener("keydown", (inputEvent) => {
              if (inputEvent.key === "Escape") {
                inputEvent.preventDefault();
                finish(false);
                return;
              }
              if (inputEvent.key === "Enter") {
                inputEvent.preventDefault();
                finish(true);
              }
            });
            editor.addEventListener("blur", () => finish(true), { once: true });
            ownerDocument.defaultView?.setTimeout(() => {
              editor.focus();
              editor.select();
            }, 0);
          };

          element.addEventListener("mousedown", beginEdit);
          element.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") beginEdit(event);
          });
          const startLoading = () => {
            if (loadingStarted || !element.__bennettImageActive) return;
            loadingStarted = true;
            imageObserver?.disconnect();
            imageObserver = null;
            element.__bennettImageObserver = null;
            renderImage();
          };
          renderStatus(
            "waiting",
            loadingMessage,
            false,
          );
          const IntersectionObserverClass = ownerDocument.defaultView?.IntersectionObserver;
          if (typeof IntersectionObserverClass === "function") {
            imageObserver = new IntersectionObserverClass((entries) => {
              if (entries.some((entry) => entry.isIntersecting)) startLoading();
            }, {
              root: view.scrollDOM instanceof Element ? view.scrollDOM : null,
              rootMargin: "400px 0px",
              threshold: 0,
            });
            element.__bennettImageObserver = imageObserver;
            imageObserver.observe(element);
          } else {
            startLoading();
          }
          return element;
        }
      };
    }

    function createMathExtension(runtime, katex, context) {
      const { Decoration, StateField, DecorationsFacet } = runtime;
      const FormulaWidget = createFormulaWidgetClass(katex);
      const ImageWidget = createImageWidgetClass(context);

      function buildDecorations(state) {
        const source = state.doc.toString();
        const ranges = [];
        const images = parseMarkdownImages(source);
        const formulas = parseMath(source);
        for (const image of images) {
          const range = imageRange(image, state);
          const widget = new ImageWidget(image, range);
          let decoration;
          try {
            decoration = Decoration.replace({
              widget,
              block: range.block,
            }).range(range.from, range.to);
          } catch {
            decoration = Decoration.replace({ widget }).range(image.start, image.end);
          }
          ranges.push(decoration);
        }
        for (const formula of formulas) {
          if (
            images.some((image) => (
              formula.start < image.end && formula.end > image.start
            ))
          ) {
            continue;
          }
          const range = formulaRange(formula, state);
          if (selectionTouches(range, state)) continue;
          const widget = new FormulaWidget(
            formula.content,
            formula.display,
            range.block,
            state.sliceDoc(formula.start, formula.end),
            formula.start,
            formula.end,
          );
          let decoration;
          try {
            decoration = Decoration.replace({
              widget,
              block: range.block,
            }).range(range.from, range.to);
          } catch {
            decoration = Decoration.replace({ widget }).range(formula.start, formula.end);
          }
          ranges.push(decoration);
        }
        return Decoration.set(ranges, true);
      }

      return StateField.define({
        create(state) {
          return buildDecorations(state);
        },
        update(decorations, transaction) {
          if (transaction.docChanged || transaction.selection) {
            return buildDecorations(transaction.state);
          }
          return decorations;
        },
        provide(field) {
          return DecorationsFacet.from(field);
        }
      });
    }

    function removeState(state) {
      states.delete(state.editor);
      if (!state.view.destroyed) {
        try {
          state.view.dispatch({
            effects: state.compartment.reconfigure([]),
          });
        } catch (error) {
          api.log.warn("Could not remove Markdown preview math extension", error);
        }
      }
    }

    async function installForEditor(editor, katex) {
      if (states.has(editor) || !editor.isConnected || disposed) return;
      const controller = findEditorController(editor);
      const runtime = discoverCodeMirrorRuntime(controller);
      if (!runtime) return;

      const compartment = new runtime.Compartment();
      const extension = createMathExtension(runtime, katex, {
        filePath: typeof controller.filePath === "string"
          ? controller.filePath
          : markdownFileNameFor(editor),
        hostId: typeof controller.hostId === "string" && controller.hostId
          ? controller.hostId
          : "local",
      });
      runtime.view.dispatch({
        effects: runtime.StateEffect.appendConfig.of(compartment.of(extension)),
      });
      states.set(editor, {
        editor,
        view: runtime.view,
        compartment,
      });
    }

    async function scanEditors() {
      scanFrame = 0;
      if (disposed) return;
      if (scanning) {
        scanRequested = true;
        return;
      }
      scanning = true;
      scanRequested = false;
      try {
        const editors = findPreviewEditors();
        const liveEditors = new Set(editors);
        for (const state of Array.from(states.values())) {
          if (
            !liveEditors.has(state.editor) ||
            !state.editor.isConnected ||
            state.view.destroyed
          ) {
            removeState(state);
          }
        }

        let katex;
        try {
          katex = await loadNativeKatex();
        } catch (error) {
          api.log.warn("Markdown preview math unavailable", error);
          return;
        }
        for (const editor of editors) await installForEditor(editor, katex);
      } finally {
        scanning = false;
        if (scanRequested && !disposed) scheduleScan();
      }
    }

    function scheduleScan() {
      if (disposed || scanFrame) return;
      scanFrame = requestAnimationFrame(() => void scanEditors());
    }

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.__bennettMarkdownPreviewMath = {
      getStats() {
        return {
          enabled: !disposed,
          previewEditors: states.size,
          renderedFormulas: Array.from(states.values()).reduce(
            (count, state) => (
              count + state.editor.querySelectorAll(`[${FORMULA_ATTR}]`).length
            ),
            0,
          ),
          renderedImages: Array.from(states.values()).reduce(
            (count, state) => (
              count + state.editor.querySelectorAll(`[${IMAGE_ATTR}] img`).length
            ),
            0,
          ),
          cachedImages: imageCache.size,
          cachedImageBytes: imageCacheBytes,
          queuedImageReads: imageReadQueue.length,
          activeImageReads,
          nativeKatexLoaded: !!katexPromise && !lastError,
          implementation: "CodeMirror formula and local-image replacement widgets; native Markdown tables preserved",
          lastError,
          scope: "right-side Markdown file preview only",
        };
      },
      refresh: scheduleScan,
    };
    scheduleScan();

    return () => {
      disposed = true;
      if (scanFrame) cancelAnimationFrame(scanFrame);
      observer.disconnect();
      for (const state of Array.from(states.values())) removeState(state);
      while (imageReadQueue.length) {
        imageReadQueue.shift().reject(new Error("图片预览已停止"));
      }
      imageCache.clear();
      imageCacheBytes = 0;
      style.remove();
      delete window.__bennettMarkdownPreviewMath;
    };
  },

  /**
   * Hide the Plus/Pro plan "Upgrade" / "Get Plus" buttons while keeping Codex software-update notices visible. We match by visible text
   * across the document, skipping anything inside Codex's settings shell
   * or our own injected panels. Hidden via inline `display:none` so we
   * can restore it cleanly on dispose.
   */
  "hide-upgrade-prompts"(api) {
    // Two matcher tiers:
    //  • EXACT: short pill labels we trust (case-insensitive, exact match).
    //  • CONTAINS: longer phrases that may appear with trailing icons/arrows
    //    or wrapped in extra spans. We substring-match (case-insensitive).
    const EXACT = new Set([
      "upgrade",
      "get plus",
      "get chatgpt plus",
      "upgrade plan",
      "upgrade your plan",
      "upgrade to plus",
    ]);
    const CONTAINS = ["upgrade for higher limits"];
    const APP_UPDATE_CONTEXT_RE =
      /(?:\b(?:app|application|desktop|codex)\s+(?:update|upgrade|version|release)\b|\b(?:update|updated|updating|new version|latest version|release|download|restart|install)\b|软件升级|应用升级|版本升级|新版本|软件更新|应用更新|更新可用|下载更新|重启更新|安装包)/i;
    const hidden = new Set(/* HTMLElement */);

    const isInsideOurShell = (el) => {
      let n = el;
      while (n) {
        if (n instanceof HTMLElement && n.dataset?.codexpp) return true;
        n = n.parentElement;
      }
      return false;
    };

    // Codex may split a label across icon + text spans, so use textContent
    // for the button itself and semantic attributes for update banners.
    const normText = (el) =>
      (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const semanticText = (el) =>
      [
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("data-testid"),
        el.getAttribute("data-test"),
        el.id,
        typeof el.className === "string" ? el.className : "",
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const isAppUpdateControl = (el) => {
      let n = el;
      for (let depth = 0; n && depth < 5; depth += 1, n = n.parentElement) {
        const text = semanticText(n);
        // Avoid matching against the entire document body, which could contain
        // an unrelated update message elsewhere in the page.
        if (text.length <= 240 && APP_UPDATE_CONTEXT_RE.test(text)) return true;
      }
      return false;
    };

    const matches = (el, text) => {
      if (!text || isAppUpdateControl(el)) return false;
      if (EXACT.has(text)) return true;
      for (const c of CONTAINS) if (text.includes(c)) return true;
      return false;
    };
    const CANDIDATE_SELECTOR = 'button, a, [role="button"], [role="menuitem"]';
    const scanRoot = (root) => {
      const candidates = [];
      if (root instanceof Element && root.matches(CANDIDATE_SELECTOR)) candidates.push(root);
      if (root?.querySelectorAll) candidates.push(...root.querySelectorAll(CANDIDATE_SELECTOR));
      for (const el of candidates) {
        if (isInsideOurShell(el)) continue;
        const t = normText(el);
        if (t.length === 0 || t.length > 80) continue;
        if (!matches(el, t)) continue;
        const host = el.closest('[class*="rounded"], [class*="badge"]') || el;
        if (!(host instanceof HTMLElement)) continue;
        if (hidden.has(host)) continue;
        host.dataset.codexppPrevDisplay = host.style.display || "";
        host.style.display = "none";
        hidden.add(host);
        api.log.info("hid upgrade element", { text: t });
      }
    };

    let scanTimer = 0;
    const pendingRoots = new Set();
    const flushPendingRoots = () => {
      scanTimer = 0;
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      for (const root of roots) scanRoot(root);
    };
    const scheduleRoots = (records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const root = node instanceof Element ? node : node.parentElement;
          if (root instanceof Element) pendingRoots.add(root);
        }
      }
      if (!pendingRoots.size) return;
      if (pendingRoots.size > 40) {
        pendingRoots.clear();
        pendingRoots.add(document.documentElement);
      }
      if (scanTimer) window.clearTimeout(scanTimer);
      scanTimer = window.setTimeout(flushPendingRoots, 100);
    };

    scanRoot(document);
    const obs = new MutationObserver(scheduleRoots);
    obs.observe(document.documentElement, { childList: true, subtree: true });

    return () => {
      obs.disconnect();
      if (scanTimer) window.clearTimeout(scanTimer);
      pendingRoots.clear();
      for (const el of hidden) {
        if ("codexppPrevDisplay" in el.dataset) {
          el.style.display = el.dataset.codexppPrevDisplay;
          delete el.dataset.codexppPrevDisplay;
        }
      }
      hidden.clear();
    };
  },

  /**
   * Surface 5h + Weekly rate limits and points balance in the sidebar slot
   * where the "Upgrade" pill lives. Sources its data from Codex's
   * authenticated app-server usage endpoint, with Codex's rendered
   * rate-limit UI as a fallback.
   *
   * Strategy
   * --------
   *  1. Fetch `/wham/usage` through Codex's existing renderer fetch bridge.
   *  2. Ignore model-specific renderer events and rendered labels; they can
   *     represent a selected model rather than the main account.
   *  3. Persist the latest current snapshot and refresh the mounted sidebar box in
   *     place. Re-mount only when Codex replaces the sidebar subtree.
   */
  "show-usage-in-sidebar"(api) {
    /**
     * Persisted snapshot:
     *   { fiveHour:{label,pct,resetAt} | null,
     *     weekly:  {label,pct,resetAt} | null,
     *     points:   {label,value} | null,
     *     at:number }
     * `pct` is REMAINING (Codex displays remaining %, e.g. "100%").
     * `resetAt` is whatever Codex shows verbatim (typically "HH:MM",
     * or "Wed, HH:MM" for weekly API data).
     */
    // Quota values are account-scoped and must come from the current
    // `/wham/usage` response. Do not render a previous snapshot at startup.
    let snapshot = null;
    let mounted = null; // HTMLElement currently rendered in the sidebar
    let directUsageAvailable = false;
    let directUsageInFlight = false;
    let directUsageLastAttemptAt = 0;
    let directUsageFailureLogged = false;
    let directUsageSuccessLogged = false;
    let usageBridgeReadyLogged = false;
    let usageBridgeScriptInjected = false;
    let bridgeRequestSeq = 0;
    let disposed = false;
    let lastMountedMode = null;
    let accountMode = "unknown"; // "official" | "api" | "unknown"
    let accountModeInFlight = false;
    let accountModeLastCheckedAt = 0;
    let accountModeLogged = false;
    let accountModeCandidate = "unknown";
    let accountModeCandidateCount = 0;
    let accountModeCandidateAt = 0;

    const log = (...a) => api.log.info("[usage]", ...a);
    const ASIDE_SELECTOR = [
      "aside.pointer-events-auto.relative.flex.overflow-hidden",
      "aside.pointer-events-auto.relative.flex.overflow-visible",
      "aside.pointer-events-auto.relative.flex",
    ].join(", ");
    const SIDEBAR_CANDIDATE_SELECTOR = [
      ASIDE_SELECTOR,
      "aside",
      "nav",
      "[role='navigation']",
      "[data-testid*='sidebar' i]",
      "[data-test*='sidebar' i]",
      "[class*='sidebar' i]",
    ].join(", ");

    // ── parsing ────────────────────────────────────────────────────────
    const isVisibleElement = (node) => {
      if (!(node instanceof HTMLElement) || !node.isConnected) return false;
      if (node.closest("[hidden], [inert], [aria-hidden='true']")) return false;
      const style = window.getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const applySnapshot = (partial, source) => {
      if (disposed) return false;
      if (
        !partial?.fiveHour &&
        !partial?.weekly &&
        !Object.prototype.hasOwnProperty.call(partial || {}, "points")
      ) {
        return false;
      }
      const next = {
        fiveHour: partial.fiveHour || snapshot?.fiveHour || null,
        weekly: partial.weekly || snapshot?.weekly || null,
        points: Object.prototype.hasOwnProperty.call(partial, "points")
          ? partial.points
          : snapshot?.points || null,
        at: Date.now(),
      };
      const changed =
        JSON.stringify(next.fiveHour) !== JSON.stringify(snapshot?.fiveHour) ||
        JSON.stringify(next.weekly) !== JSON.stringify(snapshot?.weekly) ||
        JSON.stringify(next.points) !== JSON.stringify(snapshot?.points);
      snapshot = next;
      writeSnapshot(api, snapshot);
      if (changed) {
        log(`parsed snapshot from ${source}`, snapshot);
        ensureMounted();
      }
      return changed;
    };

    const ensureUsageBridgeScript = () => {
      if (usageBridgeScriptInjected) return;
      usageBridgeScriptInjected = true;
      window.addEventListener(
        "codexpp-usage-bridge-ready",
        (event) => {
          if (usageBridgeReadyLogged) return;
          usageBridgeReadyLogged = true;
          api.log.info("[usage] bridge ready", event.detail);
        },
        { once: true },
      );
      const script = document.createElement("script");
      script.dataset.codexppUsageBridge = "true";
      script.textContent = `(() => {
        if (window.__codexppUsageBridgeInstalled) return;
        window.__codexppUsageBridgeInstalled = true;
        const pending = new Set();
        window.dispatchEvent(new CustomEvent("codexpp-usage-bridge-ready", {
          detail: {
            hasElectronBridge: typeof window.electronBridge?.sendMessageFromView === "function",
          },
        }));
        const onRequest = (event) => {
          const message = event.detail;
          if (!message || typeof message !== "object" || !message.requestId) return;
          pending.add(message.requestId);
          let forwarded = false;
          const bridge = window.electronBridge;
          if (typeof bridge?.sendMessageFromView === "function") {
            forwarded = true;
            bridge.sendMessageFromView(message).catch(() => {});
          }
          const forwardedEvent = new CustomEvent("codex-message-from-view", {
            detail: message,
          });
          if (forwarded) forwardedEvent.__codexForwardedViaBridge = true;
          window.dispatchEvent(forwardedEvent);
        };
        const onMessage = (event) => {
          const data = event.data;
          if (
            !data ||
            typeof data !== "object" ||
            data.type !== "fetch-response" ||
            !pending.has(data.requestId)
          ) {
            return;
          }
          pending.delete(data.requestId);
          window.dispatchEvent(new CustomEvent("codexpp-usage-response", {
            detail: data,
          }));
          window.postMessage({
            type: "codexpp-usage-response",
            detail: data,
          }, "*");
        };
        const stop = () => {
          window.removeEventListener("codexpp-usage-request", onRequest);
          window.removeEventListener("message", onMessage);
          window.__codexppUsageBridgeInstalled = false;
        };
        window.addEventListener("codexpp-usage-request", onRequest);
        window.addEventListener("message", onMessage);
        window.addEventListener("codexpp-usage-bridge-stop", stop, { once: true });
      })();`;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    };

    const dispatchCodexViewMessage = (message) => {
      const bridge = window.electronBridge;
      if (typeof bridge?.sendMessageFromView === "function") {
        bridge.sendMessageFromView(message).catch((e) => {
          if (!directUsageFailureLogged) {
            directUsageFailureLogged = true;
            api.log.warn("[usage] bridge send failed", e);
          }
        });
        return;
      }
      ensureUsageBridgeScript();
      window.dispatchEvent(
        new CustomEvent("codexpp-usage-request", { detail: message }),
      );
    };

    const fetchCodexAppServerJson = async (url, timeoutMs = 10_000) => {
      try {
        return await api.ipc.invoke("usage-fetch", url);
      } catch {
        // Older runtimes or a failed main-webview probe fall through to the
        // renderer bridge attempt below.
      }

      const hostId =
        new URL(window.location.href).searchParams.get("hostId")?.trim() ||
        "local";
      const requestId = `codexpp-usage-${Date.now()}-${++bridgeRequestSeq}`;

      return new Promise((resolve, reject) => {
        let done = false;
        const cleanup = () => {
          done = true;
          window.removeEventListener("message", onMessage);
          window.removeEventListener("codexpp-usage-response", onBridgeResponse);
          window.clearTimeout(timer);
        };
        const finish = (fn, value) => {
          if (done) return;
          cleanup();
          fn(value);
        };
        const onMessage = (event) => {
          const data =
            event.data?.type === "codexpp-usage-response"
              ? event.data.detail
              : event.data;
          handleResponse(data);
        };
        const onBridgeResponse = (event) => {
          handleResponse(event.detail);
        };
        const handleResponse = (data) => {
          if (
            !data ||
            typeof data !== "object" ||
            data.type !== "fetch-response" ||
            data.requestId !== requestId
          ) {
            return;
          }
          if (data.responseType === "success") {
            try {
              const body = JSON.parse(data.bodyJsonString);
              if (data.status >= 200 && data.status < 300) {
                finish(resolve, body);
              } else {
                finish(reject, new Error(`HTTP ${data.status}`));
              }
            } catch (e) {
              finish(reject, e);
            }
          } else {
            finish(reject, new Error(data.error || "fetch failed"));
          }
        };
        const timer = window.setTimeout(() => {
          dispatchCodexViewMessage({ type: "cancel-fetch", requestId });
          finish(reject, new Error("usage request timed out"));
        }, timeoutMs);
        window.addEventListener("message", onMessage);
        window.addEventListener("codexpp-usage-response", onBridgeResponse);
        dispatchCodexViewMessage({
          type: "fetch",
          hostId,
          requestId,
          method: "GET",
          url,
        });
      });
    };

    const bridgePostJson = async (path, payload = {}, timeoutMs = 2_500) => {
      const bridge = window.__codexSessionDeleteBridge;
      if (disposed || typeof bridge !== "function") return null;
      let timeout = 0;
      try {
        return await Promise.race([
          bridge(path, payload),
          new Promise((resolve) => {
            timeout = window.setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
      } finally {
        if (timeout) window.clearTimeout(timeout);
      }
    };

    const activeRelayProfile = (settings) => {
      if (!settings || typeof settings !== "object") return null;
      const profiles = Array.isArray(settings.relayProfiles) ? settings.relayProfiles : [];
      const activeId =
        typeof settings.activeRelayId === "string" && settings.activeRelayId.trim()
          ? settings.activeRelayId
          : "default";
      return profiles.find((profile) => profile?.id === activeId) || profiles[0] || null;
    };

    const fieldValue = (object, ...keys) => {
      if (!object || typeof object !== "object") return undefined;
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
      }
      return undefined;
    };

    const catalogLooksLikeApiMode = (catalog) => {
      if (!catalog || typeof catalog !== "object") return false;
      const provider = String(catalog.model_provider || catalog.provider_name || "").toLowerCase();
      if (!provider) return false;
      return !["openai", "chatgpt"].includes(provider);
    };

    const refreshAccountMode = async (force = false) => {
      if (accountModeInFlight) return accountMode;
      const now = Date.now();
      if (!force && accountModeLastCheckedAt && now - accountModeLastCheckedAt < 10_000) {
        return accountMode;
      }
      accountModeLastCheckedAt = now;
      accountModeInFlight = true;
      try {
        let nextMode = "unknown";
        let explicitMode = false;
        const settings = await bridgePostJson("/settings/get", {});
        if (disposed) return accountMode;
        const profile = activeRelayProfile(settings);
        const relayMode = fieldValue(profile, "relayMode", "relay_mode");
        const officialMixApiKey = !!fieldValue(profile, "officialMixApiKey", "official_mix_api_key");
        const legacyApiConfigured = !!(
          String(fieldValue(settings, "relayApiKey", "relay_api_key") || "").trim() ||
          String(fieldValue(settings, "relayBaseUrl", "relay_base_url") || "").trim()
        );
        if (relayMode === "official" && !officialMixApiKey) {
          nextMode = "official";
          explicitMode = true;
        } else if (relayMode === "pureApi" || relayMode === "pure_api") {
          nextMode = "api";
          explicitMode = true;
        } else if (relayMode === "mixedApi" || relayMode === "mixed_api" || officialMixApiKey) {
          nextMode = "api";
          explicitMode = true;
        } else if (!relayMode && legacyApiConfigured) {
          nextMode = "api";
          explicitMode = true;
        }

        if (nextMode === "unknown") {
          const catalog = await bridgePostJson("/codex-model-catalog", {});
          if (disposed) return accountMode;
          if (catalogLooksLikeApiMode(catalog)) nextMode = "api";
          else if (catalog?.model_provider === "openai" || catalog?.provider_name === "openai") {
            nextMode = "official";
          }
        }
        if (nextMode === "unknown") return accountMode;

        // Catalog responses can briefly reflect the previous provider while
        // Codex is switching accounts. Require two matching non-explicit
        // observations before changing the visible mode.
        if (nextMode === accountMode) {
          accountModeCandidate = "unknown";
          accountModeCandidateCount = 0;
          accountModeCandidateAt = 0;
          return accountMode;
        }
        if (accountMode !== "unknown" || !explicitMode) {
          if (
            accountModeCandidate === nextMode &&
            now - accountModeCandidateAt < 45_000
          ) {
            accountModeCandidateCount += 1;
          } else {
            accountModeCandidate = nextMode;
            accountModeCandidateCount = 1;
            accountModeCandidateAt = now;
          }
          if (accountModeCandidateCount < 2) return accountMode;
        }

        accountModeCandidate = "unknown";
        accountModeCandidateCount = 0;
        accountModeCandidateAt = 0;
        accountMode = nextMode;
        if (accountMode === "api") {
          snapshot = {
            fiveHour: { label: "API", pct: null, resetAt: null, apiMode: true },
            weekly: null,
            at: Date.now(),
            apiMode: true,
          };
        } else {
          // Keep the last stable value visible while the official snapshot
          // refreshes. Clearing here caused the control to flash "—".
          directUsageAvailable = false;
          directUsageLastAttemptAt = 0;
        }
        ensureMounted(true);
        if (!accountModeLogged) {
          accountModeLogged = true;
          log("account mode", accountMode);
        }
        return accountMode;
      } catch (e) {
        return accountMode;
      } finally {
        accountModeInFlight = false;
      }
    };

    const remainingPercent = (usedPercent) => {
      const used = Number(usedPercent);
      if (!Number.isFinite(used)) return null;
      return Math.round(Math.min(Math.max(100 - used, 0), 100));
    };

    const formatResetAt = (epochSeconds, includeDay = false) => {
      const seconds = Number(epochSeconds);
      if (!Number.isFinite(seconds)) return null;
      const date = new Date(seconds * 1000);
      if (!Number.isFinite(date.getTime())) return null;
      return date.toLocaleTimeString(undefined, {
        ...(includeDay ? { weekday: "short" } : {}),
        hour: "numeric",
        minute: "2-digit",
      });
    };

    const normalizeUsageWindow = (window, label) => {
      if (!window || typeof window !== "object") return null;
      const pct = remainingPercent(window.used_percent);
      if (pct == null) return null;
      const minutes = Number(window.limit_window_seconds) / 60;
      const includeResetDay = Number.isFinite(minutes) && minutes >= 1440;
      return {
        label,
        pct,
        resetAt: formatResetAt(window.reset_at, includeResetDay),
      };
    };

    const pointValue = (value) => {
      if (value == null) return null;
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value).trim();
        return text || null;
      }
      if (typeof value !== "object") return null;
      if (value.unlimited === true) return "无限";
      for (const key of [
        "balance",
        "remaining",
        "available",
        "amount",
        "points",
        "credits",
        "value",
      ]) {
        const result = pointValue(value[key]);
        if (result != null) return result;
      }
      return null;
    };

    const normalizePoints = (status) => {
      if (!status || typeof status !== "object") return null;
      const candidates = [
        status.points,
        status.point_balance,
        status.pointBalance,
        status.credits,
        status.credit,
        status.account?.points,
        status.account?.credits,
      ];
      for (const candidate of candidates) {
        const value = pointValue(candidate);
        if (value != null) return { label: "Credit", value, kind: "points" };
      }
      return null;
    };

    const pickClosestWindow = (windows, targetMinutes, predicate) => {
      let best = null;
      let bestDistance = Infinity;
      for (const window of windows) {
        const minutes = Number(window?.limit_window_seconds) / 60;
        if (!Number.isFinite(minutes) || !predicate(minutes)) continue;
        const distance = Math.abs(minutes - targetMinutes);
        if (
          !best ||
          distance < bestDistance ||
          (distance === bestDistance &&
            minutes > Number(best.limit_window_seconds) / 60)
        ) {
          best = window;
          bestDistance = distance;
        }
      }
      return best;
    };

    const snapshotFromUsageStatus = (status) => {
      const limits = [];
      const pushLimit = (rateLimit) => {
        if (!rateLimit || typeof rateLimit !== "object") return;
        if (rateLimit.primary_window) limits.push(rateLimit.primary_window);
        if (rateLimit.secondary_window) limits.push(rateLimit.secondary_window);
      };

      // `additional_rate_limits` are model/product-specific (such as
      // GPT-5.3 Codex) and must not replace the main account quota.
      pushLimit(status?.rate_limit);

      const five = pickClosestWindow(
        limits,
        300,
        (minutes) => minutes > 0 && minutes < 1440,
      );
      const weekly = pickClosestWindow(
        limits,
        7 * 24 * 60,
        (minutes) => minutes >= 1440,
      );

      return {
        fiveHour: normalizeUsageWindow(five, "5h"),
        weekly: normalizeUsageWindow(weekly, "Weekly"),
        points: normalizePoints(status),
      };
    };

    const collectUsageWindows = (value, out = [], seen = new WeakSet()) => {
      if (!value || typeof value !== "object") return out;
      if (seen.has(value)) return out;
      seen.add(value);
      if (
        "used_percent" in value &&
        "limit_window_seconds" in value &&
        "reset_at" in value
      ) {
        out.push(value);
      }
      if (Array.isArray(value)) {
        for (const item of value) collectUsageWindows(item, out, seen);
      } else {
        for (const item of Object.values(value)) {
          collectUsageWindows(item, out, seen);
        }
      }
      return out;
    };

    const snapshotFromUsageWindows = (windows) => {
      const five = pickClosestWindow(
        windows,
        300,
        (minutes) => minutes > 0 && minutes < 1440,
      );
      const weekly = pickClosestWindow(
        windows,
        7 * 24 * 60,
        (minutes) => minutes >= 1440,
      );
      return {
        fiveHour: normalizeUsageWindow(five, "5h"),
        weekly: normalizeUsageWindow(weekly, "Weekly"),
      };
    };

    const refreshUsageFromApi = async () => {
      if (disposed) return false;
      if ((await refreshAccountMode()) === "api" || disposed) return false;
      if (directUsageInFlight) return false;
      const now = Date.now();
      if (directUsageLastAttemptAt && now - directUsageLastAttemptAt < 15_000) {
        return false;
      }
      directUsageLastAttemptAt = now;
      directUsageInFlight = true;
      try {
        const status = await fetchCodexAppServerJson("/wham/usage");
        if (disposed) return false;
        const partial = snapshotFromUsageStatus(status);
        if (partial.fiveHour || partial.weekly) {
          directUsageAvailable = true;
          directUsageFailureLogged = false;
          if (!directUsageSuccessLogged) {
            directUsageSuccessLogged = true;
            log("api active", partial);
          }
          applySnapshot(partial, "api");
          return true;
        }
        return false;
      } catch (e) {
        if (!directUsageFailureLogged) {
          directUsageFailureLogged = true;
          api.log.warn("[usage] /wham/usage unavailable; falling back to DOM", e);
        }
        return false;
      } finally {
        directUsageInFlight = false;
      }
    };

    /**
     * Codex's expanded breakdown is a 2-column CSS grid: label in col-1,
     * value in col-2. We locate the grid by its unique class signature,
     * then walk children pairwise.
     *
     * Returns the breakdown grid element, or null.
     */
    const findBreakdownGrid = () => {
      // The full class string is long and may shift; we anchor on the
      // distinctive `grid-cols-[minmax(0,1fr)_auto]` token.
      const grids = document.querySelectorAll(
        'div[class*="grid-cols-[minmax(0,1fr)_auto]"]',
      );
      for (const g of grids) {
        if (!isVisibleElement(g)) continue;
        const txt = (g.textContent || "").toLowerCase();
        if (
          (txt.includes("5h") || txt.includes("hourly")) &&
          txt.includes("week")
        )
          return g;
      }
      return null;
    };

    /**
     * Parse a value span (e.g. "100%·16:19") into `{ pct, resetAt }`.
     * Falls back to `null` fields when a piece is missing.
     */
    const parseValueText = (txt, root) => {
      const pctMatch = txt.match(/(\d{1,3})\s*%/);
      const pct = pctMatch ? Math.max(0, Math.min(100, +pctMatch[1])) : null;
      // Prefer the inner [title="HH:MM"] attribute, else regex the text.
      const titled = root?.querySelector?.("[title]");
      let resetAt = titled ? titled.getAttribute("title") : null;
      if (!resetAt) {
        const tMatch =
          txt.match(/\b(\d{1,2}:\d{2})\b/) ||
          txt.match(/\b(\d+\s*(?:m|h|d))\b/i);
        resetAt = tMatch ? tMatch[1] : null;
      }
      return { pct, resetAt };
    };

    const parseValue = (span) => {
      const txt = (span.textContent || "").replace(/\s+/g, " ").trim();
      return parseValueText(txt, span);
    };

    const scanBreakdown = (grid) => {
      const kids = Array.from(grid.children);
      let five = null;
      let week = null;
      // Pair (label, value) — col-1 then col-2 in DOM order.
      for (let i = 0; i + 1 < kids.length; i += 2) {
        const labelTxt = (kids[i].textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const value = parseValue(kids[i + 1]);
        const lower = labelTxt.toLowerCase();
        if (!five && (lower === "5h" || lower.startsWith("hourly"))) {
          five = { label: labelTxt, ...value };
        } else if (!week && lower.startsWith("week")) {
          week = { label: labelTxt, ...value };
        }
      }
      if (!five && !week) return false;
      applySnapshot({ fiveHour: five, weekly: week }, "breakdown");
      return true;
    };

    const parseCompactUsageNode = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      if (node.closest('[data-codexpp="usage-box"]')) return null;
      if (!isVisibleElement(node)) return null;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 160 || !/%/.test(text)) return null;
      const lower = text.toLowerCase();
      const hasFive = /\b(5h|5\s*hour|hourly)\b/.test(lower);
      const hasWeek = /\b(weekly|week)\b/.test(lower);
      if (!hasFive && !hasWeek) return null;

      const value = parseValueText(text, node);
      if (value.pct == null) return null;
      const label = hasFive && !hasWeek ? "5h" : hasWeek && !hasFive ? "Weekly" : null;
      if (!label) return null;
      return label === "5h"
        ? { fiveHour: { label, ...value } }
        : { weekly: { label, ...value } };
    };

    const scanCompactUsage = () => {
      const candidates = document.querySelectorAll(
        'button, [role="button"], [role="status"], [aria-label], [title], span',
      );
      for (const node of candidates) {
        const partial = parseCompactUsageNode(node);
        if (partial) applySnapshot(partial, "compact");
      }
    };

    // ── sidebar mount ─────────────────────────────────────────────────
    /**
     * Find the sidebar slot for the upgrade pill. The pill itself is
     * hidden by `hide-upgrade-prompts`, so we mount as a sibling that
     * replaces its visual footprint. We anchor on the parent of any
     * button/link with text "Upgrade" (case-insensitive), or fall back
     * to the bottom of the sidebar group.
     *
     * Returns the parent element to mount into, or null if not found.
     */
    const compactSidebarText = (node) =>
      (node?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

    const looksLikeSettingsSidebar = (sidebar) => {
      if (!(sidebar instanceof HTMLElement)) return false;
      if (
        sidebar.matches(".window-fx-sidebar-surface.w-token-sidebar") ||
        sidebar.closest(".window-fx-sidebar-surface.w-token-sidebar")
      ) {
        return true;
      }
      const text = compactSidebarText(sidebar);
      const englishSettings =
        text.includes("general") &&
        text.includes("appearance") &&
        (text.includes("account") || text.includes("configuration"));
      const chineseSettings =
        text.includes("常规") &&
        text.includes("外观") &&
        (
          text.includes("配置") ||
          text.includes("个性化") ||
          text.includes("键盘快捷键") ||
          text.includes("mcp 服务器") ||
          text.includes("钩子") ||
          text.includes("连接") ||
          text.includes("环境") ||
          text.includes("工作树") ||
          text.includes("已归档")
        );
      return englishSettings || chineseSettings;
    };

    const looksLikeMainAppSidebar = (sidebar) => {
      const text = compactSidebarText(sidebar);
      const hasNewChat = /\bnew chat\b|\bquick chat\b|新建|新对话/.test(text);
      const hasSearch = /\bsearch\b|搜索/.test(text);
      const hasProjectOrHistory =
        /\bprojects?\b|\bhistory\b|\bchats?\b|项目|历史|会话/.test(text);
      return (hasNewChat && hasSearch) || (hasSearch && hasProjectOrHistory);
    };

    const quickControlText = (node) =>
      [
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const isSidebarGeometry = (node) => {
      if (!(node instanceof HTMLElement) || !isVisibleElement(node)) return false;
      const rect = node.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      return (
        rect.width >= 180 &&
        rect.width <= Math.min(520, Math.max(320, viewportWidth * 0.55)) &&
        rect.height >= Math.max(360, viewportHeight * 0.45) &&
        rect.left <= Math.max(96, viewportWidth * 0.12) &&
        rect.top <= Math.max(96, viewportHeight * 0.18)
      );
    };

    const hasBottomControl = (sidebar) => {
      const sidebarRect = sidebar.getBoundingClientRect();
      const controls = Array.from(sidebar.querySelectorAll('button, a, [role="button"], [role="status"], [aria-live], span, div'));
      return controls.some((control) => {
        if (!(control instanceof HTMLElement) || !isVisibleElement(control)) return false;
        const rect = control.getBoundingClientRect();
        const text = quickControlText(control);
        const nearBottom = rect.bottom >= sidebarRect.bottom - 260;
        const compact = rect.width > 0 && rect.width <= 64 && rect.height > 0 && rect.height <= 64;
        const downloadStatus = text.length <= 80 && /\bdownloading\b|\bdownload\b|\bupdating\b|\binstalling\b|正在下载|下载中|更新中|正在更新|安装中/.test(text);
        return nearBottom && (compact || downloadStatus || /\bmobile\b|\bphone\b|\bdevice\b|\bsettings?\b|手机|移动|设备|连接|设置/.test(text));
      });
    };

    const addSidebarAncestorsForBottomControls = (candidates) => {
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const controls = Array.from(document.querySelectorAll('button, a, [role="button"], [role="status"], [aria-live], span, div'));
      for (const control of controls) {
        if (!(control instanceof HTMLElement) || !isVisibleElement(control)) continue;
        const rect = control.getBoundingClientRect();
        if (rect.left > 560 || rect.bottom < viewportHeight - 280) continue;
        const text = quickControlText(control);
        const compact = rect.width > 0 && rect.width <= 64 && rect.height > 0 && rect.height <= 64;
        const downloadStatus = text.length <= 80 && /\bdownloading\b|\bdownload\b|\bupdating\b|\binstalling\b|正在下载|下载中|更新中|正在更新|安装中/.test(text);
        if (!compact && !downloadStatus && !/\bmobile\b|\bphone\b|\bdevice\b|\bsettings?\b|手机|移动|设备|连接|设置/.test(text)) continue;
        let node = control.parentElement;
        while (node && node !== document.body) {
          if (isSidebarGeometry(node) && !looksLikeSettingsSidebar(node)) candidates.add(node);
          node = node.parentElement;
        }
      }
    };

    const sidebarScore = (sidebar) => {
      if (!isSidebarGeometry(sidebar) || looksLikeSettingsSidebar(sidebar)) return -Infinity;
      const rect = sidebar.getBoundingClientRect();
      let score = 0;
      if (rect.left <= 16) score += 4;
      else if (rect.left <= 80) score += 2;
      if (rect.width >= 220 && rect.width <= 420) score += 3;
      if (rect.height >= (window.innerHeight || 0) * 0.75) score += 3;
      if (looksLikeMainAppSidebar(sidebar)) score += 6;
      if (hasBottomControl(sidebar)) score += 5;
      if (/^(aside|nav)$/i.test(sidebar.tagName) || sidebar.getAttribute("role") === "navigation") score += 2;
      return score;
    };

    const findUsageSidebar = () => {
      const primarySidebar = Array.from(document.querySelectorAll(ASIDE_SELECTOR))
        .find((sidebar) => {
          if (!(sidebar instanceof HTMLElement) || !isVisibleElement(sidebar)) return false;
          if (looksLikeSettingsSidebar(sidebar)) return false;
          const rect = sidebar.getBoundingClientRect();
          return rect.width >= 150 && rect.height >= 300;
        });
      if (primarySidebar instanceof HTMLElement) return primarySidebar;
      const candidates = new Set(
        Array.from(document.querySelectorAll(SIDEBAR_CANDIDATE_SELECTOR))
          .filter((node) => node instanceof HTMLElement),
      );
      addSidebarAncestorsForBottomControls(candidates);
      return Array.from(candidates)
        .map((sidebar) => ({ sidebar, score: sidebarScore(sidebar) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.sidebar.getBoundingClientRect().left - b.sidebar.getBoundingClientRect().left)[0]?.sidebar || null;
    };

    const controlText = (node) =>
      [
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const controlLabelText = (node) =>
      [node.getAttribute?.("aria-label"), node.getAttribute?.("title")]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const isDeviceButton = (button) => {
      const label = controlLabelText(button);
      if (/\bmobile\b|\bphone\b|\bdevice\b|手机|移动|设备|连接/.test(label)) return true;
      const text = controlText(button);
      return text.length <= 28 && /\bmobile\b|\bphone\b|\bdevice\b|手机|移动|设备|连接/.test(text);
    };

    const isDownloadStatusNode = (node) => {
      const text = controlText(node);
      if (!text || text.length > 80) return false;
      return /\bdownloading\b|\bdownload\b|\bupdating\b|\binstalling\b|正在下载|下载中|更新中|正在更新|安装中/.test(text);
    };

    const isSettingsButton = (button) => {
      const text = controlText(button);
      return /\bsettings?\b|preferences?|设置|偏好/.test(text);
    };

    const isProfileButton = (button) => {
      const text = controlText(button);
      return /\bprofile\b|\baccount\b|个人资料|账户|账号/.test(text);
    };

    const isBottomUtilityButton = (button) => {
      const text = controlText(button);
      return /\bvoice\b|\bhelp\b|语音|帮助/.test(text);
    };

    const isNearSidebarBottom = (sidebar, node) => {
      if (!(sidebar instanceof HTMLElement) || !(node instanceof HTMLElement)) return false;
      const sidebarRect = sidebar.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      const bottomBand = Math.min(Math.max(sidebarRect.height * 0.22, 120), 240);
      const visibleBottom = Math.min(
        sidebarRect.bottom,
        window.innerHeight || document.documentElement.clientHeight || sidebarRect.bottom,
      );
      return (
        rect.top < visibleBottom &&
        rect.bottom <= visibleBottom + 8 &&
        rect.bottom >= visibleBottom - bottomBand
      );
    };

    const isUsageControlNode = (node) =>
      node.closest?.('[data-codexpp="usage-slot"], [data-codexpp="usage-box"], [data-codexpp="usage-boxes"]');

    const isSidebarContentRow = (node) => Boolean(
      node?.closest?.(
        '[data-app-action-sidebar-thread-row], ' +
        '[data-app-action-sidebar-project-row], ' +
        '[data-app-action-sidebar-project-list-id], ' +
        '[role="listitem"]',
      ),
    );

    const isBottomToolbarRow = (sidebar, row) => {
      if (
        !(sidebar instanceof HTMLElement) ||
        !(row instanceof HTMLElement) ||
        isSidebarContentRow(row)
      ) {
        return false;
      }
      const sidebarRect = sidebar.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const style = window.getComputedStyle(row);
      if (
        style.display !== "flex" ||
        rect.width < sidebarRect.width * 0.75 ||
        rect.height < 36 ||
        rect.height > 80 ||
        rect.bottom < sidebarRect.bottom - 20 ||
        rect.bottom > sidebarRect.bottom + 8
      ) {
        return false;
      }
      const controls = Array.from(row.querySelectorAll('button, a, [role="button"]'))
        .filter((control) => control instanceof HTMLElement && !isUsageControlNode(control));
      return controls.some(isProfileButton) && controls.some(isBottomUtilityButton);
    };

    const nearestBottomToolbar = (sidebar, control) => {
      let row = control;
      while (row && row !== document.body && row !== sidebar.parentElement) {
        if (isBottomToolbarRow(sidebar, row)) return row;
        row = row.parentElement;
      }
      return null;
    };

    const nearestControlRow = (sidebar, button) => {
      if (isSidebarContentRow(button)) return null;
      const sidebarRect = sidebar.getBoundingClientRect();
      let row = button.parentElement;
      while (row && row !== document.body && row !== sidebar.parentElement) {
        if (!(row instanceof HTMLElement)) break;
        if (isSidebarContentRow(row)) return null;
        const rect = row.getBoundingClientRect();
        const style = window.getComputedStyle(row);
        const buttonCount = row.querySelectorAll('button, a, [role="button"]').length;
        const insideSidebar =
          rect.left >= sidebarRect.left - 8 &&
          rect.right <= sidebarRect.right + 8;
        const nearBottom = isNearSidebarBottom(sidebar, row);
        const looksLikeControlLayer =
          insideSidebar &&
          nearBottom &&
          rect.height > 0 &&
          rect.height <= 128 &&
          (style.display === "flex" || style.display === "grid" || buttonCount >= 2);
        if (looksLikeControlLayer) return row;
        row = row.parentElement;
      }
      return null;
    };

    const nearestBottomStatusRow = (sidebar, node) => {
      const sidebarRect = sidebar.getBoundingClientRect();
      let row = node.parentElement;
      while (row && row !== document.body && row !== sidebar.parentElement) {
        if (!(row instanceof HTMLElement)) break;
        const rect = row.getBoundingClientRect();
        const style = window.getComputedStyle(row);
        const insideSidebar =
          rect.left >= sidebarRect.left - 8 &&
          rect.right <= sidebarRect.right + 8;
        const nearBottom = isNearSidebarBottom(sidebar, row);
        const compactStatusLayer =
          insideSidebar &&
          nearBottom &&
          rect.height > 0 &&
          rect.height <= 96 &&
          (style.display === "flex" || style.display === "grid" || isDownloadStatusNode(row));
        if (compactStatusLayer) return row;
        row = row.parentElement;
      }
      return null;
    };

    const createInlineSlot = (row, anchor, mode = "controls-inline") => {
      const existing = row.querySelector(':scope > [data-codexpp="usage-slot"]');
      if (existing instanceof HTMLElement) return existing;
      const slot = document.createElement("div");
      slot.dataset.codexpp = "usage-slot";
      slot.dataset.codexppUsageSlot = mode;
      slot.className = "flex shrink-0 items-center";
      if (anchor?.parentElement === row) {
        row.insertBefore(slot, anchor.nextSibling);
      }
      else row.appendChild(slot);
      return slot;
    };

    const createFallbackSlot = (sidebar) => {
      const existing = sidebar.querySelector(':scope > [data-codexpp="usage-slot"]');
      if (existing instanceof HTMLElement) return existing;
      const slot = document.createElement("div");
      slot.dataset.codexpp = "usage-slot";
      slot.dataset.codexppUsageSlot = "sidebar-floating-fallback";
      slot.className = "flex items-center";
      slot.style.position = "absolute";
      slot.style.right = "0.75rem";
      slot.style.bottom = "0.75rem";
      slot.style.zIndex = "30";
      sidebar.appendChild(slot);
      return slot;
    };

    const createBottomToolbarSlot = (toolbar) => {
      const existing = toolbar.querySelector(':scope > [data-codexpp="usage-slot"]');
      if (existing instanceof HTMLElement) return existing;
      const slot = document.createElement("div");
      slot.dataset.codexpp = "usage-slot";
      slot.dataset.codexppUsageSlot = "bottom-toolbar-inline";
      slot.className = "flex shrink-0 items-center";
      toolbar.appendChild(slot);
      return slot;
    };

    const isValidUsageSlot = (sidebar, slot) => {
      if (
        !(slot instanceof HTMLElement) ||
        !(slot.parentElement instanceof HTMLElement) ||
        !slot.isConnected ||
        !sidebar.contains(slot)
      ) {
        return false;
      }
      const mode = slot.dataset.codexppUsageSlot;
      if (mode === "sidebar-floating-fallback") {
        return slot.parentElement === sidebar;
      }
      const row = slot.parentElement;
      if (isSidebarContentRow(row) || !isNearSidebarBottom(sidebar, row)) return false;
      if (mode === "bottom-toolbar-inline") return isBottomToolbarRow(sidebar, row);
      if (mode === "status-inline") return isDownloadStatusNode(row);
      if (mode !== "controls-inline") return false;
      return Array.from(row.querySelectorAll('button, a, [role="button"]')).some(
        (control) =>
          control instanceof HTMLElement &&
          !isUsageControlNode(control) &&
          !isSidebarContentRow(control) &&
          (isDeviceButton(control) || isSettingsButton(control)),
      );
    };

    const findSidebarSlot = () => {
      const sidebar = findUsageSidebar();
      if (!sidebar) return null;
      for (const slot of sidebar.querySelectorAll('[data-codexpp="usage-slot"]')) {
        if (!isValidUsageSlot(sidebar, slot)) slot.remove();
      }
      const existingSlots = Array.from(
        sidebar.querySelectorAll('[data-codexpp="usage-slot"]'),
      ).filter((slot) => isValidUsageSlot(sidebar, slot));
      const existingInline = existingSlots.find((slot) =>
        slot.dataset.codexppUsageSlot === "controls-inline" ||
        slot.dataset.codexppUsageSlot === "status-inline" ||
        slot.dataset.codexppUsageSlot === "bottom-toolbar-inline",
      );
      if (existingInline instanceof HTMLElement) return existingInline;
      const existingFallback = existingSlots.find(
        (slot) => slot.dataset.codexppUsageSlot === "sidebar-floating-fallback",
      );

      const controls = Array.from(sidebar.querySelectorAll('button, a, [role="button"]'))
        .filter((button) =>
          button instanceof HTMLElement &&
          isVisibleElement(button) &&
          isNearSidebarBottom(sidebar, button) &&
          !isUsageControlNode(button) &&
          !isSidebarContentRow(button),
        );
      const bottomToolbarControl = controls.find(
        (control) => isProfileButton(control) || isBottomUtilityButton(control),
      );
      const bottomToolbar = bottomToolbarControl
        ? nearestBottomToolbar(sidebar, bottomToolbarControl)
        : null;
      if (bottomToolbar) {
        existingFallback?.remove();
        return createBottomToolbarSlot(bottomToolbar);
      }
      const deviceControls = controls.filter(isDeviceButton);
      const settingsControls = controls.filter(isSettingsButton);
      const preferredControls = deviceControls.length
        ? deviceControls
        : settingsControls;
      const ordered = preferredControls.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.right - ar.right || br.bottom - ar.bottom;
      });

      for (const button of ordered) {
        const row = nearestControlRow(sidebar, button);
        if (row) {
          existingFallback?.remove();
          return createInlineSlot(row, button);
        }
      }

      const statusAnchors = Array.from(
        sidebar.querySelectorAll('[role="status"], [aria-live], [aria-label], [title], span, div'),
      )
        .filter((node) =>
          node instanceof HTMLElement &&
          isVisibleElement(node) &&
          isNearSidebarBottom(sidebar, node) &&
          !isUsageControlNode(node) &&
          isDownloadStatusNode(node),
        )
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.bottom - ar.bottom || br.right - ar.right;
        });

      for (const anchor of statusAnchors) {
        const row = nearestBottomStatusRow(sidebar, anchor);
        if (row) {
          existingFallback?.remove();
          return createInlineSlot(row, anchor, "status-inline");
        }
      }

      if (existingFallback instanceof HTMLElement) return existingFallback;
      return createFallbackSlot(sidebar);
    };

    const displaySnapshot = () =>
      accountMode === "api"
        ? {
            fiveHour: { label: "API", pct: null, resetAt: null, apiMode: true },
            weekly: null,
            points: null,
            at: Date.now(),
            apiMode: true,
          }
        :
      snapshot && (snapshot.fiveHour || snapshot.weekly)
        ? snapshot
        : {
            fiveHour: { label: "5h", pct: null, resetAt: null },
            weekly: { label: "Weekly", pct: null, resetAt: null },
            points: null,
            at: 0,
          };

    const ensureMounted = (forceRebuild = false) => {
      if (disposed) return;
      const visibleSnapshot = displaySnapshot();
      const slot = findSidebarSlot();
      if (!slot) {
        if (mounted) {
          mounted.remove();
          mounted = null;
        }
        for (const stale of document.querySelectorAll(
          '[data-codexpp="usage-box"], [data-codexpp="usage-boxes"]',
        )) {
          stale.remove();
        }
        if (!ensureMounted._warned) {
          log("ensureMounted: no sidebar slot found yet");
          if (typeof reportLifecycle === "function") {
            reportLifecycle("usage-slot-missing", {
              asideCount: document.querySelectorAll("aside").length,
            });
          }
          ensureMounted._warned = true;
        }
        return;
      }

      // Defensive: remove any stale boxes left by a previous mount cycle
      // (hot-reload, stop() race, or an older shape of this tweak that
      // used `data-codexpp="usage-boxes"`).
      for (const stale of document.querySelectorAll(
        '[data-codexpp="usage-box"], [data-codexpp="usage-boxes"]',
      )) {
        if (stale !== mounted) stale.remove();
      }

      if (mounted && slot.contains(mounted) && !forceRebuild) {
        mounted._refresh?.(visibleSnapshot);
        return;
      }
      if (mounted) mounted.remove();
      mounted = renderUsageBox(api, visibleSnapshot);
      mounted.dataset.codexpp = "usage-box";
      slot.appendChild(mounted);
      lastMountedMode = slot.dataset.codexppUsageSlot || "unknown";
      mounted.style.flex = "0 1 auto";
      mounted.style.width = "auto";
      mounted.style.minWidth = "4.75rem";
      mounted.style.maxWidth = "8.5rem";
      if (slot.dataset.codexppUsageSlot === "settings-inline-windows" || slot.dataset.codexppUsageSlot === "controls-inline") {
        mounted.style.width = "auto";
        mounted.style.minWidth = "4.75rem";
      }
      log("mounted usage box", {
        mode: lastMountedMode,
        slotTag: slot.tagName,
        slotClass: slot.className,
      });
      if (typeof reportLifecycle === "function") {
        reportLifecycle("usage-mounted", {
          mode: slot.dataset.codexppUsageSlot || "unknown",
        });
      }
    };

    // Initial render from persisted snapshot (so first paint isn't empty
    // even before the user opens the popover).
    ensureMounted(true);

    // ── observers ─────────────────────────────────────────────────────
    // React can emit hundreds of mutations while restoring the history list.
    // Ignore our own UI and editor churn, then coalesce the rest into one scan.
    let scheduled = false;
    let scheduleTimer = 0;
    const runMutationScan = async () => {
      if (disposed) return;
      const mode = await refreshAccountMode();
      if (disposed) return;
      if (mode !== "api") await refreshUsageFromApi();
      if (disposed) return;
      ensureMounted();
    };
    const onMutate = () => {
      if (scheduled) return;
      scheduled = true;
      scheduleTimer = window.setTimeout(() => {
        scheduleTimer = 0;
        scheduled = false;
        void runMutationScan();
      }, 1000);
    };

    onMutate();
    const IGNORED_MUTATION_SELECTOR =
      "[data-codexpp], [data-codex-composer-root], [data-codex-composer='true'], [contenteditable='true'], textarea, [data-composer-overlay-floating-ui]";
    const obs = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const target = record.target;
        const element = target instanceof Element ? target : target?.parentElement;
        return !(element instanceof Element && element.closest(IGNORED_MUTATION_SELECTOR));
      });
      if (relevant) onMutate();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const interval = window.setInterval(onMutate, 15_000);
    window.addEventListener("focus", onMutate);
    document.addEventListener("visibilitychange", onMutate);

    log("active", { snapshot });

    return () => {
      disposed = true;
      if (usageBridgeScriptInjected) {
        window.dispatchEvent(new CustomEvent("codexpp-usage-bridge-stop"));
      }
      obs.disconnect();
      window.clearInterval(interval);
      if (scheduleTimer) window.clearTimeout(scheduleTimer);
      window.removeEventListener("focus", onMutate);
      document.removeEventListener("visibilitychange", onMutate);
      if (mounted) {
        mounted.remove();
        mounted = null;
      }
      for (const slot of document.querySelectorAll('[data-codexpp="usage-slot"]')) {
        if (slot instanceof HTMLElement && slot.children.length === 0) slot.remove();
      }
      for (const slot of document.querySelectorAll('[data-codexpp="usage-floating-slot"]')) {
        slot.remove();
      }
    };
  },

  /** Hide exhaustion banners and reset prompts without touching conversation content. */
  "hide-usage-alert"() {
    const STYLE_ID = "codex-plus-hide-usage-alert-style";
    const HIDDEN_ATTR = "data-codex-plus-hidden-usage-alert";
    const quotaRe = /(Codex\s*消息限额已用尽|消息限额已用尽|message\s+limit|usage\s+limit|out\s+of\s+Codex\s+messages|额度|限额|quota|rate\s+limit)/i;
    const resetRe = /(额度将于|继续使用\s*Codex|升级至\s*Plus|quota\s+will\s+reset|limit\s+will\s+reset|rate\s+limit\s+resets|reset|重置|upgrade\s+to\s+plus)/i;
    const usageCardRe = /(剩余\s*\d+%\s*使用量|remaining\s+\d+%\s+usage|usage\s+remaining|reset\s+frequency|next\s+reset)/i;
    const actionRe = /(升级|Plus|upgrade|pricing|重置|reset|限额|额度|限制|limit|quota)/i;
    const quotaDialogSelector = [
      "[role='dialog']",
      "[aria-modal='true']",
      "[data-radix-dialog-content]",
      "[data-slot='dialog-content']",
      "[data-testid*='pricing' i]",
    ].join(",");
    const quotaSurfaceSelector = [
      "[role='alert']",
      "[role='status']",
      "[aria-live]",
      quotaDialogSelector,
      "[data-testid*='quota' i]",
      "[data-testid*='usage' i]",
      "[data-test*='quota' i]",
      "[data-test*='usage' i]",
      "[class*='toast' i]",
      "[class*='alert' i]",
      "[class*='banner' i]",
      "[class*='modal' i]",
      "aside:has(h3):has(button)",
    ].join(",");
    const hidden = new Set();
    let observer = null;
    let timer = 0;
    const guestPending = new WeakSet();
    const guestListeners = new Map();

    const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visibleBox = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width >= 160 && rect.height >= 16 && rect.bottom > 0 && rect.top < (window.innerHeight || 900);
    };
    const hasAction = (node, text) => actionRe.test(`${text} ${Array.from(node.querySelectorAll("button, a, [role='button']")).slice(0, 8).map((item) => textOf(item)).join(" ")}`);
    const hasEditable = (node) => Boolean(node.querySelector("input, textarea, [contenteditable='true'], [role='textbox']"));
    const touchesUsageControl = (node) => Boolean(node.closest("[data-codexpp='usage-slot'], [data-codexpp='usage-box'], [data-codexpp='usage-boxes']"));
    const shouldHide = (node) => {
      if (!(node instanceof HTMLElement) || node.closest("[data-message-author-role], article")) return false;
      if (!node.matches(quotaSurfaceSelector)) return false;
      if (!visibleBox(node)) return false;
      if (hasEditable(node) || touchesUsageControl(node)) return false;
      const text = textOf(node);
      if (text.length < 12 || text.length > (node.matches(quotaDialogSelector) ? 4_000 : 500)) return false;
      const rect = node.getBoundingClientRect();
      const bannerLike = rect.width >= 300 && rect.height >= 30 && rect.height <= 240 && quotaRe.test(text) && resetRe.test(text);
      const cardLike = rect.width >= 160 && rect.width <= 560 && rect.height >= 70 && rect.height <= 340 && usageCardRe.test(text) && hasAction(node, text);
      const dialogLike = node.matches(quotaDialogSelector) && quotaRe.test(text) && (resetRe.test(text) || actionRe.test(text));
      return (bannerLike || cardLike || dialogLike) && (hasAction(node, text) || dialogLike);
    };
    const findHideTarget = (node) => {
      if (!node.matches(quotaDialogSelector)) return node;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
      const nodeRect = node.getBoundingClientRect();
      if (nodeRect.width >= viewportWidth * 0.8 && nodeRect.height >= viewportHeight * 0.8) return node;
      let current = node;
      for (let depth = 0; depth < 4; depth += 1) {
        const parent = current.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) break;
        const protectedContent = parent.querySelector("[data-message-author-role], article, input, textarea, [contenteditable='true'], [role='textbox'], [data-codexpp='usage-slot'], [data-codexpp='usage-box']");
        const compactSurface = textOf(parent).length <= 800 && !protectedContent;
        const rect = parent.getBoundingClientRect();
        const position = window.getComputedStyle(parent).position;
        const coversViewport = rect.width >= viewportWidth * 0.8 && rect.height >= viewportHeight * 0.8;
        const portalLike = parent.matches("[data-radix-portal], [data-portal], [class*='portal' i]") || Boolean(parent.querySelector("[data-radix-dialog-overlay], [data-slot='dialog-overlay'], [class*='backdrop' i], [class*='overlay' i]"));
        if (compactSurface && (portalLike || (coversViewport && (position === "fixed" || position === "absolute")))) return parent;
        current = parent;
      }
      return node;
    };
    const scanGuestUsage = () => {
      const STYLE_ID = "codex-plus-hide-usage-alert-style";
      const HIDDEN_ATTR = "data-codex-plus-hidden-usage-alert";
      const STATE_KEY = "__codexPlusUsageAlertGuestState";
      const state = window[STATE_KEY] || { observer: null, timer: 0 };
      window[STATE_KEY] = state;
      const quotaRe = /(Codex\s*消息限额已用尽|消息限额已用尽|message\s+limit|usage\s+limit|out\s+of\s+Codex\s+messages|额度|限额|quota|rate\s+limit)/i;
      const resetRe = /(额度将于|继续使用\s*Codex|升级至\s*Plus|quota\s+will\s+reset|limit\s+will\s+reset|rate\s+limit\s+resets|reset|重置|upgrade\s+to\s+plus)/i;
      const usageCardRe = /(剩余\s*\d+%\s*使用量|remaining\s+\d+%\s+usage|usage\s+remaining|reset\s+frequency|next\s+reset)/i;
      const actionRe = /(升级|Plus|upgrade|pricing|重置|reset|限额|额度|限制|limit|quota)/i;
      const quotaDialogSelector = [
        "[role='dialog']",
        "[aria-modal='true']",
        "[data-radix-dialog-content]",
        "[data-slot='dialog-content']",
        "[data-testid*='pricing' i]",
      ].join(",");
      const quotaSurfaceSelector = [
        "[role='alert']",
        "[role='status']",
        "[aria-live]",
        quotaDialogSelector,
        "[data-testid*='quota' i]",
        "[data-testid*='usage' i]",
        "[data-test*='quota' i]",
        "[data-test*='usage' i]",
        "[class*='toast' i]",
        "[class*='alert' i]",
        "[class*='banner' i]",
        "[class*='modal' i]",
        "aside:has(h3):has(button)",
      ].join(",");
      const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
      const visibleBox = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 160 && rect.height >= 16 && rect.bottom > 0 && rect.top < (window.innerHeight || 900);
      };
      const hasAction = (node, text) => actionRe.test(`${text} ${Array.from(node.querySelectorAll("button, a, [role='button']")).slice(0, 8).map(textOf).join(" ")}`);
      const shouldHide = (node) => {
        if (!(node instanceof HTMLElement) || node.closest("[data-message-author-role], article")) return false;
        if (!node.matches(quotaSurfaceSelector) || !visibleBox(node)) return false;
        if (node.querySelector("input, textarea, [contenteditable='true'], [role='textbox']")) return false;
        const text = textOf(node);
        if (text.length < 12 || text.length > (node.matches(quotaDialogSelector) ? 4_000 : 500)) return false;
        const rect = node.getBoundingClientRect();
        const bannerLike = rect.width >= 300 && rect.height >= 30 && rect.height <= 240 && quotaRe.test(text) && resetRe.test(text);
        const cardLike = rect.width >= 160 && rect.width <= 560 && rect.height >= 70 && rect.height <= 340 && usageCardRe.test(text) && hasAction(node, text);
        const dialogLike = node.matches(quotaDialogSelector) && quotaRe.test(text) && (resetRe.test(text) || actionRe.test(text));
        return (bannerLike || cardLike || dialogLike) && (hasAction(node, text) || dialogLike);
      };
      const findHideTarget = (node) => {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
        const nodeRect = node.getBoundingClientRect();
        if (nodeRect.width >= viewportWidth * 0.8 && nodeRect.height >= viewportHeight * 0.8) return node;
        let current = node;
        for (let depth = 0; depth < 4; depth += 1) {
          const parent = current.parentElement;
          if (!parent || parent === document.body || parent === document.documentElement) break;
          const protectedContent = parent.querySelector("[data-message-author-role], article, input, textarea, [contenteditable='true'], [role='textbox']");
          const compactSurface = textOf(parent).length <= 800 && !protectedContent;
          const rect = parent.getBoundingClientRect();
          const position = window.getComputedStyle(parent).position;
          const coversViewport = rect.width >= viewportWidth * 0.8 && rect.height >= viewportHeight * 0.8;
          const portalLike = parent.matches("[data-radix-portal], [data-portal], [class*='portal' i]") || Boolean(parent.querySelector("[data-radix-dialog-overlay], [data-slot='dialog-overlay'], [class*='backdrop' i], [class*='overlay' i]"));
          if (compactSurface && (portalLike || (coversViewport && (position === "fixed" || position === "absolute")))) return parent;
          current = parent;
        }
        return node;
      };
      if (!document.documentElement) return 0;
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `[${HIDDEN_ATTR}="true"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }`;
        document.documentElement.appendChild(style);
      }
      const scan = () => {
        let hiddenCount = 0;
        for (const node of document.body?.querySelectorAll(quotaSurfaceSelector) || []) {
          if (!node.hasAttribute(HIDDEN_ATTR) && shouldHide(node)) {
            findHideTarget(node).setAttribute(HIDDEN_ATTR, "true");
            hiddenCount += 1;
          }
        }
        return hiddenCount;
      };
      if (!state.observer) {
        state.observer = new MutationObserver(() => {
          if (!state.timer) state.timer = window.setTimeout(() => { state.timer = 0; scan(); }, 80);
        });
        state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      }
      return scan();
    };
    const cleanupGuestUsage = () => {
      const HIDDEN_ATTR = "data-codex-plus-hidden-usage-alert";
      const state = window.__codexPlusUsageAlertGuestState;
      if (state?.timer) window.clearTimeout(state.timer);
      state?.observer?.disconnect();
      delete window.__codexPlusUsageAlertGuestState;
      document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).forEach((node) => node.removeAttribute(HIDDEN_ATTR));
      document.getElementById("codex-plus-hide-usage-alert-style")?.remove();
    };
    const scanGuests = () => {
      for (const guest of document.querySelectorAll("webview")) {
        if (typeof guest.executeJavaScript !== "function" || guestPending.has(guest)) continue;
        guestPending.add(guest);
        try {
          Promise.resolve(guest.executeJavaScript(`(${scanGuestUsage.toString()})()`, true)).catch(() => {}).finally(() => guestPending.delete(guest));
        } catch {
          guestPending.delete(guest);
        }
      }
    };
    const attachGuest = (guest) => {
      if (guestListeners.has(guest)) return;
      const onGuestReady = () => window.setTimeout(scanGuests, 80);
      guest.addEventListener("dom-ready", onGuestReady);
      guest.addEventListener("did-stop-loading", onGuestReady);
      guestListeners.set(guest, onGuestReady);
    };
    const hide = (node) => {
      if (!(node instanceof HTMLElement) || node === document.body || node === document.documentElement) return;
      const target = findHideTarget(node);
      target.setAttribute(HIDDEN_ATTR, "true");
      hidden.add(target);
    };
    const scan = () => {
      timer = 0;
      if (!document.body) return;
      for (const node of document.body.querySelectorAll(quotaSurfaceSelector)) {
        if (!node.hasAttribute(HIDDEN_ATTR) && shouldHide(node)) hide(node);
      }
      for (const guest of document.querySelectorAll("webview")) attachGuest(guest);
      scanGuests();
    };
    const schedule = () => {
      if (!timer) timer = window.setTimeout(scan, 80);
    };
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `[${HIDDEN_ATTR}="true"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }`;
    document.documentElement.appendChild(style);
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scan();

    return () => {
      if (timer) window.clearTimeout(timer);
      observer?.disconnect();
      for (const [guest, listener] of guestListeners) {
        guest.removeEventListener("dom-ready", listener);
        guest.removeEventListener("did-stop-loading", listener);
        if (typeof guest.executeJavaScript === "function") guest.executeJavaScript(`(${cleanupGuestUsage.toString()})()`, true).catch(() => {});
      }
      guestListeners.clear();
      for (const node of hidden) node.removeAttribute(HIDDEN_ATTR);
      style.remove();
      hidden.clear();
    };
  },

  /**
   * Refine the composer slash menu by lightly annotating the live DOM.
   *
   * Live DOM shape captured via Electron CDP:
   *   [data-composer-overlay-floating-ui] > slash panel
   *   slash panel [data-list-navigation-item="true"]
   *   slash panel .sticky.top-0          section headers
   */
  "slash-menu-polish"() {
    const STYLE_ID = "codexpp-slash-menu-polish";
    const MENU_ATTR = "data-codexpp-slash-menu";
    const OVERLAY_ATTR = "data-codexpp-slash-overlay";
    const TOPBAR_ATTR = "data-codexpp-slash-topbar";
    const SECTION_ATTR = "data-codexpp-slash-section";
    const SECTION_EMPTY_ATTR = "data-codexpp-slash-section-empty";
    const SECTION_TITLE_ATTR = "data-codexpp-slash-section-title";
    const SECTION_ICON_ATTR = "data-codexpp-slash-section-icon";
    const INPUT_MODE_ATTR = "data-codexpp-slash-input-mode";
    const PROGRAM_SCROLL_ATTR = "data-codexpp-slash-programmatic-scroll";
    const HOVER_SUPPRESS_ATTR = "data-codexpp-slash-hover-suppressed";
    const OVERLAY_NOISE_ATTR = "data-codexpp-slash-overlay-noise";
    const FAVORITES_GROUP_ATTR = "data-codexpp-slash-favorites";
    const FAVORITE_KEY_ATTR = "data-codexpp-slash-favorite-key";
    const FAVORITE_CLONE_ATTR = "data-codexpp-slash-favorite-clone";
    const FAVORITE_SOURCE_SECTION_ATTR = "data-codexpp-slash-favorite-source-section";
    const FAVORITE_DUPLICATE_HIDDEN_ATTR =
      "data-codexpp-slash-favorite-duplicate-hidden";
    const FAVORITES_STORAGE_KEY = "codexpp.slashMenuFavorites.v1";
    const FAVORITE_BUTTON_CLASS = "codexpp-slash-favorite-button";
    const SKILL_COPY_CLASS = "codexpp-slash-skill-copy";
    document.getElementById(STYLE_ID)?.remove();

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [data-composer-overlay-floating-ui="true"] {
        isolation: isolate;
      }

      [data-composer-overlay-floating-ui="true"][${OVERLAY_ATTR}="true"]
        > :not([${MENU_ATTR}="true"]) {
        display: none !important;
      }

      [data-composer-overlay-floating-ui="true"]
        > [${OVERLAY_NOISE_ATTR}="true"] {
        display: none !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [data-codexpp="nav-group"],
      [data-composer-overlay-floating-ui="true"]
        [data-codexpp="pages-group"],
      [data-composer-overlay-floating-ui="true"]
        [data-codexpp="nav-config"],
      [data-composer-overlay-floating-ui="true"]
        [data-codexpp="nav-tweaks"],
      [data-composer-overlay-floating-ui="true"]
        [data-codexpp^="nav-page-"] {
        display: none !important;
        height: 0 !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        overflow: hidden !important;
        pointer-events: none !important;
      }

      [class*="[container-name:home-main-content]"]
        [data-codexpp="nav-group"],
      [class*="[container-name:home-main-content]"]
        [data-codexpp="pages-group"],
      [class*="[container-name:home-main-content]"]
        [data-codexpp="nav-config"],
      [class*="[container-name:home-main-content]"]
        [data-codexpp="nav-tweaks"],
      [class*="[container-name:home-main-content]"]
        [data-codexpp^="nav-tweak"],
      [class*="[container-name:home-main-content]"]
        [data-codexpp^="nav-page-"] {
        display: none !important;
        height: 0 !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        overflow: hidden !important;
        pointer-events: none !important;
      }

      [data-composer-overlay-floating-ui="true"]
        > [${MENU_ATTR}="true"] {
        width: min(100%, calc(100vw - 1rem)) !important;
        max-width: calc(100vw - 1rem) !important;
        border-color: color-mix(in srgb, currentColor 13%, transparent) !important;
        background-color: var(--color-token-dropdown-background) !important;
        background-color: color-mix(
          in srgb,
          var(--color-token-dropdown-background) 94%,
          var(--color-token-main-surface-primary) 6%
        ) !important;
        box-shadow:
          0 18px 48px rgb(0 0 0 / 0.28),
          0 1px 0 rgb(255 255 255 / 0.06) inset !important;
        padding: 0.375rem !important;
        backdrop-filter: blur(16px) saturate(130%) !important;
        overflow-x: hidden !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .vertical-scroll-fade-mask {
        gap: 0.125rem !important;
        overflow-x: hidden !important;
        overscroll-behavior-x: none !important;
        padding-top: 0.5rem !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .vertical-scroll-fade-mask
        > div:not([${TOPBAR_ATTR}]) {
        display: flex !important;
        flex: 0 0 auto !important;
        flex-direction: column !important;
        height: auto !important;
        min-width: 0 !important;
        max-width: 100% !important;
        overflow-x: hidden !important;
        overflow-y: visible !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .vertical-scroll-fade-mask
        > div[${SECTION_ATTR}]:not(:first-child) {
        border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent) !important;
        margin-top: 0.25rem !important;
        padding-top: 0.25rem !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .vertical-scroll-fade-mask
        > div[${SECTION_EMPTY_ATTR}="true"] {
        display: none !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${TOPBAR_ATTR}="true"] {
        display: flex !important;
        flex: none !important;
        min-width: 0 !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 0.75rem !important;
        margin: -0.375rem -0.375rem 0 !important;
        border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent) !important;
        background-color: var(--color-token-dropdown-background) !important;
        background-image: linear-gradient(
          to bottom,
          color-mix(in srgb, var(--color-token-dropdown-background) 98%, transparent),
          color-mix(in srgb, var(--color-token-dropdown-background) 90%, transparent)
        ) !important;
        padding: 0.375rem 0.5rem 0.375rem 0.625rem !important;
        color: var(--color-token-text-primary) !important;
        backdrop-filter: blur(16px) saturate(130%) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_TITLE_ATTR}] {
        min-width: 0 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        font-size: 0.75rem !important;
        font-weight: 600 !important;
        letter-spacing: 0 !important;
        line-height: 1rem !important;
        text-transform: none !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_TITLE_ATTR}][data-changing="true"] {
        animation: codexpp-slash-title-change 180ms ease !important;
      }

      @keyframes codexpp-slash-title-change {
        0% {
          opacity: 0;
          transform: translateY(0.25rem);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .codexpp-slash-section-icons {
        display: flex !important;
        flex: none !important;
        align-items: center !important;
        gap: 0.125rem !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_ICON_ATTR}] {
        display: inline-flex !important;
        position: relative !important;
        width: 1.5rem !important;
        height: 1.5rem !important;
        flex: none !important;
        align-items: center !important;
        justify-content: center !important;
        border: 0 !important;
        border-radius: 999px !important;
        background: transparent !important;
        color: var(--color-token-text-secondary) !important;
        font-weight: 800 !important;
        opacity: 0.78 !important;
        overflow: hidden !important;
        transition:
          color 140ms ease,
          opacity 140ms ease,
          transform 140ms ease !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_ICON_ATTR}]::before {
        content: "" !important;
        position: absolute !important;
        inset: 0 !important;
        border-radius: inherit !important;
        background: var(--codexpp-section-color, var(--color-token-text-primary)) !important;
        box-shadow: 0 0 0 1px color-mix(in srgb, #fff 24%, transparent) inset !important;
        opacity: 0 !important;
        transform: scale(0.62) !important;
        transition:
          opacity 160ms ease,
          transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_ICON_ATTR}][data-active="true"] {
        color: #fff !important;
        font-weight: 900 !important;
        opacity: 1 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_ICON_ATTR}][data-active="true"]::before {
        opacity: 1 !important;
        transform: scale(1) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_ICON_ATTR}]:hover:not([data-active="true"]) {
        background: color-mix(in srgb, currentColor 8%, transparent) !important;
        opacity: 1 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_ICON_ATTR}][data-active="true"]:hover {
        color: #fff !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_ICON_ATTR}]
        svg {
        position: relative !important;
        z-index: 1 !important;
        width: 0.9375rem !important;
        height: 0.9375rem !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [${SECTION_ICON_ATTR}][data-active="true"]
        svg path {
        stroke-width: 1.8 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][${FAVORITE_DUPLICATE_HIDDEN_ATTR}="true"] {
        display: none !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"] {
        box-sizing: border-box !important;
        position: relative !important;
        width: 100% !important;
        min-height: 1.75rem !important;
        height: 1.75rem !important;
        padding: 0 0.625rem !important;
        color: var(--color-token-text-primary) !important;
        opacity: 0.9 !important;
        max-width: 100% !important;
        min-width: 0 !important;
        overflow-x: hidden !important;
        transition:
          background-color 120ms ease,
          color 120ms ease,
          opacity 120ms ease !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]
        > div {
        min-height: 1.25rem !important;
        gap: 0.625rem !important;
        min-width: 0 !important;
        max-width: 100% !important;
        overflow-x: hidden !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]
        svg {
        width: 1rem !important;
        height: 1rem !important;
        color: var(--color-token-description-foreground) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]:hover,
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]:focus-visible {
        background-color: color-mix(in srgb, currentColor 7%, transparent) !important;
        opacity: 1 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][aria-selected="true"] {
        background-color: color-mix(
          in srgb,
          var(--color-token-text-primary, currentColor) 11%,
          transparent
        ) !important;
        color: var(--color-token-text-primary) !important;
        opacity: 1 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][${FAVORITE_CLONE_ATTR}="true"]:hover,
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][${FAVORITE_CLONE_ATTR}="true"][aria-selected="true"] {
        background-color: color-mix(
          in srgb,
          var(--color-token-text-primary, currentColor) 10%,
          transparent
        ) !important;
        opacity: 1 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][aria-selected="true"]
        svg {
        color: var(--color-token-text-primary) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"][${INPUT_MODE_ATTR}="keyboard"]
        [data-list-navigation-item="true"]:hover:not([aria-selected="true"]) {
        background-color: transparent !important;
        opacity: 0.9 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"][${PROGRAM_SCROLL_ATTR}="true"]
        .vertical-scroll-fade-mask
        [data-list-navigation-item="true"],
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"][${HOVER_SUPPRESS_ATTR}="true"]
        .vertical-scroll-fade-mask
        [data-list-navigation-item="true"] {
        pointer-events: none !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"][${HOVER_SUPPRESS_ATTR}="true"]
        [data-list-navigation-item="true"]:hover:not([aria-selected="true"]),
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"][${HOVER_SUPPRESS_ATTR}="true"]
        [data-list-navigation-item="true"]:focus-visible:not([aria-selected="true"]) {
        background-color: transparent !important;
        opacity: 0.9 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]
        div,
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]
        span {
        min-width: 0 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]
        .text-token-description-foreground,
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]
        span[class*="text-token-description-foreground"] {
        color: var(--color-token-text-secondary) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]
        span.ml-auto {
        max-width: 40% !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent) !important;
        border-radius: 999px !important;
        padding: 0 0.375rem !important;
        font-size: 0.6875rem !important;
        line-height: 1rem !important;
        color: var(--color-token-text-secondary) !important;
        background-color: color-mix(in srgb, currentColor 5%, transparent) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .${FAVORITE_BUTTON_CLASS} {
        display: inline-flex !important;
        width: 1.25rem !important;
        height: 1.25rem !important;
        flex: 0 0 1.25rem !important;
        align-items: center !important;
        justify-content: center !important;
        border: 0 !important;
        border-radius: 999px !important;
        background: transparent !important;
        color: var(--color-token-text-secondary) !important;
        cursor: pointer !important;
        opacity: 0 !important;
        transform: scale(0.92) !important;
        transition:
          color 120ms ease,
          opacity 120ms ease,
          transform 120ms ease !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"]:hover
        .${FAVORITE_BUTTON_CLASS},
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][aria-selected="true"]
        .${FAVORITE_BUTTON_CLASS},
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .${FAVORITE_BUTTON_CLASS}[data-favorite="true"] {
        opacity: 1 !important;
        transform: scale(1) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"][${HOVER_SUPPRESS_ATTR}="true"]
        [data-list-navigation-item="true"]:hover
        .${FAVORITE_BUTTON_CLASS}:not([data-favorite="true"]) {
        opacity: 0 !important;
        transform: scale(0.92) !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .${FAVORITE_BUTTON_CLASS}[data-favorite="true"] {
        color: #f4c95d !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .${FAVORITE_BUTTON_CLASS}:hover {
        color: #ffd76a !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .${FAVORITE_BUTTON_CLASS}
        svg {
        width: 0.875rem !important;
        height: 0.875rem !important;
        color: currentColor !important;
        stroke-width: 2 !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .sticky.top-0 {
        position: static !important;
        height: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
        padding: 0 !important;
        border: 0 !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][${SECTION_ATTR}="skills"],
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][${FAVORITE_SOURCE_SECTION_ATTR}="skills"] {
        height: auto !important;
        min-height: 2.875rem !important;
        padding-top: 0.3125rem !important;
        padding-bottom: 0.3125rem !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][${SECTION_ATTR}="skills"]
        > div,
      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        [data-list-navigation-item="true"][${FAVORITE_SOURCE_SECTION_ATTR}="skills"]
        > div {
        align-items: center !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .${SKILL_COPY_CLASS} {
        display: flex !important;
        min-width: 0 !important;
        flex: 1 1 auto !important;
        flex-direction: column !important;
        gap: 0.0625rem !important;
        overflow: hidden !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .${SKILL_COPY_CLASS}
        > div {
        max-width: 100% !important;
        flex: none !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        line-height: 1rem !important;
      }

      [data-composer-overlay-floating-ui="true"]
        [${MENU_ATTR}="true"]
        .${SKILL_COPY_CLASS}
        > span {
        max-width: 100% !important;
        flex: none !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        color: var(--color-token-text-secondary) !important;
        font-size: 0.75rem !important;
        line-height: 1rem !important;
      }
    `;
    document.head.appendChild(style);

    const scrollHandlers = new Map();
    const pointerHandlers = new Map();
    const hoverGuardHandlers = new Map();
    const wheelHandlers = new Map();
    const hoverScrollStates = new WeakMap();
    const hoverSuppressStates = new WeakMap();
    const scrollAnimations = new Map();
    const titleTimers = new Map();
    const HOVER_GUARD_EVENTS = [
      "pointermove",
      "pointerover",
      "pointerenter",
      "mousemove",
      "mouseover",
      "mouseenter",
    ];
    const NAV_NOISE_SELECTOR = [
      '[data-codexpp="nav-group"]',
      '[data-codexpp="pages-group"]',
      '[data-codexpp="nav-config"]',
      '[data-codexpp="nav-tweaks"]',
      '[data-codexpp^="nav-tweak"]',
      '[data-codexpp^="nav-page-"]',
    ].join(", ");
    const OBSERVER_OPTIONS = {
      characterData: true,
      childList: true,
      subtree: true,
    };
    let scanFrame = 0;
    let scanTimer = 0;
    let homePruneFrame = 0;
    let hardPruneTimer = 0;
    let disposed = false;
    let observer = null;
    let documentHoverGuard = null;
    let slashRowScrollAllowedUntil = 0;
    const nativeScrollIntoView = Element.prototype.scrollIntoView;

    const normText = (node) =>
      String(node?.textContent || "").replace(/\s+/g, " ").trim();

    const isOverlayNoise = (node) => {
      if (node instanceof HTMLElement) {
        const codexpp = node.getAttribute("data-codexpp") || "";
        if (
          codexpp === "nav-group" ||
          codexpp === "pages-group" ||
          codexpp.startsWith("nav-page-") ||
          codexpp === "nav-config" ||
          codexpp === "nav-tweaks"
        ) {
          return true;
        }
      }
      const text = normText(node);
      return (
        /^Codex\+\+\b/.test(text) ||
        /^Tweaks\b/.test(text) ||
        /\bTweak Store\b/.test(text) ||
        /Better TerminalKeyboard ShortcutsDatabase Explorer/.test(text)
      );
    };

    const stopHoverSelectionEvent = (menu, event) => {
      if (!(menu instanceof HTMLElement)) return;
      trackPointerPosition(menu, event);
      if (shouldBlockSuppressedHover(menu, event)) {
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        return;
      }
      freezeHoverScroll(menu);
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };

    const installDocumentHoverGuard = () => {
      if (documentHoverGuard) return;
      documentHoverGuard = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        stopHoverSelectionEvent(target.closest(`[${MENU_ATTR}="true"]`), event);
      };
      HOVER_GUARD_EVENTS.forEach((type) =>
        window.addEventListener(type, documentHoverGuard, true),
      );
      HOVER_GUARD_EVENTS.forEach((type) =>
        document.addEventListener(type, documentHoverGuard, true),
      );
    };

    const allowSlashRowScrollIntoView = (duration = 220) => {
      slashRowScrollAllowedUntil = Math.max(
        slashRowScrollAllowedUntil,
        performance.now() + duration,
      );
    };

    const isSlashMenuRow = (node) =>
      node instanceof HTMLElement &&
      node.matches('[data-list-navigation-item="true"]') &&
      !!node.closest(`[${MENU_ATTR}="true"]`);

    const hoverSuppressStateFor = (menu) => {
      let state = hoverSuppressStates.get(menu);
      if (!state) {
        state = {
          active: false,
          pointerX: null,
          pointerY: null,
          releaseAfter: 0,
        };
        hoverSuppressStates.set(menu, state);
      }
      return state;
    };

    const eventPointerPosition = (event) => {
      if (!event || typeof event.clientX !== "number" || typeof event.clientY !== "number") {
        return null;
      }
      return { x: event.clientX, y: event.clientY };
    };

    const trackPointerPosition = (menu, event) => {
      const point = eventPointerPosition(event);
      if (!point) return;
      const state = hoverSuppressStateFor(menu);
      if (!state.active) {
        state.pointerX = point.x;
        state.pointerY = point.y;
      }
    };

    const clearHoverSelection = (menu) => {
      const state = hoverSuppressStateFor(menu);
      const pointerTarget =
        typeof state.pointerX === "number" && typeof state.pointerY === "number"
          ? document.elementFromPoint(state.pointerX, state.pointerY)
          : null;
      const rows = new Set(
        Array.from(menu.querySelectorAll('[data-list-navigation-item="true"]:hover')),
      );
      const pointerRow = pointerTarget?.closest?.('[data-list-navigation-item="true"]');
      if (pointerRow instanceof HTMLElement && menu.contains(pointerRow)) {
        rows.add(pointerRow);
      }
      menu
        .querySelectorAll('[data-list-navigation-item="true"][aria-selected="true"]')
        .forEach((row) => {
          if (!(row instanceof HTMLElement)) return;
          rows.add(row);
          const rect = row.getBoundingClientRect();
          if (
            typeof state.pointerX === "number" &&
            typeof state.pointerY === "number" &&
            state.pointerX >= rect.left &&
            state.pointerX <= rect.right &&
            state.pointerY >= rect.top &&
            state.pointerY <= rect.bottom
          ) {
            rows.add(row);
          }
        });
      rows.forEach((row) => {
        if (!(row instanceof HTMLElement)) return;
        row.setAttribute("aria-selected", "false");
        row.blur();
      });
    };

    const suppressHoverUntilPointerMoves = (menu, duration = 900) => {
      if (!(menu instanceof HTMLElement)) return;
      const state = hoverSuppressStateFor(menu);
      state.active = true;
      state.releaseAfter = performance.now() + duration;
      menu.setAttribute(HOVER_SUPPRESS_ATTR, "true");
      clearHoverSelection(menu);
      [0, 80, 240].forEach((delay) => {
        window.setTimeout(() => {
          if (menu.hasAttribute(HOVER_SUPPRESS_ATTR)) clearHoverSelection(menu);
        }, delay);
      });
    };

    const clearHoverSuppression = (menu) => {
      if (!(menu instanceof HTMLElement)) return;
      const state = hoverSuppressStateFor(menu);
      state.active = false;
      state.releaseAfter = 0;
      menu.removeAttribute(HOVER_SUPPRESS_ATTR);
      if (!menu.hasAttribute(PROGRAM_SCROLL_ATTR)) {
        menu.setAttribute(INPUT_MODE_ATTR, "pointer");
      }
    };

    const shouldBlockSuppressedHover = (menu, event) => {
      const state = hoverSuppressStateFor(menu);
      if (!state.active) return false;
      const point = eventPointerPosition(event);
      const now = performance.now();
      const scroller = menu.querySelector(".vertical-scroll-fade-mask");
      const programmatic =
        menu.hasAttribute(PROGRAM_SCROLL_ATTR) ||
        (scroller instanceof HTMLElement &&
          typeof hoverScrollStateFor(scroller).programmaticTarget === "number" &&
          now < hoverScrollStateFor(scroller).programmaticUntil);

      if (!point) return true;
      if (state.pointerX === null || state.pointerY === null) {
        if (!programmatic && now >= state.releaseAfter - 450) {
          clearHoverSuppression(menu);
          state.pointerX = point.x;
          state.pointerY = point.y;
          return false;
        }
        state.pointerX = point.x;
        state.pointerY = point.y;
        return true;
      }
      const moved = Math.hypot(point.x - state.pointerX, point.y - state.pointerY);
      if (moved >= 5 && !programmatic && now >= state.releaseAfter - 450) {
        clearHoverSuppression(menu);
        state.pointerX = point.x;
        state.pointerY = point.y;
        return false;
      }
      return true;
    };

    const hoverScrollStateFor = (scroller) => {
      let state = hoverScrollStates.get(scroller);
      if (!state) {
        state = {
          freezeTop: scroller.scrollTop,
          freezeUntil: 0,
          lastTop: scroller.scrollTop,
          programmaticTarget: null,
          programmaticUntil: 0,
          restoreFrame: 0,
        };
        hoverScrollStates.set(scroller, state);
      }
      return state;
    };

    const enforceHoverScrollFreeze = (scroller) => {
      const state = hoverScrollStateFor(scroller);
      const now = performance.now();
      const currentTop = scroller.scrollTop;
      const programmaticActive =
        typeof state.programmaticTarget === "number" && now < state.programmaticUntil;
      const programmaticDown = programmaticActive && state.programmaticTarget >= state.lastTop;

      if (now <= state.freezeUntil && (!programmaticActive || programmaticDown)) {
        if (currentTop < state.freezeTop - 1) {
          scroller.scrollTop = state.freezeTop;
          state.lastTop = state.freezeTop;
          return true;
        }
        state.freezeTop = Math.max(state.freezeTop, currentTop);
      }

      state.lastTop = scroller.scrollTop;
      return false;
    };

    const requestHoverScrollFreezeFrame = (scroller) => {
      const state = hoverScrollStateFor(scroller);
      if (state.restoreFrame) return;
      const tick = () => {
        state.restoreFrame = 0;
        enforceHoverScrollFreeze(scroller);
        if (performance.now() <= state.freezeUntil) {
          state.restoreFrame = requestAnimationFrame(tick);
        }
      };
      state.restoreFrame = requestAnimationFrame(tick);
    };

    const queueHoverScrollFreezeChecks = (scroller) => {
      [0, 16, 80, 180, 360].forEach((delay) => {
        window.setTimeout(() => enforceHoverScrollFreeze(scroller), delay);
      });
    };

    const freezeHoverScroll = (menu) => {
      const scroller = menu.querySelector(".vertical-scroll-fade-mask");
      if (!(scroller instanceof HTMLElement)) return;
      const state = hoverScrollStateFor(scroller);
      const now = performance.now();
      if (
        typeof state.programmaticTarget === "number" &&
        now < state.programmaticUntil &&
        state.programmaticTarget < scroller.scrollTop - 1
      ) {
        state.freezeUntil = 0;
        state.freezeTop = scroller.scrollTop;
        state.lastTop = scroller.scrollTop;
        return;
      }
      const stableTop = Math.max(state.lastTop, scroller.scrollTop);
      state.freezeTop = Math.max(state.freezeTop, stableTop);
      state.freezeUntil = Math.max(state.freezeUntil, now + 450);
      requestHoverScrollFreezeFrame(scroller);
      queueHoverScrollFreezeChecks(scroller);
    };

    const clearHoverScrollFreeze = (scroller) => {
      const state = hoverScrollStateFor(scroller);
      state.freezeUntil = 0;
      state.freezeTop = scroller.scrollTop;
      state.lastTop = scroller.scrollTop;
    };

    const allowProgrammaticScroll = (scroller, targetTop, duration = 900) => {
      const state = hoverScrollStateFor(scroller);
      if (targetTop < scroller.scrollTop - 1) {
        state.freezeUntil = 0;
        state.freezeTop = targetTop;
      }
      state.programmaticTarget = targetTop;
      state.programmaticUntil = performance.now() + duration;
    };

    const patchedScrollIntoView = function (...args) {
      if (isSlashMenuRow(this) && performance.now() > slashRowScrollAllowedUntil) {
        return;
      }
      return nativeScrollIntoView.apply(this, args);
    };

    const looksLikeSlashPanel = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (node.hasAttribute(MENU_ATTR)) return true;
      if (/^No commands$/i.test(normText(node))) return true;
      const scroller = node.querySelector(".vertical-scroll-fade-mask");
      return (
        scroller instanceof HTMLElement &&
        node.querySelector('[data-list-navigation-item="true"]')
      );
    };

    const isOverlaySlashActive = (overlay) =>
      isSlashQueryActive() ||
      Array.from(overlay.children).some((child) => looksLikeSlashPanel(child));

    const markOverlayNoise = (overlay) => {
      const active = isOverlaySlashActive(overlay);
      Array.from(overlay.children).forEach((child) => {
        if (!(child instanceof HTMLElement)) return;
        if (active && !looksLikeSlashPanel(child) && isOverlayNoise(child)) {
          child.setAttribute(OVERLAY_NOISE_ATTR, "true");
        } else {
          child.removeAttribute(OVERLAY_NOISE_ATTR);
        }
      });
    };

    const pruneOverlayNoise = (overlay) => {
      if (!isOverlaySlashActive(overlay)) return;
      Array.from(overlay.children).forEach((child) => {
        if (!(child instanceof HTMLElement)) return;
        if (looksLikeSlashPanel(child) || !isOverlayNoise(child)) return;
        child.remove();
      });
    };

    const pruneMenuNoise = (menu) => {
      menu.querySelectorAll(NAV_NOISE_SELECTOR).forEach((node) => node.remove());
    };

    const pruneHomeContentNoise = () => {
      document
        .querySelectorAll(
          [
            '[class*="[container-name:home-main-content]"] [data-codexpp="nav-group"]',
            '[class*="[container-name:home-main-content]"] [data-codexpp="pages-group"]',
            '[class*="[container-name:home-main-content]"] [data-codexpp="nav-config"]',
            '[class*="[container-name:home-main-content]"] [data-codexpp="nav-tweaks"]',
            '[class*="[container-name:home-main-content]"] [data-codexpp^="nav-tweak"]',
            '[class*="[container-name:home-main-content]"] [data-codexpp^="nav-page-"]',
          ].join(", "),
        )
        .forEach((node) => node.remove());
    };

    const shouldPruneHomeContentNoise = () =>
      isSlashQueryActive() ||
      !!document.querySelector(
        '[data-composer-overlay-floating-ui="true"], [data-codexpp-slash-menu="true"]',
      );

    const scheduleHomeContentPrune = () => {
      if (homePruneFrame) return;
      homePruneFrame = requestAnimationFrame(() => {
        homePruneFrame = 0;
        if (shouldPruneHomeContentNoise()) pruneHomeContentNoise();
      });
    };

    const hardPruneNoise = () => {
      try {
        pruneHomeContentNoise();
        document
          .querySelectorAll(`[${MENU_ATTR}="true"]`)
          .forEach((menu) => {
            if (menu instanceof HTMLElement) pruneMenuNoise(menu);
          });
      } catch {
        // Ignore transient DOM shapes while Codex is replacing the slash panel.
      }
    };

    const scheduleHardPruneNoise = () => {
      if (hardPruneTimer || disposed) return;
      hardPruneTimer = window.setTimeout(() => {
        hardPruneTimer = 0;
        if (disposed || !shouldPruneHomeContentNoise()) return;
        observer?.disconnect();
        hardPruneNoise();
        requestAnimationFrame(() => {
          if (!disposed) {
            observer?.observe(document.body, OBSERVER_OPTIONS);
            scheduleScan();
          }
        });
      }, 60);
    };

    const sectionKey = (title) =>
      String(title || "General")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/gi, "")
        .toLowerCase() || "general";

    const sectionColor = (key, index) => {
      const known = {
        favorites: "#f4c95d",
        general: "#8ab4ff",
        skills: "#7dd3a8",
        mcp: "#f0b86a",
        tools: "#c4a7ff",
      };
      return known[key] || ["#8ab4ff", "#7dd3a8", "#f0b86a", "#c4a7ff"][index % 4];
    };

    const sectionIconSvg = (key) => {
      if (key === "favorites") {
        return (
          '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
          '<path d="m10 2.75 2.14 4.35 4.8.7-3.47 3.38.82 4.77L10 13.7l-4.29 2.25.82-4.77L3.06 7.8l4.8-.7L10 2.75Z" fill="currentColor"/>' +
          "</svg>"
        );
      }
      if (key === "skills") {
        return (
          '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
          '<path d="M10 2.25 16.5 6v8L10 17.75 3.5 14V6L10 2.25Zm0 1.5L5.1 6.58 10 9.42l4.9-2.84L10 3.75Zm-5.2 4v5.5l4.55 2.62v-5.5L4.8 7.75Zm10.4 0-4.55 2.62v5.5l4.55-2.62v-5.5Z" fill="currentColor"/>' +
          "</svg>"
        );
      }
      return (
        '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<path d="M4.25 5.25h11.5M4.25 10h11.5M4.25 14.75h11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
        "</svg>"
      );
    };

    const starIconSvg = (filled) =>
      filled
        ? '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 2.75 2.14 4.35 4.8.7-3.47 3.38.82 4.77L10 13.7l-4.29 2.25.82-4.77L3.06 7.8l4.8-.7L10 2.75Z" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 3.5 1.85 3.75 4.14.6-3 2.92.71 4.12L10 12.94l-3.7 1.95.71-4.12-3-2.92 4.14-.6L10 3.5Z" stroke="currentColor" stroke-linejoin="round"/></svg>';

    const readFavorites = () => {
      try {
        const raw = window.localStorage?.getItem(FAVORITES_STORAGE_KEY);
        const values = JSON.parse(raw || "[]");
        return new Set(Array.isArray(values) ? values.filter(Boolean) : []);
      } catch {
        return new Set();
      }
    };

    const writeFavorites = (favorites) => {
      try {
        window.localStorage?.setItem(
          FAVORITES_STORAGE_KEY,
          JSON.stringify(Array.from(favorites).sort()),
        );
      } catch {
        // Ignore storage failures; the row controls still update for this render.
      }
    };

    const rowFavoriteKey = (button, fallbackSectionKey) => {
      const section = fallbackSectionKey || button.getAttribute(SECTION_ATTR) || "general";
      const text = normText(button)
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return text ? `${section}:${text}` : "";
    };

    const isSlashSearchActive = () =>
      Array.from(document.querySelectorAll('.ProseMirror[contenteditable="true"]')).some(
        (editor) => {
          if (!(editor instanceof HTMLElement)) return false;
          const text = normText(editor);
          return text.startsWith("/") && text.length > 1;
        },
      );

    const refreshFavoriteViews = () => {
      document
        .querySelectorAll(`[${MENU_ATTR}="true"] .vertical-scroll-fade-mask`)
        .forEach((scroller) => {
          if (!(scroller instanceof HTMLElement)) return;
          syncFavoriteControls(scroller);
          syncFavoritesSection(scroller);
          const sections = groupSections(scroller);
          const topbar = scroller.previousElementSibling;
          if (topbar instanceof HTMLElement) renderTopbarIcons(topbar, sections);
          updateTopbar(scroller, sections);
        });
    };

    const toggleFavorite = (key) => {
      if (!key) return;
      const favorites = readFavorites();
      if (favorites.has(key)) favorites.delete(key);
      else favorites.add(key);
      writeFavorites(favorites);
      refreshFavoriteViews();
      scheduleScan();
    };

    const stripNativeCommandState = (row) => {
      if (!(row instanceof HTMLElement)) return;
      const stripNode = (node) => {
        if (!(node instanceof HTMLElement)) return;
        node.removeAttribute(FAVORITE_DUPLICATE_HIDDEN_ATTR);
        for (const attr of Array.from(node.attributes)) {
          if (
            attr.name === "cmdk-item" ||
            attr.name === "data-value" ||
            (attr.name.startsWith("data-codexpp-") &&
              !attr.name.startsWith("data-codexpp-slash-"))
          ) {
            node.removeAttribute(attr.name);
          }
        }
      };
      stripNode(row);
      row.querySelectorAll("*").forEach(stripNode);
    };

    const ensureFavoriteControl = (button, key, favorites = readFavorites()) => {
      if (!key) return;
      button.setAttribute(FAVORITE_KEY_ATTR, key);
      const inner = button.firstElementChild instanceof HTMLElement ? button.firstElementChild : button;
      let control = button.querySelector(`:scope .${FAVORITE_BUTTON_CLASS}`);
      if (!(control instanceof HTMLElement)) {
        control = document.createElement("span");
        control.setAttribute("role", "button");
        control.setAttribute("tabindex", "-1");
        control.className = FAVORITE_BUTTON_CLASS;
        control.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        control.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        control.addEventListener("pointerup", (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleFavorite(button.getAttribute(FAVORITE_KEY_ATTR) || key);
        });
        control.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        const shortcut = inner.querySelector("span.ml-auto");
        if (shortcut instanceof HTMLElement) inner.insertBefore(control, shortcut);
        else inner.appendChild(control);
      }
      const active = favorites.has(key);
      control.dataset.favorite = active ? "true" : "false";
      control.setAttribute("aria-label", active ? "Remove from favorites" : "Add to favorites");
      control.innerHTML = starIconSvg(active);
    };

    const unwrapSkillRow = (button) => {
      const copy = button.querySelector(`.${SKILL_COPY_CLASS}`);
      if (!copy || !copy.parentElement) return;
      while (copy.firstChild) copy.parentElement.insertBefore(copy.firstChild, copy);
      copy.remove();
    };

    const wrapSkillRow = (button) => {
      const inner = button.firstElementChild;
      if (!(inner instanceof HTMLElement)) return;
      if (inner.querySelector(`.${SKILL_COPY_CLASS}`)) return;
      const children = Array.from(inner.children);
      const title = children.find(
        (node) =>
          node instanceof HTMLElement &&
          node.tagName === "DIV" &&
          normText(node).length > 0,
      );
      const description = children.find(
        (node) =>
          node instanceof HTMLElement &&
          node.tagName === "SPAN" &&
          String(node.className).includes("text-token-description-foreground"),
      );
      if (!title || !description) return;
      const copy = document.createElement("div");
      copy.className = SKILL_COPY_CLASS;
      inner.insertBefore(copy, title);
      copy.appendChild(title);
      copy.appendChild(description);
    };

    const sourceCommandRows = (scroller) =>
      Array.from(scroller.querySelectorAll('[data-list-navigation-item="true"]')).filter(
        (row) =>
          row instanceof HTMLElement &&
          !row.closest(`[${FAVORITES_GROUP_ATTR}="true"]`) &&
          !row.hasAttribute(FAVORITE_CLONE_ATTR),
      );

    const syncSectionVisibility = (scroller) => {
      Array.from(scroller.children).forEach((group) => {
        if (!(group instanceof HTMLElement) || group.hasAttribute(TOPBAR_ATTR)) return;
        const rows = Array.from(
          group.querySelectorAll('[data-list-navigation-item="true"]'),
        ).filter((row) => row instanceof HTMLElement);
        const hasVisibleRows = rows.some(
          (row) => !row.hasAttribute(FAVORITE_DUPLICATE_HIDDEN_ATTR),
        );
        group.setAttribute(SECTION_EMPTY_ATTR, hasVisibleRows ? "false" : "true");
      });
    };

    const syncFavoriteSourceVisibility = (scroller, favoriteKeys = new Set()) => {
      const hideDuplicates = isSlashSearchActive() && favoriteKeys.size > 0;
      let hiddenSelectedKey = "";
      sourceCommandRows(scroller).forEach((row) => {
        const key = row.getAttribute(FAVORITE_KEY_ATTR) || rowFavoriteKey(row);
        if (hideDuplicates && key && favoriteKeys.has(key)) {
          if (row.getAttribute("aria-selected") === "true") hiddenSelectedKey = key;
          row.setAttribute(FAVORITE_DUPLICATE_HIDDEN_ATTR, "true");
        } else {
          row.removeAttribute(FAVORITE_DUPLICATE_HIDDEN_ATTR);
        }
      });
      syncSectionVisibility(scroller);
      if (!hiddenSelectedKey) return;
      const favorite = favoriteRows(scroller).find(
        (row) => row.getAttribute(FAVORITE_KEY_ATTR) === hiddenSelectedKey,
      );
      if (favorite instanceof HTMLElement) selectNavigationRow(scroller, favorite);
    };

    const syncFavoriteControls = (scroller) => {
      const favorites = readFavorites();
      sourceCommandRows(scroller).forEach((row) => {
        const key = row.getAttribute(FAVORITE_KEY_ATTR) || rowFavoriteKey(row);
        ensureFavoriteControl(row, key, favorites);
      });
      scroller
        .querySelectorAll(`[${FAVORITE_CLONE_ATTR}="true"]`)
        .forEach((row) => {
          if (!(row instanceof HTMLElement)) return;
          stripNativeCommandState(row);
          const key = row.getAttribute(FAVORITE_KEY_ATTR) || rowFavoriteKey(row, "favorites");
          ensureFavoriteControl(row, key, favorites);
        });
    };

    const removeFavoriteSection = (scroller) => {
      scroller
        .querySelectorAll(`:scope > [${FAVORITES_GROUP_ATTR}="true"]`)
        .forEach((group) => group.remove());
      syncFavoriteSourceVisibility(scroller);
      syncSectionVisibility(scroller);
      delete scroller.dataset.codexppSlashFavoriteSelectionReady;
      delete scroller.dataset.codexppSlashFavoriteSelectionTouched;
    };

    const syncFavoritesSection = (scroller) => {
      const favorites = readFavorites();
      const rowsByKey = new Map();
      sourceCommandRows(scroller).forEach((row) => {
        const key = row.getAttribute(FAVORITE_KEY_ATTR) || rowFavoriteKey(row);
        if (key && favorites.has(key) && !rowsByKey.has(key)) rowsByKey.set(key, row);
      });
      const entries = Array.from(rowsByKey.entries());
      if (entries.length === 0) {
        removeFavoriteSection(scroller);
        return;
      }
      const entryKeys = new Set(entries.map(([key]) => key));
      syncFavoriteSourceVisibility(scroller, entryKeys);

      let group = scroller.querySelector(`:scope > [${FAVORITES_GROUP_ATTR}="true"]`);
      if (!(group instanceof HTMLElement)) {
        group = document.createElement("div");
        group.setAttribute(FAVORITES_GROUP_ATTR, "true");
        scroller.insertBefore(group, scroller.firstElementChild);
      } else if (group !== scroller.firstElementChild) {
        scroller.insertBefore(group, scroller.firstElementChild);
      }

      const signature = entries.map(([key]) => key).join("|");
      if (group.dataset.signature === signature) return;
      group.dataset.signature = signature;
      delete scroller.dataset.codexppSlashFavoriteSelectionReady;
      delete scroller.dataset.codexppSlashFavoriteSelectionTouched;
      group.replaceChildren();

      const header = document.createElement("div");
      header.className = "sticky top-0";
      header.textContent = "Favorites";
      group.appendChild(header);

      entries.forEach(([key, sourceRow]) => {
        const clone = sourceRow.cloneNode(true);
        if (!(clone instanceof HTMLElement)) return;
        clone.setAttribute(FAVORITE_CLONE_ATTR, "true");
        clone.setAttribute(FAVORITE_KEY_ATTR, key);
        clone.setAttribute(
          FAVORITE_SOURCE_SECTION_ATTR,
          sourceRow.getAttribute(SECTION_ATTR) || "",
        );
        stripNativeCommandState(clone);
        clone.removeAttribute("aria-selected");
        clone.querySelectorAll(`.${FAVORITE_BUTTON_CLASS}`).forEach((node) => node.remove());
        ["pointermove", "mousemove", "mouseover"].forEach((type) => {
          clone.addEventListener(type, (event) => {
            event.stopPropagation();
          });
        });
        clone.addEventListener("click", (event) => {
          if (event.target instanceof HTMLElement && event.target.closest(`.${FAVORITE_BUTTON_CLASS}`)) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          sourceRow.click();
        });
        clone.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          sourceRow.click();
        });
        group.appendChild(clone);
      });
    };

    const navigationRows = (scroller) =>
      Array.from(scroller.querySelectorAll('[data-list-navigation-item="true"]')).filter(
        (row) => row instanceof HTMLElement && row.offsetParent !== null,
      );

    const favoriteRows = (scroller) =>
      Array.from(
        scroller.querySelectorAll(
          `[${FAVORITES_GROUP_ATTR}="true"] [data-list-navigation-item="true"]`,
        ),
      ).filter((row) => row instanceof HTMLElement && row.offsetParent !== null);

    const selectedNavigationRow = (scroller) =>
      navigationRows(scroller).find(
        (row) => row.getAttribute("aria-selected") === "true",
      );

    const reconcileFavoriteSelection = (scroller) => {
      const rows = navigationRows(scroller);
      const selected = rows.filter((row) => row.getAttribute("aria-selected") === "true");
      if (selected.length <= 1) return;
      const favoriteSelected =
        selected.find((row) => row.hasAttribute(FAVORITE_CLONE_ATTR)) || selected[0];
      rows.forEach((row) =>
        row.setAttribute("aria-selected", row === favoriteSelected ? "true" : "false"),
      );
    };

    const selectNavigationRow = (scroller, row, options = {}) => {
      if (!(row instanceof HTMLElement)) return;
      const menu = scroller.closest(`[${MENU_ATTR}="true"]`);
      if (options.inputMode !== false) {
        menu?.setAttribute(INPUT_MODE_ATTR, options.inputMode || "keyboard");
      }
      navigationRows(scroller).forEach((item) =>
        item.setAttribute("aria-selected", item === row ? "true" : "false"),
      );
      allowSlashRowScrollIntoView();
      row.scrollIntoView({ block: "nearest" });
      updateTopbar(scroller);
    };

    const ensureInitialFavoriteSelection = (scroller) => {
      if (scroller.dataset.codexppSlashFavoriteSelectionReady === "true") return;
      if (scroller.closest(`[${MENU_ATTR}="true"]`)?.hasAttribute(HOVER_SUPPRESS_ATTR)) return;
      const firstFavorite = favoriteRows(scroller)[0];
      if (!(firstFavorite instanceof HTMLElement)) return;
      selectNavigationRow(scroller, firstFavorite, { inputMode: false });
      scroller.dataset.codexppSlashFavoriteSelectionReady = "true";
      const keepFavoriteSelected = () => {
        if (!scroller.isConnected) return;
        if (scroller.closest(`[${MENU_ATTR}="true"]`)?.hasAttribute(HOVER_SUPPRESS_ATTR)) return;
        if (scroller.dataset.codexppSlashFavoriteSelectionTouched === "true") return;
        const nextFirstFavorite = favoriteRows(scroller)[0];
        if (!(nextFirstFavorite instanceof HTMLElement)) return;
        if (selectedNavigationRow(scroller) !== nextFirstFavorite) {
          selectNavigationRow(scroller, nextFirstFavorite);
        }
      };
      requestAnimationFrame(keepFavoriteSelected);
      window.setTimeout(keepFavoriteSelected, 80);
    };

    const handleFavoriteNavigationKey = (event, scroller) => {
      const rows = navigationRows(scroller);
      const favs = favoriteRows(scroller);
      if (rows.length === 0 || favs.length === 0) return false;

      if (event.key === "Enter") {
        const selected = selectedNavigationRow(scroller);
        if (!(selected instanceof HTMLElement)) return false;
        scroller.dataset.codexppSlashFavoriteSelectionTouched = "true";
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        selected.click();
        return true;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
      scroller.dataset.codexppSlashFavoriteSelectionTouched = "true";
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const selected = selectedNavigationRow(scroller);
      const currentIndex = selected instanceof HTMLElement ? rows.indexOf(selected) : -1;
      const fallbackIndex = event.key === "ArrowDown" ? 0 : rows.length - 1;
      const nextIndex =
        currentIndex < 0
          ? fallbackIndex
          : event.key === "ArrowDown"
            ? Math.min(rows.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1);
      selectNavigationRow(scroller, rows[nextIndex]);
      return true;
    };

    const cleanupMenu = (menu) => {
      const overlay = menu.closest('[data-composer-overlay-floating-ui="true"]');
      const scroller = menu.querySelector(".vertical-scroll-fade-mask");
      if (scroller instanceof HTMLElement) {
        const scrollHandler = scrollHandlers.get(scroller);
        if (scrollHandler) {
          scroller.removeEventListener("scroll", scrollHandler);
          scrollHandlers.delete(scroller);
        }
        const animation = scrollAnimations.get(scroller);
        if (animation) {
          cancelScrollAnimation(scroller);
        }
        const pointerHandler = pointerHandlers.get(scroller);
        if (pointerHandler) {
          scroller.removeEventListener("pointermove", pointerHandler);
          scroller.removeEventListener("pointerdown", pointerHandler);
          pointerHandlers.delete(scroller);
        }
        const wheelHandler = wheelHandlers.get(scroller);
        if (wheelHandler) {
          scroller.removeEventListener("wheel", wheelHandler);
          wheelHandlers.delete(scroller);
        }
        const hoverGuardHandler = hoverGuardHandlers.get(scroller);
        if (hoverGuardHandler) {
          HOVER_GUARD_EVENTS.forEach((type) =>
            scroller.removeEventListener(type, hoverGuardHandler, true),
          );
          hoverGuardHandlers.delete(scroller);
        }
      }
      if (scroller instanceof HTMLElement) removeFavoriteSection(scroller);
      menu.removeAttribute(MENU_ATTR);
      menu.removeAttribute(INPUT_MODE_ATTR);
      menu.removeAttribute(PROGRAM_SCROLL_ATTR);
      menu.removeAttribute(HOVER_SUPPRESS_ATTR);
      menu.querySelectorAll(`[${TOPBAR_ATTR}]`).forEach((node) => node.remove());
      menu.querySelectorAll(`.${FAVORITE_BUTTON_CLASS}`).forEach((node) => node.remove());
      menu.querySelectorAll(`.${SKILL_COPY_CLASS}`).forEach((copy) => {
        if (!(copy instanceof HTMLElement) || !copy.parentElement) return;
        while (copy.firstChild) copy.parentElement.insertBefore(copy.firstChild, copy);
        copy.remove();
      });
      menu
        .querySelectorAll(
          `[${FAVORITE_KEY_ATTR}], [${FAVORITE_CLONE_ATTR}], [${FAVORITE_SOURCE_SECTION_ATTR}], [${FAVORITE_DUPLICATE_HIDDEN_ATTR}]`,
        )
        .forEach((node) => {
          node.removeAttribute(FAVORITE_KEY_ATTR);
          node.removeAttribute(FAVORITE_CLONE_ATTR);
          node.removeAttribute(FAVORITE_SOURCE_SECTION_ATTR);
          node.removeAttribute(FAVORITE_DUPLICATE_HIDDEN_ATTR);
        });
      menu
        .querySelectorAll(`[${SECTION_ATTR}]`)
        .forEach((node) => {
          node.removeAttribute(SECTION_ATTR);
          node.removeAttribute(SECTION_EMPTY_ATTR);
        });
      if (overlay && !overlay.querySelector(`[${MENU_ATTR}="true"]`)) {
        overlay.removeAttribute(OVERLAY_ATTR);
        markOverlayNoise(overlay);
      }
    };

    const isSlashMenu = (menu) => {
      if (!menu.closest('[data-composer-overlay-floating-ui="true"]')) return false;
      if (isEmptySlashMenu(menu)) return true;
      const scroller = menu.querySelector(".vertical-scroll-fade-mask");
      if (!(scroller instanceof HTMLElement)) return false;
      if (
        isSlashQueryActive() &&
        menu.querySelectorAll('[data-list-navigation-item="true"]').length > 0
      ) {
        return true;
      }
      return Array.from(scroller.children).some((group) => {
        if (!(group instanceof HTMLElement)) return false;
        const rows = group.querySelectorAll('[data-list-navigation-item="true"]');
        if (rows.length < 2) return false;
        const header = group.querySelector(":scope > .sticky.top-0");
        const headerText = normText(header);
        if (!/^Skills\b/i.test(headerText)) return false;
        return Array.from(rows).some((row) =>
          row.querySelector(
            '.text-token-description-foreground, span[class*="text-token-description-foreground"]',
          ),
        );
      });
    };

    const isSlashQueryActive = () =>
      Array.from(document.querySelectorAll('.ProseMirror[contenteditable="true"]')).some(
        (editor) => editor instanceof HTMLElement && normText(editor).startsWith("/"),
      );

    const isEmptySlashMenu = (menu) =>
      isSlashQueryActive() &&
      menu.querySelectorAll('[data-list-navigation-item="true"]').length === 0 &&
      /^No commands$/i.test(normText(menu));

    const buildTopbar = (menu, scroller) => {
      let topbar = menu.querySelector(`:scope > [${TOPBAR_ATTR}="true"]`);
      if (topbar instanceof HTMLElement) return topbar;
      topbar = document.createElement("div");
      topbar.setAttribute(TOPBAR_ATTR, "true");
      topbar.innerHTML =
        `<div ${SECTION_TITLE_ATTR}="true">General</div>` +
        '<div class="codexpp-slash-section-icons"></div>';
      menu.insertBefore(topbar, scroller);
      return topbar;
    };

    const setTopbarTitle = (title, text) => {
      if (!(title instanceof HTMLElement) || title.textContent === text) return;
      title.textContent = text;
      title.setAttribute("data-changing", "true");
      const previousTimer = titleTimers.get(title);
      if (previousTimer) window.clearTimeout(previousTimer);
      const timer = window.setTimeout(() => {
        title.removeAttribute("data-changing");
        titleTimers.delete(title);
      }, 190);
      titleTimers.set(title, timer);
    };

    const groupSections = (scroller) =>
      Array.from(scroller.children)
        .filter(
          (node) =>
            node instanceof HTMLElement &&
            !node.hasAttribute(TOPBAR_ATTR) &&
            node.getAttribute(SECTION_EMPTY_ATTR) !== "true" &&
            node.querySelector('[data-list-navigation-item="true"]'),
        )
        .map((group, index) => {
          const header = group.querySelector(":scope > .sticky.top-0");
          const isFavorites = group.hasAttribute(FAVORITES_GROUP_ATTR);
          const title = isFavorites ? "Favorites" : normText(header) || "General";
          const key = sectionKey(title);
          const color = sectionColor(key, index);
          const favorites = readFavorites();
          group.setAttribute(SECTION_ATTR, key);
          group.dataset.codexppSlashSectionTitle = title;
          group.style.setProperty("--codexpp-section-color", color);
          group.querySelectorAll('[data-list-navigation-item="true"]').forEach((button) => {
            if (!(button instanceof HTMLElement)) return;
            if (button.hasAttribute(FAVORITE_CLONE_ATTR)) stripNativeCommandState(button);
            button.setAttribute(SECTION_ATTR, key);
            button.style.setProperty("--codexpp-section-color", color);
            const visualKey =
              button.getAttribute(FAVORITE_SOURCE_SECTION_ATTR) ||
              button.getAttribute(SECTION_ATTR) ||
              key;
            if (visualKey === "skills") wrapSkillRow(button);
            else unwrapSkillRow(button);
            const favoriteKey =
              button.getAttribute(FAVORITE_KEY_ATTR) || rowFavoriteKey(button, key);
            ensureFavoriteControl(button, favoriteKey, favorites);
          });
          return { group, title, key, color };
        });

    const renderTopbarIcons = (topbar, sections) => {
      const icons = topbar.querySelector(".codexpp-slash-section-icons");
      if (!(icons instanceof HTMLElement)) return;
      const signature = sections.map((s) => `${s.key}:${s.title}`).join("|");
      if (icons.dataset.signature === signature) return;
      icons.dataset.signature = signature;
      icons.replaceChildren();
      for (const section of sections) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute(SECTION_ICON_ATTR, section.key);
        button.setAttribute("aria-label", section.title);
        button.style.setProperty("--codexpp-section-color", section.color);
        button.innerHTML = sectionIconSvg(section.key);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const scroller = topbar.nextElementSibling;
          if (!(scroller instanceof HTMLElement)) return;
          scrollToSection(scroller, section, sections);
          updateTopbar(scroller, sections);
        });
        icons.appendChild(button);
      }
    };

    const scrollToSection = (scroller, section, sections = groupSections(scroller)) => {
      const menu = scroller.closest(`[${MENU_ATTR}="true"]`);
      menu?.setAttribute(INPUT_MODE_ATTR, "keyboard");
      menu?.setAttribute(PROGRAM_SCROLL_ATTR, "true");
      if (menu instanceof HTMLElement) suppressHoverUntilPointerMoves(menu);
      scroller.dataset.codexppSlashFavoriteSelectionTouched = "true";
      scroller.scrollLeft = 0;
      const targetTop = sectionTop(scroller, section.group);
      const adjustedTop =
        sections.indexOf(section) > 0
          ? Math.min(targetTop + 1, scroller.scrollHeight - scroller.clientHeight)
          : targetTop;
      allowProgrammaticScroll(scroller, adjustedTop);
      const topbar = scroller.previousElementSibling;
      if (topbar instanceof HTMLElement) {
        topbar.dataset.forcedActiveSection = section.key;
      }
      updateTopbar(scroller, sections);
      animateScrollTop(
        scroller,
        adjustedTop,
        () => updateTopbar(scroller, sections),
        () => {
          menu?.removeAttribute(PROGRAM_SCROLL_ATTR);
          if (topbar instanceof HTMLElement) delete topbar.dataset.forcedActiveSection;
          updateTopbar(scroller, sections);
        },
      );
      updateTopbar(scroller, sections);
    };

    const sectionTop = (scroller, group) => {
      const target =
        scroller.scrollTop +
        group.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      return Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));
    };

    const cancelScrollAnimation = (scroller) => {
      const animation = scrollAnimations.get(scroller);
      if (!animation) return;
      cancelAnimationFrame(animation.frame);
      window.clearTimeout(animation.timer);
      scrollAnimations.delete(scroller);
    };

    const animateScrollTop = (scroller, targetTop, onStep, onDone) => {
      cancelScrollAnimation(scroller);
      const startTop = scroller.scrollTop;
      const delta = targetTop - startTop;
      if (Math.abs(delta) < 1) {
        scroller.scrollTop = targetTop;
        onStep?.();
        onDone?.();
        return;
      }
      const start = performance.now();
      const duration = 260;
      const scheduleTick = () => {
        const animation = { frame: 0, timer: 0 };
        const run = (now = performance.now()) => {
          if (scrollAnimations.get(scroller) !== animation) return;
          cancelAnimationFrame(animation.frame);
          window.clearTimeout(animation.timer);
          tick(now);
        };
        animation.frame = requestAnimationFrame(run);
        animation.timer = window.setTimeout(() => run(performance.now()), 16);
        scrollAnimations.set(scroller, animation);
      };
      const tick = (now) => {
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        scroller.scrollTop = startTop + delta * eased;
        onStep?.();
        if (progress < 1) {
          scheduleTick();
        } else {
          scrollAnimations.delete(scroller);
          onDone?.();
        }
      };
      scheduleTick();
    };

    const updateTopbar = (scroller, sections = groupSections(scroller)) => {
      const topbar = scroller.previousElementSibling;
      if (!(topbar instanceof HTMLElement) || !topbar.hasAttribute(TOPBAR_ATTR)) return;
      if (!(topbar instanceof HTMLElement) || sections.length === 0) return;
      const threshold = scroller.scrollTop + 4;
      let active = sections[0];
      for (const section of sections) {
        if (sectionTop(scroller, section.group) <= threshold) active = section;
      }
      if (topbar.dataset.forcedActiveSection) {
        active =
          sections.find((section) => section.key === topbar.dataset.forcedActiveSection) ||
          active;
      }
      const title = topbar.querySelector(`[${SECTION_TITLE_ATTR}]`);
      setTopbarTitle(title, active.title);
      topbar.dataset.activeSection = active.key;
      topbar.style.setProperty("--codexpp-section-color", active.color);
      topbar
        .querySelectorAll(`[${SECTION_ICON_ATTR}]`)
        .forEach((button) =>
          button.setAttribute(
            "data-active",
            button.getAttribute(SECTION_ICON_ATTR) === active.key ? "true" : "false",
          ),
        );
    };

    const enhanceMenu = (menu) => {
      if (!isSlashMenu(menu)) {
        cleanupMenu(menu);
        return;
      }
      menu.setAttribute(MENU_ATTR, "true");
      menu.closest('[data-composer-overlay-floating-ui="true"]')?.setAttribute(OVERLAY_ATTR, "true");
      pruneMenuNoise(menu);
      if (isEmptySlashMenu(menu)) {
        menu.querySelectorAll(`[${TOPBAR_ATTR}]`).forEach((node) => node.remove());
        return;
      }
      const scroller = menu.querySelector(".vertical-scroll-fade-mask");
      if (!(scroller instanceof HTMLElement)) {
        menu.querySelectorAll(`[${TOPBAR_ATTR}]`).forEach((node) => node.remove());
        return;
      }
      scroller.scrollLeft = 0;
      const topbar = buildTopbar(menu, scroller);
      groupSections(scroller);
      syncFavoritesSection(scroller);
      const sections = groupSections(scroller);
      renderTopbarIcons(topbar, sections);
      updateTopbar(scroller, sections);
      ensureInitialFavoriteSelection(scroller);
      reconcileFavoriteSelection(scroller);
      if (!scrollHandlers.has(scroller)) {
        const handler = () => {
          enforceHoverScrollFreeze(scroller);
          updateTopbar(scroller);
        };
        scroller.addEventListener("scroll", handler, { passive: true });
        scrollHandlers.set(scroller, handler);
      }
      hoverScrollStateFor(scroller).lastTop = scroller.scrollTop;
      if (!pointerHandlers.has(scroller)) {
        const handler = (event) => {
          if (menu.hasAttribute(PROGRAM_SCROLL_ATTR)) return;
          if (event.type === "pointermove") {
            if (!menu.hasAttribute(HOVER_SUPPRESS_ATTR)) {
              menu.setAttribute(INPUT_MODE_ATTR, "pointer");
            }
            return;
          }
          menu.setAttribute(INPUT_MODE_ATTR, "pointer");
        };
        scroller.addEventListener("pointermove", handler, { passive: true });
        scroller.addEventListener("pointerdown", handler, { passive: true });
        pointerHandlers.set(scroller, handler);
      }
      if (!wheelHandlers.has(scroller)) {
        const handler = () => clearHoverScrollFreeze(scroller);
        scroller.addEventListener("wheel", handler, { passive: true });
        wheelHandlers.set(scroller, handler);
      }
      if (!hoverGuardHandlers.has(scroller)) {
        const handler = (event) => {
          stopHoverSelectionEvent(menu, event);
        };
        HOVER_GUARD_EVENTS.forEach((type) => scroller.addEventListener(type, handler, true));
        hoverGuardHandlers.set(scroller, handler);
      }
    };

    const activeSlashMenu = () =>
      Array.from(document.querySelectorAll(`[${MENU_ATTR}="true"]`)).find(
        (menu) =>
          menu instanceof HTMLElement &&
          menu.isConnected &&
          menu.querySelector(".vertical-scroll-fade-mask"),
      );

    installDocumentHoverGuard();
    Element.prototype.scrollIntoView = patchedScrollIntoView;

    const keyDigit = (event) => {
      const key = String(event.key || "");
      if (/^[1-9]$/.test(key)) return Number(key);
      const code = String(event.code || "");
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(code);
      return match ? Number(match[1]) : 0;
    };

    const onSectionShortcut = (event) => {
      const menu = activeSlashMenu();
      if (!(menu instanceof HTMLElement)) return;
      const scroller = menu.querySelector(".vertical-scroll-fade-mask");
      if (!(scroller instanceof HTMLElement)) return;

      if (handleFavoriteNavigationKey(event, scroller)) return;

      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageDown" ||
        event.key === "PageUp"
      ) {
        allowSlashRowScrollIntoView();
        menu.setAttribute(INPUT_MODE_ATTR, "keyboard");
        return;
      }

      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const digit = keyDigit(event);
      activateSectionByDigit(scroller, digit, event);
    };

    const onSectionShortcutBridge = (event) => {
      const menu = activeSlashMenu();
      if (!(menu instanceof HTMLElement)) return;
      const scroller = menu.querySelector(".vertical-scroll-fade-mask");
      if (!(scroller instanceof HTMLElement)) return;
      activateSectionByDigit(scroller, Number(event.detail?.digit) || 0, event);
    };

    const activateSectionByDigit = (scroller, digit, event) => {
      if (!digit) return;
      const sections = groupSections(scroller);
      const section = sections[digit - 1];
      if (!section) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      scrollToSection(scroller, section, sections);
    };

    const scan = () => {
      scanFrame = 0;
      try {
        pruneHomeContentNoise();
      } catch {
        // Ignore transient DOM shapes while Codex is replacing the slash panel.
      }
      document
        .querySelectorAll('[data-composer-overlay-floating-ui="true"]')
        .forEach((overlay) => {
          if (!(overlay instanceof HTMLElement)) return;
          try {
            pruneOverlayNoise(overlay);
            markOverlayNoise(overlay);
          } catch {
            // Keep the observer alive if Codex swaps the overlay mid-scan.
          }
        });
      document
        .querySelectorAll('[data-composer-overlay-floating-ui="true"] > *')
        .forEach((menu) => {
          if (!(menu instanceof HTMLElement)) return;
          try {
            enhanceMenu(menu);
          } catch {
            // Keep scanning other candidates.
          }
        });
    };

    const scheduleScan = () => {
      if (scanFrame || scanTimer) return;
      const run = () => {
        if (scanFrame) cancelAnimationFrame(scanFrame);
        if (scanTimer) window.clearTimeout(scanTimer);
        scanFrame = 0;
        scanTimer = 0;
        scan();
      };
      scanFrame = requestAnimationFrame(run);
      scanTimer = window.setTimeout(run, 60);
    };

    const scheduleSlashWork = () => {
      scheduleHomeContentPrune();
      scheduleHardPruneNoise();
      scheduleScan();
    };

    scan();
    observer = new MutationObserver(scheduleSlashWork);
    observer.observe(document.body, OBSERVER_OPTIONS);
    document.addEventListener("input", scheduleSlashWork, true);
    document.addEventListener("keyup", scheduleSlashWork, true);
    window.addEventListener("codexpp-slash-section-shortcut", onSectionShortcutBridge);
    window.addEventListener("keydown", onSectionShortcut, true);
    document.addEventListener("keydown", onSectionShortcut, true);
    const activeSlashInterval = window.setInterval(() => {
      if (isSlashQueryActive()) scheduleSlashWork();
    }, 250);

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(activeSlashInterval);
      if (scanFrame) cancelAnimationFrame(scanFrame);
      if (scanTimer) window.clearTimeout(scanTimer);
      if (homePruneFrame) cancelAnimationFrame(homePruneFrame);
      if (hardPruneTimer) window.clearTimeout(hardPruneTimer);
      document.removeEventListener("input", scheduleSlashWork, true);
      document.removeEventListener("keyup", scheduleSlashWork, true);
      window.removeEventListener("codexpp-slash-section-shortcut", onSectionShortcutBridge);
      window.removeEventListener("keydown", onSectionShortcut, true);
      document.removeEventListener("keydown", onSectionShortcut, true);
      for (const [scroller, handler] of scrollHandlers) {
        scroller.removeEventListener("scroll", handler);
      }
      scrollHandlers.clear();
      for (const [scroller, handler] of pointerHandlers) {
        scroller.removeEventListener("pointermove", handler);
        scroller.removeEventListener("pointerdown", handler);
      }
      pointerHandlers.clear();
      for (const [scroller, handler] of wheelHandlers) {
        scroller.removeEventListener("wheel", handler);
      }
      wheelHandlers.clear();
      for (const [scroller, handler] of hoverGuardHandlers) {
        HOVER_GUARD_EVENTS.forEach((type) =>
          scroller.removeEventListener(type, handler, true),
        );
      }
      hoverGuardHandlers.clear();
      if (documentHoverGuard) {
        HOVER_GUARD_EVENTS.forEach((type) =>
          window.removeEventListener(type, documentHoverGuard, true),
        );
        HOVER_GUARD_EVENTS.forEach((type) =>
          document.removeEventListener(type, documentHoverGuard, true),
        );
        documentHoverGuard = null;
      }
      if (Element.prototype.scrollIntoView === patchedScrollIntoView) {
        Element.prototype.scrollIntoView = nativeScrollIntoView;
      }
      for (const animation of scrollAnimations.values()) {
        cancelAnimationFrame(animation.frame);
        window.clearTimeout(animation.timer);
      }
      scrollAnimations.clear();
      for (const timer of titleTimers.values()) window.clearTimeout(timer);
      titleTimers.clear();
      document
        .querySelectorAll(`[${FAVORITES_GROUP_ATTR}]`)
        .forEach((node) => node.remove());
      document.querySelectorAll(`.${FAVORITE_BUTTON_CLASS}`).forEach((node) => node.remove());
      document.querySelectorAll(`.${SKILL_COPY_CLASS}`).forEach((copy) => {
        if (!(copy instanceof HTMLElement) || !copy.parentElement) return;
        while (copy.firstChild) copy.parentElement.insertBefore(copy.firstChild, copy);
        copy.remove();
      });
      document.querySelectorAll(`[${TOPBAR_ATTR}]`).forEach((node) => node.remove());
      document
        .querySelectorAll(`[${MENU_ATTR}]`)
        .forEach((node) => node.removeAttribute(MENU_ATTR));
      document
        .querySelectorAll(`[${INPUT_MODE_ATTR}]`)
        .forEach((node) => node.removeAttribute(INPUT_MODE_ATTR));
      document
        .querySelectorAll(`[${PROGRAM_SCROLL_ATTR}]`)
        .forEach((node) => node.removeAttribute(PROGRAM_SCROLL_ATTR));
      document
        .querySelectorAll(`[${HOVER_SUPPRESS_ATTR}]`)
        .forEach((node) => node.removeAttribute(HOVER_SUPPRESS_ATTR));
      document
        .querySelectorAll(`[${OVERLAY_ATTR}]`)
        .forEach((node) => node.removeAttribute(OVERLAY_ATTR));
      document
        .querySelectorAll(`[${OVERLAY_NOISE_ATTR}]`)
        .forEach((node) => node.removeAttribute(OVERLAY_NOISE_ATTR));
      document
        .querySelectorAll(`[${SECTION_ATTR}]`)
        .forEach((node) => {
          node.removeAttribute(SECTION_ATTR);
          node.removeAttribute(SECTION_EMPTY_ATTR);
        });
      document
        .querySelectorAll(
          `[${FAVORITE_KEY_ATTR}], [${FAVORITE_CLONE_ATTR}], [${FAVORITE_SOURCE_SECTION_ATTR}], [${FAVORITE_DUPLICATE_HIDDEN_ATTR}]`,
        )
        .forEach((node) => {
          node.removeAttribute(FAVORITE_KEY_ATTR);
          node.removeAttribute(FAVORITE_CLONE_ATTR);
          node.removeAttribute(FAVORITE_SOURCE_SECTION_ATTR);
          node.removeAttribute(FAVORITE_DUPLICATE_HIDDEN_ATTR);
        });
      style.remove();
    };
  },

  /**
   * Add subtle grouped backgrounds behind project rows in the main sidebar.
   *
   * Codex's sidebar project rows are `div[role="listitem"]` nodes with
   * class `group/cwd` and an aria-label matching the child folder button.
   * We mark that row directly, then color the folder icon/title and any
   * unread indicator with the row's project theme.
   *
   * We only mark existing nodes and inject token-based CSS. No wrapping,
   * no synthetic click targets, and cleanup restores the original DOM.
   */
  "sidebar-project-backgrounds"(api) {
    const STYLE_ID = "codexpp-sidebar-project-backgrounds";
    const ATTR = "data-codexpp-sidebar-project-backgrounds";
    const COLOR_STORAGE_KEY = PROJECT_COLOR_STORAGE_KEY;
    const NATIVE_COLOR_MENU_ID = "bennett-ui:project-color";
    const ASIDE_SELECTOR = [
      "aside.pointer-events-auto.relative.flex.overflow-hidden",
      "aside.pointer-events-auto.relative.flex.overflow-visible",
      "aside.pointer-events-auto.relative.flex",
    ].join(", ");
    const SIDEBAR_CANDIDATE_SELECTOR = [
      ASIDE_SELECTOR,
      "aside",
      "nav",
      "[role='navigation']",
      "[data-testid*='sidebar' i]",
      "[data-test*='sidebar' i]",
      "[class*='sidebar' i]",
    ].join(", ");
    const EXCLUDED_LABELS = new Set([
      "account",
      "automations",
      "get plus",
      "help",
      "new chat",
      "add new project",
      "collapse all",
      "filter sidebar chats",
      "performance boost",
      "pinned",
      "plugins",
      "projects",
      "rate limits",
      "search",
      "settings",
      "subway surfers",
      "ui improvements",
      "upgrade",
      "upgrade plan",
    ]);
    const PALETTE = [
      {
        id: "blue",
        label: "Blue",
        value: "var(--blue-400, #0285ff)",
        textValue: "var(--codexpp-project-blue-text)",
      },
      {
        id: "green",
        label: "Green",
        value: "var(--green-400, #04b84c)",
        textValue: "var(--codexpp-project-green-text)",
      },
      {
        id: "yellow",
        label: "Yellow",
        value: "var(--yellow-400, #ffc300)",
        textValue: "var(--codexpp-project-yellow-text)",
      },
      {
        id: "red",
        label: "Red",
        value: "var(--red-400, #fa423e)",
        textValue: "var(--codexpp-project-red-text)",
      },
      {
        id: "pink",
        label: "Pink",
        value: "var(--pink-400, #ff66ad)",
        textValue: "var(--codexpp-project-pink-text)",
      },
      {
        id: "purple",
        label: "Purple",
        value: "var(--purple-400, #924ff7)",
        textValue: "var(--codexpp-project-purple-text)",
      },
      {
        id: "gray",
        label: "Gray",
        value: "var(--color-token-text-secondary)",
        textValue: "var(--codexpp-project-gray-text)",
      },
    ];
    window.__codexppSidebarProjectPalette = PALETTE;
    const colorPrefsCacheKey = "__codexppSidebarProjectColorPrefs";
    let colorPrefs = readColorPrefs();
    window[colorPrefsCacheKey] = colorPrefs;
    const patchedProjectActionHandles = new Map();
    let disposed = false;

    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      :root {
        --codexpp-project-blue-text: var(--blue-400, #0285ff);
        --codexpp-project-green-text: color-mix(in srgb, var(--green-400, #04b84c) 72%, black);
        --codexpp-project-yellow-text: color-mix(in srgb, var(--yellow-400, #ffc300) 42%, black);
        --codexpp-project-red-text: color-mix(in srgb, var(--red-400, #fa423e) 82%, black);
        --codexpp-project-pink-text: color-mix(in srgb, var(--pink-400, #ff66ad) 68%, black);
        --codexpp-project-purple-text: color-mix(in srgb, var(--purple-400, #924ff7) 82%, black);
        --codexpp-project-gray-text: color-mix(in srgb, var(--color-token-text-primary, currentColor) 25%, black);
      }

      .electron-dark {
        --codexpp-project-blue-text: var(--blue-400, #0285ff);
        --codexpp-project-green-text: var(--green-400, #04b84c);
        --codexpp-project-yellow-text: var(--yellow-400, #ffc300);
        --codexpp-project-red-text: color-mix(in srgb, var(--red-400, #fa423e) 86%, white);
        --codexpp-project-pink-text: var(--pink-400, #ff66ad);
        --codexpp-project-purple-text: color-mix(in srgb, var(--purple-400, #924ff7) 88%, white);
        --codexpp-project-gray-text: var(--color-token-text-secondary);
      }

      [${ATTR}="row"] {
        position: relative !important;
        border-radius: var(--radius-md, 0.375rem) !important;
        background-color: color-mix(
          in srgb,
          var(--codexpp-project-tint, var(--color-token-text-secondary)) 7%,
          transparent
        ) !important;
        box-shadow:
          inset 0 0 0 1px color-mix(
            in srgb,
            var(--codexpp-project-text-color, var(--codexpp-project-tint, var(--color-token-text-secondary))) 30%,
            transparent
          ) !important;
      }

      .electron-dark [${ATTR}="row"] {
        box-shadow:
          inset 0 0 0 1px color-mix(
            in srgb,
            var(--codexpp-project-text-color, var(--codexpp-project-tint, var(--color-token-text-secondary))) 22%,
            transparent
          ) !important;
      }

      [${ATTR}="row"][style*="--codexpp-project-blue-token-override"] {
        --color-accent-blue: var(--codexpp-project-blue-token-override);
        --color-chart-blue: var(--codexpp-project-blue-token-override);
        --color-token-charts-blue: var(--codexpp-project-blue-token-override);
        --vscode-charts-blue: var(--codexpp-project-blue-token-override);
        --vscode-terminal-ansiBlue: var(--codexpp-project-blue-token-override);
        --vscode-terminal-ansiBrightBlue: var(--codexpp-project-blue-token-override);
      }

      [${ATTR}="row"][style*="--codexpp-project-link-token-override"] {
        --color-token-text-link-foreground: var(--codexpp-project-link-token-override);
        --color-token-text-link-active-foreground: var(--codexpp-project-link-token-override);
        --vscode-textLink-foreground: var(--codexpp-project-link-token-override);
        --vscode-textLink-activeForeground: var(--codexpp-project-link-token-override);
      }

      [${ATTR}="project-list"] {
        display: flex !important;
        flex-direction: column !important;
        gap: 4px !important;
      }

      [${ATTR}="row"]:hover {
        background-color: color-mix(
          in srgb,
          var(--codexpp-project-tint, var(--color-token-text-secondary)) 10%,
          transparent
        ) !important;
      }

      [${ATTR}="icon"],
      [${ATTR}="title"] {
        color: var(--codexpp-project-text-color, var(--codexpp-project-tint, currentColor)) !important;
      }

      [${ATTR}="unread"] {
        background-color: var(--codexpp-project-tint, currentColor) !important;
        color: var(--codexpp-project-tint, currentColor) !important;
        fill: var(--codexpp-project-tint, currentColor) !important;
        stroke: var(--codexpp-project-tint, currentColor) !important;
      }

      [${ATTR}="row"] [class*="bg-token-charts-blue"],
      [${ATTR}="row"] [class*="bg-chart-blue"],
      [${ATTR}="row"] [class*="bg-token-accent"],
      [${ATTR}="row"] [class*="bg-token-link"],
      [${ATTR}="row"] [data-testid*="unread" i],
      [${ATTR}="row"] [aria-label*="unread" i] {
        background-color: var(--codexpp-project-tint, currentColor) !important;
      }

      [${ATTR}="row"] [class*="text-token-charts-blue"],
      [${ATTR}="row"] [class*="text-chart-blue"],
      [${ATTR}="row"] [class*="text-token-accent"],
      [${ATTR}="row"] [class*="text-token-link"],
      [${ATTR}="row"] [data-testid*="unread" i],
      [${ATTR}="row"] [aria-label*="unread" i] {
        color: var(--codexpp-project-tint, currentColor) !important;
        fill: var(--codexpp-project-tint, currentColor) !important;
        stroke: var(--codexpp-project-tint, currentColor) !important;
      }

      aside.pointer-events-auto.relative.flex.overflow-hidden
        [role="button"].hover\\:bg-token-list-hover-background:not(.group\\/folder-row),
      aside.pointer-events-auto.relative.flex.overflow-visible
        [role="button"].hover\\:bg-token-list-hover-background:not(.group\\/folder-row) {
        margin-inline: 4px !important;
        width: calc(100% - 8px) !important;
      }

    `;
    document.head.appendChild(style);

    const normalize = (value) =>
      String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

    const visible = (node) => {
      if (!(node instanceof HTMLElement) || !node.isConnected) return false;
      if (node.closest("[hidden], [inert], [aria-hidden='true']")) return false;
      const style = window.getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const mainSidebar = () => {
      const aside = document.querySelector(ASIDE_SELECTOR);
      return aside instanceof HTMLElement ? aside : null;
    };

    const labelFor = (node) =>
      normalize(
        node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          node.textContent ||
          "",
      ).replace(/\s*[⌘⇧⌥⌃^].*$/, "");

    const nativeProjectRowFor = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      if (node.matches("[data-app-action-sidebar-project-row]")) return node;
      return node.querySelector("[data-app-action-sidebar-project-row]");
    };

    const projectLabelFor = (node) => {
      const nativeRow = nativeProjectRowFor(node);
      return normalize(
        nativeRow?.getAttribute("data-app-action-sidebar-project-label") ||
          node?.getAttribute?.("aria-label") ||
          nativeRow?.textContent ||
          node?.textContent ||
          "",
      );
    };

    const projectInfoFor = (node) => {
      const nativeRow = nativeProjectRowFor(node);
      const id = normalize(
        nativeRow?.getAttribute("data-app-action-sidebar-project-id") ||
          node?.getAttribute?.("data-app-action-sidebar-project-id") ||
          "",
      );
      return { id, label: projectLabelFor(node) };
    };

    const isProjectRow = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (!visible(node)) return false;

      const nativeRow = nativeProjectRowFor(node);
      if (nativeRow) {
        const label = projectLabelFor(node);
        return Boolean(label && label.length >= 2 && label.length <= 80 && !EXCLUDED_LABELS.has(label));
      }

      if (node.getAttribute("role") !== "listitem" || !node.classList.contains("group/cwd")) return false;

      const text = labelFor(node);
      if (!text || text.length < 2 || text.length > 80) return false;
      if (EXCLUDED_LABELS.has(text)) return false;

      const action = node.querySelector("[role='button'][aria-label]");
      return action instanceof HTMLElement && labelFor(action) === text;
    };

    const candidateRows = (sidebar) =>
      Array.from(sidebar.querySelectorAll("[data-app-action-sidebar-project-row], div[role='listitem'][aria-label]"))
        .map((node) => {
          if (!node.matches("[data-app-action-sidebar-project-row]")) return node;
          return node.closest("div[role='listitem'][aria-label]") || node;
        })
        .filter(isProjectRow)
        .filter((node, index, rows) => rows.indexOf(node) === index);

    const clearMarks = () => {
      document.querySelectorAll(`[${ATTR}]`).forEach((node) => {
        if (!(node instanceof Element)) return;
        node.removeAttribute(ATTR);
        node.removeAttribute("data-codexpp-sidebar-project-expanded");
        if ("style" in node) {
          node.style.removeProperty("--codexpp-project-tint");
          node.style.removeProperty("--codexpp-project-text-color");
          node.style.removeProperty("--codexpp-project-blue-token-override");
          node.style.removeProperty("--codexpp-project-link-token-override");
        }
      });
    };

    const preferenceKeysFor = (info) => [
      info?.id ? `id:${normalize(info.id)}` : "",
      projectKey(info?.label),
    ].filter(Boolean);

    const storedColorForProject = (info) => {
      for (const key of preferenceKeysFor(info)) {
        if (Object.prototype.hasOwnProperty.call(colorPrefs, key)) return colorPrefs[key];
      }
      return undefined;
    };

    const promoteColorPreferenceToId = (info) => {
      if (!info?.id || !info?.label) return false;
      const idKey = `id:${normalize(info.id)}`;
      const labelKey = projectKey(info.label);
      if (
        Object.prototype.hasOwnProperty.call(colorPrefs, idKey) ||
        !Object.prototype.hasOwnProperty.call(colorPrefs, labelKey)
      ) {
        return false;
      }
      colorPrefs[idKey] = colorPrefs[labelKey];
      return true;
    };

    const paletteFor = (info) => {
      const stored = storedColorForProject(info);
      const match = PALETTE.find((color) => color.id === stored);
      if (match) return match;

      const text = normalize(info?.label || info?.id);
      let hash = 0;
      for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      }
      return PALETTE[hash % 4];
    };

    const tintFor = (info) => paletteFor(info).value;

    const textColorFor = (info) => {
      const color = paletteFor(info);
      return color.textValue || color.value;
    };

    const blueTokenOverrideFor = (info) => {
      const color = paletteFor(info);
      return color.id === "blue" ? "" : color.value;
    };

    const linkTokenOverrideFor = (info) => {
      const color = paletteFor(info);
      return color.id === "blue" ? "" : textColorFor(info);
    };

    const markRows = (rows) => {
      reconcileProjectLists(rows);
      let promotedPreference = false;
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue;
        const info = projectInfoFor(row);
        const label = info.label;
        promotedPreference = promoteColorPreferenceToId(info) || promotedPreference;
        if (storedColorForProject(info) === "none") {
          clearRowMarks(row);
          continue;
        }
        setAttr(row, ATTR, "row");
        setAttr(row, "data-codexpp-sidebar-project-expanded", String(isExpandedProject(row)));
        setStyleVar(row, "--codexpp-project-tint", tintFor(info));
        setStyleVar(row, "--codexpp-project-text-color", textColorFor(info));
        setOptionalStyleVar(row, "--codexpp-project-blue-token-override", blueTokenOverrideFor(info));
        setOptionalStyleVar(row, "--codexpp-project-link-token-override", linkTokenOverrideFor(info));
        markProjectParts(row, label);
      }
      if (promotedPreference) persistColorPrefs();
      patchProjectActionMenus(rows);
    };

    const reconcileProjectLists = (rows) => {
      const parents = new Set(
        rows
          .map((row) => row.parentElement)
          .filter((node) => node instanceof HTMLElement),
      );
      document.querySelectorAll(`[${ATTR}="project-list"]`).forEach((node) => {
        if (!parents.has(node)) node.removeAttribute(ATTR);
      });
      for (const parent of parents) {
        setAttr(parent, ATTR, "project-list");
      }
    };

    const projectKey = (label) => normalize(label);

    function readColorPrefs() {
      const value = api.storage.get(COLOR_STORAGE_KEY, {});
      const stored = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const cached = window[colorPrefsCacheKey];
      return cached && typeof cached === "object" && !Array.isArray(cached)
        ? { ...cached, ...stored }
        : stored;
    }

    const writeColorPrefs = () => {
      colorPrefs = { ...colorPrefs };
      window[colorPrefsCacheKey] = colorPrefs;
      const result = api.storage.set(COLOR_STORAGE_KEY, colorPrefs);
      window.dispatchEvent(new CustomEvent("codexpp-sidebar-project-colors-changed"));
      return result;
    };

    const persistColorPrefs = () => {
      try {
        Promise.resolve(writeColorPrefs()).catch((e) => {
          api.log.warn("sidebar project color write failed", e);
        });
      } catch (e) {
        api.log.warn("sidebar project color write failed", e);
      }
    };

    const isExpandedProject = (row) => {
      if (row.getBoundingClientRect().height > 40) return true;
      return Boolean(row.querySelector('[role="list"][aria-label]'));
    };

    const markProjectParts = (row, label) => {
      const header = Array.from(row.querySelectorAll("[role='button'][aria-label]"))
        .find((node) => node instanceof HTMLElement && labelFor(node) === label);
      const target = header instanceof HTMLElement ? header : row.querySelector("[role='button'][aria-label]");
      if (!(target instanceof HTMLElement)) return;

      target.querySelectorAll("svg").forEach((node) => {
        if (node instanceof SVGElement) setAttr(node, ATTR, "icon");
      });

      const title = Array.from(target.querySelectorAll("span"))
        .filter((node) => node instanceof HTMLElement && normalize(node.textContent) === normalize(label))
        .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
      if (title instanceof HTMLElement) setAttr(title, ATTR, "title");

      row.querySelectorAll(
        [
          '[class*="bg-token-charts-blue"]',
          '[class*="bg-chart-blue"]',
          '[class*="bg-token-accent"]',
          '[class*="bg-token-link"]',
          '[class*="text-token-charts-blue"]',
          '[class*="text-chart-blue"]',
          '[class*="text-token-accent"]',
          '[class*="text-token-link"]',
          '[class*="unread" i]',
          '[data-testid*="unread" i]',
          '[aria-label*="unread" i]',
        ].join(", "),
      )
        .forEach((node) => {
          if (node instanceof HTMLElement) setAttr(node, ATTR, "unread");
        });
    };

    const reactFiberFor = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const key = Object.keys(node).find((item) => item.startsWith("__reactFiber$"));
      return key ? node[key] : null;
    };

    const projectActionsHandleFor = (row) => {
      const button = row.querySelector(
        "button[aria-haspopup='menu'], [role='button'][aria-haspopup='menu']",
      );
      let fiber = reactFiberFor(button);
      for (let depth = 0; fiber && depth < 16; depth += 1, fiber = fiber.return) {
        const handle = fiber.memoizedProps?.ref?.current;
        if (handle && typeof handle.getContextMenuItems === "function") return handle;
      }
      return null;
    };

    const nativeMenuMessage = (id, defaultMessage) => ({
      id: `bennettUi.${id}`,
      defaultMessage,
      description: "Bennett UI project color menu",
    });

    const nativeMenuLabels = () => {
      const isChinese = /^zh(?:-|$)/i.test(
        document.documentElement.lang || navigator.language || "",
      );
      if (!isChinese) {
        return {
          title: "Project color",
          auto: "Auto",
          none: "No color",
          blue: "Blue",
          green: "Green",
          yellow: "Yellow",
          red: "Red",
          pink: "Pink",
          purple: "Purple",
          gray: "Gray",
        };
      }
      return {
        title: "项目着色",
        auto: "自动",
        none: "无颜色",
        blue: "蓝色",
        green: "绿色",
        yellow: "黄色",
        red: "红色",
        pink: "粉色",
        purple: "紫色",
        gray: "灰色",
      };
    };

    const NATIVE_SWATCH_COLORS = Object.freeze({
      blue: "#0285ff",
      green: "#04b84c",
      yellow: "#ffc300",
      red: "#fa423e",
      pink: "#ff66ad",
      purple: "#924ff7",
      gray: "#8e8e93",
    });

    const nativeColorSwatchIcon = (colorId) => {
      if (colorId === "none") {
        const svg = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="6.25" stroke="#8e8e93" stroke-width="1.5"/><path d="M5.6 14.4 14.4 5.6" stroke="#8e8e93" stroke-width="1.5" stroke-linecap="round"/></svg>`;
        return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
      }
      const fill = NATIVE_SWATCH_COLORS[colorId];
      const gradient = colorId === "auto"
        ? `<defs><linearGradient id="g" x1="3" y1="3" x2="17" y2="17" gradientUnits="userSpaceOnUse"><stop stop-color="#0285ff"/><stop offset=".34" stop-color="#04b84c"/><stop offset=".67" stop-color="#ffc300"/><stop offset="1" stop-color="#fa423e"/></linearGradient></defs>`
        : "";
      const svg = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">${gradient}<circle cx="10" cy="10" r="6.25" fill="${fill || "url(#g)"}"/><circle cx="10" cy="10" r="6.25" stroke="#808080" stroke-opacity=".42"/></svg>`;
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    };

    const setProjectColor = (info, colorId) => {
      for (const key of preferenceKeysFor(info)) {
        if (colorId === "auto") delete colorPrefs[key];
        else colorPrefs[key] = colorId;
      }
      applyColorToCurrentRows(info);
      persistColorPrefs();
      applyColorToCurrentRows(info);
      scheduleApply();
    };

    const appendProjectColorSubmenu = (items, info) => {
      if (!Array.isArray(items)) return items;
      if (items.some((item) => item?.id === NATIVE_COLOR_MENU_ID)) return items;
      const labels = nativeMenuLabels();
      const selected = storedColorForProject(info) || "auto";
      const options = ["auto", "none", ...PALETTE.map(({ id }) => id)];
      const submenu = options.map((colorId) => ({
        id: `${NATIVE_COLOR_MENU_ID}:${colorId}`,
        message: nativeMenuMessage(`projectColor.${colorId}`, labels[colorId]),
        icon: nativeColorSwatchIcon(colorId),
        checked: selected === colorId,
        onSelect: () => setProjectColor(info, colorId),
      }));
      const item = {
        id: NATIVE_COLOR_MENU_ID,
        message: nativeMenuMessage("projectColor", labels.title),
        icon: nativeColorSwatchIcon("auto"),
        submenu,
      };
      const next = [...items];
      const destructiveIndex = next.findIndex((entry) =>
        /(?:remove|delete).*(?:project|workspace|folder)|(?:project|workspace|folder).*(?:remove|delete)/i
          .test(String(entry?.id || "")),
      );
      const insertAt = destructiveIndex > 0 && next[destructiveIndex - 1]?.type === "separator"
        ? destructiveIndex - 1
        : destructiveIndex >= 0
          ? destructiveIndex
          : next.length;
      next.splice(insertAt, 0, item);
      return next;
    };

    const restoreProjectActionHandle = (handle, record) => {
      if (handle?.getContextMenuItems === record.wrapped) {
        handle.getContextMenuItems = record.original;
      }
      patchedProjectActionHandles.delete(handle);
    };

    const patchProjectActionMenus = (rows) => {
      const activeHandles = new Set();
      for (const row of rows) {
        const handle = projectActionsHandleFor(row);
        if (!handle) continue;
        activeHandles.add(handle);
        const info = projectInfoFor(row);
        let record = patchedProjectActionHandles.get(handle);
        if (record && handle.getContextMenuItems === record.wrapped) {
          record.info = info;
          continue;
        }
        if (record) patchedProjectActionHandles.delete(handle);
        const original = handle.getContextMenuItems;
        record = { info, original, wrapped: null };
        record.wrapped = function bennettProjectColorMenuItems(...args) {
          const items = record.original.apply(this, args);
          return appendProjectColorSubmenu(items, record.info);
        };
        try {
          handle.getContextMenuItems = record.wrapped;
          if (handle.getContextMenuItems === record.wrapped) {
            patchedProjectActionHandles.set(handle, record);
          }
        } catch (e) {
          api.log.warn("project color native menu hook unavailable", e);
        }
      }
      for (const [handle, record] of patchedProjectActionHandles) {
        if (!activeHandles.has(handle)) restoreProjectActionHandle(handle, record);
      }
    };

    const applyColorToCurrentRows = (info) => {
      const sidebar = mainSidebar();
      if (!sidebar) return;
      const rows = candidateRows(sidebar).filter((row) => {
        const candidate = projectInfoFor(row);
        return info?.id
          ? candidate.id === normalize(info.id)
          : candidate.label === projectKey(info?.label);
      });
      markRows(rows);
    };

    let activeSidebar = null;
    const apply = () => {
      const sidebar = mainSidebar();
      activeSidebar = sidebar instanceof HTMLElement ? sidebar : null;
      if (!sidebar) {
        return;
      }

      let rows = candidateRows(sidebar);
      rows = rows.filter((node, index) => rows.indexOf(node) === index);
      const seenLabels = new Set();
      rows = rows.filter((node) => {
        const label = projectLabelFor(node);
        if (!label || seenLabels.has(label)) return false;
        seenLabels.add(label);
        return true;
      });
      if (!rows.length) {
        return;
      }

      reconcileMarkedRows(rows);
      markRows(rows);
      if (apply._lastCount !== rows.length) {
        apply._lastCount = rows.length;
        api.log.info("sidebar project backgrounds marked rows", {
          count: rows.length,
          labels: rows.slice(0, 8).map(projectLabelFor),
        });
      }
    };

    const reconcileMarkedRows = (rows) => {
      const active = new Set(rows);
      document.querySelectorAll(`[${ATTR}="row"]`).forEach((row) => {
        if (!(row instanceof HTMLElement)) return;
        if (active.has(row) && row.isConnected) return;
        clearRowMarks(row);
      });
    };

    const clearRowMarks = (row) => {
      row.removeAttribute(ATTR);
      row.removeAttribute("data-codexpp-sidebar-project-expanded");
      row.style.removeProperty("--codexpp-project-tint");
      row.style.removeProperty("--codexpp-project-text-color");
      row.style.removeProperty("--codexpp-project-blue-token-override");
      row.style.removeProperty("--codexpp-project-link-token-override");
      row.querySelectorAll(`[${ATTR}]`).forEach((node) => node.removeAttribute(ATTR));
    };

    const setAttr = (node, name, value) => {
      if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    };

    const setStyleVar = (node, name, value) => {
      if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
    };

    const setOptionalStyleVar = (node, name, value) => {
      if (value) setStyleVar(node, name, value);
      else if (node.style.getPropertyValue(name)) node.style.removeProperty(name);
    };

    let scheduled = false;
    let scheduleTimer = 0;
    const runScheduledApply = () => {
      if (!scheduled) return;
      scheduled = false;
      if (scheduleTimer) {
        window.clearTimeout(scheduleTimer);
        scheduleTimer = 0;
      }
      if (disposed) return;
      apply();
    };

    const scheduleApply = (delay = 140) => {
      if (disposed) return;
      scheduled = true;
      if (scheduleTimer) window.clearTimeout(scheduleTimer);
      scheduleTimer = window.setTimeout(runScheduledApply, delay);
    };

    const scheduleApplyForMutations = (records) => {
      if (disposed) return;
      const sidebar = activeSidebar?.isConnected ? activeSidebar : null;
      const relevant = records.some((record) => {
        const target = record.target instanceof Element
          ? record.target
          : record.target?.parentElement;
        if (sidebar && target instanceof Element && (target === sidebar || sidebar.contains(target))) {
          return true;
        }
        return [...record.addedNodes, ...record.removedNodes].some((node) =>
          node instanceof Element && (
            node.matches?.(ASIDE_SELECTOR) ||
            node.querySelector?.(ASIDE_SELECTOR) ||
            node.hasAttribute?.("data-app-action-sidebar-project-id") ||
            node.querySelector?.("[data-app-action-sidebar-project-id]")
          ),
        );
      });
      if (relevant) scheduleApply();
    };

    apply();
    scheduleApply();
    const retryTimers = [250, 1000, 2500].map((delay) =>
      window.setTimeout(scheduleApply, delay),
    );
    const observer = new MutationObserver(scheduleApplyForMutations);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [
        "aria-label",
        "data-app-action-sidebar-project-collapsed",
        "data-app-action-sidebar-project-id",
        "data-app-action-sidebar-project-label",
        "data-app-action-sidebar-project-row",
        "role",
      ],
      childList: true,
      subtree: true,
    });
    const onWindowFocus = () => scheduleApply();
    const onVisibilityChange = () => scheduleApply();
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    api.log.info("sidebar project backgrounds active");

    return () => {
      disposed = true;
      observer.disconnect();
      if (scheduleTimer) window.clearTimeout(scheduleTimer);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const [handle, record] of patchedProjectActionHandles) {
        restoreProjectActionHandle(handle, record);
      }
      clearMarks();
      style.remove();
    };
  },

  /**
   * Apply the selected project color to native conversation rows.
   * Codex owns the list, ordering, and filtering; this feature only adds
   * reversible visual marks to rows carrying the native sidebar attributes.
   */
  "sidebar-conversation-colors"(api) {
    const STYLE_ID = "codexpp-sidebar-conversation-colors";
    const ATTR = "data-codexpp-sidebar-conversation-color";
    const COLOR_STORAGE_KEY = PROJECT_COLOR_STORAGE_KEY;
    const COLOR_EVENT = "codexpp-sidebar-project-colors-changed";
    const PALETTE_CACHE_KEY = "__codexppSidebarProjectPalette";
    const COLOR_PREFS_CACHE_KEY = "__codexppSidebarProjectColorPrefs";
    const ASIDE_SELECTOR = [
      "aside.pointer-events-auto.relative.flex.overflow-hidden",
      "aside.pointer-events-auto.relative.flex.overflow-visible",
      "aside.pointer-events-auto.relative.flex",
    ].join(", ");
    const THREAD_SELECTOR = "[data-app-action-sidebar-thread-row]";
    const PROJECT_SELECTOR = "[data-app-action-sidebar-project-row]";
    const PROJECT_LIST_SELECTOR = "[data-app-action-sidebar-project-list-id]";
    const PROJECT_ID_ATTRS = [
      "data-app-action-sidebar-project-id",
      "data-project-id",
    ];
    const PROJECT_LABEL_ATTRS = [
      "data-app-action-sidebar-project-label",
      "data-project-name",
    ];
    const PALETTE_FALLBACK = [
      {
        id: "blue",
        value: "var(--blue-400, #0285ff)",
      },
      {
        id: "green",
        value: "var(--green-400, #04b84c)",
      },
      {
        id: "yellow",
        value: "var(--yellow-400, #ffc300)",
      },
      {
        id: "red",
        value: "var(--red-400, #fa423e)",
      },
      {
        id: "pink",
        value: "var(--pink-400, #ff66ad)",
      },
      {
        id: "purple",
        value: "var(--purple-400, #924ff7)",
      },
      {
        id: "gray",
        value: "var(--color-token-text-secondary)",
      },
    ];
    let disposed = false;
    let activeSidebar = null;
    let applyTimer = 0;
    let colorEventHandler = null;
    let colorPrefs = {};

    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${ATTR}="row"] {
        position: relative !important;
        box-sizing: border-box !important;
        border-inline-start: 3px solid color-mix(
          in srgb,
          var(--codexpp-project-tint, var(--color-token-text-secondary)) 78%,
          transparent
        ) !important;
        background-color: color-mix(
          in srgb,
          var(--codexpp-project-tint, var(--color-token-text-secondary)) 6%,
          transparent
        ) !important;
      }

      [${ATTR}="row"]:hover {
        background-color: color-mix(
          in srgb,
          var(--codexpp-project-tint, var(--color-token-text-secondary)) 10%,
          transparent
        ) !important;
      }

      [${ATTR}="row"][aria-selected="true"],
      [${ATTR}="row"][data-app-action-sidebar-thread-active="true"] {
        background-color: color-mix(
          in srgb,
          var(--codexpp-project-tint, var(--color-token-text-secondary)) 14%,
          var(--color-token-list-hover-background, transparent)
        ) !important;
      }
    `;
    document.head.appendChild(style);

    const normalize = (value) =>
      String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

    const visible = (node) => {
      if (!(node instanceof HTMLElement) || !node.isConnected) return false;
      if (node.closest("[hidden], [inert], [aria-hidden='true']")) return false;
      const computed = window.getComputedStyle(node);
      if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const mainSidebar = () => {
      const aside = document.querySelector(ASIDE_SELECTOR);
      return aside instanceof HTMLElement ? aside : null;
    };

    const attrValue = (node, names) => {
      for (const name of names) {
        const value = node?.getAttribute?.(name);
        if (value) return value.trim();
      }
      return "";
    };

    const projectInfo = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const id = attrValue(node, PROJECT_ID_ATTRS);
      const label = attrValue(node, PROJECT_LABEL_ATTRS) ||
        normalize(
          node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          node.querySelector("[role='button'][aria-label]")?.getAttribute("aria-label") ||
          "",
        );
      if (!id && !label) return null;
      return {
        id,
        label,
        key: id ? `id:${normalize(id)}` : `label:${normalize(label)}`,
      };
    };

    const projectIndex = (sidebar) => {
      const byId = new Map();
      const byList = new Map();
      for (const row of sidebar.querySelectorAll(PROJECT_SELECTOR)) {
        const info = projectInfo(row);
        if (!info) continue;
        if (info.id) byId.set(normalize(info.id), info);
        const list = row.querySelector(PROJECT_LIST_SELECTOR);
        const listId = attrValue(list, ["data-app-action-sidebar-project-list-id"]);
        if (listId) byList.set(normalize(listId), info);
      }
      for (const list of sidebar.querySelectorAll(PROJECT_LIST_SELECTOR)) {
        const listId = attrValue(list, ["data-app-action-sidebar-project-list-id"]);
        if (!listId || byList.has(normalize(listId))) continue;
        const row = list.closest(PROJECT_SELECTOR);
        const info = projectInfo(row);
        if (info) byList.set(normalize(listId), info);
      }
      return { byId, byList };
    };

    const secondaryProjectInfo = (thread) => {
      const secondary = Array.from(
        thread.querySelectorAll('[data-thread-secondary-title="true"]'),
      ).find((node) => {
        const icon = node.querySelector("svg");
        const viewBox = icon?.getAttribute("viewBox") || "";
        const width = icon?.getAttribute("width") || "";
        return viewBox === "0 0 16 16" || width === "16";
      });
      const label = normalize(secondary?.textContent || "");
      return label
        ? { id: "", label, key: `label:${label}` }
        : null;
    };

    const reactProjectInfo = (thread) => {
      const fiberKey = Object.getOwnPropertyNames(thread).find((name) =>
        name.startsWith("__reactFiber$"),
      );
      let fiber = fiberKey ? thread[fiberKey] : null;
      const visited = new Set();

      // Priority and recent views no longer expose project attributes in the
      // DOM, but assigned threads still carry a stable project id in their
      // native hover-card props. A label without an id is only the basename of
      // the thread's working directory and must not be treated as membership.
      for (let depth = 0; fiber && depth < 12 && !visited.has(fiber); depth += 1) {
        visited.add(fiber);
        for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
          if (!props || typeof props !== "object") continue;
          if (props.isProjectlessHoverCard === true) return false;
          const id = typeof props.hoverCardProjectId === "string"
            ? props.hoverCardProjectId.trim()
            : "";
          const label = typeof props.hoverCardProjectLabel === "string"
            ? props.hoverCardProjectLabel.trim()
            : "";
          if (id) {
            return {
              id,
              label,
              key: `id:${normalize(id)}`,
            };
          }
          if (label) return false;
        }
        fiber = fiber.return;
      }
      return null;
    };

    const projectForThread = (thread, index) => {
      const nestedProject = thread.closest(PROJECT_SELECTOR);
      const nestedInfo = projectInfo(nestedProject);
      if (nestedInfo) return nestedInfo;

      const directId = attrValue(thread, PROJECT_ID_ATTRS);
      if (directId) return index.byId.get(normalize(directId)) || { id: directId, label: "", key: `id:${normalize(directId)}` };

      const list = thread.closest(PROJECT_LIST_SELECTOR);
      const listId = attrValue(list, ["data-app-action-sidebar-project-list-id"]);
      if (listId) return index.byList.get(normalize(listId)) || null;

      const directLabel = attrValue(thread, PROJECT_LABEL_ATTRS);
      if (directLabel) {
        const label = normalize(directLabel);
        return { id: "", label, key: `label:${label}` };
      }

      const reactInfo = reactProjectInfo(thread);
      if (reactInfo === false) return null;
      if (reactInfo) return reactInfo;

      // Newer Codex builds render the project as a folder-marked secondary
      // title inside each thread row instead of exposing project row nodes.
      return secondaryProjectInfo(thread);
    };

    const readColorPrefs = () => {
      const stored = api.storage.get(COLOR_STORAGE_KEY, {});
      const cache = window[COLOR_PREFS_CACHE_KEY];
      return {
        ...(cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {}),
        ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}),
      };
    };

    colorPrefs = readColorPrefs();

    const storedColorFor = (info) =>
      (info.id && colorPrefs[`id:${normalize(info.id)}`]) || colorPrefs[normalize(info.label)];

    const paletteFor = (info) => {
      const palette = Array.isArray(window[PALETTE_CACHE_KEY]) && window[PALETTE_CACHE_KEY].length
        ? window[PALETTE_CACHE_KEY]
        : PALETTE_FALLBACK;
      const storedId = storedColorFor(info);
      const selected = palette.find((item) => item.id === storedId);
      if (selected) return selected;
      const seed = normalize(info.label || info.id);
      let hash = 0;
      for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
      return palette[hash % Math.min(4, palette.length)];
    };

    const clearRow = (row) => {
      row.removeAttribute(ATTR);
      row.style.removeProperty("--codexpp-project-tint");
    };

    const apply = () => {
      if (disposed) return;
      const sidebar = mainSidebar();
      activeSidebar = sidebar;
      if (!sidebar) return;
      const index = projectIndex(sidebar);
      const active = new Set();
      for (const thread of sidebar.querySelectorAll(THREAD_SELECTOR)) {
        if (!(thread instanceof HTMLElement) || !visible(thread)) continue;
        const info = projectForThread(thread, index);
        if (!info) {
          clearRow(thread);
          continue;
        }
        if (storedColorFor(info) === "none") {
          clearRow(thread);
          continue;
        }
        const palette = paletteFor(info);
        thread.setAttribute(ATTR, "row");
        thread.style.setProperty("--codexpp-project-tint", palette.value);
        active.add(thread);
      }
      sidebar.querySelectorAll(`[${ATTR}="row"]`).forEach((row) => {
        if (row instanceof HTMLElement && !active.has(row)) clearRow(row);
      });
    };

    const scheduleApply = (delay = 100) => {
      if (disposed) return;
      if (applyTimer) window.clearTimeout(applyTimer);
      applyTimer = window.setTimeout(() => {
        applyTimer = 0;
        apply();
      }, delay);
    };

    const observer = new MutationObserver((records) => {
      const sidebar = activeSidebar?.isConnected ? activeSidebar : mainSidebar();
      if (!sidebar) return scheduleApply();
      const relevant = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target?.parentElement;
        if (target instanceof Element && (target === sidebar || sidebar.contains(target))) return true;
        return [...record.addedNodes, ...record.removedNodes].some((node) =>
          node instanceof Element && (node.matches?.(ASIDE_SELECTOR) || node.querySelector?.(THREAD_SELECTOR) || node.querySelector?.(PROJECT_SELECTOR)),
        );
      });
      if (relevant) scheduleApply();
    });

    colorEventHandler = () => {
      colorPrefs = readColorPrefs();
      scheduleApply(0);
    };
    window.addEventListener(COLOR_EVENT, colorEventHandler);
    apply();
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [
      "aria-selected",
      "data-app-action-sidebar-project-id",
      "data-app-action-sidebar-project-label",
      "data-app-action-sidebar-project-list-id",
      "data-app-action-sidebar-thread-active",
      "data-app-action-sidebar-thread-row",
    ] });

    return () => {
      disposed = true;
      observer.disconnect();
      if (applyTimer) window.clearTimeout(applyTimer);
      if (colorEventHandler) window.removeEventListener(COLOR_EVENT, colorEventHandler);
      activeSidebar?.querySelectorAll(`[${ATTR}="row"]`).forEach((row) => {
        if (row instanceof HTMLElement) clearRow(row);
      });
      style.remove();
    };
  },

};

// ─────────────────────────────────────────────────────────────── helpers ──

function writeSnapshot(api, snap) {
  api.storage.set("usage:snapshot", snap);
}

function formatCreditAmount(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : text;
}

/**
 * Render a single rotating usage box. Click toggles between 5h, Weekly, and points;
 * hover replaces the content with "Resets: HH:MM" for 5h or a points value for
 * "Resets: Wed, HH:MM" for weekly. The currently-selected kind is persisted
 * to storage so it survives reloads.
 *
 * The returned element exposes `_refresh(snapshot)` so callers can update
 * values in place without unmount/remount.
 */
function renderUsageBox(api, snapshot) {
  const BASE_ORDER = ["5h", "weekly"];
  let order = [...BASE_ORDER];
  let kind = api.storage.get("usage:visible-kind", "5h");
  const syncOrder = (snap) => {
    const hasPoints = !!(
      snap?.points &&
      snap.points.value != null &&
      String(snap.points.value).trim() !== ""
    );
    order = hasPoints ? [...BASE_ORDER, "points"] : BASE_ORDER;
    if (!order.includes(kind)) {
      kind = "5h";
      api.storage.set("usage:visible-kind", kind);
    }
  };
  syncOrder(snapshot);

  const btn = document.createElement("button");
  btn.type = "button";
  // Keep alignment consistent with the row that hosted the upgrade pill.
  btn.className =
    "flex w-auto min-w-0 shrink-0 items-center justify-between gap-2 rounded-md border border-token-border " +
    "px-2 py-1 text-xs cursor-interaction transition-colors " +
    "hover:bg-token-foreground/10";

  const left = document.createElement("span");
  left.className = "min-w-0 truncate";
  const right = document.createElement("span");
  right.className = "shrink-0 tabular-nums flex items-center gap-1";

  btn.append(left, right);

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const setClass = (node, className) => {
    if (node.className !== className) node.className = className;
  };
  const singleRightSpan = () => {
    let child = right.firstElementChild;
    if (!(child instanceof HTMLSpanElement)) {
      child = document.createElement("span");
      right.replaceChildren(child);
      return child;
    }
    while (child.nextSibling) child.nextSibling.remove();
    return child;
  };

  /** Pull the entry for `kind` out of the live snapshot. */
  const entryFor = (snap, k) => {
    if (k === "5h") return snap.fiveHour;
    if (k === "weekly") return snap.weekly;
    return snap.points;
  };
  const isApiSnapshot = (snap) => !!snap?.apiMode || !!snap?.fiveHour?.apiMode;

  /** Apply colors + text for the *value* state (i.e. not hover). */
  const applyValueState = (snap) => {
    if (isApiSnapshot(snap)) {
      btn.classList.remove("bg-token-charts-red/10", "text-token-charts-red");
      btn.classList.add("bg-token-foreground/5", "text-token-text-primary");
      setText(left, "API");
      setClass(left, "truncate");
      right.replaceChildren();
      return;
    }
    const entry = entryFor(snap, kind);
    const pct = entry?.pct;
    const remaining = typeof pct === "number" ? pct : null;
    const lowEnergy = typeof remaining === "number" && remaining < 15;

    btn.classList.toggle("bg-token-charts-red/10", lowEnergy);
    btn.classList.toggle("text-token-charts-red", lowEnergy);
    btn.classList.toggle("bg-token-foreground/5", !lowEnergy);
    btn.classList.toggle("text-token-text-primary", !lowEnergy);

    setText(
      left,
      entry?.label || (kind === "5h" ? "5h" : kind === "weekly" ? "Weekly" : "Credit"),
    );

    const pctEl = singleRightSpan();
    setText(
      pctEl,
      kind === "points"
        ? formatCreditAmount(entry?.value) || "—"
        : remaining == null
          ? "—"
          : `${remaining}%`,
    );
    setClass(pctEl, lowEnergy ? "font-medium" : "text-token-text-secondary");
  };

  /** Replace the entire box content with the reset label. */
  const applyHoverState = (snap) => {
    if (isApiSnapshot(snap)) {
      applyValueState(snap);
      return;
    }
    const entry = entryFor(snap, kind);
    if (kind === "points") {
      // Credit is a stable balance value; hovering it must not replace the label.
      applyValueState(snap);
      return;
    }
    setText(left, "Resets:");
    setClass(left, "truncate text-token-text-secondary");
    const t = singleRightSpan();
    setClass(t, "tabular-nums");
    setText(t, entry?.resetAt || "—");
  };

  // Bind hover with a snapshot getter so handlers always see the latest.
  let currentSnap = snapshot;
  // While true, the cursor is *inside* the box but the user has clicked
  // since their last mouseleave — we suppress hover state until they
  // physically leave the element so the click's value state is sticky.
  let suppressHover = false;

  btn.addEventListener("mouseenter", () => {
    suppressHover = false;
    applyHoverState(currentSnap);
  });
  btn.addEventListener("mouseleave", () => {
    suppressHover = false;
    setClass(left, "truncate");
    applyValueState(currentSnap);
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const i = order.indexOf(kind);
    kind = order[(i + 1) % order.length];
    api.storage.set("usage:visible-kind", kind);
    // Per the design: clicking shows the OTHER kind's value, even if the
    // cursor is still over the box.
    suppressHover = true;
    setClass(left, "truncate");
    applyValueState(currentSnap);
  });

  // Initial paint.
  applyValueState(currentSnap);

  // Allow the parent to push fresh data without remounting us. We honour
  // the click-guard so refreshes don't reintroduce hover state mid-click.
  btn._refresh = (next) => {
    if (next === currentSnap) return;
    currentSnap = next;
    syncOrder(next);
    if (btn.matches(":hover") && !suppressHover) applyHoverState(currentSnap);
    else applyValueState(currentSnap);
  };

  return btn;
}

function readFlag(api, id, fallback) {
  const v = api.storage.get(`feature:${id}`, undefined);
  return typeof v === "boolean" ? v : !!fallback;
}
function writeFlag(api, id, on) {
  api.storage.set(`feature:${id}`, !!on);
}

  const tweak = module.exports;
  const loaderApi = globalThis.__codexScriptLoader?.activeApi || null;
  const baseApi = loaderApi || createBigPizzaRendererApi();
  const api = createProjectColorCompatibleApi(baseApi);
  if (!tweak || typeof tweak.start !== "function") {
    throw new Error("Bennett UI tweak entrypoint was not found");
  }

  if (loaderApi?.storage) {
    for (const id of FEATURE_IDS) {
      const key = `feature:${id}`;
      if (loaderApi.storage.get(key, undefined) !== undefined) continue;
      try {
        const legacy = localStorage.getItem(`bennett-ui-improvements:${key}`);
        if (legacy !== null) loaderApi.storage.set(key, JSON.parse(legacy));
      } catch {}
    }
  }

  tweak.start.call(tweak, api);
  const features = FEATURE_IDS;
  const featureInfo = FEATURE_DEFINITIONS;
  let settingsScanTimer = 0;
  let nativeSettingsActive = false;
  let settingsObserver = null;
  let settingsPageHandle = null;
  const scheduleSettingsPanelInstall = () => {
    if (settingsScanTimer) return;
    settingsScanTimer = window.setTimeout(() => {
      settingsScanTimer = 0;
      installSettingsPanel();
    }, 100);
  };
  const handleSidecarSettingsSelect = (event) => {
    if (event?.detail?.id !== "bennett-ui") deactivateNativeSettingsPanel();
  };
  const handleNativeSettingsNavigation = (event) => {
    const target = event.target instanceof Element ? event.target.closest("button[data-settings-panel-slug]") : null;
    if (target && target.id !== "bennett-ui-native-settings-nav") deactivateNativeSettingsPanel();
  };
  if (loaderApi?.settings?.registerPage) {
    settingsPageHandle = loaderApi.settings.registerPage({
      id: "main",
      title: "界面增强",
      description: "",
      iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M10 2.5 11.4 8.6 17.5 10l-6.1 1.4L10 17.5l-1.4-6.1L2.5 10l6.1-1.4L10 2.5Z" fill="currentColor"/></svg>',
      render(root) {
        root.dataset.bennettUiSettingsRoot = "true";
        root.innerHTML = settingsPanelHtml();
        bindSettingsPanel(root);
        ensureSettingsStyle();
        refreshSettingsPanel(root);
        return () => {
          delete root.dataset.bennettUiSettingsRoot;
          root.innerHTML = "";
        };
      },
    });
  } else {
    window.addEventListener("codex-sidecar-settings-select", handleSidecarSettingsSelect);
    document.addEventListener("click", handleNativeSettingsNavigation, true);
    settingsObserver = new MutationObserver(scheduleSettingsPanelInstall);
    settingsObserver.observe(document.documentElement, { childList: true, subtree: true });
    installSettingsPanel();
  }

  function featureDefault(id) {
    return featureInfo.find((item) => item.id === id)?.defaultEnabled ?? false;
  }

  function featureEnabled(id) {
    const meta = featureInfo.find((item) => item.id === id);
    if (meta?.disabled) return false;
    return !!api.storage.get(`feature:${id}`, featureDefault(id));
  }

  function setFeatureEnabled(id, enabled) {
    if (!features.includes(id)) {
      throw new Error(`Unknown Bennett UI feature: ${id}`);
    }
    api.storage.set(`feature:${id}`, !!enabled);
    const state = tweak._state;
    if (state && typeof activateFeature === "function" && typeof deactivateFeature === "function") {
      if (enabled) activateFeature(state, id);
      else deactivateFeature(state, id);
    }
    refreshSettingsPanel();
  }

  function installSettingsPanel() {
    const modal = document.querySelector(".codex-plus-modal-content");
    if (!modal) {
      installNativeSettingsPanel();
      return;
    }
    document.getElementById("bennett-ui-settings-launcher")?.remove();
    document.getElementById("bennett-ui-settings-dialog")?.remove();
    const tabs = modal.querySelector(".codex-plus-tabs");
    const body = modal.querySelector(".codex-plus-modal-body");
    if (!tabs || !body) return;
    const currentTab = tabs.querySelector('[data-codex-plus-tab="bennettUi"]');
    const currentPanel = body.querySelector('[data-codex-plus-panel="bennettUi"]');
    if (
      modal.dataset.bennettUiSettingsLoadId === SCRIPT_LOAD_ID &&
      currentTab &&
      currentPanel
    ) {
      return;
    }
    modal.dataset.bennettUiSettingsVersion = VERSION;
    modal.dataset.bennettUiSettingsLoadId = SCRIPT_LOAD_ID;

    tabs.querySelectorAll('[data-codex-plus-tab="bennettUi"]').forEach((node) => node.remove());
    body.querySelectorAll('[data-codex-plus-panel="bennettUi"]').forEach((node) => node.remove());

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "codex-plus-tab-button";
    tab.dataset.codexPlusTab = "bennettUi";
    tab.dataset.active = "false";
    tab.textContent = "界面增强";
    tabs.appendChild(tab);

    const panel = document.createElement("div");
    panel.className = "codex-plus-panel";
    panel.dataset.codexPlusPanel = "bennettUi";
    panel.hidden = true;
    panel.innerHTML = settingsPanelHtml();
    bindSettingsPanel(panel);
    body.appendChild(panel);
    ensureSettingsStyle();
    refreshSettingsPanel();
  }

  function bindSettingsPanel(panel) {
    panel.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const toggle = target?.closest("[data-bennett-ui-feature]");
      if (!toggle) return;
      event.preventDefault();
      event.stopPropagation();
      const id = toggle.getAttribute("data-bennett-ui-feature");
      const meta = featureInfo.find((item) => item.id === id);
      if (!id || meta?.disabled) return;
      setFeatureEnabled(id, !featureEnabled(id));
    }, true);
  }

  function nativeSettingsParts() {
    const nav = document.querySelector("nav[aria-label='设置'], nav[aria-label='Settings']");
    const aside = nav?.closest("aside");
    const shell = aside?.parentElement;
    const main = shell
      ? Array.from(shell.children).find((node) => node !== aside && node instanceof HTMLElement)
      : null;
    return { nav, main };
  }

  function deactivateNativeSettingsPanel() {
    nativeSettingsActive = false;
    const panel = document.getElementById("bennett-ui-native-settings-panel");
    const button = document.getElementById("bennett-ui-native-settings-nav");
    if (panel) panel.hidden = true;
    button?.removeAttribute("aria-current");
    const { main } = nativeSettingsParts();
    if (!main) return;
    for (const child of main.children) {
      if (!(child instanceof HTMLElement) || child === panel || child.hasAttribute("data-sidecar-settings-panel")) continue;
      if (child.dataset.sidecarPreviousDisplay !== undefined) {
        child.style.display = child.dataset.sidecarPreviousDisplay;
        delete child.dataset.sidecarPreviousDisplay;
      }
    }
  }

  function activateNativeSettingsPanel() {
    const { nav, main } = nativeSettingsParts();
    const panel = document.getElementById("bennett-ui-native-settings-panel");
    const button = document.getElementById("bennett-ui-native-settings-nav");
    if (!nav || !main || !panel || !button) return;
    window.dispatchEvent(new CustomEvent("codex-sidecar-settings-select", { detail: { id: "bennett-ui" } }));
    nativeSettingsActive = true;
    nav.querySelectorAll("[aria-current='page']").forEach((node) => node.removeAttribute("aria-current"));
    button.setAttribute("aria-current", "page");
    for (const child of main.children) {
      if (!(child instanceof HTMLElement) || child === panel || child.hasAttribute("data-sidecar-settings-panel")) continue;
      if (child.dataset.sidecarPreviousDisplay === undefined) child.dataset.sidecarPreviousDisplay = child.style.display || "";
      child.style.display = "none";
    }
    panel.hidden = false;
    refreshSettingsPanel();
  }

  function installNativeSettingsPanel() {
    document.getElementById("bennett-ui-settings-launcher")?.remove();
    document.getElementById("bennett-ui-settings-dialog")?.remove();
    const { nav, main } = nativeSettingsParts();
    if (!nav || !main) return;
    const existingNav = document.getElementById("bennett-ui-native-settings-nav");
    const existingPanel = document.getElementById("bennett-ui-native-settings-panel");
    if (existingNav?.isConnected && existingPanel?.isConnected && existingPanel.parentElement === main) return;

    let navButton = document.getElementById("bennett-ui-native-settings-nav");
    if (!navButton) {
      const template = nav.querySelector("button[data-settings-panel-slug]");
      if (!template) return;
      navButton = template.cloneNode(false);
      navButton.id = "bennett-ui-native-settings-nav";
      navButton.type = "button";
      navButton.dataset.settingsPanelSlug = "bennett-ui";
      navButton.removeAttribute("aria-current");
      navButton.setAttribute("aria-label", "界面增强");
      navButton.innerHTML = '<div class="flex min-w-0 items-center text-base gap-2 flex-1 text-default"><span class="flex w-4 shrink-0 items-center justify-center" aria-hidden="true">◈</span><span class="text-fade-truncate">界面增强</span></div>';
      navButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        activateNativeSettingsPanel();
      }, true);
      const anchor = nav.querySelector("button[data-settings-panel-slug='plugins']") || template;
      const wrapper = document.createElement("div");
      wrapper.className = "contents";
      wrapper.dataset.sidecarSettingsNav = "bennett-ui";
      wrapper.appendChild(navButton);
      anchor.parentElement?.after(wrapper);
    }

    let panel = document.getElementById("bennett-ui-native-settings-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "bennett-ui-native-settings-panel";
      panel.className = "codex-plus-panel bennett-ui-native-settings-panel";
      panel.dataset.codexPlusPanel = "bennettUi";
      panel.dataset.sidecarSettingsPanel = "bennett-ui";
      panel.hidden = true;
      panel.innerHTML = settingsPanelHtml();
      bindSettingsPanel(panel);
      main.appendChild(panel);
    }
    ensureSettingsStyle();
    if (nativeSettingsActive) activateNativeSettingsPanel();
    refreshSettingsPanel();
  }

  function settingsPanelHtml() {
    const groups = [
      {
        id: "usage",
        title: "额度",
        features: ["show-usage-in-sidebar", "hide-usage-alert", "hide-upgrade-prompts"],
      },
      {
        id: "sidebar",
        title: "侧栏与项目",
        features: ["sidebar-project-backgrounds", "sidebar-conversation-colors"],
      },
      {
        id: "editor",
        title: "编辑与会话",
        features: ["render-markdown-preview-math", "slash-menu-polish", "thread-markdown-export", "thread-permanent-delete"],
      },
    ];
    const badges = {
      "show-usage-in-sidebar": "需额度数据",
      "render-markdown-preview-math": "LaTeX",
      "thread-markdown-export": "本地会话",
      "thread-permanent-delete": "不可撤销",
    };
    return `
      <div class="bennett-ui-settings-page">
        ${groups.map((group) => `
          <section class="bennett-ui-settings-section" data-bennett-ui-section="${escapeAttr(group.id)}">
            <h2 class="bennett-ui-section-title">${escapeHtmlLocal(group.title)}</h2>
            <div class="bennett-ui-settings-group">
              ${group.features.map((id) => featureInfo.find((item) => item.id === id)).filter(Boolean).map((item) => `
                <div class="codex-plus-row bennett-ui-feature-row" data-bennett-ui-row="${escapeAttr(item.id)}">
                  <div class="bennett-ui-feature-copy">
                    <div class="bennett-ui-feature-title-line">
                      <div class="codex-plus-row-title">${escapeHtmlLocal(item.title)}</div>
                      ${badges[item.id] ? `<span class="bennett-ui-feature-badge" data-tone="${item.id === "thread-permanent-delete" ? "danger" : "neutral"}">${escapeHtmlLocal(badges[item.id])}</span>` : ""}
                    </div>
                    <div class="codex-plus-row-description">${escapeHtmlLocal(item.detail)}</div>
                  </div>
                  <button type="button" role="switch" aria-label="${escapeAttr(item.title)}" aria-checked="false" class="codex-plus-toggle bennett-ui-toggle" data-bennett-ui-feature="${escapeAttr(item.id)}" ${item.disabled ? "disabled" : ""}><span></span></button>
                </div>
              `).join("")}
            </div>
          </section>
        `).join("")}
        <div class="bennett-ui-settings-footer">Bennett UI Improvements · ${escapeHtmlLocal(VERSION)}</div>
      </div>
    `;
  }

  function refreshSettingsPanel(root = document) {
    for (const item of featureInfo) {
      const row = root.querySelector(`[data-bennett-ui-row="${cssEscape(item.id)}"]`);
      const toggle = row?.querySelector("[data-bennett-ui-feature]");
      if (!toggle) continue;
      toggle.dataset.enabled = String(featureEnabled(item.id));
      toggle.dataset.support = item.disabled ? "unsupported" : "supported";
      toggle.setAttribute("aria-checked", String(featureEnabled(item.id)));
      row.dataset.enabled = String(featureEnabled(item.id));
    }
  }

  function ensureSettingsStyle() {
    if (document.getElementById("bennett-ui-settings-style")) return;
    const style = document.createElement("style");
    style.id = "bennett-ui-settings-style";
    style.textContent = `
      [data-bennett-ui-settings-root="true"] {
        display: block;
        width: 100%;
        color: var(--color-text-primary, var(--color-token-text-primary, #1a1c1f));
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-settings-page {
        display: flex;
        flex-direction: column;
        gap: 36px;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-settings-section {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-section-title {
        margin: 0;
        color: var(--color-text-primary, var(--color-token-text-primary, currentColor));
        font-size: 16px;
        font-weight: 600;
        line-height: 1.4;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-settings-group {
        overflow: hidden;
        border: 1px solid var(--color-border-default, color-mix(in srgb, currentColor 14%, transparent));
        border-radius: 14px;
        background: var(--color-background-primary, transparent);
      }
      [data-bennett-ui-settings-root="true"] .codex-plus-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 28px;
        min-height: 76px;
        padding: 15px 20px;
        border-bottom: 1px solid var(--color-border-default, color-mix(in srgb, currentColor 11%, transparent));
      }
      [data-bennett-ui-settings-root="true"] .codex-plus-row:last-child { border-bottom: 0; }
      [data-bennett-ui-settings-root="true"] .bennett-ui-feature-copy {
        min-width: 0;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-feature-title-line {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      [data-bennett-ui-settings-root="true"] .codex-plus-row-title {
        color: var(--color-text-primary, currentColor);
        font-size: 14px;
        font-weight: 600;
        line-height: 1.35;
      }
      [data-bennett-ui-settings-root="true"] .codex-plus-row-description {
        margin-top: 4px;
        color: var(--color-text-secondary, var(--color-token-text-secondary, #8f96a3));
        font-size: 13px;
        line-height: 1.45;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-feature-badge {
        flex: 0 0 auto;
        padding: 2px 6px;
        border-radius: 999px;
        background: var(--color-background-secondary, color-mix(in srgb, currentColor 7%, transparent));
        color: var(--color-text-secondary, #737982);
        font-size: 11px;
        font-weight: 500;
        line-height: 1.35;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-feature-badge[data-tone="danger"] {
        background: color-mix(in srgb, #ef4444 10%, transparent);
        color: var(--color-text-danger, #c24141);
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-toggle {
        flex: 0 0 auto;
        width: 34px;
        height: 20px;
        padding: 2px;
        border: 0;
        border-radius: 999px;
        background: color-mix(in srgb, currentColor 18%, transparent);
        cursor: pointer;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-toggle[data-enabled="true"] {
        background: var(--color-chart-blue, #3b82f6);
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-toggle span {
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: white;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .16);
        transition: transform .15s ease;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-toggle:focus-visible {
        outline: 2px solid var(--color-focus-ring, #3998f6);
        outline-offset: 2px;
      }
      [data-bennett-ui-settings-root="true"] .bennett-ui-settings-footer {
        padding-top: 2px;
        color: var(--color-text-tertiary, var(--color-text-secondary, #8f96a3));
        font-size: 12px;
        line-height: 1.4;
      }
      .bennett-ui-native-settings-panel {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        overflow: auto;
        padding: 32px clamp(24px, 5vw, 72px) 64px;
        background: var(--color-background-primary, #11141a);
        color: var(--color-text-primary, #f3f4f6);
      }
      .bennett-ui-native-settings-panel[hidden] { display: none !important; }
      .bennett-ui-native-settings-panel .codex-plus-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 24px;
        padding: 14px 16px;
        border: 1px solid var(--color-border-default, rgba(127,127,127,.28));
        border-bottom: 0;
        background: var(--color-background-panel, var(--color-background-primary-soft-alpha, rgba(127,127,127,.06)));
      }
      .bennett-ui-native-settings-panel .codex-plus-row:first-child { border-radius: 16px 16px 0 0; }
      .bennett-ui-native-settings-panel .codex-plus-row:last-child { border-bottom: 1px solid var(--color-border-default, rgba(127,127,127,.28)); border-radius: 0 0 16px 16px; }
      .bennett-ui-native-settings-panel .codex-plus-row-title { color: var(--color-text-primary, #f3f4f6) !important; font-weight: 600; }
      .bennett-ui-native-settings-panel .codex-plus-row-description,
      .bennett-ui-native-settings-panel .bennett-ui-feature-status { color: var(--color-text-secondary, #a1a1aa) !important; }
      .bennett-ui-native-settings-panel .bennett-ui-toggle {
        flex: 0 0 auto;
        width: 34px;
        height: 20px;
        padding: 2px;
        border: 0;
        border-radius: 999px;
        background: color-mix(in srgb, currentColor 18%, transparent);
        cursor: pointer;
      }
      .bennett-ui-native-settings-panel .bennett-ui-toggle[data-enabled="true"] { background: var(--color-chart-blue, #3b82f6); }
      .bennett-ui-native-settings-panel .bennett-ui-toggle span { display: block; width: 16px; height: 16px; border-radius: 50%; background: white; transition: transform .15s ease; }
      [data-codex-plus-panel="bennettUi"] {
        color: #f3f4f6 !important;
        color-scheme: dark;
      }
      [data-codex-plus-panel="bennettUi"] .codex-plus-row-title {
        color: #f3f4f6 !important;
      }
      [data-codex-plus-panel="bennettUi"] .codex-plus-row-description {
        color: #a1a1aa !important;
      }
      .bennett-ui-settings-note,
      .bennett-ui-feature-status {
        margin-top: 6px;
        color: #a1a1aa !important;
        font-size: 12px;
        line-height: 1.35;
      }
      .bennett-ui-feature-row[data-enabled="true"] .bennett-ui-feature-status {
        color: #d1d5db !important;
      }
      .bennett-ui-toggle[disabled] {
        cursor: not-allowed;
        opacity: 0.45;
      }
      .bennett-ui-toggle[data-enabled="true"] span {
        transform: translateX(14px);
      }
      #bennett-ui-settings-launcher {
        position: fixed;
        right: 92px;
        bottom: 18px;
        z-index: 2147482999;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 10px;
        padding: 9px 12px;
        background: #171b22;
        color: #f3f4f6;
        font: 600 12px/1.2 system-ui, sans-serif;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        cursor: pointer;
      }
      #bennett-ui-settings-dialog {
        width: min(720px, 92vw);
        max-height: min(820px, 88vh);
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 14px;
        background: #11141a;
        color: #f3f4f6;
      }
      #bennett-ui-settings-dialog::backdrop {
        background: rgba(0, 0, 0, 0.58);
      }
      #bennett-ui-settings-dialog [data-codex-plus-panel="bennettUi"] {
        display: grid;
        max-height: min(820px, 88vh);
        overflow: auto;
        padding: 10px 18px 18px;
      }
      #bennett-ui-settings-dialog .codex-plus-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        padding: 14px 2px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      #bennett-ui-settings-dialog .codex-plus-row-title {
        font-weight: 650;
      }
      #bennett-ui-settings-dialog .codex-plus-row-description {
        margin-top: 4px;
        line-height: 1.45;
      }
      #bennett-ui-settings-dialog .bennett-ui-toggle {
        flex: 0 0 auto;
        width: 34px;
        height: 20px;
        padding: 2px;
        border: 0;
        border-radius: 999px;
        background: #3f4652;
        cursor: pointer;
      }
      #bennett-ui-settings-dialog .bennett-ui-toggle[data-enabled="true"] {
        background: #2fbf8f;
      }
      #bennett-ui-settings-dialog .bennett-ui-toggle span {
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: white;
        transition: transform 0.15s ease;
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHtmlLocal(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[ch]);
  }

  function escapeAttr(value) {
    return escapeHtmlLocal(value);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  window[INSTALL_KEY] = {
    version: VERSION,
    scriptLoadId: SCRIPT_LOAD_ID,
    api,
    features,
    featureInfo,
    threadActionsStatus() {
      return sessionThreadActions.status();
    },
    setFeature(id, enabled, reload = false) {
      setFeatureEnabled(id, enabled);
      if (reload) window.location.reload();
    },
    stop() {
      for (const timer of lifecycleTimers) window.clearTimeout(timer);
      lifecycleTimers.clear();
      settingsObserver?.disconnect();
      settingsPageHandle?.unregister?.();
      settingsPageHandle = null;
      if (settingsScanTimer) window.clearTimeout(settingsScanTimer);
      window.removeEventListener("codex-sidecar-settings-select", handleSidecarSettingsSelect);
      document.removeEventListener("click", handleNativeSettingsNavigation, true);
      deactivateNativeSettingsPanel();
      document.querySelectorAll('[data-codex-plus-tab="bennettUi"]').forEach((node) => node.remove());
      document.querySelectorAll('[data-codex-plus-panel="bennettUi"]').forEach((node) => node.remove());
      document.querySelectorAll('[data-sidecar-settings-nav="bennett-ui"]').forEach((node) => node.remove());
      document.getElementById("bennett-ui-settings-launcher")?.remove();
      document.getElementById("bennett-ui-settings-dialog")?.remove();
      const settingsModal = document.querySelector(".codex-plus-modal-content");
      if (settingsModal?.dataset.bennettUiSettingsLoadId === SCRIPT_LOAD_ID) {
        delete settingsModal.dataset.bennettUiSettingsLoadId;
        delete settingsModal.dataset.bennettUiSettingsVersion;
      }
      document.getElementById("bennett-ui-settings-style")?.remove();
      if (typeof tweak.stop === "function") {
        tweak.stop.call(tweak);
      }
    },
  };

  reportLifecycle("script-loaded", {
    readyState: document.readyState,
    activeFeatures: Array.from(tweak._state?.features?.keys?.() || []),
  });
  scheduleLifecycle(() => {
    const usageBox = document.querySelector('[data-codexpp="usage-box"], [data-codexpp="usage-boxes"]');
    reportLifecycle("script-settled", {
      activeFeatures: Array.from(tweak._state?.features?.keys?.() || []),
      usageMounted: Boolean(usageBox),
      usageSlotMode: usageBox?.parentElement?.dataset?.codexppUsageSlot || "",
      asideCount: document.querySelectorAll("aside").length,
    });
  }, 1500);

  function createProjectColorCompatibleApi(baseApi) {
    const baseStorage = baseApi.storage;
    const legacyKey = `${LEGACY_STORAGE_PREFIX}${PROJECT_COLOR_STORAGE_KEY}`;
    const loaderKey = `${LOADER_STORAGE_PREFIX}${PROJECT_COLOR_STORAGE_KEY}`;

    const readRecord = (key) => {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw == null) return null;
        const value = JSON.parse(raw);
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
      } catch {
        return null;
      }
    };

    const writeBoth = (value) => {
      const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      try {
        const serialized = JSON.stringify(record);
        window.localStorage.setItem(legacyKey, serialized);
        window.localStorage.setItem(loaderKey, serialized);
      } catch {
        // The delegated storage call below retains the active runtime's behavior.
      }
      try {
        baseStorage.set(PROJECT_COLOR_STORAGE_KEY, record);
      } catch {
        // Project coloring remains usable for this renderer through its in-memory cache.
      }
      return record;
    };

    const readAndMigrate = (fallback) => {
      const legacy = readRecord(legacyKey);
      const loader = readRecord(loaderKey);
      const cache = window.__codexppSidebarProjectColorPrefs;
      const cached = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : null;
      let active = null;
      try {
        const value = baseStorage.get(PROJECT_COLOR_STORAGE_KEY, null);
        if (value && typeof value === "object" && !Array.isArray(value)) active = value;
      } catch {
        // Direct localStorage reads above are sufficient when the API is unavailable.
      }
      const merged = {
        ...(legacy || {}),
        ...(loader || {}),
        ...(loader ? {} : active || {}),
        ...(cached || {}),
      };
      if (!legacy && !loader && !active && !cached) return fallback;
      return writeBoth(merged);
    };

    const storage = Object.freeze({
      get(key, fallback = null) {
        return String(key) === PROJECT_COLOR_STORAGE_KEY
          ? readAndMigrate(fallback)
          : baseStorage.get(key, fallback);
      },
      set(key, value) {
        return String(key) === PROJECT_COLOR_STORAGE_KEY
          ? writeBoth(value)
          : baseStorage.set(key, value);
      },
      delete(key) {
        if (String(key) !== PROJECT_COLOR_STORAGE_KEY) return baseStorage.delete(key);
        try {
          window.localStorage.removeItem(legacyKey);
          window.localStorage.removeItem(loaderKey);
        } catch {}
        try {
          baseStorage.delete(PROJECT_COLOR_STORAGE_KEY);
        } catch {}
      },
    });

    return Object.freeze({ ...baseApi, storage });
  }

  function createBigPizzaRendererApi() {
    const storagePrefix = "bennett-ui-improvements:";
    const blockedFeatureKeys = new Set([
    ]);
    const noop = () => {};
    const logWith = (level) => (...args) => {
      const fn = console[level] || console.log || noop;
      fn.call(console, "[Bennett UI/BigPizza]", ...args);
    };

    const storage = {
      get(key, fallback) {
        if (blockedFeatureKeys.has(key)) return false;
        try {
          const raw = window.localStorage.getItem(storagePrefix + key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        try {
          window.localStorage.setItem(storagePrefix + key, JSON.stringify(value));
        } catch {
          // localStorage can be disabled; UI tweaks should still run.
        }
        return value;
      },
      delete(key) {
        try {
          window.localStorage.removeItem(storagePrefix + key);
        } catch {
          // Ignore storage failures.
        }
      },
    };

    return {
      storage,
      log: {
        debug: logWith("debug"),
        info: logWith("info"),
        warn: logWith("warn"),
        error: logWith("error"),
      },
      ipc: {
        invoke(channel) {
          return Promise.reject(
            new Error(`BigPizza Codex++ user scripts do not expose b-nnett IPC channel: ${channel}`),
          );
        },
      },
    };
  }
  if (loaderApi) module.exports = {};
})();
