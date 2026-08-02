import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { makeTempRoot } from "./helpers.mjs";
import { startManagerServer } from "../src/manager-server.mjs";

async function withServer(run) {
  const root = await makeTempRoot("codex-loader-manager-");
  const manager = await startManagerServer({ dataRoot: path.join(root, "data"), port: 0 });
  try {
    const page = await fetch(`${manager.origin}/`);
    assert.equal(page.status, 200);
    const setCookie = page.headers.get("set-cookie");
    assert.ok(setCookie);
    const cookie = setCookie.split(";", 1)[0];
    await run({ manager, cookie, page });
  } finally {
    await manager.close();
  }
}

async function api(manager, cookie, route, { method = "GET", body, origin = manager.origin, headers = {} } = {}) {
  const requestHeaders = { Cookie: cookie, ...headers };
  if (origin !== null) requestHeaders.Origin = origin;
  if (method !== "GET" && method !== "HEAD") {
    requestHeaders["X-Requested-With"] = "Codex-Script-Loader-UI";
    if (!("Content-Type" in requestHeaders)) requestHeaders["Content-Type"] = "application/json";
  }
  const response = await fetch(`${manager.origin}${route}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

test("manager binds a random IPv4 loopback port and serves hardened static assets", async () => {
  await withServer(async ({ manager, page }) => {
    assert.equal(manager.host, "127.0.0.1");
    assert.ok(manager.port > 0);
    assert.equal(new URL(manager.origin).hostname, "127.0.0.1");
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.match(await page.text(), /Codex Script Loader/);
  });
});

test("manager requires its process token and exact Origin for mutations", async () => {
  await withServer(async ({ manager, cookie }) => {
    let result = await fetch(`${manager.origin}/api/status`, { headers: { Origin: manager.origin } });
    assert.equal(result.status, 401);

    result = (await api(manager, cookie, "/api/status", { origin: "http://example.invalid" })).response;
    assert.equal(result.status, 403);

    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${manager.origin}/api/status`, {
        headers: { Host: `localhost:${manager.port}`, Cookie: cookie, Origin: manager.origin }
      }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
    });
    assert.equal(wrongHostStatus, 421);

    result = (await api(manager, cookie, "/api/safe-mode", { method: "POST", body: { enabled: true }, origin: null })).response;
    assert.equal(result.status, 403);

    const allowedGet = await api(manager, cookie, "/api/status", { origin: null });
    assert.equal(allowedGet.response.status, 200);
    assert.equal(allowedGet.payload.data.codexInspected, false);
    assert.equal(allowedGet.payload.data.cdpInspected, false);
  });
});

