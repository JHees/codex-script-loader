import http from "node:http";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ScriptRegistry } from "./registry.mjs";
import { UiController } from "./ui-controller.mjs";
import { assertWithinDirectory } from "./paths.mjs";
import { integrityLabel } from "./hash.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const TOKEN_COOKIE = "codex_loader_manager_token";
const MAX_JSON_BYTES = 600 * 1024;
const DEFAULT_STATIC_ROOT = fileURLToPath(new URL("../prototype/", import.meta.url));
const SCRIPT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const QUARANTINE_KEY_PATTERN = /^q-[a-z0-9]+-[a-f0-9]{24}$/;
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"]
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function securityHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...extraHeaders
  });
  response.end(body);
}

function success(response, data, status = 200) {
  sendJson(response, status, { ok: true, data });
}

function hasExactToken(cookieHeader, token) {
  if (typeof cookieHeader !== "string") return false;
  const entry = cookieHeader.split(";").map(value => value.trim()).find(value => value.startsWith(`${TOKEN_COOKIE}=`));
  if (!entry) return false;
  const candidate = entry.slice(TOKEN_COOKIE.length + 1);
  const expectedBuffer = Buffer.from(token, "utf8");
  const candidateBuffer = Buffer.from(candidate, "utf8");
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_json", "JSON body must be an object");
  }
  return value;
}

function assertKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HttpError(400, "invalid_request", `unsupported field: ${key}`);
  }
}

async function readJson(request) {
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "json_required", "Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "body_too_large", "JSON request body is too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "body_too_large", "JSON request body is too large");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
  return assertObject(value);
}

function serializeScript(script, statusOverride) {
  const failed = script.status === "failed";
  const output = {
    id: String(script.id),
    name: String(script.name),
    version: String(script.version),
    enabled: Boolean(script.enabled),
    status: statusOverride || (failed ? "failed" : script.status || "ready"),
    fingerprint: typeof script.fingerprint === "string" ? script.fingerprint : null,
    scope: script.scope || "renderer",
    runAt: script.runAt || "document-start",
    permissions: Array.isArray(script.permissions) ? script.permissions.map(String) : []
  };
  if (output.fingerprint) output.integrity = integrityLabel(output.fingerprint);
  if (failed) output.errorSummary = "invalid script package";
  return output;
}

function serializeQuarantine(record) {
  return {
    key: String(record.key),
    scriptId: String(record.scriptId),
    name: String(record.name),
    version: String(record.version),
    enabled: Boolean(record.enabled),
    quarantinedAt: String(record.quarantinedAt),
    status: "quarantined"
  };
}

function sourcePayload(body, { install = false } = {}) {
  const allowed = new Set(install ? ["fileName", "sourceText", "enabled", "overwrite"] : ["fileName", "sourceText"]);
  assertKeys(body, allowed);
  if (typeof body.fileName !== "string" || typeof body.sourceText !== "string") {
    throw new HttpError(400, "invalid_source", "fileName and sourceText must be strings");
  }
  if (install && body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new HttpError(400, "invalid_request", "enabled must be a boolean");
  }
  if (install && body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
    throw new HttpError(400, "invalid_request", "overwrite must be a boolean");
  }
  return {
    name: body.fileName,
    sourceText: body.sourceText,
    options: { enabled: body.enabled === true, overwrite: body.overwrite === true }
  };
}

function validScriptId(encoded) {
  let id;
  try { id = decodeURIComponent(encoded); } catch { throw new HttpError(400, "invalid_script_id", "invalid script id"); }
  if (!SCRIPT_ID_PATTERN.test(id)) throw new HttpError(400, "invalid_script_id", "invalid script id");
  return id;
}

function validQuarantineKey(encoded) {
  let key;
  try { key = decodeURIComponent(encoded); } catch { throw new HttpError(400, "invalid_quarantine_key", "invalid quarantine key"); }
  if (!QUARANTINE_KEY_PATTERN.test(key)) throw new HttpError(400, "invalid_quarantine_key", "invalid quarantine key");
  return key;
}

function invalidSource(error) {
  const message = String(error?.message || "");
  const safeMessage = message.startsWith("script name must ") || message.startsWith("script source exceeds ")
    ? message
    : "script source is invalid";
  return new HttpError(400, "invalid_source", safeMessage);
}

