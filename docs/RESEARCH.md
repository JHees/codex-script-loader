# 社区方案调研

调研时间：2026-08-02。

## 1. 官方 Codex Plugins

仓库：<https://github.com/openai/plugins>

官方插件使用 `.codex-plugin/plugin.json`，主要承载 skills、apps、MCP、hooks、commands 和 assets。它适合扩展 agent 工具与工作流，但目前没有公开的 renderer JavaScript/CSS 注入接口，因此不能替代本项目所加载的 renderer UI 插件。

结论：保留官方插件体系，但它与本项目解决的是不同层次的问题。

## 2. b-nnett/codex-plusplus

仓库：<https://github.com/b-nnett/codex-plusplus>

加载方式：

- 修改 Codex `app.asar`，让一个小 loader 在 Codex 启动时先运行；
- runtime、tweaks、配置和日志位于用户目录；
- Codex 更新移除 patch 后，通过 watcher 检测并 repair；
- macOS 需要处理 asar integrity 和重新签名；
- Windows Store 版需要复制为可写的 managed app，并使用专用快捷方式。

优点：天然获得启动生命周期，可支持 renderer、main process 和 native bridge。

缺点：修改应用包、签名和更新恢复复杂；功能范围远大于我们只加载 renderer 脚本的需求。

可借鉴：manifest、`start/stop` 生命周期、安全模式、doctor、脚本目录和更新回滚。

不采用：ASAR patch、main-process tweak、native bridge、managed Codex copy。

## 3. pawnsmaster/codex-rtl-toolkit

仓库：<https://github.com/pawnsmaster/codex-rtl-toolkit>

加载方式：

- Windows 一键 launcher 关闭旧宿主并用 loopback DevTools 端口重启 Codex/ChatGPT Desktop；
- Node injector 等 renderer 就绪后注入本地 CSS/JavaScript；
- 不修改 Codex 安装文件，也不修改账号和消息数据；
- 明确拒绝非本地 DevTools target。

优点：与我们的 renderer-only 需求最接近，部署简单，Codex 更新不会覆盖 loader。

已知限制：注入只持续当前 renderer session，页面 reload 后需要手动重新 inject。

可借鉴：loopback-only、启动前处理残留进程、安装零修改、安全审计清单。

需要增强：常驻 CDP supervisor、future-document 注入、target 重建监听、多脚本 registry 和热重载。

## 4. jackwener/OpenCLI

仓库：<https://github.com/jackwener/OpenCLI>

Codex 文档：<https://opencli.info/docs/adapters/desktop/codex.html>

加载方式：从终端以 `--remote-debugging-port` 启动 Codex，通过 CDP 控制内部 UI、读取 DOM 和执行交互。

优点：进一步证明官方 Codex renderer 可以在不修改安装包的情况下通过 CDP 稳定连接。

差异：OpenCLI 目标是自动化和控制，不是持久用户脚本生命周期管理。

可借鉴：CDP endpoint 配置、status/dump/screenshot 诊断思想和桌面适配器分层。

## 5. friuns2/codex-web-ui

仓库：<https://github.com/friuns2/codex-web-ui>

加载方式：解包 `app.asar`，修改 main bundle 和 renderer，加入 HTTP/WebSocket bridge，再启动 headless Electron。也会同时开启 Node inspector 和 Chromium remote debugging。

优点：可以深度修改主进程和把 UI 暴露到浏览器。

缺点：补丁面很大，依赖 minified bundle 锚点，安全和更新成本高，不适合一个轻量本地脚本加载器。

可借鉴：启动预检、端口与 origin 安全、bridge 权限最小化。

## 6. BJDubb/codex-full-output

仓库：<https://github.com/BJDubb/codex-full-output>

加载方式：下载并验证 Codex MSIX，提取到独立目录，修改 `app.asar` 注入 CSS/JS，创建独立 launcher；更新由该工具自行重新构建替换。

优点：不修改 Microsoft Store 原安装，回滚边界清晰。

缺点：形成不受 Store 自动更新的第二份 Codex，仍需维护 ASAR 锚点与完整安装生命周期。

可借鉴：安装标记、防误删、构建后验证、替换失败回滚。

## 7. 调研结论

本项目选择“外部 CDP 启动器 + 常驻 supervisor”，原因：

1. UI 插件只需要 renderer 能力；
2. 不修改 Codex 安装包，避免签名和 Store 副本维护；
3. 不接触会话、认证和供应商文件；
4. 可以完全独立于 CC Switch 更新；
5. 通过 `Page.addScriptToEvaluateOnNewDocument` 和 target 监听可以补上简单 CDP injector 的刷新丢失问题；
6. 如果将来 CDP 被官方构建禁用，可以保留 ASAR loader 作为明确标注的备用后端，而不是一开始就承担该复杂度。
