import assert from "node:assert/strict";
import net from "node:net";
import process from "node:process";
import {
  discoverWindowsCodex,
  listWindowsCodexProcesses,
  listWindowsLoopbackListeners
} from "../src/windows-platform.mjs";

if (process.platform !== "win32") throw new Error("Windows platform smoke test only supports Windows");

const packageInfo = await discoverWindowsCodex();
const processes = await listWindowsCodexProcesses(packageInfo);
const server = net.createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
});
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const listeners = await listWindowsLoopbackListeners(address.port);
  assert.ok(listeners.some(listener => listener.processId === process.pid), "temporary loopback listener owner was not detected");
  process.stdout.write(`${JSON.stringify({
    codexVersion: packageInfo.version,
    appUserModelId: packageInfo.appUserModelId,
    currentCodexPackageProcessCount: processes.length,
    loopbackOwnershipProbe: "pass"
  }, null, 2)}\n`);
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
