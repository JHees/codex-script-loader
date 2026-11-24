# Codex Script Loader 0.6.4

改进 Windows 版 Codex 更新后的连接恢复。若更新后的应用重新提供受管端口，Loader 会校验归属并重连。如果端口在 20 秒后仍未恢复，Loader 会向已确认的桌面程序请求一次正常关闭，等待退出后重新启动受管实例。启动 Loader 时发现未经接管的 Codex 也会先请求正常关闭；若应用仍驻留托盘，会提示手动退出。

Loader 按各版本包清单识别桌面可执行文件，同包后台工具可以继续运行。无法确认身份的进程会阻止重复启动。输入区接口新增可选的 `reuseMatching`，插件可复用当前任务草稿中唯一且完全相同的指令块。编辑过或重复的指令保留原文。

目标环境为 Windows 版 Codex 26.1120.5083.0。更新恢复通过策略和进程识别测试，本次没有在活动聊天中触发真实商店升级。通过 Loader 更新，或退出 Codex 后运行匹配架构的安装器，再通过 Loader 启动 Codex。

## English

After a Codex desktop update, Loader checks whether the updated app restored the managed endpoint. If the endpoint is still absent after 20 seconds, Loader requests a normal window close once and waits for the desktop process to exit before relaunching. Starting Loader while an unmanaged Codex is open also requests a normal close. If Codex stays in the tray, Loader prompts the user to exit it.

Executable identity comes from the manifest for each process's package version. Background helpers can remain running, while unresolved processes block a second launch. Composer plugins can now request exact reuse of one matching instruction block in a restored draft.

The target is Codex Desktop for Windows 26.1120.5083.0. Recovery policy and process classification were tested without triggering a Store update during a live chat. Update Loader or run the installer for your architecture after exiting Codex.

[Full Changelog](https://github.com/JHees/codex-script-loader/compare/v0.6.3...v0.6.4)
