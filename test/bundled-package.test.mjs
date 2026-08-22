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
  assert.equal(descriptor.version, "1.3.0");
  assert.equal(descriptor.lifecycleGlobal, "__bennettUiImprovementsBigPizza");
  assert.match(descriptor.source, /Original license: MIT License/u);
  assert.match(descriptor.source, /show-usage-in-sidebar/u);
  assert.match(descriptor.source, /settings-search/u);
  assert.match(descriptor.source, /sidebar-project-backgrounds/u);
  assert.match(descriptor.source, /sidebar-conversation-colors/u);
  assert.match(descriptor.source, /NATIVE_COLOR_MENU_ID = "bennett-ui:project-color"/u);
  assert.match(descriptor.source, /nativeColorSwatchIcon/u);
  assert.match(descriptor.source, /icon: nativeColorSwatchIcon\(colorId\)/u);
  assert.match(descriptor.source, /none: "No color"/u);
  assert.match(descriptor.source, /storedColorFor\(info\) === "none"/u);
  assert.match(descriptor.source, /getContextMenuItems/u);
  assert.match(descriptor.source, /submenu,/u);
  assert.match(descriptor.source, /render-markdown-preview-math/u);
  assert.match(descriptor.source, /slash-menu-polish/u);
  assert.match(descriptor.source, /__bennettMarkdownPreviewMath/u);
  assert.match(descriptor.source, /__bennettUiEmbeddedHistoryLoader/u);
  assert.match(descriptor.source, /degraded: true/u);
  assert.match(descriptor.source, /\/wham\/usage/u);
  assert.doesNotMatch(descriptor.source, /"square-sidebar"/u);
  assert.doesNotMatch(descriptor.source, /"sidebar-action-grid"/u);
  assert.doesNotMatch(descriptor.source, /registerPage/u);
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
    "settings-search",
    "match-sidebar-width",
    "sidebar-project-backgrounds",
    "sidebar-conversation-colors",
    "render-markdown-preview-math",
    "slash-menu-polish",
  ]);

  const root = await makeTempRoot();
  const registry = await new ScriptRegistry(path.join(root, "data")).init();
  await registry.install(packageDirectory, { enabled: true });
  const plan = await registry.buildPlan();
  assert.deepEqual(plan.summary.map(item => item.id), ["co.bennett.ui-improvements"]);
  assert.match(plan.source, /__bennettUiImprovementsBigPizza/u);
});
