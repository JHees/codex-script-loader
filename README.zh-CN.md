<div align="center">

<img src="windows/branding/CodexScriptLoader-master.png" alt="Codex Script Loader 图标" width="160" />

# Codex Script Loader

**打开 Codex 调试入口，加载用户脚本，并自动管理注入、重载与清理。**

[![Version](https://img.shields.io/badge/version-0.4.2-f97316)](https://github.com/JHees/codex-script-loader)
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
| 内置 Bennett UI | 首次运行安装 Bennett UI Improvements 1.4.10。 |
| Windows 打包 | 为 x64/arm64 生成每用户 NSIS 安装器和 portable ZIP。 |

## 系统要求

- Windows 11 x64 或 arm64，并已安装 Microsoft Store 版 Codex。
- macOS 已将 `Codex.app` 安装到 `/Applications` 或 `~/Applications`，并安装 Node.js 22 或更高版本（尚未实机测试）。
- Windows 源码构建需要 .NET 10 SDK 与 Windows SDK 10.0.26100 或更高版本。

启动 Loader 前先完全退出已有的 Codex 进程；受管会话统一通过 Loader 打开 Codex。

## 安装与运行

从 [GitHub Releases](https://github.com/JHees/codex-script-loader/releases) 下载对应架构的 NSIS 安装器即可。标准安装向导会先让用户选择安装目录和开始菜单目录，再创建桌面与开始菜单快捷方式；安装按当前用户进行，并登记到 Windows“已安装的应用”，不需要管理员权限。每个安装器同时提供 portable ZIP。

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
├── app/CodexScriptLoader.exe
├── CodexScriptLoader-0.4.2-windows-x64-setup.exe
├── CodexScriptLoader-0.4.2-windows-x64.zip
├── CodexScriptLoader-0.4.2-x64.spdx.json
└── SHA256SUMS.txt
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
  └─ CodexScriptLoader.exe（WinExe，单实例）
       ├─ Windows 包 API ──> Microsoft Store Codex
       ├─ 随机 loopback CDP ──> 已验证 Codex renderer
       ├─ 脚本 registry ──> manifest / 权限 / SHA-256
       └─ 生命周期 supervisor ──> 注入 / 重载 / 清理 / 退出
```

生产数据位于 `%LOCALAPPDATA%\CodexScriptLoader`，包含 `config.json`、`scripts`、`quarantine`、`logs` 和 `state`。日志使用 UTF-8 JSON Lines，诊断摘要会脱敏用户路径和无关命令行。

Windows 宿主通过官方包 API 启动 Codex，使用随机 loopback CDP 端口，并在注入前核对所属进程和目标 renderer。整个过程保持 Codex 应用文件不变，也不需要访问 `WindowsApps` 或申请管理员权限。

## 脚本包

已安装插件统一在 **Codex 设置 → Script-Loader → 设置** 中管理。该页面展示实时状态，支持启用/禁用、单个或全部重载、本地文件夹/ZIP 安装、隔离与恢复，以及受控的 Codex 重启。声明了设置页的插件会直接列在“设置”入口下方。

完整的插件编写与生命周期约定见 [`docs/PLUGIN_SPEC.md`](docs/PLUGIN_SPEC.md)。

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

内置的 [Bennett UI Improvements](packages/bennett-ui-improvements) 是参考实现，Loader 保留其 manifest、权限、SHA-256、归属声明与生命周期语义。

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

- 内置插件：[Better UI Improvements for Codex](https://github.com/JHees/better-ui-improvements-for-codex)。保留 Bennett 包标识、原作者和 MIT 声明；Codex++ 支持已止于市场发布的 `1.2.4`，当前版本面向本 Loader。
- Bennett 上游：[b-nnett/codex-plusplus-bennett-ui](https://github.com/b-nnett/codex-plusplus-bennett-ui)。
- 编辑抽象图标方法：[ZzzLc0405/photo-abstract-editorial](https://github.com/ZzzLc0405/photo-abstract-editorial)。

Loader 代码使用 [MIT License](LICENSE)。内置第三方代码继续遵守各自包含的许可与归属声明。`windows/branding` 下的改编品牌资源不属于 MIT 代码许可范围，受 [`windows/branding/README.md`](windows/branding/README.md) 记录的非商业限制约束；商业分发前必须获得原作者授权。
