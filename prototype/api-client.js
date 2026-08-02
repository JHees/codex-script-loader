export class ManagerApiError extends Error {
  constructor(message, { status = 0, code = "manager_api_error" } = {}) {
    super(message);
    this.name = "ManagerApiError";
    this.status = status;
    this.code = code;
  }
}
function unwrapPayload(payload) {
  if (payload && typeof payload === "object" && payload.ok === true && "data" in payload) {
    return payload.data;
  }
  return payload;
}

function errorDetails(payload, fallback) {
  if (payload && typeof payload === "object") {
    if (typeof payload.error === "string") return { message: payload.error, code: payload.code };
    if (payload.error && typeof payload.error.message === "string") {
      return { message: payload.error.message, code: payload.error.code || payload.code };
    }
    if (typeof payload.message === "string") return { message: payload.message, code: payload.code };
  }
  return { message: fallback };
}

export function createManagerApi({ baseUrl = globalThis.location?.href, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new TypeError("baseUrl is required outside a browser");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const root = new URL("./", baseUrl);

  async function request(route, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json", "X-Requested-With": "Codex-Script-Loader-UI" };
    const options = { method, headers, credentials: "same-origin", cache: "no-store" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(new URL(route.replace(/^\//, ""), root), options);
    } catch (error) {
      throw new ManagerApiError(`无法连接本地加载器：${error instanceof Error ? error.message : String(error)}`, { code: "connection_failed" });
    }

    const contentType = response.headers?.get?.("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const details = errorDetails(payload, `本地加载器返回 HTTP ${response.status}`);
      throw new ManagerApiError(details.message, { status: response.status, code: details.code || "request_failed" });
    }
    return unwrapPayload(payload);
  }

  return Object.freeze({
    status: () => request("api/status"),
    scripts: () => request("api/scripts"),
    quarantine: () => request("api/quarantine"),
    inspectScript: ({ fileName, sourceText }) => request("api/scripts/inspect", { method: "POST", body: { fileName, sourceText } }),
    installScript: ({ fileName, sourceText, enabled = false, overwrite = false }) => request("api/scripts/install", { method: "POST", body: { fileName, sourceText, enabled, overwrite } }),
    setScriptEnabled: (id, enabled) => request(`api/scripts/${encodeURIComponent(id)}/enabled`, { method: "POST", body: { enabled } }),
    removeScript: id => request(`api/scripts/${encodeURIComponent(id)}/remove`, { method: "POST", body: { mode: "quarantine" } }),
    restoreScript: key => request(`api/quarantine/${encodeURIComponent(key)}/restore`, { method: "POST", body: {} }),
    setSafeMode: enabled => request("api/safe-mode", { method: "POST", body: { enabled } }),
    reload: ids => request("api/reload", { method: "POST", body: ids ? { ids, live: false } : { live: false } }),
    doctor: () => request("api/doctor", { method: "POST", body: {} })
  });
}
