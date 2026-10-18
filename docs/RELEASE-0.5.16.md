# Codex Script Loader 0.5.16

修复新版 Codex 设置页识别问题，避免 Script-Loader 及插件设置入口错误出现在聊天侧栏旁边。

## 修复

- 根据原生设置导航标记识别页面，不再把聊天标题中的“外观、配置、Usage”等文字当成设置页依据。
- 设置入口固定挂载在识别到的原生导航内，不再扩大到父布局容器。
- 返回聊天或设置容器被替换时，完整移除导航、插件面板和旧监听，恢复原生内容。
- 页面切换瞬间的旧按钮、停止后的回调不能重新挂载设置界面；仅导航属性变化时也会重新校验。

## 升级与验证

标准安装可通过 Loader 更新功能升级。手动安装时，退出 Codex 后运行对应架构的 `CodexScriptLoader-0.5.16-windows-<x64|arm64>-setup.exe`；也提供便携 ZIP 和 SHA-256 校验文件。已有插件、设置和通用插件接口保持不变，无需重新配置插件。

设置宿主修复已在当前 Windows Codex 中热加载并验收。回归覆盖聊天标题误识别、原生设置导航、页面退出清理、旧按钮、连续页面切换、重复加载及停止后的回调。发布流程检查 Node 与原生测试、x64/Arm64 构建、可复现载荷、安装包和校验文件；x64 安装/卸载验证在 CI 的独立环境执行。

安装包未进行 Authenticode 签名。此次没有更改原生二进制行为；Arm64 和其他 Codex 版本未做交互运行验证。未来 Codex 调整原生设置结构时仍可能需要适配，识别不到设置导航时不会猜测其他挂载位置。

---

## English

Fixes settings-page detection in newer Codex versions, preventing Script-Loader and plugin settings entries from appearing beside the chat sidebar.

### Fixed

- Identify settings by native navigation markers instead of matching settings-related words in chat titles.
- Mount entries inside the identified navigation rather than expanding into its parent layout container.
- Remove navigation, plugin panels and old listeners when leaving settings or replacing the settings container, restoring native content.
- Reject stale button actions and callbacks from stopped hosts. Revalidate when navigation attributes change without replacing DOM nodes.

### Upgrade and validation

Standard installations can use Loader updates. For manual installation, exit Codex and run `CodexScriptLoader-0.5.16-windows-<x64|arm64>-setup.exe` for your architecture. Portable ZIPs and SHA-256 files are also provided. Existing plugins, settings and the generic plugin interface are preserved.

The renderer fix was hot-loaded and accepted on Windows. Regression checks cover misleading chat titles, native navigation, teardown, stale controls, repeated navigation/reload and stopped callbacks. Release checks cover Node/native tests, x64/Arm64 builds, reproducible payloads, packages and checksums; x64 installation/uninstallation is tested in isolated CI.

Packages are not Authenticode-signed. Native binary behavior is unchanged. Arm64 and other Codex versions were not interactively tested. Future native settings changes may require adaptation; an unrecognized settings navigation does not trigger a guessed mount elsewhere.

**Full Changelog:** [v0.5.15...v0.5.16](https://github.com/JHees/codex-script-loader/compare/v0.5.15...v0.5.16)
