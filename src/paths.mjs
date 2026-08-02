import os from "node:os";
import path from "node:path";

export function getDataRoot({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let base;
  if (platform === "win32") {
    base = env.APPDATA || pathApi.join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    base = pathApi.join(home, "Library", "Application Support");
  } else {
    base = env.XDG_DATA_HOME || pathApi.join(home, ".local", "share");
  }
  return pathApi.join(base, "codex-script-loader");
}

export function getLayout(root) {
  const dataRoot = path.resolve(root);
  return {
    dataRoot,
    scriptsRoot: path.join(dataRoot, "scripts"),
    configPath: path.join(dataRoot, "config.json"),
    logsRoot: path.join(dataRoot, "logs"),
    quarantineRoot: path.join(dataRoot, "quarantine")
  };
}

export function isWithinDirectory(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function assertWithinDirectory(root, candidate, label = "path") {
  if (!isWithinDirectory(root, candidate)) {
    throw new Error(`${label} escapes its allowed directory`);
  }
  return path.resolve(candidate);
}

export function safeScriptIdFromName(name) {
  const normalized = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `local.${normalized || "script"}`.slice(0, 128);
}
