# Codex Script Loader 0.5.15

恢复新版 Codex 中点击 Loader 或插件设置入口后页面不切换的问题，并适配左侧独立导航栏。

## 兼容性

**支持并实际验证的 Codex 版本：26.924.1866.0（Windows）。** 其他 Codex 版本、macOS 和 Arm64 未在本轮进行运行验证。通用插件包接口、权限和用户配置不变。

## 修复

- 定位新版主内容区域，避免将导航旁的背景节点误认为设置内容。
- 识别分离的页面标题、正文和滚动容器，恢复 Loader 以及通过通用接口注册的插件设置页。
- 使用当前原生设置高亮样式；显示插件页面时不再同时高亮“常规”等原生页面。
- 在应用语言就绪后更新 Loader 导航标题，避免中文界面残留英文 Settings。

## 升级与验证

标准安装可在本版本发布后通过 Loader 更新功能升级；也可退出 Codex 后运行 `CodexScriptLoader-0.5.15-windows-x64-setup.exe`，或使用同版便携 ZIP。插件及配置保留。本地安装包未进行 Authenticode 签名。

已验收的 renderer 候选通过原位热加载；实际检查覆盖通用设置页挂载、滚动、选中高亮、返回原生页面及无重复节点。Node 静态检查与 148 项测试、Windows Release 构建、284 项原生测试、x64 包验证及 287 个载荷文件的可复现构建检查均通过。本轮未运行需要关闭 Codex 的 Activation Probe，也未在已有正式安装的机器上运行安装/卸载测试。

---

## English

This patch restores Loader and plugin settings pages after the Codex layout update, including the separate navigation rail.

### Compatibility

**Supported and verified Codex version: 26.924.1866.0 on Windows.** Other Codex versions, macOS, and Arm64 were not runtime-tested in this round. The generic plugin package interface, permissions, and user configuration are unchanged.

### Fixed

- Locate the actual main content area instead of selecting a background sibling beside navigation.
- Recognize separate title, body, and scroll containers so registered settings pages mount correctly.
- Highlight the selected plugin page without leaving the native General page highlighted.
- Resolve the Loader navigation title after the app language is available.

### Upgrading and validation

After publication, use Loader updates or exit Codex and install `CodexScriptLoader-0.5.15-windows-x64-setup.exe`; a matching portable ZIP is also provided. Installed plugins and configuration are preserved. Local binaries are not Authenticode-signed.

The accepted renderer candidate was hot-loaded and checked for settings mounting, scrolling, selection, native navigation, and duplicate nodes. Node syntax checks and 148 tests, the Windows Release build, 284 native tests, x64 package verification, and reproducibility checks for 287 payload files all pass. Activation Probe and installation/uninstallation testing were not run against the active installed app.

**Full Changelog:** [v0.5.14...v0.5.15](https://github.com/JHees/codex-script-loader/compare/v0.5.14...v0.5.15)
