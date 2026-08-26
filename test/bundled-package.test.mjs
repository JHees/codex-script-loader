import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScriptDescriptor } from "../src/manifest.mjs";
import { ScriptRegistry } from "../src/registry.mjs";
import { makeTempRoot } from "./helpers.mjs";

const packageDirectory = fileURLToPath(new URL("../packages/bennett-ui-improvements/", import.meta.url));

test("bundled Bennett package is valid, attributed and lifecycle-aware", async () => {
  const descriptor = await loadScriptDescriptor(packageDirectory);
  assert.equal(descriptor.id, "co.bennett.ui-improvements");
  assert.equal(descriptor.version, "1.4.9");
  assert.equal(descriptor.lifecycleGlobal, "__bennettUiImprovementsBigPizza");
  assert.match(descriptor.source, /Original license: MIT License/u);
  assert.match(descriptor.source, /show-usage-in-sidebar/u);
  assert.doesNotMatch(descriptor.source, /\bsettings-search\b/u);
  assert.doesNotMatch(descriptor.source, /\bmatch-sidebar-width\b/u);
  assert.match(descriptor.source, /bennett-ui-native-settings-nav/u);
  assert.match(descriptor.source, /data-settings-panel-slug/u);
  assert.match(descriptor.source, /sidebar-project-backgrounds/u);
  assert.match(descriptor.source, /sidebar-conversation-colors/u);
  assert.match(descriptor.source, /NATIVE_COLOR_MENU_ID = "bennett-ui:project-color"/u);
  assert.match(descriptor.source, /nativeColorSwatchIcon/u);
  assert.match(descriptor.source, /icon: nativeColorSwatchIcon\(colorId\)/u);
  assert.match(descriptor.source, /none: "No color"/u);
  assert.match(descriptor.source, /storedColorFor\(info\) === "none"/u);
  assert.match(descriptor.source, /createProjectColorCompatibleApi/u);
  assert.match(descriptor.source, /LEGACY_STORAGE_PREFIX/u);
  assert.match(descriptor.source, /LOADER_STORAGE_PREFIX/u);
  assert.match(descriptor.source, /promoteColorPreferenceToId/u);
  assert.match(descriptor.source, /info\.id && colorPrefs\[`id:\$\{normalize\(info\.id\)\}`\]/u);
  assert.match(descriptor.source, /getContextMenuItems/u);
  assert.match(descriptor.source, /submenu,/u);
  assert.match(descriptor.source, /render-markdown-preview-math/u);
  assert.match(descriptor.source, /slash-menu-polish/u);
  assert.match(descriptor.source, /thread-title-regeneration/u);
  assert.match(descriptor.source, /bennett-thread-regenerate-title/u);
  assert.match(
    descriptor.source,
    /if \(typeof candidate\.__bennettThreadMenuOriginal === "function"\) return ref;/u,
  );
  assert.match(descriptor.source, /thread\/compact\/start/u);
  assert.match(descriptor.source, /item\/completed/u);
  assert.match(descriptor.source, /contextCompaction/u);
  assert.match(descriptor.source, /thread\/compacted/u);
  assert.match(descriptor.source, /thread\/turns\/list/u);
  assert.match(descriptor.source, /itemsView:\s*"full"/u);
  assert.match(descriptor.source, /existingCompactionTurnIds/u);
  assert.match(descriptor.source, /turn\?\.status === "completed"/u);
  assert.match(descriptor.source, /ephemeral:\s*false/u);
  assert.match(descriptor.source, /threadSource:\s*"system"/u);
  assert.match(descriptor.source, /temporaryTitle:\s*"正在生成标题（\{title\}）"/u);
  assert.match(descriptor.source, /data-bennett-title-working-thread/u);
  assert.match(descriptor.source, /titleWorkingThreadIds\.add\(threadId\)/u);
  assert.match(descriptor.source, /compactingTitle:\s*"压缩中 · \{title\}"/u);
  assert.match(descriptor.source, /generatingTitle:\s*"生成标题 · \{title\}"/u);
  assert.match(descriptor.source, /const progressToast = await showTitleProgress\(/u);
  assert.match(descriptor.source, /nativeToastFromScope/u);
  assert.match(descriptor.source, /hasCloseButton:\s*true/u);
  assert.match(descriptor.source, /duration:\s*timeout === null \? 0 : timeout \/ 1000/u);
  assert.match(descriptor.source, /onRemove:/u);
  assert.match(descriptor.source, /handle = toast\.info/u);
  assert.match(descriptor.source, /events\?\.turnCompletedListeners/u);
  assert.match(descriptor.source, /listeners\.unshift\(listener\)/u);
  assert.match(descriptor.source, /event\.hasPendingContinuation = true/u);
  assert.match(descriptor.source, /notificationGuardedThreadIds\.add\(threadId\)/u);
  assert.match(descriptor.source, /progressToast\.update\(/u);
  assert.match(descriptor.source, /thread\/name\/set/u);
  assert.match(descriptor.source, /regenerateLocalThreadTitle/u);
  assert.match(descriptor.source, /900000/u);
  assert.match(descriptor.source, /thread\/delete/u);
  assert.match(descriptor.source, /excludeTurns:\s*true/u);
  assert.doesNotMatch(descriptor.source, /excludeTurns:\s*false/u);
  assert.match(descriptor.source, /gpt-5\.6-luna/u);
  assert.match(descriptor.source, /model_reasoning_effort:\s*"low"/u);
  assert.match(descriptor.source, /outputSchema:\s*TITLE_OUTPUT_SCHEMA/u);
  assert.match(descriptor.source, /thread-markdown-export/u);
  assert.match(descriptor.source, /thread-permanent-delete/u);
  assert.match(descriptor.source, /__bennettMarkdownPreviewMath/u);
  assert.match(descriptor.source, /looksLikeCurrencySpan/u);
  assert.doesNotMatch(descriptor.source, /MathTableWidget/u);
  assert.doesNotMatch(descriptor.source, /data-bennett-markdown-preview-math-table/u);
  assert.match(descriptor.source, /\/wham\/usage/u);
  assert.doesNotMatch(descriptor.source, /__bennettUiEmbeddedHistoryLoader/u);
  assert.doesNotMatch(descriptor.source, /__codexListPagebuster/u);
  assert.doesNotMatch(descriptor.source, /refresh-recent-conversations-for-host/u);
  assert.doesNotMatch(descriptor.source, /"square-sidebar"/u);
  assert.doesNotMatch(descriptor.source, /"sidebar-action-grid"/u);
  assert.match(descriptor.source, /loaderApi\.settings\.registerPage/u);
  assert.match(descriptor.source, /data-bennett-ui-settings-root/u);
  assert.doesNotMatch(descriptor.source, /api\.process/u);
  assert.doesNotMatch(descriptor.source, /require\("electron"\)/u);
  assert.doesNotMatch(descriptor.source, /const onProjectContextMenu/u);
  assert.doesNotMatch(descriptor.source, /data-codexpp-sidebar-project-color-menu/u);
  assert.doesNotMatch(descriptor.source, /electronBridge\.showContextMenu\s*=/u);

  const definitions = descriptor.source.match(
    /const FEATURE_DEFINITIONS = Object\.freeze\(\[(.*?)\]\);\s*const FEATURE_IDS/su,
  );
  assert.ok(definitions, "canonical feature definitions should exist");
  const featureIds = [...definitions[1].matchAll(/\bid:\s*"([a-z0-9-]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(featureIds, [
    "hide-upgrade-prompts",
    "show-usage-in-sidebar",
    "hide-usage-alert",
    "sidebar-project-backgrounds",
    "sidebar-conversation-colors",
    "render-markdown-preview-math",
    "slash-menu-polish",
    "thread-title-regeneration",
    "thread-markdown-export",
    "thread-permanent-delete",
  ]);

  const root = await makeTempRoot();
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await registry.install(packageDirectory, { enabled: true });
  const plan = await registry.buildPlan();
  assert.deepEqual(plan.summary.map(item => item.id), ["co.bennett.ui-improvements"]);
  assert.match(plan.source, /__bennettUiImprovementsBigPizza/u);
});