test("source-text workflow remains offline and dry-run only", async () => {
  await withServer(async ({ manager, cookie }) => {
    delete globalThis.__managerServerMustNotExecute;
    const sourceText = "globalThis.__managerServerMustNotExecute = true;";

    const preview = await api(manager, cookie, "/api/scripts/inspect", {
      method: "POST",
      body: { fileName: "offline-test.js", sourceText }
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.data.requiresConfirmation, true);
    assert.equal(preview.payload.data.script.id, "local.offline-test");
    assert.equal("source" in preview.payload.data.script, false);
    assert.equal((await api(manager, cookie, "/api/scripts")).payload.data.length, 0);

    const installed = await api(manager, cookie, "/api/scripts/install", {
      method: "POST",
      body: { fileName: "offline-test.js", sourceText, enabled: false, overwrite: false }
    });
    assert.equal(installed.response.status, 201);
    assert.equal(installed.payload.data.enabled, false);
    assert.equal("directory" in installed.payload.data, false);
    assert.equal("source" in installed.payload.data, false);

    const enabled = await api(manager, cookie, "/api/scripts/local.offline-test/enabled", {
      method: "POST",
      body: { enabled: true }
    });
    assert.equal(enabled.payload.data.enabled, true);

    const safeMode = await api(manager, cookie, "/api/safe-mode", { method: "POST", body: { enabled: true } });
    assert.deepEqual(safeMode.payload.data, { safeMode: true });
    const safeReload = await api(manager, cookie, "/api/reload", { method: "POST", body: { live: false } });
    assert.equal(safeReload.payload.data.mode, "dry-run");
    assert.deepEqual(safeReload.payload.data.summary, []);

    await api(manager, cookie, "/api/safe-mode", { method: "POST", body: { enabled: false } });
    const reload = await api(manager, cookie, "/api/reload", { method: "POST", body: { ids: ["local.offline-test"], live: false } });
    assert.equal(reload.payload.data.targetCount, 0);
    assert.equal(reload.payload.data.summary.length, 1);

    const forbiddenLive = await api(manager, cookie, "/api/reload", { method: "POST", body: { live: true } });
    assert.equal(forbiddenLive.response.status, 400);
    assert.equal(forbiddenLive.payload.error.code, "live_forbidden");

    const doctor = await api(manager, cookie, "/api/doctor", { method: "POST", body: {} });
    assert.equal(doctor.payload.data.offline, true);
    assert.equal(doctor.payload.data.checks.find(check => check.id === "codex-process").status, "skipped");
    assert.equal(doctor.payload.data.checks.find(check => check.id === "cdp").status, "skipped");
    assert.equal(globalThis.__managerServerMustNotExecute, undefined);
  });
});

test("manager rejects non-JSON mutations and unknown command-shaped routes", async () => {
  await withServer(async ({ manager, cookie }) => {
    const wrongType = await api(manager, cookie, "/api/safe-mode", {
      method: "POST",
      body: "enabled=true",
      headers: { "Content-Type": "text/plain" }
    });
    assert.equal(wrongType.response.status, 415);
    assert.equal(wrongType.payload.error.code, "json_required");

    const oversizedSource = await api(manager, cookie, "/api/scripts/inspect", {
      method: "POST",
      body: { fileName: "too-large.js", sourceText: "x".repeat(512 * 1024 + 1) }
    });
    assert.equal(oversizedSource.response.status, 400);
    assert.equal(oversizedSource.payload.error.code, "invalid_source");

    const commandRoute = await api(manager, cookie, "/api/eval", { method: "POST", body: {} });
    assert.equal(commandRoute.response.status, 404);
    assert.equal(commandRoute.payload.error.code, "not_found");
  });
});

test("manager quarantine API removes recoverably, restores, and refuses conflicts", async () => {
  await withServer(async ({ manager, cookie }) => {
    delete globalThis.__quarantineApiMustNotExecute;
    const sourceText = "globalThis.__quarantineApiMustNotExecute = true;";
    await api(manager, cookie, "/api/scripts/install", {
      method: "POST",
      body: { fileName: "recover-api.js", sourceText, enabled: false }
    });

    const permanent = await api(manager, cookie, "/api/scripts/local.recover-api/remove", {
      method: "POST",
      body: { mode: "permanent" }
    });
    assert.equal(permanent.response.status, 400);
    assert.equal(permanent.payload.error.code, "permanent_delete_forbidden");
    assert.equal((await api(manager, cookie, "/api/scripts")).payload.data.length, 1);

    const removed = await api(manager, cookie, "/api/scripts/local.recover-api/remove", { method: "POST", body: {} });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.payload.data.scriptId, "local.recover-api");
    assert.equal(removed.payload.data.status, "quarantined");
    assert.equal("directory" in removed.payload.data, false);
    assert.equal("source" in removed.payload.data, false);
    assert.equal((await api(manager, cookie, "/api/scripts")).payload.data.length, 0);

    const quarantine = await api(manager, cookie, "/api/quarantine");
    assert.deepEqual(quarantine.payload.data, [removed.payload.data]);
    const key = removed.payload.data.key;
    const restored = await api(manager, cookie, `/api/quarantine/${encodeURIComponent(key)}/restore`, { method: "POST", body: {} });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.payload.data.key, key);
    assert.equal(restored.payload.data.script.id, "local.recover-api");
    assert.equal(restored.payload.data.script.enabled, false);
    assert.equal("source" in restored.payload.data.script, false);
    assert.deepEqual((await api(manager, cookie, "/api/quarantine")).payload.data, []);

    const removedAgain = await api(manager, cookie, "/api/scripts/local.recover-api/remove", { method: "POST", body: { mode: "quarantine" } });
    await api(manager, cookie, "/api/scripts/install", {
      method: "POST",
      body: { fileName: "recover-api.js", sourceText: "globalThis.__replacementMustNotExecute = true;", enabled: true }
    });
    const conflict = await api(manager, cookie, `/api/quarantine/${encodeURIComponent(removedAgain.payload.data.key)}/restore`, { method: "POST", body: {} });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.error.code, "restore_conflict");
    assert.equal((await api(manager, cookie, "/api/quarantine")).payload.data.length, 1);
    assert.equal(globalThis.__quarantineApiMustNotExecute, undefined);
    assert.equal(globalThis.__replacementMustNotExecute, undefined);
  });
});
