import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

export async function makeTempRoot(prefix = "codex-loader-test-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function makeScript(root, { id = "test.example", name = "Test Script", version = "1.0.0", source = "globalThis.__testScriptRuns = (globalThis.__testScriptRuns || 0) + 1;" } = {}) {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name, version, entry: "index.js", scope: "renderer", permissions: ["dom"] }), "utf8");
  await writeFile(path.join(directory, "index.js"), source, "utf8");
  return directory;
}

