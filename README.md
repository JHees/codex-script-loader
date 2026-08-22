# Codex Script Loader

独立于 Codex++ 与 CC Switch 的 Codex Desktop 本地脚本加载器。

它使用“外部启动器 + 仅回环 CDP”启动官方 Codex，并把用户明确启用的 renderer JavaScript 加载到当前页面和后续重载页面。它不修改 Codex 安装包，不读取或重写会话、认证、供应商及 CC Switch 数据。

> 当前状态：Windows MVP 已实现并通过离线、模拟 CDP、真实管理 UI 与 Windows 平台探测；真实 Codex 端到端注入仍需在完全关闭当前 Codex 后做最后一次受控验证。

## 已实现

- 发现并校验 Microsoft Store/AppX 版官方 Codex；
- 检测所有官方包进程，已有实例存在时拒绝受管启动；
- 通过 packaged activation 传入随机 `127.0.0.1` CDP 端口；
- 验证 CDP 监听 PID 确实属于本次官方 Codex 进程族；
- 对当前 document 注入，并为 future document 注册脚本；
- renderer target 更换、脚本配置或哈希变化后自动恢复；
- 脚本 `stop()` 生命周期、安全模式和无重复注入指纹；
- 本地管理 UI：检查/安装单文件脚本、启停、实时重载、诊断、隔离和恢复；
- 内置 Bennett UI Improvements `1.3.0` 轻量兼容包及原许可证；
- Node.js 实现，无 npm 运行时依赖，也不要求 Rust。

## 快速开始

要求 Windows 11、官方 Codex Desktop 和 Node.js 22 或更高版本。

先在普通终端安装并启用随仓库提供的 Bennett UI 包：

```powershell
cd "F:\Codex\Codex++ ui plugin\codex-script-loader"
node src\cli.mjs install packages\bennett-ui-improvements --enable
```

随后完全退出所有官方 Codex 窗口和后台进程，再从这个外部终端启动受管实例：

```powershell
node src\cli.mjs run --live
```

命令会输出管理界面的随机 `http://127.0.0.1:<port>` 地址。保持终端进程运行，加载器才能在 renderer 重载后继续恢复脚本。按 `Ctrl+C` 只停止加载器，不会强制结束 Codex。

如果 Codex 仍在运行，命令会在激活之前失败并提示先完全退出。加载器不会向一个没有受管 CDP 端口的既有实例强行附加。

### 仅打开离线管理 UI

```powershell
node src\cli.mjs serve
```

离线 UI 可以管理脚本文件和配置，但“重新加载”只生成 dry-run 计划，不查询或连接 Codex。

## 常用命令

```text
node src/cli.mjs status
node src/cli.mjs scripts
node src/cli.mjs doctor
node src/cli.mjs install <file-or-directory> [--enable]
node src/cli.mjs safe-mode <on|off>
node src/cli.mjs reload                 # dry-run
node src/cli.mjs serve                  # 离线管理 UI
node src/cli.mjs run --live             # 受管启动 + 实时 UI + supervisor
```

默认数据目录是 `%APPDATA%\codex-script-loader`。开发验证可增加 `--data-dir .runtime\manual`，该目录已被 Git 忽略。

## 安全边界

- 不读写 `.codex/state_5.sqlite`、JSONL 会话、`auth.json` 或 `config.toml`；
- 不读写 CC Switch 数据库、供应商或凭据；
- 不修改、解包或重新签名 Codex 的 `app.asar`；
- CDP 和管理服务都只使用 IPv4 loopback；
- 管理 API 校验精确 Host/Origin、进程随机 token、JSON 类型和请求体上限；
- API 不返回脚本源码、安装路径、CDP WebSocket URL、会话正文或认证数据；
- “移除”只移动到加载器自己的隔离区，不提供永久删除；
- 停用或安全模式会调用已注册脚本的 `stop()`，清理 Bennett observer、timer 和 UI。

同一 Windows 用户下已经能读取本机文件或直接访问回环端口的恶意进程不在该边界内。

## 验证

```powershell
npm run check
npm test
npm run smoke:ui
npm run smoke:windows
```

当前共有 59 项 Node 测试。浏览器烟雾测试只访问临时管理服务；Windows 烟雾测试只读取 AppX 信息并用本进程临时端口验证 PID 归属，均不会附加当前 Codex。

## Bennett UI 包

目录：`packages/bennett-ui-improvements/`

- 保留 Bennett 原 MIT 许可证和归属；
- 使用 `lifecycleGlobal` 接入加载器的可靠停止/重载；
- 兼容缺少 Codex++ IPC/设置注册 API 的 renderer 环境；
- 只保留本地项目与所属会话的颜色提示，不覆盖 Codex 原生设置、额度、Markdown、历史、斜杠菜单或远程连接颜色。

## 当前限制

- 只实现 Windows AppX 启动，macOS 尚未接入；
- 管理 UI 当前由本地浏览器承载，尚无托盘/单文件安装器；
- 不能把 CDP 参数补加到已经运行的 Codex，首次使用必须从加载器启动；
- Bennett 的细粒度功能开关仍保存在 Codex renderer 的 localStorage，加载器 UI 当前只控制整个脚本；
- 首次真实受管启动与 renderer 重载回归尚待完成。

## 设计文档

- [需求与功能边界](docs/REQUIREMENTS.md)
- [系统架构](docs/ARCHITECTURE.md)
- [社区方案调研](docs/RESEARCH.md)
- [实现流程与里程碑](docs/IMPLEMENTATION_PLAN.md)
- [管理 UI 规范](docs/UI_SPEC.md)
- [UI/后端契约](docs/UI_BACKEND_CONTRACT.md)
- [ADR-0001：外部 CDP 注入](docs/adr/0001-external-cdp-loader.md)
