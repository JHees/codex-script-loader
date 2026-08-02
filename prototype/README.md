# UI Prototype

这是 Codex Script Loader 桌面管理界面的无依赖交互原型，用于验证信息架构和操作流程。

直接打开 `index.html` 即可查看。原型中的脚本加载、重载、Codex 启停和诊断是浏览器内模拟状态，尚未连接 Rust/CDP 后端，也不会修改本机文件。

真实实现将遵循 `docs/UI_BACKEND_CONTRACT.md`，由 Tauri/Rust 后端执行所有文件、进程和 CDP 操作。

![Codex Script Loader 总览原型](preview.png)
