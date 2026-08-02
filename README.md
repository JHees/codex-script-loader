# Codex Script Loader

一个独立于 Codex++ 和 CC Switch 的 Codex Desktop 本地脚本加载器。

当前仓库处于架构规划阶段。目标是只解决一件事：安全、稳定地把经过用户确认的本地 renderer JavaScript 加载到 Codex Desktop，不修改 Codex 会话数据库、认证信息、供应商配置或安装包。

## 核心结论

- 采用外部启动器 + Chrome DevTools Protocol（CDP）注入。
- 不修改、解包或重新签名 Codex 的 `app.asar`。
- Windows 首发，随后支持 macOS。
- 首发版本包含独立桌面管理 UI；CLI 作为诊断和自动化接口保留。
- 加载器与 CC Switch 分开更新；未来只提供可选的 CLI/URI 集成接口。
- 第一批兼容脚本是 Bennett UI Improvements。

## 规划文档

- [需求与功能边界](docs/REQUIREMENTS.md)
- [系统架构](docs/ARCHITECTURE.md)
- [社区方案调研](docs/RESEARCH.md)
- [实现流程与里程碑](docs/IMPLEMENTATION_PLAN.md)
- [桌面管理 UI 规范](docs/UI_SPEC.md)
- [UI 与加载器后端契约](docs/UI_BACKEND_CONTRACT.md)
- [ADR-0001：选择外部 CDP 注入](docs/adr/0001-external-cdp-loader.md)
- [可交互 UI 原型](prototype/README.md)

## 预期命令

```text
codex-script-loader run
codex-script-loader status
codex-script-loader reload [script-id]
codex-script-loader doctor
codex-script-loader safe-mode
codex-script-loader open-scripts
codex-script-loader migrate-codexplusplus
```

这些命令目前是设计目标，尚未实现。

## 非目标

- 不管理 Codex 供应商、API Key 或 OAuth。
- 不同步、迁移或重写会话历史。
- 不提供 Codex 主进程原生模块注入。
- 不下载并静默执行远程脚本。
- 不成为新的 Codex++ 或 CC Switch 分支。

## 项目状态

`Planning / 0.0.0`
