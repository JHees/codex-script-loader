# UI 与加载器后端契约

本文定义桌面 UI 可调用的最小后端表面。接口名称是草案，后续将由 Rust 类型和生成的 TypeScript 类型共同维护。

## 1. 查询命令

```text
get_app_status() -> AppStatus
list_scripts() -> ScriptSummary[]
get_script(id) -> ScriptDetails
get_settings() -> Settings
get_recent_logs(filter, cursor, limit) -> LogPage
get_doctor_report() -> DoctorReport
```

## 2. 变更命令

```text
launch_codex(mode) -> OperationAccepted
focus_codex() -> OperationAccepted
restart_codex(mode, confirmation) -> OperationAccepted
reload_scripts(ids?) -> OperationAccepted
set_script_enabled(id, enabled) -> ScriptSummary
inspect_script_source(source) -> PendingInstall
confirm_script_install(installId, enabled) -> ScriptSummary
remove_script(id, mode) -> RemovalResult
rollback_script(id, version) -> ScriptSummary
run_doctor() -> OperationAccepted
update_settings(patch) -> Settings
migrate_codexplusplus(selection) -> MigrationResult
```

`inspect_script_source` 只解析和验证，不执行脚本。`confirm_script_install` 只能接受后端生成的短期 `installId`，前端不能传入任意目标路径。

## 3. 事件

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
  source: "local-file" | "local-directory" | "codexplusplus" | "github-release";
  enabled: boolean;
  status: "disabled" | "loading" | "running" | "failed" | "restart-required";
  fingerprint: string;
  lastInjectedAt?: string;
  errorSummary?: string;
}
```

## 5. 安全约束

- Tauri command allowlist 中不存在 `eval`、`execute_script`、`run_command` 或任意路径写入；
- 所有脚本路径都由 Rust canonicalize，并限制在用户明确选择的来源和 loader 数据目录内；
- 前端不能获得 CDP WebSocket URL；
- 前端不能获得 Codex Cookie、认证头、会话内容或 CC Switch 凭据；
- 文件选择、打开目录和导出诊断使用系统对话框与后端校验；
- 操作进度以不可伪造的 operation ID 关联；
- 危险操作需要后端签发的 confirmation token，防止旧 UI 状态误提交。

