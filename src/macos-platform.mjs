import path from "node:path";
import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";

const execFile = promisify(execFileCallback);

export async function discoverMacCodex({ candidates = ["/Applications/Codex.app", path.join(process.env.HOME || "", "Applications", "Codex.app")], execFileFn = execFile } = {}) {
  for (const appPath of candidates) {
    try {
      await access(appPath);
      const { stdout: executableName } = await execFileFn("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", path.join(appPath, "Contents", "Info.plist")], { encoding: "utf8" });
      const { stdout: bundleId } = await execFileFn("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(appPath, "Contents", "Info.plist")], { encoding: "utf8" });
      const { stdout: version } = await execFileFn("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(appPath, "Contents", "Info.plist")], { encoding: "utf8" });
      const executable = path.join(appPath, "Contents", "MacOS", executableName.trim());
      await access(executable);
      return Object.freeze({ appPath, executable, bundleId: bundleId.trim(), version: version.trim() });
    } catch {}
  }
  throw new Error("Codex.app was not found in Applications");
}

export async function listMacCodexProcesses(appInfo, { execFileFn = execFile } = {}) {
  const { stdout } = await execFileFn("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout.split(/\r?\n/u).map(line => line.trim().match(/^(\d+)\s+(.+)$/u)).filter(Boolean)
    .map(match => ({ processId: Number(match[1]), command: match[2] }))
    .filter(item => item.command.startsWith(appInfo.appPath) || item.command.startsWith(appInfo.executable));
}

export async function listMacLoopbackListeners(port, { execFileFn = execFile } = {}) {
  try {
    const { stdout } = await execFileFn("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], { encoding: "utf8" });
    let processId = null;
    const output = [];
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.startsWith("p")) processId = Number(line.slice(1));
      if (line.startsWith("n") && /127\.0\.0\.1|\[::1\]/u.test(line)) output.push({ address: line.slice(1), port, processId });
    }
    return output.filter(item => Number.isInteger(item.processId));
  } catch (error) { if (error?.code === 1) return []; throw error; }
}

export async function activateMacCodex(appInfo, args, { spawn = spawnProcess } = {}) {
  const child = spawn(appInfo.executable, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { processId: child.pid, arguments: [...args] };
}

export async function stopMacCodexProcesses(appInfo, { listProcesses = listMacCodexProcesses, kill = process.kill } = {}) {
  const processes = await listProcesses(appInfo);
  for (const item of processes) kill(item.processId, "SIGTERM");
  return processes.map(item => item.processId);
}
