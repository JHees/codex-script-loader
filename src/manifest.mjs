import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { assertWithinDirectory, safeScriptIdFromName } from "./paths.mjs";
import { integrityLabel, sha256Text } from "./hash.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RUN_AT = new Set(["document-start", "document-end"]);
const LIFECYCLE_GLOBAL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PAGE_COMPANION_OPERATION_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PAGE_COMPANION_PERMISSION = "browser-page-companion";
const PAGE_COMPANION_ORIGINS = new Set(["https://chatgpt.com"]);
export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;

function boundedText(value, fallback, label, maxLength) {
  const text = String(value ?? fallback);
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`manifest ${label} must be 1-${maxLength} characters without control characters`);
  }
  return text;
}

export function describeTextScript({ name, sourceText }) {
  if (typeof name !== "string") throw new Error("script name must be a string");
  if (typeof sourceText !== "string") throw new Error("script source must be a string");
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 128 || /[\\/\u0000-\u001f\u007f]/u.test(normalizedName)) {
    throw new Error("script name must be 1-128 characters without path separators or control characters");
  }
  if (Buffer.byteLength(sourceText, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`script source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  const displayName = normalizedName.toLowerCase().endsWith(".js") ? normalizedName.slice(0, -3) : normalizedName;
  if (!displayName) throw new Error("script name must include a name before the .js extension");
  return {
    id: safeScriptIdFromName(displayName),
    name: displayName,
    version: "local",
    entry: "index.js",
    scope: "renderer",
    runAt: "document-start",
    lifecycleGlobal: null,
    permissions: [],
    source: sourceText,
    fingerprint: sha256Text(sourceText)
  };
}

export function validateManifest(input, scriptDirectory) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("manifest must be an object");
  }
  const id = String(input.id || "");
  if (!ID_PATTERN.test(id)) throw new Error(`invalid script id: ${id || "<empty>"}`);

  const schemaVersion = Number(input.schemaVersion ?? 1);
  if (schemaVersion !== 1) throw new Error(`unsupported manifest schemaVersion: ${input.schemaVersion}`);

  const entry = String(input.main || input.entry || "index.js");
  if (!entry || entry.length > 240 || /[\u0000-\u001f\u007f]/u.test(entry) || path.isAbsolute(entry)) throw new Error("manifest entry must be a safe relative path");
  const entryPath = assertWithinDirectory(scriptDirectory, path.join(scriptDirectory, entry), "manifest entry");
  const scope = input.scope || "renderer";
  if (scope !== "renderer") throw new Error("only renderer scripts are supported in this version");
  const runAt = input.runAt || "document-start";
  if (!RUN_AT.has(runAt)) throw new Error(`unsupported runAt: ${runAt}`);
  const lifecycleGlobal = input.lifecycleGlobal == null ? null : String(input.lifecycleGlobal);
  if (lifecycleGlobal !== null && !LIFECYCLE_GLOBAL_PATTERN.test(lifecycleGlobal)) throw new Error("manifest lifecycleGlobal must be a JavaScript global property name");
  if (input.permissions !== undefined && !Array.isArray(input.permissions)) throw new Error("manifest permissions must be an array");
  const permissions = (input.permissions || []).map(permission => boundedText(permission, "", "permission", 64));
  if (permissions.length > 32) throw new Error("manifest declares too many permissions");
  const pageCompanion = validatePageCompanion(input.pageCompanion, scriptDirectory, permissions);
  const integrity = input.integrity == null ? null : String(input.integrity);
  if (integrity !== null && !/^sha256-[a-f0-9]{64}$/u.test(integrity)) throw new Error("manifest integrity must be a sha256 hex label");
  let documentation = null;
  let documentationPath = null;
  if (input.documentation != null) {
    documentation = String(input.documentation);
    if (!documentation || documentation.length > 240 || /[\u0000-\u001f\u007f]/u.test(documentation) || path.isAbsolute(documentation)) throw new Error("manifest documentation must be a safe relative path");
    documentationPath = assertWithinDirectory(scriptDirectory, path.join(scriptDirectory, documentation), "manifest documentation");
  }
  let settingsMode = "legacy";
  let settingsPageId = null;
  let settingsPageTitle = null;
  if (input.settings !== undefined) {
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) throw new Error("manifest settings must be an object");
    settingsMode = String(input.settings.mode || "");
    if (!new Set(["page", "none"]).has(settingsMode)) throw new Error("manifest settings mode must be page or none");
    if (settingsMode === "page") {
      settingsPageId = boundedText(input.settings.pageId, "main", "settings pageId", 64);
      settingsPageTitle = boundedText(input.settings.title, input.name || id, "settings title", 128);
      if (!permissions.includes("settings")) throw new Error("a settings page requires the settings permission");
    }
  }

  let update = null;
  if (input.update !== undefined) {
    if (!input.update || typeof input.update !== "object" || Array.isArray(input.update)) throw new Error("manifest update must be an object");
    const provider = String(input.update.provider || "");
    if (provider !== "github-releases") throw new Error("manifest update provider must be github-releases");
    const repository = String(input.update.repository || "");
    if (!GITHUB_REPOSITORY_PATTERN.test(repository) || repository.toLowerCase().endsWith(".git")) throw new Error("manifest update repository must be owner/repository");
    const asset = String(input.update.asset || "");
    const placeholderCount = asset.split("{version}").length - 1;
    if (!asset || asset.length > 160 || path.basename(asset) !== asset || /[<>:"\\|?*\u0000-\u001f]/u.test(asset) || asset.includes("/") || !asset.toLowerCase().endsWith(".zip") || placeholderCount !== 1 || /[{}]/u.test(asset.replace("{version}", ""))) {
      throw new Error("manifest update asset must be a versioned ZIP filename using {version}");
    }
    const version = String(input.version || "0.0.0");
    if (!STABLE_VERSION_PATTERN.test(version)) throw new Error("manifest update requires a stable major.minor.patch version");
    update = Object.freeze({ provider, repository, asset });
  }

  return {
    schemaVersion,
    id,
    name: boundedText(input.name, id, "name", 128),
    version: boundedText(input.version, "0.0.0", "version", 64),
    entry,
    main: entry,
    entryPath,
    scope,
    runAt,
    lifecycleGlobal,
    permissions,
    integrity,
    documentation,
    documentationPath,
    settingsMode,
    settingsPageId,
    settingsPageTitle,
    update,
    pageCompanion,
    raw: input
  };
}

function validatePageCompanion(input, scriptDirectory, permissions) {
  if (input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("manifest pageCompanion must be an object");
  if (!permissions.includes(PAGE_COMPANION_PERMISSION)) throw new Error("pageCompanion requires the browser-page-companion permission");
  const id = boundedText(input.id, "main", "pageCompanion id", 64);
  if (!ID_PATTERN.test(id)) throw new Error("manifest pageCompanion id is invalid");
  const origin = boundedText(input.origin, "", "pageCompanion origin", 200);
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); }
  catch { throw new Error("manifest pageCompanion origin is invalid"); }
  if (parsedOrigin.origin !== origin || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash || !PAGE_COMPANION_ORIGINS.has(origin)) {
    throw new Error("manifest pageCompanion origin is not allowlisted");
  }
  const entry = boundedText(input.main ?? input.entry, "", "pageCompanion main", 240);
  if (path.isAbsolute(entry)) throw new Error("manifest pageCompanion main must be a safe relative path");
  const entryPath = assertWithinDirectory(scriptDirectory, path.join(scriptDirectory, entry), "pageCompanion main");
  if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > 16) throw new Error("manifest pageCompanion operations must contain 1-16 items");
  const operations = [...new Set(input.operations.map(operation => boundedText(operation, "", "pageCompanion operation", 64)))];
  if (operations.length !== input.operations.length || operations.some(operation => !PAGE_COMPANION_OPERATION_PATTERN.test(operation))) {
    throw new Error("manifest pageCompanion operations are invalid or duplicated");
  }
  return Object.freeze({ id, origin, entry, entryPath, operations });
}

export async function loadScriptDescriptor(scriptDirectory) {
  const directory = path.resolve(scriptDirectory);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("script package must be a real directory");
  const canonicalDirectory = await realpath(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_MANIFEST_BYTES) throw new Error("script manifest must be a regular file no larger than 64 KiB");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = validateManifest(raw, directory);
  const entryInfo = await lstat(manifest.entryPath);
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error("script entry must be a regular file");
  if (entryInfo.size > MAX_SOURCE_BYTES) throw new Error(`script source exceeds ${MAX_SOURCE_BYTES} bytes`);
  const canonicalEntryPath = await realpath(manifest.entryPath);
  assertWithinDirectory(canonicalDirectory, canonicalEntryPath, "manifest entry");
  const source = await readFile(canonicalEntryPath, "utf8");
  let pageCompanion = null;
  if (manifest.pageCompanion) {
    const companionInfo = await lstat(manifest.pageCompanion.entryPath);
    if (!companionInfo.isFile() || companionInfo.isSymbolicLink() || companionInfo.size > MAX_SOURCE_BYTES) throw new Error("page companion entry must be a regular file no larger than 512 KiB");
    const canonicalCompanionPath = await realpath(manifest.pageCompanion.entryPath);
    assertWithinDirectory(canonicalDirectory, canonicalCompanionPath, "pageCompanion main");
    const companionSource = await readFile(canonicalCompanionPath, "utf8");
    pageCompanion = Object.freeze({
      ...manifest.pageCompanion,
      entryPath: canonicalCompanionPath,
      source: companionSource,
      fingerprint: sha256Text(companionSource),
    });
  }
  if (manifest.documentationPath) {
    const documentationInfo = await lstat(manifest.documentationPath);
    if (!documentationInfo.isFile() || documentationInfo.isSymbolicLink() || documentationInfo.size > 256 * 1024) throw new Error("declared plugin documentation is missing or invalid");
    const canonicalDocumentationPath = await realpath(manifest.documentationPath);
    assertWithinDirectory(canonicalDirectory, canonicalDocumentationPath, "manifest documentation");
  }
  const fingerprint = sha256Text(source);
  if (manifest.integrity && manifest.integrity !== integrityLabel(fingerprint)) {
    throw new Error(`integrity mismatch for ${manifest.id}`);
  }
  return { ...manifest, entryPath: canonicalEntryPath, source, fingerprint, pageCompanion, manifestPath, directory };
}
