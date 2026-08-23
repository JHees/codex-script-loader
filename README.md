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

## 启动

要求 Node.js 22 或更高版本，以及 Microsoft Store 版官方 Codex。

Windows 可直接双击：

```text
Start Codex with Loader.cmd
```

该入口是可读的批处理文件，不包含自编译、未签名的 EXE，也不调用 PowerShell。窗口需要在 Codex 运行期间保持打开。

开发模式：

```text
node src\cli.mjs run --live --data-dir .runtime\manual
```

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
- Windows 启动路径不使用 PowerShell、动态 C# 编译或未签名自制 EXE；
- 热重载先执行旧实例清理，再加载新实例。

## 验证

```text
npm run check
npm test
npm run smoke:live
```
