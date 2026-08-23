import path from "node:path";
import process from "node:process";
import { access, readdir } from "node:fs/promises";
import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PACKAGE_DIRECTORY_PATTERN = /^OpenAI\.Codex_([^_]+)_(?:x64|arm64|x86)__([a-z0-9]+)$/i;

function numericVersion(value) {
  return String(value).split(".").map((part) => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = numericVersion(left);
  const b = numericVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

export function validateWindowsPackage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Codex Store package was not found");
  const installLocation = path.win32.normalize(String(input.installLocation || ""));
  const executable = path.win32.normalize(String(input.executable || path.win32.join(installLocation, "app", "ChatGPT.exe")));
  const packageFamilyName = String(input.packageFamilyName || "");
  if (!path.win32.isAbsolute(installLocation) || !path.win32.basename(installLocation).toLowerCase().startsWith("openai.codex_")) throw new Error("unexpected Codex package install location");
  if (!path.win32.isAbsolute(executable) || !executable.toLowerCase().startsWith(`${installLocation.toLowerCase()}\\`)) throw new Error("unexpected Codex executable path");
  if (!/^OpenAI\.Codex_[a-z0-9]+$/i.test(packageFamilyName)) throw new Error("unexpected Codex package family name");
  return Object.freeze({
    name: "OpenAI.Codex",
    packageFamilyName,
    appUserModelId: `${packageFamilyName}!App`,
    installLocation,
    executable,
    version: String(input.version || ""),
  });
}

export async function discoverWindowsCodex({
  windowsAppsRoot = path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps"),
  readDirectory = readdir,
  accessFile = access,
} = {}) {
  const entries = await readDirectory(windowsAppsRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(PACKAGE_DIRECTORY_PATTERN);
    if (!match) continue;
    const installLocation = path.win32.join(windowsAppsRoot, entry.name);
    for (const name of ["ChatGPT.exe", "Codex.exe"]) {
      const executable = path.win32.join(installLocation, "app", name);
      try {
        await accessFile(executable);
        candidates.push({
          installLocation,
          executable,
          version: match[1],
          packageFamilyName: `OpenAI.Codex_${match[2]}`,
        });
        break;
      } catch {}
    }
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version));
  if (!candidates.length) throw new Error("OpenAI Codex Microsoft Store package was not found; pass a supported Store installation");
  return validateWindowsPackage(candidates[0]);
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { values.push(value); value = ""; }
    else value += character;
  }
  values.push(value);
  return values;
}

export async function listWindowsCodexProcesses(_packageInfo, { execFileFn = execFile } = {}) {
  const { stdout } = await execFileFn("tasklist.exe", ["/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout || "").split(/\r?\n/u).map((line) => parseCsvLine(line.trim())).filter((row) => row.length >= 2)
    .map((row) => ({ name: row[0], processId: Number(row[1]), parentProcessId: 0 }))
    .filter((item) => /^(ChatGPT|Codex)\.exe$/i.test(item.name) && Number.isInteger(item.processId) && item.processId > 0);
}

export async function listWindowsLoopbackListeners(port, { execFileFn = execFile } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid listener port");
  const { stdout } = await execFileFn("netstat.exe", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const listeners = [];
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    const match = line.trim().match(/^TCP\s+(127\.0\.0\.1|\[::1\]|::1):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!match || Number(match[2]) !== port) continue;
    listeners.push({ address: match[1].replace(/^\[|\]$/g, ""), port, processId: Number(match[3]) });
  }
  return listeners;
}

export async function activateWindowsCodex(packageInfo, args, { spawn = spawnProcess } = {}) {
  const validated = validateWindowsPackage(packageInfo);
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || /[\u0000\r\n]/u.test(argument))) throw new Error("Codex launch arguments must be safe strings");
  const child = spawn(validated.executable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error("Codex launch returned an invalid process id");
  return { processId: child.pid, executable: validated.executable, arguments: [...args] };
}
