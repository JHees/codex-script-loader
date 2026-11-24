# Codex Script Loader 0.6.3

修复 Windows 版 Codex 多窗口环境下的任务路由。原生输入区仍挂载的后台标签页现在可以接收该任务的插件命令。主窗口切到其他任务后，原先可能返回 `RENDERER_UNAVAILABLE`。

窗口选择优先匹配前台输入区。只有一个窗口持有目标后台任务时，才向它分派允许后台执行的命令。请求受信任输入的插件仍须匹配前台任务，多个后台窗口同时匹配时会拒绝分派。

已在 Windows x64 版 Codex 26.1120.5083.0 实测任务命令，并在 26.1117.4957.0 实测后台窗口选择。更新需要替换原生宿主。通过 Loader 更新，或退出 Codex 后运行匹配架构的安装器，随后通过 Loader 启动 Codex。

## English

Plugin commands can now reach a task in a mounted background tab when several Codex windows are open. Loader prefers a matching foreground composer and accepts a single background owner for commands eligible for background execution. Ambiguous background matches are rejected. Plugins requesting trusted input still require a matching foreground composer.

Task commands were verified on Codex Desktop for Windows x64 26.1120.5083.0, and background-window selection was verified on 26.1117.4957.0. Update the native host through Loader, or exit Codex, run the installer for your architecture and start Codex through Loader.

[Full Changelog](https://github.com/JHees/codex-script-loader/compare/v0.6.2...v0.6.3)
