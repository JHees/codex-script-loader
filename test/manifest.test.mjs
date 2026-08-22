import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempRoot, makeScript } from "./helpers.mjs";
import { describeTextScript, loadScriptDescriptor, MAX_SOURCE_BYTES, validateManifest } from "../src/manifest.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { integrityLabel, sha256Text } from "../src/hash.mjs";

test("manifest and source descriptor calculate integrity", async () => {
  const root = await makeTempRoot();
  const directory = await makeScript(root, { id: "test.valid", source: "console.log('ok');" });
  const descriptor = await loadScriptDescriptor(directory);
  assert.equal(descriptor.id, "test.valid");
  assert.equal(descriptor.fingerprint, sha256Text("console.log('ok');"));
  assert.equal(integrityLabel(descriptor.fingerprint), `sha256-${descriptor.fingerprint}`);
});

test("manifest rejects absolute and escaping entries", () => {
  const root = "C:/loader/scripts/test";
  assert.throws(() => validateManifest({ id: "test.valid", entry: "C:/outside.js" }, root), /relative/);
  assert.throws(() => validateManifest({ id: "test.valid", entry: "../../outside.js" }, root), /escapes/);
  assert.throws(() => validateManifest({ id: "Bad ID", entry: "index.js" }, root), /invalid script id/);
});

test("manifest accepts a safe lifecycle global and rejects property paths", () => {
  const root = "C:/loader/scripts/test";
  assert.equal(validateManifest({ id: "test.valid", lifecycleGlobal: "__testLifecycle" }, root).lifecycleGlobal, "__testLifecycle");
  assert.equal(validateManifest({ id: "test.valid" }, root).lifecycleGlobal, null);
  assert.throws(() => validateManifest({ id: "test.valid", lifecycleGlobal: "window.bad" }, root), /lifecycleGlobal/);
  assert.throws(() => validateManifest({ id: "test.valid", lifecycleGlobal: "bad-name" }, root), /lifecycleGlobal/);
  assert.throws(() => validateManifest({ id: "test.valid", lifecycleGlobal: "" }, root), /lifecycleGlobal/);
  assert.throws(() => validateManifest({ id: "test.valid", schemaVersion: 2 }, root), /schemaVersion/);
  assert.throws(() => validateManifest({ id: "test.valid", permissions: "dom" }, root), /permissions/);
  assert.throws(() => validateManifest({ id: "test.valid", integrity: "sha256-bad" }, root), /integrity/);
});

test("directory packages enforce the same source size limit", async () => {
  const root = await makeTempRoot();
  const directory = path.join(root, "test.large-package");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ id: "test.large-package", entry: "index.js" }), "utf8");
  await writeFile(path.join(directory, "index.js"), "x".repeat(MAX_SOURCE_BYTES + 1), "utf8");
  await assert.rejects(() => loadScriptDescriptor(directory), /exceeds/);
});

test("text script descriptors reject empty names and oversized UTF-8 source", () => {
  assert.throws(() => describeTextScript({ name: ".js", sourceText: "" }), /include a name/);
  assert.throws(() => describeTextScript({ name: "../bad.js", sourceText: "" }), /path separators/);
  assert.throws(() => describeTextScript({ name: "large.js", sourceText: "界".repeat(Math.ceil(MAX_SOURCE_BYTES / 3) + 1) }), /exceeds/);
});
