import path from "node:path";
import { readFile } from "node:fs/promises";
import { assertWithinDirectory } from "./paths.mjs";
import { integrityLabel, sha256Text } from "./hash.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RUN_AT = new Set(["document-start", "document-end"]);

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

