# Codex Script Loader

一个不修改 `app.asar` 的 Codex Desktop renderer 插件加载器。它只负责发现插件包、建立生命周期、热重载，并向插件提供受限 API。

当前 v1 边界：

- `manifest.json + index.js` renderer 插件包；
- `start(api)` / `stop()` 生命周期；
- scoped storage、日志、DOM observer、事件清理；
- 仿照 b-nnett/codex-plusplus 的 `api.settings.register()` 与 `registerPage()`；
- Codex 设置中的内建 `Loader` 状态与脚本热重载页；
- 内置 Bennett UI Improvements `1.4.8`；
- Windows 先行，macOS 复用同一插件层。

账户、供应商、Responses 代理、MCP、Skills、CC Switch 导入和独立控制中心不属于当前版本。

## Windows 原生启动

v0.3 的生产入口是无控制台、无托盘图标的 `.NET 10 WinForms WinExe` 后台宿主及其每用户 MSIX。安装后从开始菜单或桌面快捷方式启动；它会启动并监督 Codex，在 Codex 退出后自动结束，不需要 Node.js、PowerShell、cmd 或管理员权限。

原生宿主通过 Windows 包 API发现当前用户的 Microsoft Store Codex，并通过 `IApplicationActivationManager` 传入随机 loopback CDP 端口。它不枚举 `WindowsApps`、不直接运行包内 EXE，也不复制或修改官方 Codex。详细构建、签名和发布说明见 [`windows/README.md`](windows/README.md)。

仓库中的旧批处理入口仅供开发兼容，不进入 MSIX，也不再是受支持的生产启动路径。Node CLI 同样只保留为开发与 parity 工具：

```text
node src\cli.mjs run --live --data-dir .runtime\manual
```

降低 Defender、卡巴斯基等产品的误报是发布门禁，但任何架构、签名或测试流程都无法绝对保证“不被拦截”。正式方案不会要求关闭杀毒软件或添加本地排除项。

## 插件包

`manifest.json`：

```json
{
  "schemaVersion": 1,
  "id": "local.example",
  "name": "Example",
  "version": "1.0.0",
  "main": "index.js",
  "scope": "renderer",
  "runAt": "document-end",
  "permissions": ["dom", "local-storage", "settings"]
}
```

`index.js`：

```js
module.exports = {
  start(api) {
    const page = api.settings.registerPage({
      id: "main",
      title: "Example",
      description: "Plugin settings",
      render(root) {
        root.textContent = "Hello";
      },
    });
    api.log.info("started");
    return () => page.unregister();
  },
};
```

Loader 自身位于 Codex 设置侧栏的 `Loader` 分组，只显示运行状态并提供 `Reload scripts`。插件页统一挂入后续的 `Tweaks` 分组；插件不需要复制设置导航、覆盖 Codex 路由或放置悬浮按钮。

## CLI

```text
node src\cli.mjs status
node src\cli.mjs scripts
node src\cli.mjs doctor
node src\cli.mjs install <file-or-directory> --enable
node src\cli.mjs reload [--live]
node src\cli.mjs safe-mode <on|off>
```

## 安全边界

- 不修改、复制或重新签名官方 Codex；
- CDP 仅绑定 loopback；
- 设置页通过当前受管 CDP target 上的随机、限权 binding 调用状态与重载，不开放 HTTP 控制端口；
- 插件只在 renderer 中运行；
- Loader 不保存账户凭据或供应商密钥；
- Windows 生产启动路径不使用 PowerShell、cmd、Node、临时脚本、自解压或动态 C# 编译；
- 热重载先执行旧实例清理，再加载新实例。

## 验证

```text
npm run check
npm test
npm run smoke:live
```
