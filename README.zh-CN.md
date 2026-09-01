<div align="center">

<img src="windows/branding/CodexScriptLoader-master.png" alt="Codex Script Loader 图标" width="160" />

# Codex Script Loader

**打开 Codex 调试入口，加载用户脚本，并自动管理注入、重载与清理。**

[![Version](https://img.shields.io/badge/version-0.5.8-f97316)](https://github.com/JHees/codex-script-loader)
[![Windows](https://img.shields.io/badge/Windows-11-0078d4?logo=windows11)](#系统要求)
[![macOS](https://img.shields.io/badge/macOS-未测试-999999?logo=apple)](#平台支持)
[![.NET](https://img.shields.io/badge/.NET-10-512bd4?logo=dotnet)](global.json)
[![Windows Loader](https://github.com/JHees/codex-script-loader/actions/workflows/windows-loader.yml/badge.svg)](https://github.com/JHees/codex-script-loader/actions/workflows/windows-loader.yml)
[![License](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)

[English](README.md) · **简体中文**

</div>

Codex Script Loader 启动 Codex 时打开本地 Chrome DevTools Protocol（CDP）调试入口，并加载用户安装的 renderer 脚本。它会自动完成脚本发现、manifest 与哈希验证、权限配置、当前及未来文档注入、原位重载、旧实例清理，以及随 Codex 退出。

Windows 使用无控制台、无托盘图标的原生 .NET 10 后台宿主，是当前经过实机验证的主要平台；macOS 使用 Node.js live runtime，代码已经实现，但尚未在 macOS 实机测试。

## 功能亮点

| 领域 | 提供的能力 |
| --- | --- |
| 调试模式启动 | 打开 Codex 本地调试入口，为 renderer 脚本提供运行环境。 |
| 用户自定义脚本 | 从 Loader 数据目录加载 `manifest.json + index.js` 脚本包。 |
| 全自动生命周期 | 自动验证、注入、重载、替换并清理当前及未来 renderer 中的脚本。 |
| Windows 原生宿主 | 在后台随 Codex 运行，并在受管 Codex 退出后自动结束。 |
| macOS runtime | 发现 `Codex.app`，通过 Node.js 提供相同的 CDP 与脚本流程；当前未测试。 |
| 诊断与重载 | Windows 再次启动同一 EXE 可打开诊断；`--reload` 原位替换脚本。 |
| Loader 在线升级 | 启动后检查稳定版 GitHub Release，并在不重启 Codex 的情况下切换已校验宿主。 |
| 插件 Release 更新 | 扫描声明了公开 GitHub 更新源的插件，并对用户单独启用的更新执行校验、原子替换和定向重载。 |
| 内置示例插件 | 首次运行安装一个由 Loader 自身维护、用于演示插件包契约的小型 UI 插件。 |
| Windows 打包 | 为 x64/arm64 生成每用户 NSIS 安装器和 portable ZIP。 |

## 系统要求

- Windows 11 x64 或 arm64，并已安装 Microsoft Store 版 Codex。
- macOS 已将 `Codex.app` 安装到 `/Applications` 或 `~/Applications`，并安装 Node.js 22 或更高版本（尚未实机测试）。
- Windows 源码构建需要 .NET 10 SDK、Windows SDK 10.0.26100 或更高版本，以及 Visual Studio C++ 桌面生成工具；在 x64 机器上交叉发布 `win-arm64` 还需要 `Microsoft.VisualStudio.Component.VC.Tools.ARM64`。

启动 Loader 前先完全退出已有的 Codex 进程；受管会话统一通过 Loader 打开 Codex。

## 安装与运行

从 [GitHub Releases](https://github.com/JHees/codex-script-loader/releases) 下载对应架构的 NSIS 安装器即可。标准安装向导会先让用户选择安装目录和开始菜单目录，再创建桌面与开始菜单快捷方式；安装按当前用户进行，并登记到 Windows“已安装的应用”，不需要管理员权限。每个安装器同时提供 portable ZIP。

0.5.0 是从 0.4.x 平铺目录迁移到版本化目录所需的最后一次手工安装。从 0.5.1 起，标准 NSIS 安装可在 **Codex 设置 → Script-Loader → 设置** 中直接升级宿主，Codex、当前任务和页面保持打开；portable 版本仍需手工替换。

0.5.2 会把更新错误固定显示在更新卡片内，并使用 Windows 系统 `curl.exe` 解析最新稳定 GitHub Release、直接下载发布资产。它不调用 GitHub API，也不读取 GitHub CLI 凭据。传输仅允许 HTTPS 与 GitHub 官方下载主机，并继续执行大小、SHA-256、压缩包、更新清单和逐文件校验。

0.5.3 新增默认关闭、逐插件启用的 GitHub Release 更新。声明更新源的第三方插件会被独立扫描，通过相同的受限传输下载，经强制 `.sha256` 校验后以事务方式替换并原位重载。Loader 自有的示例插件仍随 Loader 打包，不进入第三方更新流程。

### 从源码构建

```powershell
git clone https://github.com/JHees/codex-script-loader.git
Set-Location .\codex-script-loader
.\windows\scripts\package.ps1 -RuntimeIdentifier win-x64
```

Windows on Arm 使用 `win-arm64`。打包前只清理仓库根目录 `build` 中上次生成的文件，然后在其中保留当次最新架构和版本；不会再清理或覆盖 `bin`。`build` 根部的 setup EXE 是本地安装入口，`build\app` 只用于打包，不是推荐启动路径。升级或卸载不会删除 `%LOCALAPPDATA%\CodexScriptLoader` 中的脚本和设置。

```text
build/
├── README.md
├── app/CodexScriptLoader.exe                 # 稳定 NativeAOT 启动器
├── app/active.json
├── app/previous.json
├── app/update-manifest.json
├── app/versions/0.5.8/win-x64/               # 完整 Loader 宿主
├── CodexScriptLoader-0.5.8-windows-x64-setup.exe
├── CodexScriptLoader-0.5.8-windows-x64-setup.exe.sha256
├── CodexScriptLoader-0.5.8-windows-x64.zip
├── CodexScriptLoader-0.5.8-windows-x64.zip.sha256
└── CodexScriptLoader-0.5.8-x64.spdx.json
```

### macOS live runtime（尚未测试）

```bash
git clone https://github.com/JHees/codex-script-loader.git
cd codex-script-loader
node src/cli.mjs run --live
```

macOS runtime 会发现 `Codex.app`，以随机 loopback CDP 端口启动它，加载相同格式的脚本包，并在终端中持续监督本次会话。数据目录为 `~/Library/Application Support/codex-script-loader`。

### Windows 运行流程

再次启动 Loader EXE 会打开诊断窗口。如需在不刷新、不聚焦 Codex 的情况下重载脚本，执行：

```powershell
& "$env:LOCALAPPDATA\Programs\CodexScriptLoader\CodexScriptLoader.exe" --reload
```

## Windows 架构与数据

```text
用户
  └─ CodexScriptLoader.exe（稳定 NativeAOT 启动器）
       └─ versions/<version>/<rid>/CodexScriptLoader.exe
            ├─ Windows 包 API ──> Microsoft Store Codex
            ├─ 随机 loopback CDP ──> 已验证 Codex renderer
            ├─ 脚本 registry ──> manifest / 权限 / SHA-256
            └─ 生命周期 supervisor ──> 注入 / 重载 / 宿主接管 / 清理
```

生产数据位于 `%LOCALAPPDATA%\CodexScriptLoader`，包含 `config.json`、`scripts`、`quarantine`、`logs` 和 `state`。日志使用 UTF-8 JSON Lines，诊断摘要会脱敏用户路径和无关命令行。

在线更新固定使用 `JHees/codex-script-loader` 的稳定版 Release。Loader 通过 Windows 系统 `curl.exe` 跟随仓库的 `releases/latest` 重定向，只构造预期的版本化资产名，完全不调用 GitHub API。它会核对 tag、资产名、架构、响应声明大小、GitHub 官方 HTTPS 下载主机、与压缩包同名的 `.sha256` 校验资产、ZIP 安全结构、协议版本及每个文件的哈希。GitHub Release + SHA-256 信任模型可以发现下载损坏和资产错配，但无法抵御 Release 与哈希文件被同时替换；独立签名与 Authenticode 留作后续安全增强。

Windows 宿主通过官方包 API 启动 Codex，使用随机 loopback CDP 端口，并在注入前核对所属进程和目标 renderer。整个过程保持 Codex 应用文件不变，也不需要访问 `WindowsApps` 或申请管理员权限。

## 脚本包

已安装插件统一在 **Codex 设置 → Script-Loader → 设置** 中管理。该页面展示实时状态，支持启用/禁用、单个或全部重载、本地文件夹/ZIP 安装、隔离与恢复、检查更新，以及受控的 Codex 重启。声明了设置页的插件会直接列在“设置”入口下方。

第三方包可以选择声明自己的公开 GitHub Release 更新源。原生 Windows 宿主会在首次进入健康状态后扫描一次，也可从设置页手动检查；逐插件自动替换默认关闭。更新必须来自稳定的 `vMAJOR.MINOR.PATCH` Release，并同时提供版本化 ZIP 与同名 `.sha256`。新增权限或检测到本地修改时必须确认；插件已禁用或没有可用 renderer 时不会替换。此功能不建立远程市场，也不要求 Loader 仓库同步第三方源码、版本或发布流程。

完整的插件编写与生命周期约定见 [`docs/PLUGIN_SPEC.md`](docs/PLUGIN_SPEC.md)。
版本化目录、Release 校验和无需重启 Codex 的宿主接管流程见 [`docs/UPDATE_PROTOCOL.md`](docs/UPDATE_PROTOCOL.md)。

Renderer 包由 `manifest.json` 与入口脚本组成：

```json
{
  "schemaVersion": 1,
  "id": "local.example",
  "name": "Example",
  "version": "1.0.0",
  "main": "index.js",
  "scope": "renderer",
  "runAt": "document-end",
  "permissions": ["dom", "local-storage", "settings"]
}
```

### 可选的 loopback WebSocket 传输

`loopback-websocket` 是插件在 manifest 中显式声明的可选 capability。只有声明
该权限的包才会获得 `api.localTransport.openWebSocket(endpoint)`；未声明的包
没有 `localTransport` 属性，其他既有 API 形状保持不变。权限是受信任本地
JavaScript 的 capability 声明，不是安全沙箱，启用插件前应先审查其代码。

```json
{ "permissions": ["dom", "loopback-websocket"] }
```

```js
const socket = await api.localTransport.openWebSocket(
  "ws://127.0.0.1:43127/renderer",
);
socket.addEventListener("message", event => handleMessage(event.data));
socket.send("hello");
```

宿主只接受精确的 `ws://127.0.0.1:<port>/<safe-path>` endpoint；会拒绝
`localhost`、IPv6、局域网地址、`wss:`、凭据、query、fragment、不安全路径、
CDP 路径以及 Loader 管理的 CDP 端口。传输仅允许文本，并限制为单帧 64 KiB、
每个入站队列 32 条消息/256 KiB、每个 target 8 条连接、总计 32 条连接、
1 秒 long-poll、最多 32 个并行 binding dispatch 和 5 秒 binding 请求；关闭连接
最多短暂保留 30 秒以排空终止事件。
每个请求都携带 plugin ID，宿主会重新核验当前启用的 descriptor 及其权限。
无效或未授权请求会 fail-closed 并返回经过清理的错误；不会记录传输内容、
endpoint 或 secret，也不会暴露 CDP endpoint。

该传输使用独立的 binding 与协议，与 Loader 管理桥完全分离；不会改变任何既有
management command 或行为，也不包含 Bridge 专属的 ID、路径或协议。插件停止、
重载、禁用、target 丢失或替换、重连以及 Loader 关闭时，连接都会被清理。Windows
原生宿主与 Node.js runtime 提供相同的公开 seam 和限制。

内置的 [Example UI Plugin](packages/example-ui-plugin) 是插件包 interface 的参考 adapter。它完全由本仓库维护和版本化，用于演示 manifest 权限、设置页注册、Loader 范围存储、可逆 DOM 修改和生命周期清理。

第三方插件是独立项目。其源码、测试、版本、发布与部署说明均留在各自仓库中；Loader 开发不再要求把第三方源码复制或同步到本仓库。需要使用第三方插件时，应在设置页安装其独立发布的文件夹或 ZIP。

Windows 添加自定义脚本时，将脚本包目录放入 `%LOCALAPPDATA%\CodexScriptLoader\scripts\<script-id>`，再运行 `CodexScriptLoader.exe --reload`。Node.js runtime 可用以下命令安装脚本包或单个 `.js` 文件：

```bash
node src/cli.mjs install /path/to/script --enable
```

## 开发与验证

```powershell
# 原生构建和测试
dotnet build .\windows\CodexScriptLoader.Windows.sln -c Release --configfile .\NuGet.Config
dotnet run --project .\windows\tests\CodexScriptLoader.Tests\CodexScriptLoader.Tests.csproj -c Release

# Node 兼容和 parity 检查
npm run check
npm test

# 签名前可复现性检查
.\windows\scripts\verify-reproducible.ps1 -RuntimeIdentifier win-x64
.\windows\scripts\verify-reproducible.ps1 -RuntimeIdentifier win-arm64
```

在 Codex 完全关闭时运行 [`ActivationProbe`](windows/tools/ActivationProbe)。它会发现真实 application ID、带 CDP 参数激活 Codex、校验 listener 所有权，并在通过后输出 `ACTIVATION_PASS`。NSIS、portable ZIP、可选签名和发布说明见 [`windows/README.md`](windows/README.md)。

## 故障排查

- **Codex 已运行**：关闭所有 Codex 窗口并等待进程退出，再启动 Loader。
- **Loader 启动后没有窗口**：这是预期行为；再启动一次可打开诊断。
- **脚本状态为 Degraded**：查看诊断窗口和 `%LOCALAPPDATA%\CodexScriptLoader\logs`。
- **安装器无法替换正在运行的 Loader**：完整退出受管 Codex 与 Loader 后重新安装；安装器不会强制结束进程。
- **Codex 更新后无法激活**：关闭 Codex 并运行 Activation Probe，获取包身份与 CDP 诊断。

## 平台支持

| 平台 | Runtime | 状态 |
| --- | --- | --- |
| Windows 11 x64/arm64 | 原生 .NET 10 后台宿主 | 已测试并提供打包 |
| macOS | Node.js 22 live runtime | 已实现，尚未在 macOS 实机测试 |

Codex 更新可能需要 Loader 或脚本适配。本项目独立开发，与 OpenAI 或 Microsoft 无隶属关系。

## 贡献

欢迎提交 Issue 和范围清晰的 Pull Request。环境配置、架构、测试与打包说明见 [`windows/README.md`](windows/README.md)。

## 来源与许可

- 编辑抽象图标方法：[ZzzLc0405/photo-abstract-editorial](https://github.com/ZzzLc0405/photo-abstract-editorial)。

Loader 代码和内置示例使用 [MIT License](LICENSE)。第三方插件在本仓库之外继续遵守各自的许可证。`windows/branding` 下的改编品牌资源不属于 MIT 代码许可范围，受 [`windows/branding/README.md`](windows/branding/README.md) 记录的非商业限制约束；商业分发前必须获得原作者授权。
