import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { assertWithinDirectory, safeScriptIdFromName } from "./paths.mjs";
import { integrityLabel, sha256Text } from "./hash.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RUN_AT = new Set(["document-start", "document-end"]);
const LIFECYCLE_GLOBAL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
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
  const integrity = input.integrity == null ? null : String(input.integrity);
  if (integrity !== null && !/^sha256-[a-f0-9]{64}$/u.test(integrity)) throw new Error("manifest integrity must be a sha256 hex label");

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
    raw: input
  };
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
  const fingerprint = sha256Text(source);
  if (manifest.integrity && manifest.integrity !== integrityLabel(fingerprint)) {
    throw new Error(`integrity mismatch for ${manifest.id}`);
  }
  return { ...manifest, entryPath: canonicalEntryPath, source, fingerprint, manifestPath, directory };
}
