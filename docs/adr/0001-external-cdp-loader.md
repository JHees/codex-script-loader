# ADR-0001：使用外部 CDP 启动器加载 renderer 脚本

- 状态：Accepted for prototype
- 日期：2026-08-02

## 背景

用户已把供应商、认证和会话管理迁移到 CC Switch，只需要保留 Codex Desktop renderer 用户脚本。Codex++ 的完整 patch/runtime/bridge 范围过大，并且曾让脚本加载与会话、后端桥接和 UI 管理耦合。

## 决策

实现一个可审阅的 Node sidecar，以受限的 loopback CDP 参数启动官方 Codex，并通过 CDP 注入本地脚本。Windows 用户入口是普通 `.cmd` 文件，不生成或分发自制 EXE。加载器不修改 Codex `app.asar`，不使用 Codex++ helper server，也不嵌入 CC Switch。

## 理由

- 当前目标只需要 renderer，不需要 main-process/native tweak；
- Codex++ 本地代码已证明 `Runtime.evaluate` 和 `Page.addScriptToEvaluateOnNewDocument` 足够完成脚本注入；
- OpenCLI 和 codex-rtl-toolkit 证明外部 CDP 路线可用于官方 Codex Desktop；
- 不修改安装包可显著降低签名、Store 更新和回滚复杂度；
- 与 CC Switch 分离后，两者可以独立更新和故障隔离。

## 后果

正面：

- 安装和卸载简单；
- Codex 更新通常不会抹除 loader；
- 不需要维护 Codex 副本；
- 能清晰承诺不操作会话和供应商数据。

负面：

- Codex 必须由 loader 启动，普通快捷方式启动的既有实例无法事后开启 CDP；
- CDP 是高权限本地调试面，必须严格限制 loopback 和脚本来源；
- 如果官方构建停止接受 CDP 参数，需要重新评估备用后端；
- renderer DOM 和私有 bridge 仍然不是稳定公共 API，具体脚本需要随 Codex UI 更新维护。

## 未采用方案

- 直接修改 `app.asar`：更新和签名成本过高；
- 独立解包 Codex 副本：形成第二套更新路径；
- 合并进 CC Switch：依赖上游发布周期，增加供应商管理应用的攻击面；
- 官方 Codex Plugin：目前不提供 renderer UI JavaScript 注入能力；
- 手动 DevTools 注入：无法满足自动启动与重载。

## 复审条件

出现以下任一情况时复审：

- 官方提供受支持的 renderer extension API；
- Codex 禁止 loopback CDP 启动；
- macOS Owl 版本无法获得 renderer CDP target；
- 用户明确需要 main-process/native tweak 能力。
