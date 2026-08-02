# UI 与加载器后端契约

本文定义管理 UI 可调用的最小后端表面。接口名称是草案，当前由 Node controller 与 HTTP 路由共同维护；未来如增加其他桌面壳，应复用同一语义。

## 1. 当前 HTTP API

```text
GET  /api/status
GET  /api/scripts
POST /api/scripts/inspect          { fileName, sourceText }
POST /api/scripts/install          { fileName, sourceText, enabled?, overwrite? }
POST /api/scripts/:id/enabled      { enabled }
POST /api/safe-mode                { enabled }
POST /api/reload                   { ids?, live: false }
POST /api/doctor                   {}
```

成功和失败分别使用统一 envelope：

```json
{ "ok": true, "data": {} }
{ "ok": false, "error": { "code": "stable_code", "message": "sanitized message" } }
```

`inspect` 只校验文件名/源码大小、生成脚本描述并计算 SHA-256，不写入也不执行。`install` 由浏览器再次提交相同源码，后端只把它复制到 loader 数据目录，默认 `enabled: false`；即使启用也只是保存配置。当前 `/api/reload` 强制 dry-run，管理服务没有 injector。

## 2. 后续扩展（尚未实现）

Codex 受管启动、聚焦/重启、脚本移除/回滚、事件流、设置持久化、日志导出和 Codex++ 迁移均不在当前 API 中。加入这些功能时必须继续使用枚举路由和结构化参数，不能增加通用 command、shell 或 eval 入口。

## 3. 事件（后续阶段）

```text
app-status-changed(AppStatus)
script-status-changed(ScriptSummary)
operation-progress(OperationProgress)
log-batch(LogRecord[])
doctor-progress(DoctorCheck)
security-warning(SecurityWarning)
```

UI 按批次消费日志事件，并以 requestAnimationFrame 或固定时间片更新可见列表，不能对每条日志同步重绘整个页面。

## 4. 核心类型

```ts
type Health = "stopped" | "starting" | "healthy" | "degraded" | "failed";

interface AppStatus {
  loader: Health;
  codex: Health;
  cdp: Health;
  safeMode: boolean;
  managedProcess: boolean;
  codexVersion?: string;
  targetCount: number;
  enabledScripts: number;
  failedScripts: number;
  lastInjectionAt?: string;
}

interface ScriptSummary {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  status: "pending" | "ready" | "disabled" | "running" | "failed";
  fingerprint: string | null;
  integrity?: string;
  scope: "renderer";
  runAt: "document-start" | "document-end";
  permissions: string[];
  lastInjectedAt?: string;
  errorSummary?: string;
}
```

## 5. 安全约束

- controller/HTTP route allowlist 中不存在 `eval`、`execute_script`、`run_command` 或任意路径写入；
- 所有脚本目标路径都由后端规范化，并限制在 loader 数据目录内；浏览器上传只提交受限源码文本，不提交服务器任意路径；
- 前端不能获得 CDP WebSocket URL；
- 前端不能获得 Codex Cookie、认证头、会话内容或 CC Switch 凭据；
- 本地管理服务只监听 `127.0.0.1`，拒绝非精确 Host、跨源写请求、非 JSON 变更请求和超限请求体；
- 每个服务进程生成独立的 256-bit token，并通过 `HttpOnly; SameSite=Strict; Path=/api` Cookie 下发；
- 所有变更请求还必须具有精确同源 Origin、固定 UI header 和 `application/json`；
- 当前 API 的请求体上限为 600 KiB，脚本源码上限为 512 KiB；
- 将来如加入重启、移除或覆盖等危险操作，再增加短期 confirmation token，防止旧 UI 状态误提交。
