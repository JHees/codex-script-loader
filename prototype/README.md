# Management UI

这是 Codex Script Loader 的无依赖本地管理界面。

直接打开 `index.html` 时进入静态演示模式，不修改本机文件。运行以下命令后，页面会连接真实的本地管理 API：

```powershell
node src/cli.mjs serve --data-dir .runtime/manual
```

离线 `serve` 支持脚本检查/复制安装、启停配置、可恢复隔离/恢复、安全模式、dry-run 计划和离线诊断，但不检查 Codex。通过 `node src/cli.mjs run --live` 启动时，同一界面还会显示受管 Codex/CDP 状态，并允许显式实时 reload；API 本身仍不提供 shell、eval 或任意 CDP endpoint 参数。

Rust/Tauri 不是使用该 UI 的前置条件，未来只可能作为托盘和分发薄壳。

![Codex Script Loader 总览原型](preview.png)
