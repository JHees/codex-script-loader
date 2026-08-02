import test from "node:test";
import assert from "node:assert/strict";
import { createManagerApi, ManagerApiError } from "../prototype/api-client.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

test("manager API uses same-origin JSON requests and unwraps data", async () => {
  const calls = [];
  const api = createManagerApi({
    baseUrl: "http://127.0.0.1:43127/index.html",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ ok: true, data: { safeMode: true } });
    }
  });

  assert.deepEqual(await api.setSafeMode(true), { safeMode: true });
  assert.equal(calls[0].url, "http://127.0.0.1:43127/api/safe-mode");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[0].options.headers["X-Requested-With"], "Codex-Script-Loader-UI");
  assert.deepEqual(JSON.parse(calls[0].options.body), { enabled: true });
});
test("manager API encodes script ids in route segments", async () => {
  let requestedUrl;
  const api = createManagerApi({
    baseUrl: "http://127.0.0.1:43127/",
    fetchImpl: async url => {
      requestedUrl = String(url);
      return jsonResponse({ enabled: false });
    }
  });

  await api.setScriptEnabled("local/a b", false);
  assert.equal(requestedUrl, "http://127.0.0.1:43127/api/scripts/local%2Fa%20b/enabled");
});

test("manager API exposes sanitized HTTP errors", async () => {
  const api = createManagerApi({
    baseUrl: "http://127.0.0.1:43127/",
    fetchImpl: async () => jsonResponse({ error: { code: "invalid_source", message: "脚本格式无效" } }, 400)
  });

  await assert.rejects(
    api.inspectScript({ fileName: "bad.js", sourceText: "" }),
    error => error instanceof ManagerApiError && error.status === 400 && error.code === "invalid_source" && error.message === "脚本格式无效"
  );
});

test("manager API converts connection failures to a stable error", async () => {
  const api = createManagerApi({
    baseUrl: "http://127.0.0.1:43127/",
    fetchImpl: async () => { throw new Error("offline"); }
  });

  await assert.rejects(api.status(), error => error instanceof ManagerApiError && error.code === "connection_failed");
});
