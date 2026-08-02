import test from "node:test";
import assert from "node:assert/strict";
import { buildChromiumDebugArgs, buildLaunchPlan } from "../src/launcher.mjs";

test("launch plan only describes loopback debug args and never starts a process", () => {
  assert.deepEqual(buildChromiumDebugArgs(9333), [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9333",
    "--remote-allow-origins=http://127.0.0.1:9333"
  ]);
  const plan = buildLaunchPlan({ platform: "win32", executable: "ChatGPT.exe", debugPort: 9333, extraArgs: ["--new-window", ""] });
  assert.equal(plan.executable, "ChatGPT.exe");
  assert.deepEqual(plan.args, [...buildChromiumDebugArgs(9333), "--new-window"]);
  assert.equal(plan.mutatesCodexInstallation, false);
  assert.equal(plan.touchesSessionData, false);
  assert.equal(plan.requiresExplicitLiveConfirmation, true);
});

