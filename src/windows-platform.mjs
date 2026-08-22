import path from "node:path";
import process from "node:process";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PACKAGE_NAME = "OpenAI.Codex";
const PACKAGE_FAMILY_PATTERN = /^OpenAI\.Codex_[a-z0-9]+$/i;
const APP_USER_MODEL_ID_PATTERN = /^OpenAI\.Codex_[a-z0-9]+![A-Za-z0-9._-]+$/i;

function defaultPowerShellPath() {
  const windowsRoot = process.env.SystemRoot || "C:\\Windows";
  return path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function encodePowerShellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function payloadPrelude(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `$payloadJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$payload=$payloadJson|ConvertFrom-Json;`;
}

export async function runPowerShellJson(script, {
  powershellPath = defaultPowerShellPath(),
  execFileFn = execFile,
  timeoutMs = 15_000
} = {}) {
  const prefix = "$ErrorActionPreference='Stop';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new();[Console]::InputEncoding=[Text.UTF8Encoding]::new();";
  const { stdout } = await execFileFn(powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(`${prefix}${script}`)], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  const text = String(stdout || "").replace(/^\uFEFF/u, "").trim();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error("PowerShell returned an invalid JSON response"); }
}

export function validateWindowsPackage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Codex AppX package was not found");
  const packageFamilyName = String(input.packageFamilyName || input.PackageFamilyName || "");
  const installLocation = String(input.installLocation || input.InstallLocation || "");
  const version = String(input.version || input.Version || "");
  const appUserModelId = String(input.appUserModelId || input.AppUserModelId || `${packageFamilyName}!App`);
  if (!PACKAGE_FAMILY_PATTERN.test(packageFamilyName)) throw new Error("unexpected Codex package family name");
  if (!path.win32.isAbsolute(installLocation) || !path.win32.basename(installLocation).toLowerCase().startsWith("openai.codex_")) {
    throw new Error("unexpected Codex package install location");
  }
  if (!APP_USER_MODEL_ID_PATTERN.test(appUserModelId) || !appUserModelId.toLowerCase().startsWith(`${packageFamilyName.toLowerCase()}!`)) {
    throw new Error("unexpected Codex AppUserModelId");
  }
  return Object.freeze({
    name: PACKAGE_NAME,
    packageFamilyName,
    appUserModelId,
    installLocation: path.win32.normalize(installLocation),
    version
  });
}

export async function discoverWindowsCodex({ runPowerShell = runPowerShellJson } = {}) {
  const script = `$package=Get-AppxPackage -Name '${PACKAGE_NAME}'|Sort-Object Version -Descending|Select-Object -First 1;if($null -eq $package){throw 'OpenAI.Codex AppX package not found'};$applicationId='App';try{$manifest=Get-AppxPackageManifest -Package $package.PackageFullName;$application=@($manifest.Package.Applications.Application|Where-Object{$_.Executable -match '^(ChatGPT|codex)\\.exe$'}|Select-Object -First 1);if($application.Count -eq 0){$application=@($manifest.Package.Applications.Application|Select-Object -First 1)};if($application.Count -gt 0 -and $application[0].Id){$applicationId=[string]$application[0].Id}}catch{};[pscustomobject]@{packageFamilyName=$package.PackageFamilyName;appUserModelId=($package.PackageFamilyName+'!'+$applicationId);installLocation=$package.InstallLocation;version=$package.Version.ToString()}|ConvertTo-Json -Compress`;
  return validateWindowsPackage(await runPowerShell(script));
}

function normalizeProcessList(value) {
  const items = value == null ? [] : Array.isArray(value) ? value : [value];
  return items.map(item => ({
    processId: Number(item.processId ?? item.ProcessId),
    parentProcessId: Number(item.parentProcessId ?? item.ParentProcessId ?? 0),
    name: String(item.name ?? item.Name ?? "")
  })).filter(item => Number.isInteger(item.processId) && item.processId > 0 && /^(ChatGPT|codex)\.exe$/i.test(item.name));
}

