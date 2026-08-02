import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { startManagerServer } from "../src/manager-server.mjs";

function findBrowser() {
  const candidates = process.platform === "win32"
    ? [
        process.env.CODEX_LOADER_BROWSER,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      ]
    : [process.env.CODEX_LOADER_BROWSER, "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const browser = candidates.find(candidate => candidate && existsSync(candidate));
  if (!browser) throw new Error("No supported headless browser found; set CODEX_LOADER_BROWSER");
  return browser;
}
function runBrowser(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`headless browser exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-loader-browser-smoke-"));
const manager = await startManagerServer({ dataRoot: path.join(temporaryRoot, "data"), port: 0 });
try {
  const result = await runBrowser(findBrowser(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${path.join(temporaryRoot, "browser-profile")}`,
    "--virtual-time-budget=2000",
    "--dump-dom",
    manager.origin
  ]);
  assert.match(result.stdout, /id="loader-health-label">加载器正常</u);
  assert.match(result.stdout, /id="loader-mode-label">Node 本地管理服务</u);
  assert.match(result.stdout, /尚未安装脚本/u);
  assert.match(result.stdout, /隔离区为空/u);
  assert.match(result.stdout, /未检查 Codex/u);
  process.stdout.write("Browser smoke test passed: management UI loaded its real loopback API without touching Codex.\n");
} finally {
  await manager.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