async function serveStatic(request, response, url, staticRoot, token) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "method_not_allowed", "static resources only support GET and HEAD");
  }
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, "invalid_path", "invalid resource path"); }
  if (decodedPath === "/") decodedPath = "/index.html";
  if (decodedPath.includes("\\") || decodedPath.includes("\0")) throw new HttpError(400, "invalid_path", "invalid resource path");
  const segments = decodedPath.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new HttpError(404, "not_found", "resource not found");
  }
  const candidate = assertWithinDirectory(staticRoot, path.join(staticRoot, ...segments), "static resource");
  let canonical;
  try { canonical = await realpath(candidate); } catch { throw new HttpError(404, "not_found", "resource not found"); }
  assertWithinDirectory(staticRoot, canonical, "static resource");
  const info = await stat(canonical);
  const contentType = CONTENT_TYPES.get(path.extname(canonical).toLowerCase());
  if (!info.isFile() || !contentType) throw new HttpError(404, "not_found", "resource not found");
  const body = await readFile(canonical);
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Set-Cookie": `${TOKEN_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict`
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

async function apiRoute(request, response, url, controller) {
  if (url.search) throw new HttpError(400, "query_not_allowed", "query parameters are not supported");
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/status") {
    const data = await controller.dispatch("get_app_status");
    return success(response, { ...data, offline: true, codexInspected: false, cdpInspected: false });
  }
  if (request.method === "GET" && pathname === "/api/scripts") {
    return success(response, (await controller.dispatch("list_scripts")).map(script => serializeScript(script)));
  }
  if (request.method === "GET" && pathname === "/api/quarantine") {
    return success(response, (await controller.dispatch("list_quarantined")).map(record => serializeQuarantine(record)));
  }
  if (request.method === "POST" && pathname === "/api/scripts/inspect") {
    const payload = sourcePayload(await readJson(request));
    let preview;
    try { preview = await controller.dispatch("inspect_script_text", payload); }
    catch (error) { throw invalidSource(error); }
    return success(response, { ...preview, script: serializeScript(preview.script, "pending") });
  }
  if (request.method === "POST" && pathname === "/api/scripts/install") {
    const payload = sourcePayload(await readJson(request), { install: true });
    try {
      return success(response, serializeScript(await controller.dispatch("install_script_text", payload)), 201);
    } catch (error) {
      if (String(error.message).startsWith("script already installed:")) throw new HttpError(409, "script_exists", error.message);
      if (String(error.message).startsWith("script name must ") || String(error.message).startsWith("script source exceeds ")) throw invalidSource(error);
      throw error;
    }
  }
  const enabledMatch = pathname.match(/^\/api\/scripts\/([^/]+)\/enabled$/u);
  if (request.method === "POST" && enabledMatch) {
    const body = await readJson(request);
    assertKeys(body, new Set(["enabled"]));
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "invalid_request", "enabled must be a boolean");
    try { return success(response, serializeScript(await controller.dispatch("set_script_enabled", { id: validScriptId(enabledMatch[1]), enabled: body.enabled }))); }
    catch (error) {
      if (String(error.message).startsWith("unknown script:")) throw new HttpError(404, "script_not_found", "script not found");
      throw error;
    }
  }
  const removeMatch = pathname.match(/^\/api\/scripts\/([^/]+)\/remove$/u);
  if (request.method === "POST" && removeMatch) {
    const body = await readJson(request);
    assertKeys(body, new Set(["mode"]));
    if (body.mode !== undefined && body.mode !== "quarantine") {
      throw new HttpError(400, "permanent_delete_forbidden", "only quarantine removal is supported");
    }
    try {
      const record = await controller.dispatch("remove_script", { id: validScriptId(removeMatch[1]), mode: body.mode || "quarantine" });
      return success(response, serializeQuarantine(record));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (String(error.message).startsWith("unknown script:")) throw new HttpError(404, "script_not_found", "script not found");
      if (String(error.message) === "only quarantine removal is supported") throw new HttpError(400, "permanent_delete_forbidden", "only quarantine removal is supported");
      if (String(error.message).startsWith("invalid installed script:")) throw new HttpError(409, "script_not_removable", "installed script cannot be quarantined safely");
      throw error;
    }
  }
  const restoreMatch = pathname.match(/^\/api\/quarantine\/([^/]+)\/restore$/u);
  if (request.method === "POST" && restoreMatch) {
    const body = await readJson(request);
    assertKeys(body, new Set());
    try {
      const result = await controller.dispatch("restore_quarantined", { key: validQuarantineKey(restoreMatch[1]) });
      return success(response, { key: result.key, script: serializeScript(result.script) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (String(error.message).startsWith("unknown quarantine entry:")) throw new HttpError(404, "quarantine_not_found", "quarantine entry not found");
      if (String(error.message).startsWith("restore conflict:")) throw new HttpError(409, "restore_conflict", "a script with this id is already installed");
      if (String(error.message).startsWith("invalid quarantine entry:")) throw new HttpError(409, "quarantine_invalid", "quarantine entry is not restorable");
      throw error;
    }
  }
  if (request.method === "POST" && pathname === "/api/safe-mode") {
    const body = await readJson(request);
    assertKeys(body, new Set(["enabled"]));
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "invalid_request", "enabled must be a boolean");
    return success(response, await controller.dispatch("set_safe_mode", { enabled: body.enabled }));
  }
  if (request.method === "POST" && pathname === "/api/reload") {
    const body = await readJson(request);
    assertKeys(body, new Set(["ids", "live"]));
    if (body.live !== undefined && body.live !== false) throw new HttpError(400, "live_forbidden", "this server only supports dry-run reloads");
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some(id => typeof id !== "string" || !SCRIPT_ID_PATTERN.test(id)))) {
      throw new HttpError(400, "invalid_request", "ids must be an array of valid script ids");
    }
    const result = await controller.dispatch("reload_scripts", { live: false });
    if (body.ids) result.summary = result.summary.filter(item => body.ids.includes(item.id));
    return success(response, result);
  }
  if (request.method === "POST" && pathname === "/api/doctor") {
    const body = await readJson(request);
    assertKeys(body, new Set());
    return success(response, await controller.dispatch("run_doctor"));
  }
  throw new HttpError(404, "not_found", "API route not found");
}