export async function listWindowsCodexProcesses(packageInfo, { runPowerShell = runPowerShellJson } = {}) {
  const validated = validateWindowsPackage(packageInfo);
  const prelude = payloadPrelude({ installLocation: validated.installLocation });
  const script = `${prelude}$root=[IO.Path]::GetFullPath([string]$payload.installLocation).TrimEnd('\\')+'\\';$items=@();try{$items=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -match '^(ChatGPT|codex)\\.exe$' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)}|ForEach-Object{[pscustomobject]@{processId=[int]$_.ProcessId;parentProcessId=[int]$_.ParentProcessId;name=[string]$_.Name}})}catch{$items=@(Get-Process -ErrorAction SilentlyContinue|Where-Object{$_.ProcessName -match '^(ChatGPT|codex)$'}|ForEach-Object{try{$candidate=$_.Path}catch{$candidate=$null};if($candidate -and $candidate.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){[pscustomobject]@{processId=[int]$_.Id;parentProcessId=0;name=([string]$_.ProcessName+'.exe')}}})};ConvertTo-Json -Compress -InputObject @($items)`;
  return normalizeProcessList(await runPowerShell(script));
}

function normalizeListenerList(value, expectedPort) {
  const items = value == null ? [] : Array.isArray(value) ? value : [value];
  return items.map(item => ({
    address: String(item.address ?? item.Address ?? ""),
    port: Number(item.port ?? item.Port),
    processId: Number(item.processId ?? item.ProcessId)
  })).filter(item => new Set(["127.0.0.1", "::1"]).has(item.address)
    && item.port === expectedPort
    && Number.isInteger(item.processId)
    && item.processId > 0);
}

export async function listWindowsLoopbackListeners(port, { runPowerShell = runPowerShellJson } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid listener port");
  const prelude = payloadPrelude({ port });
  const script = `${prelude}$items=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$payload.port) -ErrorAction Stop|Where-Object{$_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1'}|ForEach-Object{[pscustomobject]@{address=[string]$_.LocalAddress;port=[int]$_.LocalPort;processId=[int]$_.OwningProcess}});ConvertTo-Json -Compress -InputObject @($items)`;
  return normalizeListenerList(await runPowerShell(script), port);
}

export function quoteWindowsArgument(value) {
  const argument = String(value);
  if (argument && !/[\s"]/u.test(argument)) return argument;
  let output = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      output += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      output += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  output += "\\".repeat(backslashes * 2) + '"';
  return output;
}

export function buildWindowsArgumentString(args) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || /[\u0000\r\n]/u.test(argument))) {
    throw new Error("Codex launch arguments must be strings without control line breaks");
  }
  return args.map(quoteWindowsArgument).join(" ");
}

const ACTIVATION_TYPE = String.raw`
using System;
using System.Runtime.InteropServices;
namespace CodexScriptLoader {
  [Flags] public enum ActivateOptions { None = 0 }
  [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
    [PreserveSig] int ActivateForFile(IntPtr appUserModelId, IntPtr itemArray, IntPtr verb, out uint processId);
    [PreserveSig] int ActivateForProtocol(IntPtr appUserModelId, IntPtr itemArray, out uint processId);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  class ApplicationActivationManager {}
  public static class Activation {
    public static uint Activate(string appUserModelId, string arguments) {
      var manager = (IApplicationActivationManager)new ApplicationActivationManager();
      uint processId;
      int result = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
      Marshal.ThrowExceptionForHR(result);
      return processId;
    }
  }
}`;

export async function activateWindowsCodex(packageInfo, args, { runPowerShell = runPowerShellJson } = {}) {
  const validated = validateWindowsPackage(packageInfo);
  if (!APP_USER_MODEL_ID_PATTERN.test(validated.appUserModelId)) throw new Error("invalid Codex AppUserModelId");
  const prelude = payloadPrelude({ appUserModelId: validated.appUserModelId, arguments: buildWindowsArgumentString(args) });
  const typeBase64 = Buffer.from(ACTIVATION_TYPE, "utf8").toString("base64");
  const script = `${prelude}$typeSource=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${typeBase64}'));Add-Type -TypeDefinition $typeSource -Language CSharp;$processId=[CodexScriptLoader.Activation]::Activate([string]$payload.appUserModelId,[string]$payload.arguments);[pscustomobject]@{processId=[uint32]$processId}|ConvertTo-Json -Compress`;
  const result = await runPowerShell(script);
  const processId = Number(result?.processId ?? result?.ProcessId);
  if (!Number.isInteger(processId) || processId <= 0) throw new Error("Codex packaged activation returned an invalid process id");
  return { processId, appUserModelId: validated.appUserModelId, arguments: buildWindowsArgumentString(args) };
}
