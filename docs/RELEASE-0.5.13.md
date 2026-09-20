# Codex Script Loader 0.5.13

修复新版 Codex 增加应用入口后，Loader 无法启动 Codex 的问题。

## 修复与改进

- **Codex 启动恢复**：明确选择 Codex 的桌面 `App` 入口，避免将包含多个应用入口的安装包误判为不明确。
- **诊断窗口**：提供“退出 Loader”按钮，方便用户结束 Loader。

## 升级提示

标准安装可通过 Script-Loader 设置页的更新功能升级；手动安装请选择与 Windows 架构匹配的安装器或便携包。已安装插件和配置保留。

## English

This release restores startup after Codex registers a second package application entry.

### Fixed and improved

- Select the desktop `App` entry explicitly instead of treating a package with multiple application entries as ambiguous.
- Provide an **Exit Loader** button in the diagnostics window.

### Upgrading

Standard installations can update from Script-Loader settings. For manual installation, choose the installer or portable ZIP matching your Windows architecture. Installed plugins and configuration are preserved.

**Full Changelog:** [v0.5.12...v0.5.13](https://github.com/JHees/codex-script-loader/compare/v0.5.12...v0.5.13)
