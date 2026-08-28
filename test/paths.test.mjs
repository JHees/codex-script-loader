import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getDataRoot, getLayout, isWithinDirectory, assertWithinDirectory, safeScriptIdFromName } from "../src/paths.mjs";

test("data roots are platform-specific and deterministic", () => {
  assert.equal(getDataRoot({ platform: "win32", home: "C:/Users/Test", env: { APPDATA: "C:/Users/Test/AppData/Roaming" } }), path.join("C:/Users/Test/AppData/Roaming", "codex-script-loader"));
  assert.equal(getDataRoot({ platform: "darwin", home: "/Users/test", env: {} }), path.posix.join("/Users/test", "Library", "Application Support", "codex-script-loader"));
  assert.equal(getDataRoot({ platform: "linux", home: "/home/test", env: { XDG_DATA_HOME: "/tmp/data" } }), path.posix.join("/tmp/data", "codex-script-loader"));
});

test("path boundary rejects traversal", () => {
  const layout = getLayout("C:/loader");
  assert.equal(isWithinDirectory(layout.scriptsRoot, path.join(layout.scriptsRoot, "ok")), true);
  assert.equal(isWithinDirectory(layout.scriptsRoot, path.join(layout.scriptsRoot, "..", "outside")), false);
  assert.throws(() => assertWithinDirectory(layout.scriptsRoot, path.join(layout.scriptsRoot, "..", "outside")), /escapes/);
});

test("legacy script ids are normalized", () => {
  assert.equal(safeScriptIdFromName("Example UI.js"), "local.example-ui-js");
});
