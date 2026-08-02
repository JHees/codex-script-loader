import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256Text(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export async function sha256File(filePath) {
  return sha256Text(await readFile(filePath, "utf8"));
}

export function integrityLabel(hash) {
  return `sha256-${hash}`;
}