export async function startManagerServer({ dataRoot, staticRoot = DEFAULT_STATIC_ROOT, port = 0 } = {}) {
  if (typeof dataRoot !== "string" || !dataRoot) throw new TypeError("dataRoot is required");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("port must be between 0 and 65535");
  const canonicalStaticRoot = await realpath(path.resolve(staticRoot));
  if (!(await stat(canonicalStaticRoot)).isDirectory()) throw new TypeError("staticRoot must be a directory");
  const registry = await new ScriptRegistry(path.resolve(dataRoot)).init();
  const controller = new UiController({ registry });
  const token = randomBytes(32).toString("base64url");
  let expectedOrigin = null;
  let expectedHost = null;

  const server = http.createServer(async (request, response) => {
    try {
      if (!expectedOrigin || request.headers.host !== expectedHost) {
        throw new HttpError(421, "invalid_host", "request Host does not match the loopback manager");
      }
      const url = new URL(request.url, expectedOrigin);
      if (url.origin !== expectedOrigin) throw new HttpError(400, "invalid_url", "absolute request URLs are not supported");
      if (url.pathname.startsWith("/api/")) {
        const origin = request.headers.origin;
        if (origin !== undefined && origin !== expectedOrigin) throw new HttpError(403, "origin_rejected", "request Origin is not allowed");
        if (request.method !== "GET" && request.method !== "HEAD" && origin !== expectedOrigin) {
          throw new HttpError(403, "origin_required", "state-changing requests require the exact manager Origin");
        }
        if (!hasExactToken(request.headers.cookie, token)) throw new HttpError(401, "invalid_token", "manager session token is missing or invalid");
        if (request.method !== "GET" && request.method !== "HEAD" && request.headers["x-requested-with"] !== "Codex-Script-Loader-UI") {
          throw new HttpError(403, "ui_header_required", "state-changing requests require the manager UI header");
        }
        if (request.method !== "GET" && request.method !== "HEAD" && String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          throw new HttpError(415, "json_required", "Content-Type must be application/json");
        }
        await apiRoute(request, response, url, controller);
      } else {
        await serveStatic(request, response, url, canonicalStaticRoot, token);
      }
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) return sendJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
      sendJson(response, 500, { ok: false, error: { code: "internal_error", message: "local manager request failed" } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    await new Promise(resolve => server.close(resolve));
    throw new Error("manager server failed to bind the IPv4 loopback address");
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeIdleConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  return Object.freeze({ origin: expectedOrigin, host: LOOPBACK_HOST, port: address.port, token, cookieName: TOKEN_COOKIE, close });
}
