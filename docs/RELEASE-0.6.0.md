# Codex Script Loader 0.6.0

本版改进更新体验、Codex 生命周期恢复和通用插件兼容性。它从稳定维护线发布，不包含此前实验分支的账号路由、provider 注入或共享历史迁移。

## 改进与修复

- 重做更新卡片：检查中、已是最新、下载进度、失败原因和上次检查时间均有明确反馈；插件检查完成后保留结果提示。
- 新增安装包更新路径：下载并校验后，用户再次确认才会正常关闭 Codex 和 Loader、打开安装向导；此路径不强制结束进程。
- 恢复普通退出与 Store 更新的区分：包进程结束后退出 Loader；更新期间等待包注册，重连继承的受管端口或启动新版包。观察应用内更新请求，恢复失败时保留诊断状态。
- 简化插件管理布局，恢复作者、来源与版本信息，将运行诊断折叠展示。
- 修复新版输入框的会话身份识别与提交回执处理；支持显式安装插件预发布版本，自动发现仍仅使用稳定版。
- 改善插件目录被占用时的替换、回滚与中断恢复，并保留权限增加和本地修改的确认步骤。

## 升级与验证

标准安装可使用兼容的在线宿主更新；如果旧宿主要求安装器，请退出 Codex 与 Loader 后运行对应架构的安装包。新增的“退出并安装”能力需要先运行支持它的宿主。插件、配置和已有历史不会被迁移到实验账号系统。

本地通过静态检查、165 项 Node 测试、382 项原生检查、Release 构建及 x64 包校验。更新页面已热加载并验证检查反馈。真实关闭应用、安装交接和 Store 升级重连仍需实际环境验收；自动化测试使用模拟安装器，不代表已经执行了真实升级。

提供 Windows x64、Arm64 安装器和便携 ZIP，以及各自的 SHA-256 文件。二进制未进行 Authenticode 签名。

---

This release improves update feedback, Codex lifecycle recovery and generic plugin compatibility. It follows the stable maintenance line and does not include the experimental account router, provider injection or shared-history migration.

## Improvements and fixes

- The update card reports checking, up-to-date, progress, errors and the last check time. Plugin checks retain their result instead of silently clearing it.
- Installer updates download and verify first. A separate confirmation then requests a normal Codex/Loader shutdown and opens setup, without force-killing processes.
- Ordinary process exit is distinguished from Store updates. Loader waits for package registration, reconnects to an inherited managed port or launches the updated package, and retains diagnostics if recovery fails.
- Plugin management shows author, source and version with collapsible diagnostics.
- Composer identity and submission receipts work across the newer native layout. Explicit prerelease plugin installation is supported; automatic discovery remains stable-only.
- Plugin replacement, rollback and interrupted-update recovery handle held-open directories while preserving permission and local-change confirmations.

## Upgrade and validation

Standard installations can use compatible online host updates. If an older host requires an installer, close Codex and Loader and run the matching setup package. The new confirmed installer workflow requires a host that supports it.

Local validation passed static checks, 165 Node tests, 382 native checks, Release build and x64 package verification. The update page and check feedback were tested live. Real shutdown/setup handoff and Store-update reconnection remain environment-specific acceptance checks; automated installer tests use a fake launch callback.

Assets include Windows x64/Arm64 setup executables and portable ZIPs with SHA-256 files. Binaries are not Authenticode-signed.

[Full Changelog](https://github.com/JHees/codex-script-loader/compare/v0.5.17...v0.6.0)
