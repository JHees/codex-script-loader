# Codex Script Loader 0.6.2

本版修复连接仍在但插件已丢失时的恢复，支持经过校验的分离聊天窗口，并移除影响原生更新交互的 UI 钩子。

## 修复与改进

- 检查各窗口实际的插件与宿主状态；新窗口或文档重建后恢复缺失的运行时，保留其他正常窗口的实例，诊断显示实际运行结果。
- 允许本机主聊天页和分离聊天页，继续排除头像浮层、外部网页及意外 URL 参数。多窗口命令按任务上下文选择目标；无法唯一确定时拒绝执行。
- 使用应用自己的设置导航打开插件设置页，避免模拟头像菜单点击导致超时。
- 移除更新按钮和 renderer 更新服务上的生命周期钩子，保留 Codex 官方自动更新及通知。继续登记原生重启参数；退出时结合包进程、版本、注册状态和同用户的待完成部署证据等待重连，不额外启动第二个 Codex。

## 升级与验证范围

通过 Loader 更新流程或对应架构安装器升级完整宿主。分离窗口和运行时恢复需要新的原生程序，仅热加载脚本不能替代升级。已安装第三方插件和用户配置保持独立。

本地验证包括 169 项 Node 测试、431 项原生自检、Release 构建和 x64 包校验。独立 Electron 夹具验证了新增分离窗口、文档重建恢复、其他实例保留和头像浮层排除；真实主窗口验证了三个设置页导航。真实官方更新后的首次启动和真实分离窗口仍需对应运行环境验收。

资产为 Windows x64/Arm64 安装器、便携 ZIP 和各自的 SHA-256 文件。二进制未进行 Authenticode 签名。

---

This release repairs missing plugin runtimes even when the connection remains alive, supports validated detached chat windows, and removes UI hooks from the native update flow.

- Read actual plugin and host state per window. Restore missing runtimes after a new window or document replacement without restarting healthy instances in other windows.
- Allow local main and detached chat pages while excluding avatar overlays, external pages and unexpected URL parameters. Route multi-window commands by task context and reject ambiguous matches.
- Open plugin settings through the application's own settings navigation instead of simulated profile-menu clicks.
- Remove renderer update-service and button hooks while retaining official updates and notifications. Keep native restart-argument registration and wait for reconnection using process, version, registration and pending deployment evidence; do not launch a second Codex instance.

Upgrade the complete host through Loader or the installer. Script reload alone cannot enable the native changes. Third-party packages and user settings remain independent.

Local validation covers 169 Node tests, 431 native checks, a Release build and x64 package verification. An isolated Electron fixture covers detached windows, document recovery, instance preservation and overlay exclusion. Real main-window settings navigation passed. Actual official update/restart and detached-window acceptance remain environment-specific checks.

Assets include x64/Arm64 installers and portable ZIPs with SHA-256 files. Binaries are not Authenticode-signed.

[Full Changelog](https://github.com/JHees/codex-script-loader/compare/v0.6.1...v0.6.2)
