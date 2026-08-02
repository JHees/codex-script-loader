const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);

export function buildChromiumDebugArgs(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("debug port must be between 1 and 65535");
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`
  ];
}

export function buildLaunchPlan({ platform, executable, debugPort, extraArgs = [] }) {
  if (!SUPPORTED_PLATFORMS.has(platform)) throw new Error(`unsupported platform: ${platform}`);
  if (!executable) throw new Error("Codex executable is required");
  return {
    platform,
    executable,
    args: [...buildChromiumDebugArgs(debugPort), ...extraArgs.filter(argument => typeof argument === "string" && argument.length > 0)],
    mutatesCodexInstallation: false,
    touchesSessionData: false,
    requiresExplicitLiveConfirmation: true
  };
}

