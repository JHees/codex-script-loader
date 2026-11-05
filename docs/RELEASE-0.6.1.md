# Codex Script Loader 0.6.1

本版恢复新版 Codex 输入区的插件入口，改进应用更新后的受管连接恢复，并加入官方桌面包的云端静态兼容预警。

## 修复与改进

- 支持新版推理控件的挂载标记，保留旧版模型控件兼容；不修改用户草稿或降低任务身份校验。
- 在已验证的受管进程中注册并回读更新重启参数，保留现有参数和标志。更新操作在参数验证通过后才交给 Codex 原有更新器。
- 适配新版打包结构中的更新服务，报告观察器或注册失败；更新恢复等待 Codex 自己的首次启动并重连继承的端口，不额外启动第二个 Codex。
- 设置页页脚增加项目介绍入口。
- 独立定时检查官方最新 Windows x64 桌面包的包身份、输入区和设置导航特征；报告明确区分静态通过、疑似不兼容和检查错误。
- 构建工具链更新到 .NET SDK 10.0.403，使用已修复已知漏洞的 .NET 10.0.14 运行时与 AOT 编译器。

## 升级与验证范围

此版本包含原生宿主和重启注册组件更新，需要通过 Loader 更新流程或对应架构安装器更新完整宿主。仅热加载脚本不能替换原生组件。已安装第三方插件和用户配置保持独立。

验证包括 Node 契约测试、原生 Release 构建与测试、安装包校验，以及输入区候选的原位热加载验证。真实 Codex 的退出、Store 升级及重连仍需对应运行环境验收；独立测试夹具不等于已对真实 Codex 执行升级。

云端预警仅检查静态源码特征，不安装 Codex、不登录账号、不检查第三方插件内部实现，也不自动修复或发布。详情见 [桌面兼容性预警](DESKTOP-COMPATIBILITY.md)。

提供 Windows x64、Arm64 安装器与便携 ZIP，以及各自 SHA-256 校验文件。二进制未进行 Authenticode 签名。

---

This release restores plugin accessories in the newer Codex composer, improves managed reconnection after app updates, and adds a static desktop compatibility watch.

- Recognize the newer reasoning-control anchor while retaining the previous model-control anchor and existing task-identity checks.
- Register and read back managed restart arguments in the verified Codex process, preserving existing arguments and flags. The native updater proceeds only after preflight succeeds.
- Discover the newer bundled update service and report observer/registration errors. Recovery waits for Codex's own first launch and inherited endpoint instead of launching another instance.
- Add a project introduction link to the settings footer.
- Independently inspect the latest official Windows x64 package for identity, composer and settings signals, distinguishing missing signals from inspection errors.
- Update the build toolchain to .NET SDK 10.0.403 and the patched .NET 10.0.14 runtime/AOT compiler.

Upgrade the complete host through Loader's update flow or the installer for your architecture. Script reload alone cannot replace the native components. Installed third-party plugins and user settings remain independent.

Validation covers Node contracts, native Release build/tests, package verification and the live composer candidate. Real Codex shutdown, Store upgrade and reconnection remain environment-specific acceptance steps; isolated fixtures are not an actual Codex upgrade.

Assets include Windows x64/Arm64 setup executables and portable ZIPs with SHA-256 files. Binaries are not Authenticode-signed. The cloud watch is static only and does not test signed-in behavior or third-party plugin internals.

[Full Changelog](https://github.com/JHees/codex-script-loader/compare/v0.6.0...v0.6.1)
