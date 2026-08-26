<div align="center">

<img src="windows/branding/CodexScriptLoader-master.png" alt="Codex Script Loader 图标" width="160" />

# Codex Script Loader

**为 Windows Microsoft Store Codex 提供的原生、无控制台脚本加载器。**

[![Version](https://img.shields.io/badge/version-0.3.0-f97316)](https://github.com/JHees/codex-script-loader)
[![Windows](https://img.shields.io/badge/Windows-11-0078d4?logo=windows11)](#系统要求)
[![.NET](https://img.shields.io/badge/.NET-10-512bd4?logo=dotnet)](global.json)
[![Windows Loader](https://github.com/JHees/codex-script-loader/actions/workflows/windows-loader.yml/badge.svg)](https://github.com/JHees/codex-script-loader/actions/workflows/windows-loader.yml)
[![License](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)

[English](README.md) · **简体中文**

</div>

Codex Script Loader 通过 Windows 包 API 启动 Microsoft Store 官方 Codex，为本次运行分配随机 loopback CDP 端口，核对端口所有者后加载明确安装的 renderer 脚本。它不修改 `app.asar`，不复制或重签名 Codex，不枚举 `WindowsApps`，也不需要管理员权限。

v0.3 是 .NET 10 `WinExe` 后台宿主：无控制台窗口、无托盘图标，随受管 Codex 启动和退出。

> [!IMPORTANT]
> 目前尚未发布已签名的公开二进制包。本地生成的未签名 MSIX 只是开发产物，不是正式发布包。不要通过关闭杀毒软件或添加排除项来安装。

## 功能亮点

| 领域 | 提供的能力 |
| --- | --- |
| 原生启动 | 发现当前用户 Store 包，并通过 Windows 包 API 激活真实 AUMID。 |
| CDP 验证 | 使用随机 `127.0.0.1` 端口，校验 PID 与包族，只接受 `app://-/index.html`。 |
| 脚本生命周期 | 验证 manifest、权限和 SHA-256，覆盖当前/未来文档，重载前先清理旧实例。 |
| 安静的后台宿主 | 无控制台、托盘、服务、计划任务、开机启动项或 UAC 弹窗。 |
| 诊断与重载 | 再次启动同一 EXE 可打开脱敏诊断；`--reload` 执行原位重载。 |
| 内置 Bennett UI | 首次运行安装 Bennett UI Improvements 1.4.8。 |
| 可复现打包 | 生成 x64/arm64 自包含 MSIX、SBOM 和 SHA-256 校验值。 |

## 系统要求

- Windows 11 x64 或 arm64。
- 当前用户已从 Microsoft Store 安装官方 Codex。
- 普通交互用户权限；Loader 不申请提权。
- 源码构建需要 .NET 10 SDK 与 Windows SDK 10.0.26100 或更高版本。

通过 Loader 启动受管 Codex 前，必须先完全退出已运行的 Codex。

## 安装与运行

### 已签名发布包

已签名版本发布后，从 [GitHub Releases](https://github.com/JHees/codex-script-loader/releases) 下载匹配架构的 MSIX 或 `.appinstaller`，验证发布者与 SHA-256 后按每用户方式安装。

### 从源码构建

```powershell
git clone https://github.com/JHees/codex-script-loader.git
Set-Location .\codex-script-loader
.\windows\scripts\package.ps1 -RuntimeIdentifier win-x64
```

Windows on Arm 使用 `win-arm64`。打包前会清理仓库根目录的 `bin`，然后只保留当次最新架构和版本。可直接运行 `bin\app\CodexScriptLoader.exe` 测试自包含构建。

```text
bin/
├── app/CodexScriptLoader.exe
├── layout/
├── CodexScriptLoader-0.3.0.0-x64.msix
├── CodexScriptLoader-x64.appinstaller
├── CodexScriptLoader-0.3.0.0-x64.spdx.json
└── SHA256SUMS.txt
```

再次启动 Loader EXE 会打开诊断窗口。如需在不刷新、不聚焦 Codex 的情况下重载脚本，执行：

```powershell
& .\bin\app\CodexScriptLoader.exe --reload
```

## 架构与数据

```text
用户
  └─ CodexScriptLoader.exe（WinExe，单实例）
       ├─ Windows 包 API ──> Microsoft Store Codex
       ├─ 随机 loopback CDP ──> 已验证 Codex renderer
       ├─ 脚本 registry ──> manifest / 权限 / SHA-256
       └─ 生命周期 supervisor ──> 注入 / 重载 / 清理 / 退出
```

生产数据位于 `%LOCALAPPDATA%\CodexScriptLoader`，包含 `config.json`、`scripts`、`quarantine`、`logs` 和 `state`。日志使用 UTF-8 JSON Lines，诊断摘要会脱敏用户路径和无关命令行。

## 安全边界

- 不修改、复制、解包或重签名官方 Codex。
- 不枚举或写入受保护的 `WindowsApps` 目录。
- 生产启动链不调用 PowerShell、cmd、Node.js、`tasklist`、`netstat`、临时脚本、自解压或反射加载。
- CDP 只侦听随机 loopback 端口，注入前必须校验所有权。
- 只接受 `app://-/index.html` 主 renderer。
- 当前用户单实例管道只接受 `ShowStatus` 和 `ReloadScripts`。
- 未知必填字段、哈希不符、权限失败和非法路径都会直接失败。

这些边界可以降低误报风险，但不能绝对保证不被安全软件拦截。Defender 或卡巴斯基检测应阻断发布；关闭防护或要求用户添加白名单不是支持方案。

## 脚本包

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

[`ActivationProbe`](windows/tools/ActivationProbe) 只能在 Codex 完全关闭时运行。通过标准是发现真实 application ID、带 CDP 参数激活 Codex、校验 listener 所有权，并输出 `ACTIVATION_PASS`。签名、MSIX、App Installer 和发布门禁见 [`windows/README.md`](windows/README.md)。

## 故障排查

- **Codex 已运行**：关闭所有 Codex 窗口并等待进程退出，再启动 Loader。
- **Loader 启动后没有窗口**：这是预期行为；再启动一次可打开诊断。
- **脚本状态为 Degraded**：查看诊断窗口和 `%LOCALAPPDATA%\CodexScriptLoader\logs`。
- **MSIX 无法安装**：确认它是来自预期发布者的 Authenticode 已签名包。
- **Codex 更新后无法激活**：关闭 Codex 并运行 Activation Probe，不得回退到直接启动 `WindowsApps` 文件。
- **杀毒软件报告 Loader**：保留检测名、定义版本、签名、哈希、进程树和脱敏日志，不要关闭防护。

## 兼容性与范围

Codex Script Loader 当前面向 Windows Microsoft Store 版 Codex。这是独立非官方项目，不隶属于 OpenAI 或 Microsoft，也未获得其背书。Codex 更新可能需要 Loader 或脚本适配。账户、provider、MCP、Skills 和独立控制中心不属于 Loader 范围。

## 贡献

欢迎提交 Issue 和范围清晰的 Pull Request。修改应用激活、包发现、CDP 所有权或发布打包时，必须测试失败路径，并保留无提权、无 shell 的生产边界。不得提交运行数据、凭据、签名证书、本地安装包或生成的 `bin` 产物。

## 来源与许可

- 内置插件：[Bennett UI Improvements for Codex++](https://github.com/JHees/bennett-ui-improvements-for-codexplusplus)。
- Bennett 上游：[b-nnett/codex-plusplus-bennett-ui](https://github.com/b-nnett/codex-plusplus-bennett-ui)。
- 编辑抽象图标方法：[ZzzLc0405/photo-abstract-editorial](https://github.com/ZzzLc0405/photo-abstract-editorial)。

Loader 代码使用 [MIT License](LICENSE)。内置第三方代码继续遵守各自包含的许可与归属声明。`windows/branding` 下的改编品牌资源不属于 MIT 代码许可范围，受 [`windows/branding/README.md`](windows/branding/README.md) 记录的非商业限制约束；商业分发前必须获得原作者授权。
