import { fileURLToPath } from "node:url";
import { loadScriptDescriptor } from "./manifest.mjs";

const BUNDLED_PACKAGES = [
  fileURLToPath(new URL("../packages/example-ui-plugin/", import.meta.url))
];

export async function ensureBundledPackages(registry) {
  const installed = new Set((await registry.list({ includeInvalid: false })).map(script => script.id));
  const added = [];
  for (const packagePath of BUNDLED_PACKAGES) {
    const bundled = await loadScriptDescriptor(packagePath);
    if (installed.has(bundled.id)) continue;
    const descriptor = await registry.install(packagePath, { enabled: true });
    if (descriptor) added.push(descriptor.id);
  }
  return added;
}
