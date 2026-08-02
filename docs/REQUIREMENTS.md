# 需求与功能边界

## 1. 产品目标

Codex Script Loader 是一个最小化、可审计的本地工具。它负责启动官方 Codex Desktop，并把用户明确启用的本地 JavaScript 注入 Codex renderer。

成功标准：卸载 Codex++ 后，用户仍能稳定使用 Bennett UI 等 renderer 脚本，同时 CC Switch 继续独立管理供应商、认证、路由和会话统一。

## 2. 强制边界

加载器不得读写以下数据：

- `~/.codex/state_5.sqlite` 及其 WAL/SHM；
- Codex `sessions`、`archived_sessions` 和 JSONL 会话记录；
- `~/.codex/auth.json`；
- `~/.codex/config.toml`；
- CC Switch 数据库和供应商凭据；
- Codex 安装目录中的 `app.asar` 或签名文件。

只有在执行显式迁移命令时，加载器才可以只读扫描原 Codex++ 用户脚本目录，并把用户选择的脚本复制到自己的数据目录。迁移不得删除原文件。

## 3. MVP 功能

### 3.1 Codex 启动

- 发现 Windows Microsoft Store/ChatGPT 宿主中的 Codex 安装。
- 以仅监听 `127.0.0.1` 的临时 CDP 端口启动。
- 转发 Codex 原有启动参数、协议激活参数和工作区参数。
- 检测 Codex 是否已运行：
  - 若已由本加载器启动，则复用现有实例；
  - 若未开放受管 CDP 端口，则提示用户保存输入并重启；
  - 不强制结束未知进程，除非用户明确确认。
- Windows 首发；macOS 在第二阶段支持。

### 3.2 脚本发现与配置

- 默认加载器数据目录：
  - Windows：`%APPDATA%/codex-script-loader/`
  - macOS：`~/Library/Application Support/codex-script-loader/`
- `scripts/<script-id>/manifest.json` + 本地入口文件。
- 支持原始单文件 `.js` 的兼容模式，便于迁移 Bennett UI。
- 全局开关和逐脚本开关。
- 配置原子写入；损坏配置自动进入安全模式，不覆盖原文件。
- 不自动下载脚本更新。

### 3.3 注入生命周期

- 轮询 CDP `/json`，识别所有可信 Codex `page` target，而非只选择第一个页面。
- 对当前 document 执行 `Runtime.evaluate`。
- 对后续 document 注册 `Page.addScriptToEvaluateOnNewDocument`。
- renderer reload、窗口重建或 target WebSocket 地址变化时自动重新连接。
- 以脚本 ID + 内容 SHA-256 作为注入指纹，避免重复执行。
- 脚本更新时先调用旧实例的 `stop()`，再加载新版本；不支持生命周期的旧脚本使用幂等包装器。
- 监听 `Runtime.exceptionThrown` 和 `Runtime.consoleAPICalled`，形成可读诊断日志。

### 3.4 用户控制

MVP 先提供 CLI；稳定后增加轻量托盘菜单：

- 启动/显示 Codex；
- 重新加载全部脚本；
- 启用/停用某个脚本；
- 安全模式启动；
- 打开脚本目录；
- 显示 Codex/CDP/脚本状态；
- 查看最近错误；
- 退出加载器但不强制关闭 Codex。

### 3.5 诊断

`doctor` 至少检查：

- 官方 Codex 是否安装；
- Codex/ChatGPT 宿主路径与版本；
- 受管 CDP 端口是否只监听 loopback；
- target 是否为预期的 Codex 页面；
- manifest、入口文件和 SHA-256 是否一致；
- 是否存在脚本重复 ID；
- Bennett UI 是否仍引用缺失的 Codex++ bridge；
- 最近一次注入结果、异常和 renderer 重连次数。

## 4. 脚本规范草案

```json
{
  "schemaVersion": 1,
  "id": "com.bennett.ui-improvements",
  "name": "Bennett UI Improvements",
  "version": "1.2.4",
  "entry": "index.js",
  "scope": "renderer",
  "runAt": "document-start",
  "enabled": true,
  "integrity": "sha256-...",
  "permissions": ["dom", "codex-renderer-bridge"]
}
```

推荐入口格式：

```js
globalThis.codexScriptLoader.register({
  async start(api) {},
  async stop() {}
});
```

兼容模式允许普通 IIFE 脚本，但必须由加载器建立全局实例记录，并要求脚本尽可能自行清理事件监听器、观察器和定时器。

## 5. 安全要求

- CDP 必须绑定 `127.0.0.1`/`::1`，不得监听局域网地址。
- 使用系统分配的随机高位端口，避免固定 `9229`。
- 启动后验证监听进程 PID 与加载器启动的 Codex 宿主一致。
- target 必须通过类型、URL/标题特征和启动进程归属校验。
- 拒绝 `ws://0.0.0.0`、非 loopback 或远程 CDP endpoint。
- 只执行本地脚本；脚本网络更新必须是显式操作并显示来源、版本与哈希。
- 日志不得记录认证头、API Key、Cookie、会话正文或完整敏感 URL。
- 连续启动崩溃或同一脚本连续异常达到阈值后，下次自动进入安全模式。
- 加载器本身不向 renderer 暴露任意文件读写或命令执行桥。

## 6. Bennett UI 兼容目标

首轮迁移包括：

- DOM/CSS、设置搜索、侧栏布局、项目折叠；
- Markdown 图片和公式；
- 额度显示的 Codex renderer fetch 路径；
- 原生历史会话加载上限；
- 隐藏消息可见性修复（若仍需要）。

需要清理或替换：

- Codex++ `/diagnostics/log` 调用改为可选的 loader 日志 API；
- Codex++ `/settings/get`、`/codex-model-catalog` 依赖改为 renderer 推断或可选的 CC Switch 状态适配器；
- 所有 `window.__codexSessionDeleteBridge` 引用必须允许 bridge 不存在。

## 7. 后续功能

- Windows 托盘 UI 和开机启动；
- macOS Codex/Owl 启动与 CDP 兼容；
- 脚本目录文件监听和开发热重载；
- 版本化脚本 API；
- 导入/导出脚本配置；
- 可选 URI：`codex-script-loader://reload`；
- 可选 CC Switch 外部工具入口，但不形成运行时依赖。

