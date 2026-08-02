import path from "node:path";
import { readFile } from "node:fs/promises";
import { assertWithinDirectory, safeScriptIdFromName } from "./paths.mjs";
import { integrityLabel, sha256Text } from "./hash.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RUN_AT = new Set(["document-start", "document-end"]);
export const MAX_SOURCE_BYTES = 512 * 1024;

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

  const entry = String(input.entry || "index.js");
  if (!entry || path.isAbsolute(entry)) throw new Error("manifest entry must be a relative path");
  const entryPath = assertWithinDirectory(scriptDirectory, path.join(scriptDirectory, entry), "manifest entry");
  const scope = input.scope || "renderer";
  if (scope !== "renderer") throw new Error("only renderer scripts are supported in this version");
  const runAt = input.runAt || "document-start";
  if (!RUN_AT.has(runAt)) throw new Error(`unsupported runAt: ${runAt}`);

  return {
    schemaVersion: Number(input.schemaVersion || 1),
    id,
    name: String(input.name || id),
    version: String(input.version || "0.0.0"),
    entry,
    entryPath,
    scope,
    runAt,
    permissions: Array.isArray(input.permissions) ? input.permissions.map(String) : [],
    integrity: input.integrity ? String(input.integrity) : null,
    raw: input
  };
}

export async function loadScriptDescriptor(scriptDirectory) {
  const directory = path.resolve(scriptDirectory);
  const manifestPath = path.join(directory, "manifest.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = validateManifest(raw, directory);
  const source = await readFile(manifest.entryPath, "utf8");
  const fingerprint = sha256Text(source);
  if (manifest.integrity && manifest.integrity !== integrityLabel(fingerprint)) {
    throw new Error(`integrity mismatch for ${manifest.id}`);
  }
  return { ...manifest, source, fingerprint, manifestPath, directory };
}
