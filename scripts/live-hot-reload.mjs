import process from "node:process";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CdpInjector, connectCdpSession, listTargets, pickCodexTargets } from "../src/cdp.mjs";
import { LoaderHostBridge } from "../src/loader-bridge.mjs";
import { LiveSupervisor } from "../src/live-runtime.mjs";
import { loadScriptDescriptor } from "../src/manifest.mjs";
import { ScriptRegistry } from "../src/registry.mjs";
import { UiController } from "../src/ui-controller.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const port = Number(option("--port", "9229"));
const expectedVersion = option("--version", "1.4.10");
const captureLabel = option("--capture-label", "current").replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "") || "current";
const packageDirectory = fileURLToPath(new URL("../packages/bennett-ui-improvements/", import.meta.url));
const descriptor = await loadScriptDescriptor(packageDirectory);
if (descriptor.version !== expectedVersion) throw new Error(`package version ${descriptor.version} does not match ${expectedVersion}`);
const targets = pickCodexTargets(await listTargets(port)).filter(target => target.url === "app://-/index.html");
if (targets.length < 1) throw new Error("no exact app://-/index.html renderer target was found");
const dataRoot = fileURLToPath(new URL("../.runtime/manual/", import.meta.url));
const registry = await new ScriptRegistry(path.resolve(dataRoot)).init();
const targetProvider = async () => pickCodexTargets(await listTargets(port));
const sessionFactory = endpoint => connectCdpSession(endpoint);
const injector = new CdpInjector({ targetProvider, sessionFactory });
const supervisor = new LiveSupervisor({ registry, injector, targetProvider });
const controller = new UiController({ registry, injector, supervisor });
let lastBridgeDispatch = null;
const bridge = new LoaderHostBridge({
  targetProvider,
  sessionFactory,
  dispatch: async (command, payload) => {
    const result = await controller.dispatch(command, payload);
    if (command === "reload_scripts") lastBridgeDispatch = result;
    return result;
  },
});
supervisor.hostBridge = bridge;
const session = await connectCdpSession(targets[0].webSocketDebuggerUrl);
const runtimeExceptions = [];
const unrelatedExceptions = new Map();
session.onEvent?.(message => {
  if (message.method !== "Runtime.exceptionThrown") return;
  const description = String(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "renderer exception");
  if (/bennett-ui-improvements|codex-script-loader/iu.test(description)) runtimeExceptions.push(description);
  else unrelatedExceptions.set(description, (unrelatedExceptions.get(description) || 0) + 1);
});
await session.sendCommand("Runtime.enable", {});
const evaluate = async expression => {
  const result = await session.sendCommand("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "renderer evaluation failed");
  return result?.result?.value;
};
const snapshotExpression = `(() => {
  const lifecycle = globalThis.__bennettUiImprovementsBigPizza;
  const host = globalThis.__codexScriptLoader?.settingsHost;
  return {
    version: lifecycle?.version || null,
    scriptLoadId: lifecycle?.scriptLoadId || null,
    hasStop: typeof lifecycle?.stop === "function",
    hasSetFeature: typeof lifecycle?.setFeature === "function",
    features: Array.isArray(lifecycle?.features) ? [...lifecycle.features] : [],
    loaderStatus: globalThis.__codexScriptLoader?.scripts?.["co.bennett.ui-improvements"]?.status || null,
    settingsHost: host?.snapshot?.() || null,
    tweaksGroups: document.querySelectorAll('[data-codex-loader-settings="pages-group"]').length,
    loaderEntries: document.querySelectorAll('[data-codex-loader-settings="nav:loader:runtime"]').length,
    settingsEntries: document.querySelectorAll('[data-codex-loader-settings="nav:co.bennett.ui-improvements:main"]').length,
    settingsPanels: document.querySelectorAll('[data-codex-loader-settings="panel-host"]').length,
    legacySettingsEntries: document.querySelectorAll('#bennett-ui-native-settings-nav, [data-codex-plus-tab="bennettUi"]').length,
    usageControls: document.querySelectorAll('[data-codexpp="usage-box"], [data-codexpp="usage-boxes"]').length,
    usageText: String(document.querySelector('[data-codexpp="usage-box"], [data-codexpp="usage-boxes"]')?.textContent || "").replace(/\\s+/g, " ").trim(),
    usageRefreshButtons: document.querySelectorAll('[data-codexpp="usage-box"] button, [data-codexpp="usage-boxes"] button').length,
    projectStyle: document.querySelectorAll('#codexpp-sidebar-project-backgrounds').length,
    conversationStyle: document.querySelectorAll('#codexpp-sidebar-conversation-colors').length,
    settingsStyle: document.querySelectorAll('#bennett-ui-settings-style').length,
    removedNativeDuplicateArtifacts: document.querySelectorAll('#codexpp-settings-search-style, #codexpp-match-sidebar-width, [data-codexpp-settings-search], [data-codexpp-settings-search-hidden], [data-codexpp-settings-search-highlight]').length,
    settingsPanelVisible: Boolean(document.querySelector('[data-codex-loader-settings="panel-host"] [data-bennett-ui-settings-root="true"]')),
    settingsNavPresent: Boolean(document.querySelector("nav[aria-label='设置'], nav[aria-label='Settings']")),
    floatingButtons: document.querySelectorAll('#bennett-ui-settings-launcher, #codex-script-loader-control-button').length,
    featureRows: document.querySelectorAll('[data-bennett-ui-row]').length,
    featureToggles: document.querySelectorAll('[data-bennett-ui-feature]').length,
    oldNativePanels: document.querySelectorAll('#bennett-ui-native-settings-panel, #bennett-ui-settings-dialog').length,
    lastLifecycle: globalThis.__bennettUiLastLifecycle || null
  };
})()`;

async function clickAt(rect) {
  await session.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await session.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

try {
  const before = await evaluate(snapshotExpression);
  await supervisor.tick({ force: true, restartIds: "all", targets });
  await new Promise(resolve => setTimeout(resolve, 2200));
  const first = await evaluate(snapshotExpression);
  if (!first.settingsNavPresent) {
    const profileRect = await evaluate(`(() => { const target = [...document.querySelectorAll("button")].find(node => /^(open profile menu|打开个人资料菜单)$/iu.test(String(node.getAttribute("aria-label") || "").trim())); if (!target) return null; const rect = target.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    if (!profileRect) throw new Error("Codex profile menu control was not found");
    await clickAt(profileRect);
    await new Promise(resolve => setTimeout(resolve, 300));
    const settingsRect = await evaluate(`(() => { const visible = node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }; const target = [...document.querySelectorAll("[role='menuitem'], [role='menu'] button")].find(node => visible(node) && /(settings|preferences|设置|偏好)/iu.test(String(node.innerText || node.getAttribute("aria-label") || "").trim())); if (!target) return null; const rect = target.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    if (!settingsRect) throw new Error("Codex Settings menu item was not found");
    await clickAt(settingsRect);
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  const screenshotDirectory = fileURLToPath(new URL("../.runtime/qa-after/", import.meta.url));
  await mkdir(screenshotDirectory, { recursive: true });
  const nativeScreenshot = await session.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const nativeScreenshotPath = path.join(screenshotDirectory, `${captureLabel}-native-settings.png`);
  await writeFile(nativeScreenshotPath, Buffer.from(nativeScreenshot.data, "base64"));
  const nativeLayoutMetrics = await evaluate(`(() => {
    const visible = node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left > innerWidth * 0.2; };
    const h1 = [...document.querySelectorAll('h1')].find(visible);
    const h2 = [...document.querySelectorAll('h2')].find(visible);
    const rect = node => { if (!node) return null; const box = node.getBoundingClientRect(); return { top: box.top, left: box.left, width: box.width, height: box.height }; };
    return { title: String(h1?.textContent || '').trim(), section: String(h2?.textContent || '').trim(), titleRect: rect(h1), sectionRect: rect(h2), titleStyle: h1 ? { fontSize: getComputedStyle(h1).fontSize, lineHeight: getComputedStyle(h1).lineHeight, fontWeight: getComputedStyle(h1).fontWeight } : null };
  })()`);
  const loaderRect = await evaluate(`(() => { const target = document.querySelector('[data-codex-loader-settings="nav:loader:runtime"]'); if (!target) return null; const rect = target.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  if (!loaderRect) throw new Error("Loader settings entry was not mounted before Tweaks");
  await clickAt(loaderRect);
  await new Promise(resolve => setTimeout(resolve, 500));
  const loaderBeforeReload = await evaluate(`(() => {
    const host = document.querySelector('[data-codex-loader-settings="panel-host"]');
    const button = [...(host?.querySelectorAll('button') || [])].find(node => /reload|重新加载/iu.test(String(node.textContent || '')));
    const groups = [...document.querySelectorAll('[data-codex-loader-settings="pages-group"] > div')].map(node => String(node.firstElementChild?.textContent || '').trim());
    const sectionTitle = host?.querySelector('section h2');
    const card = sectionTitle?.nextElementSibling;
    const row = card?.firstElementChild;
    const title = row?.querySelector('.text-token-text-primary');
    const description = row?.querySelector('.text-token-description-foreground');
    return {
      locale: String(document.documentElement.lang || navigator.language || ''),
      groups,
      connected: /Connected|已连接/u.test(String(host?.textContent || '')),
      buttonDisabled: button?.disabled ?? null,
      buttonText: String(button?.textContent || '').replace(/\\s+/g, ' ').trim(),
      systemStyle: {
        sectionFontSize: sectionTitle ? getComputedStyle(sectionTitle).fontSize : null,
        sectionFontWeight: sectionTitle ? getComputedStyle(sectionTitle).fontWeight : null,
        cardRadius: card ? getComputedStyle(card).borderRadius : null,
        rowMinHeight: row ? getComputedStyle(row).minHeight : null,
        rowPadding: row ? getComputedStyle(row).padding : null,
        titleFontSize: title ? getComputedStyle(title).fontSize : null,
        descriptionFontSize: description ? getComputedStyle(description).fontSize : null,
        titleRect: (() => { const node = host?.querySelector('h1'); if (!node) return null; const box = node.getBoundingClientRect(); return { top: box.top, left: box.left, width: box.width, height: box.height }; })(),
        sectionRect: (() => { if (!sectionTitle) return null; const box = sectionTitle.getBoundingClientRect(); return { top: box.top, left: box.left, width: box.width, height: box.height }; })(),
      },
    };
  })()`);
  if (!loaderBeforeReload.connected || loaderBeforeReload.buttonDisabled !== false) throw new Error(`Loader page is not connected: ${JSON.stringify(loaderBeforeReload)}`);
  if (loaderBeforeReload.systemStyle.cardRadius !== "14px" || loaderBeforeReload.systemStyle.rowMinHeight !== "76px" || loaderBeforeReload.systemStyle.sectionFontWeight !== "600") {
    throw new Error(`Loader page did not use the expected native settings metrics: ${JSON.stringify(loaderBeforeReload.systemStyle)}`);
  }
  const screenshot = await session.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const screenshotPath = path.join(screenshotDirectory, `${captureLabel}-loader-settings.png`);
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  const reloadRect = await evaluate(`(() => { const host = document.querySelector('[data-codex-loader-settings="panel-host"]'); const target = [...(host?.querySelectorAll('button') || [])].find(node => /reload|重新加载/iu.test(String(node.textContent || ''))); if (!target) return null; const rect = target.getBoundingClientRect(); target.click(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  if (!reloadRect) throw new Error("Reload scripts button was not found");
  await new Promise(resolve => setTimeout(resolve, 2600));
  const loaderAfterReload = await evaluate(`(() => { const host = document.querySelector('[data-codex-loader-settings="panel-host"]'); return { text: String(host?.textContent || '').replace(/\\s+/g, ' ').trim(), reloadCount: globalThis.__codexScriptLoader?.scripts?.["co.bennett.ui-improvements"]?.status || null }; })()`);
  if (!/Reloaded 1 plugin across 1 Codex page\.|已重新加载 1 个插件，已应用到 1 个 Codex 页面。/u.test(loaderAfterReload.text)) throw new Error(`Loader reload feedback is missing: ${JSON.stringify({ loaderAfterReload, lastBridgeDispatch })}`);

  const entryRect = await evaluate(`(() => { const target = document.querySelector('[data-codex-loader-settings="nav:co.bennett.ui-improvements:main"]'); if (!target) return null; target.click(); const rect = target.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  if (!entryRect) throw new Error("Bennett UI entry was not mounted under Tweaks");
  await new Promise(resolve => setTimeout(resolve, 700));
  const afterSettingsOpen = await evaluate(snapshotExpression);
  const bennettSettingsLayout = await evaluate(`(() => ({
    sections: [...document.querySelectorAll('[data-bennett-ui-section]')].map(section => ({
      id: section.getAttribute('data-bennett-ui-section'),
      features: [...section.querySelectorAll('[data-bennett-ui-row]')].map(row => row.getAttribute('data-bennett-ui-row')),
    })),
  }))()`);
  const bennettScreenshot = await session.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bennettScreenshotPath = path.join(screenshotDirectory, `${captureLabel}-bennett-settings.png`);
  await writeFile(bennettScreenshotPath, Buffer.from(bennettScreenshot.data, "base64"));
  const toggleBefore = await evaluate(`document.querySelector('[data-bennett-ui-feature="hide-upgrade-prompts"]')?.getAttribute('aria-checked') || null`);
  await evaluate(`document.querySelector('[data-bennett-ui-feature="hide-upgrade-prompts"]')?.click()`);
  await new Promise(resolve => setTimeout(resolve, 150));
  const toggleChanged = await evaluate(`document.querySelector('[data-bennett-ui-feature="hide-upgrade-prompts"]')?.getAttribute('aria-checked') || null`);
  await evaluate(`document.querySelector('[data-bennett-ui-feature="hide-upgrade-prompts"]')?.click()`);
  await new Promise(resolve => setTimeout(resolve, 150));
  const toggleRestored = await evaluate(`document.querySelector('[data-bennett-ui-feature="hide-upgrade-prompts"]')?.getAttribute('aria-checked') || null`);
  await controller.dispatch("reload_scripts", { live: true });
  await new Promise(resolve => setTimeout(resolve, 2200));
  const second = await evaluate(snapshotExpression);
  const backRect = await evaluate(`(() => { const nav = document.querySelector("nav[aria-label='设置'], nav[aria-label='Settings']"); const back = nav?.querySelector("[role='link']"); if (!back) return null; const rect = back.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  if (!backRect) throw new Error("Settings back control was not found");
  await clickAt(backRect);
  await new Promise(resolve => setTimeout(resolve, 3000));
  const afterReturn = await evaluate(snapshotExpression);

  if (first.version !== expectedVersion || second.version !== expectedVersion) throw new Error(`Bennett lifecycle version does not match ${expectedVersion}`);
  if (first.loaderStatus !== "running" || second.loaderStatus !== "running") throw new Error("Loader did not report Bennett as running");
  if (!first.hasStop || !first.hasSetFeature || first.features.length !== 10) throw new Error(`Bennett ${expectedVersion} lifecycle API or feature list is incomplete`);
  if (!afterSettingsOpen.settingsPanelVisible || afterSettingsOpen.featureToggles !== first.features.length) throw new Error(`Bennett settings page did not open with all feature toggles: ${JSON.stringify(afterSettingsOpen)}`);
  const usageSection = bennettSettingsLayout.sections.find(section => section.id === "usage");
  if (!usageSection || JSON.stringify(usageSection.features) !== JSON.stringify(["show-usage-in-sidebar", "hide-usage-alert", "hide-upgrade-prompts"])) throw new Error(`quota settings order is incorrect: ${JSON.stringify(bennettSettingsLayout)}`);
  if (bennettSettingsLayout.sections.some(section => section.id === "interface")) throw new Error(`obsolete Codex interface settings section is still present: ${JSON.stringify(bennettSettingsLayout)}`);
  if (toggleBefore === null || toggleChanged === toggleBefore || toggleRestored !== toggleBefore) throw new Error(`Bennett switch interaction failed: ${JSON.stringify({ toggleBefore, toggleChanged, toggleRestored })}`);
  if (first.scriptLoadId === second.scriptLoadId) throw new Error("second injection did not replace the lifecycle instance");
  if (runtimeExceptions.length) throw new Error(`renderer reported ${runtimeExceptions.length} uncaught exception(s): ${runtimeExceptions.join(" | ")}`);
  for (const key of ["tweaksGroups", "settingsEntries", "settingsPanels", "usageControls", "projectStyle", "conversationStyle", "settingsStyle"]) {
    if (second[key] > 1) throw new Error(`duplicate Bennett/Loader nodes detected for ${key}`);
  }
  if (second.settingsHost?.builtinPageCount !== 1 || second.settingsHost?.pageCount !== 1) throw new Error(`unexpected registered settings page count: ${JSON.stringify(second.settingsHost)}`);
  if (!second.settingsPanelVisible || second.featureToggles !== first.features.length) throw new Error(`Bennett settings page did not survive hot reload: ${JSON.stringify(second)}`);
  if (second.legacySettingsEntries !== 0 || second.oldNativePanels !== 0 || second.floatingButtons !== 0) throw new Error("legacy or floating settings controls are still present");
  if (first.removedNativeDuplicateArtifacts !== 0 || second.removedNativeDuplicateArtifacts !== 0) throw new Error("removed native-duplicate settings tweaks left renderer artifacts behind");
  if (afterReturn.settingsNavPresent) throw new Error(`Codex did not leave Settings: ${JSON.stringify(afterReturn)}`);
  if (afterReturn.usageControls !== 1 || !afterReturn.usageText) throw new Error(`Bennett quota control was not restored with display content: ${JSON.stringify(afterReturn)}`);
  console.log(JSON.stringify({ port, targetCount: targets.length, target: { id: targets[0].id, url: targets[0].url }, packageDirectory, nativeScreenshotPath, screenshotPath, bennettScreenshotPath, nativeLayoutMetrics, runtimeExceptions, unrelatedExceptions: [...unrelatedExceptions].slice(0, 5).map(([error, count]) => ({ error, count })), loaderBeforeReload, loaderAfterReload, bennettSettingsLayout, toggleInteraction: { before: toggleBefore, changed: toggleChanged, restored: toggleRestored }, before, first, afterSettingsOpen, second, afterReturn }, null, 2));
} finally {
  await bridge.close();
  await session.close();
}
