import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempRoot, makeScript } from "./helpers.mjs";
import { loadScriptDescriptor, validateManifest } from "../src/manifest.mjs";
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

