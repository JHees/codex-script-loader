import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import pngjs from "file:///C:/Users/Xingz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pngjs/lib/png.js";

const { PNG } = pngjs;
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const sourcePath = path.join(root, ".runtime", "qa", "native-settings-reference.png");
const implementationPath = path.join(root, ".runtime", "qa-after", "bennett-settings-before.png");
const outputPath = path.join(root, ".runtime", "qa-after", "settings-side-by-side.png");
const source = PNG.sync.read(await readFile(sourcePath));
const implementation = PNG.sync.read(await readFile(implementationPath));
if (source.width !== implementation.width || source.height !== implementation.height) throw new Error("QA screenshots must have identical dimensions");
const output = new PNG({ width: source.width * 2, height: source.height });
PNG.bitblt(source, output, 0, 0, source.width, source.height, 0, 0);
PNG.bitblt(implementation, output, 0, 0, implementation.width, implementation.height, source.width, 0);
await writeFile(outputPath, PNG.sync.write(output));
console.log(pathToFileURL(outputPath).pathname);
