# Codex Script Loader

一个独立于 Codex++ 和 CC Switch 的 Codex Desktop 本地脚本加载器。

当前仓库处于 Phase 0 可运行原型。目标是只解决一件事：安全、稳定地管理经过用户确认的本地 renderer JavaScript，随后再以受控方式加载到 Codex Desktop；不修改 Codex 会话数据库、认证信息、供应商配置或安装包。

## 核心结论

- 采用外部启动器 + Chrome DevTools Protocol（CDP）注入。
- 不修改、解包或重新签名 Codex 的 `app.asar`。
- Windows 首发，随后支持 macOS。
- 当前使用 Node.js 本地管理服务 + 浏览器管理 UI；Rust/Tauri 不是必需条件，未来只作为可选分发壳评估。
- CLI 作为诊断和自动化接口保留。
- 加载器与 CC Switch 分开更新；未来只提供可选的 CLI/URI 集成接口。
- 第一批兼容脚本是 Bennett UI Improvements。

## 规划文档

- [需求与功能边界](docs/REQUIREMENTS.md)
- [系统架构](docs/ARCHITECTURE.md)
- [社区方案调研](docs/RESEARCH.md)
- [实现流程与里程碑](docs/IMPLEMENTATION_PLAN.md)
- [桌面管理 UI 规范](docs/UI_SPEC.md)
- [UI 与加载器后端契约](docs/UI_BACKEND_CONTRACT.md)
- [ADR-0001：选择外部 CDP 注入](docs/adr/0001-external-cdp-loader.md)
- [可交互 UI 原型](prototype/README.md)

## 预期命令

```text
codex-script-loader run
codex-script-loader status
codex-script-loader reload [script-id]
codex-script-loader doctor
codex-script-loader safe-mode
codex-script-loader open-scripts
codex-script-loader migrate-codexplusplus
```

其中 `status`、`scripts`、`doctor`、`safe-mode`、`install`、`serve` 和默认 dry-run `reload` 已在 Node Phase 0 原型中实现；带 `--live` 的真实 Codex 启动/注入仍未启用。

## 运行本地管理 UI

需要 Node.js 20 或更高版本，不需要安装 npm 依赖：

```powershell
npm test
npm run check
node src/cli.mjs serve --data-dir .runtime\manual
```

`serve` 会输出一个随机的 `http://127.0.0.1:<port>` 地址，但不会自动打开浏览器，也不会启动、停止、查询或附加当前 Codex。访问该地址后可以：

- 查看离线 loader 状态和已安装脚本；
- 检查单个 `.js` 文件并预览 ID、权限声明和 SHA-256；
- 确认复制安装，默认保持停用，安装过程不执行源码；
- 修改脚本启用配置和全局安全模式；
- 把脚本可恢复地移入隔离区，并在无冲突时恢复原启用配置；不提供永久删除；
- 生成 dry-run 加载计划；
- 运行明确跳过 Codex 进程与 CDP 的离线诊断。

## 当前实现

- `src/paths.mjs`：跨平台数据目录和安全路径边界；
- `src/manifest.mjs` / `src/hash.mjs`：manifest 校验与 SHA-256；
- `src/registry.mjs`：本地脚本安装、启停、安全模式和注入计划；
- `src/cdp.mjs`：loopback endpoint 校验、target 过滤、CDP 命令和注入器；
- `src/ui-controller.mjs`：与桌面 UI 对应的白名单命令；
- `src/manager-server.mjs`：仅绑定 IPv4 loopback 的本地管理服务与白名单 JSON API；
- `src/cli.mjs`：离线 CLI；
- `prototype/`：已连接本地管理 API 的管理 UI；直接以文件方式打开时仍可查看静态演示；
- `test/`：30 个 Node 内置测试，全部使用临时目录、随机本地端口或 fake session，不连接真实 Codex；另有独立的无界面浏览器烟雾测试。

## 本地管理服务安全边界

- 只绑定 `127.0.0.1`，默认使用操作系统分配的随机端口；
- 精确校验 Host 和写请求 Origin，不启用 CORS；
- 每个进程生成独立的 256-bit 会话 token，并通过 `HttpOnly; SameSite=Strict` Cookie 限制管理请求；
- 写请求还必须使用指定 UI header 和 `application/json`；
- 请求体最多 600 KiB，脚本源码最多 512 KiB；
- API 不返回脚本源码、安装绝对路径、CDP URL、Codex Cookie、会话正文或 CC Switch 凭据；
- 管理服务没有 live injector，`reload` 只允许 `live: false`。
- 移除只允许同卷移动到 loader 自己的隔离区；恢复冲突会拒绝操作，不会覆盖新安装脚本。

该边界用于阻止普通网页跨源调用本地管理接口，但无法隔离同一 Windows 用户下已经能直接访问回环端口和本机文件的恶意进程。

## 非目标

- 不管理 Codex 供应商、API Key 或 OAuth。
- 不同步、迁移或重写会话历史。
- 不提供 Codex 主进程原生模块注入。
- 不下载并静默执行远程脚本。
- 不成为新的 Codex++ 或 CC Switch 分支。

## 项目状态

`Phase 0 prototype / 0.0.1`
