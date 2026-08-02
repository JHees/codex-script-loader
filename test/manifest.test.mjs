import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempRoot, makeScript } from "./helpers.mjs";
import { describeTextScript, loadScriptDescriptor, MAX_SOURCE_BYTES, validateManifest } from "../src/manifest.mjs";
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

test("text script descriptors reject empty names and oversized UTF-8 source", () => {
  assert.throws(() => describeTextScript({ name: ".js", sourceText: "" }), /include a name/);
  assert.throws(() => describeTextScript({ name: "../bad.js", sourceText: "" }), /path separators/);
  assert.throws(() => describeTextScript({ name: "large.js", sourceText: "界".repeat(Math.ceil(MAX_SOURCE_BYTES / 3) + 1) }), /exceeds/);
});
