# 系统架构

## 1. 推荐架构

```text
用户 / 快捷方式 / 可选 CC Switch 按钮
                 │
                 ▼
        codex-script-loader
        ├─ Platform Launcher
        ├─ CDP Supervisor
        ├─ Script Registry
        ├─ Injection Runtime
        ├─ Diagnostics / Logs
        └─ CLI / Tray Controller
                 │
          loopback CDP only
                 │
                 ▼
       官方 Codex Desktop renderer
                 │
                 └─ Bennett UI 等本地脚本

CC Switch ──独立管理──> provider / auth / routing / history alignment
```

加载器和 CC Switch 没有共享数据库，也不要求同版本发布。未来如果 CC Switch 接受集成，只需启动加载器可执行文件或调用受限的本地控制接口。

## 2. 模块设计

### 2.1 Platform Launcher

职责：

- 发现官方 Codex 安装和宿主进程；
- 构造受限 CDP 启动参数；
- 处理 Windows Store/AppX 激活与 macOS app 参数；
- 保留传入的工作区、深链接等参数；
- 记录自己启动的进程 PID，不接管未知 Codex 实例。

Windows 当前 Codex 可能由 `ChatGPT.exe` 承载，因此不能只寻找名为 `codex.exe` 的进程。AppX 启动需要沿用 Codex++ 已验证的 packaged activation 思路，但不加载 Codex++ bridge、helper server 或其他业务模块。

建议参数：

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=<ephemeral-port>
--remote-allow-origins=http://127.0.0.1:<port>
```

### 2.2 CDP Supervisor

职责：

- 访问 `http://127.0.0.1:<port>/json`；
- 发现和验证 Codex `page` targets；
- 为每个 target 建立独立 WebSocket session；
- 订阅 target 创建/销毁、console、exception、execution context 事件；
- renderer 重载后重新注册新 document 脚本；
- 指数退避重连，正常运行时不高频轮询。

状态机：

```text
Stopped
  └─ start ─> Launching
                ├─ timeout ─> Degraded
                └─ CDP ready ─> Attaching
                                  ├─ invalid target ─> Degraded
                                  └─ injected ─> Healthy
                                                   ├─ renderer reload ─> Attaching
                                                   ├─ script failure ─> Degraded
                                                   └─ process exit ─> Stopped
```

### 2.3 Script Registry

职责：

- 读取 manifest 和本地入口文件；
- 校验 ID、版本、权限、文件边界和 SHA-256；
- 合并全局与逐脚本启用状态；
- 按依赖排序；MVP 不允许循环依赖；
- 生成注入计划，但不直接接触 Codex 数据。

数据模型：

```text
ScriptDescriptor
├─ id / name / version
├─ entry / runAt / scope
├─ enabled / integrity
├─ permissions
├─ dependencies
└─ sourcePath
```

### 2.4 Injection Runtime

每个 document 建立：

```js
window.__codexScriptLoader = {
  runtimeVersion,
  documentId,
  scripts: Map<scriptId, {
    version,
    fingerprint,
    status,
    startedAt,
    stop,
    error
  }>
};
```

注入顺序：

1. 注入最小 bootstrap；
2. 为 future document 注册 bootstrap 和启用脚本；
3. 对当前 document 立即执行；
4. 等待每个脚本注册生命周期；
5. 记录成功或异常；
6. reload 时对旧实例调用 `stop()`，清理后再启动新 fingerprint。

为了兼容旧 IIFE 脚本，loader 会提供包装层，但无法替脚本可靠清理其所有 DOM observer、定时器和全局 listener。因此 Bennett UI 应在迁移阶段补齐明确的 `start/stop` 生命周期。

### 2.5 Controller

MVP 使用 CLI。CLI 与常驻 supervisor 通过以下方式之一通信：

- Windows named pipe；
- macOS Unix domain socket。

不建议默认开放 HTTP 控制端口。控制协议仅提供枚举后的命令，禁止传入任意 JavaScript 字符串。

### 2.6 Diagnostics

日志分层：

- launcher：安装发现、参数、PID、端口；
- cdp：target、连接、重载和重连；
- script：ID、版本、哈希、启动耗时、异常摘要；
- security：非 loopback 拒绝、路径越界、哈希不一致；
- migration：只记录文件名和结果，不记录脚本内容。

日志采用滚动文件，默认保留 7 天或限定总大小。所有可能包含 URL、Cookie、header、消息正文的字段在写入前脱敏。

## 3. 为什么不直接合并进 CC Switch

CC Switch 是有自己发布、签名和自动更新流程的 Tauri/Rust 应用。它不能在已安装版本中动态获得我们新增的 Rust 后端模块；除非：

1. 维护长期 fork 并自行构建发布；或者
2. 向上游提交 PR，等待其合并并发布新版本。

两种方式都会把加载器生命周期绑定到 CC Switch。更合理的集成面是稳定的外部协议：

```text
cc-switch UI（可选）
  └─ spawn codex-script-loader run
  └─ spawn codex-script-loader status --json
  └─ open codex-script-loader://reload
```

这让 CC Switch 更新不会覆盖加载器，加载器更新也不会接触供应商数据。即使完全没有 CC Switch 集成，桌面快捷方式和托盘菜单也能独立工作。

## 4. 方案比较

| 方案 | 更新后维护 | 安装签名风险 | 当前页/刷新支持 | 主进程能力 | 适合本项目 |
|---|---:|---:|---:|---:|---:|
| 外部 CDP 启动器 | 低 | 低 | 需 supervisor 实现 | 弱 | 最适合 |
| 修改 `app.asar` | 高 | 高 | 天然 | 强 | 不需要 |
| 独立解包 Codex 副本 | 高 | 中高 | 天然 | 强 | 不需要 |
| DevTools 手动粘贴 | 高 | 低 | 单次 | 无 | 仅调试 |
| 官方 Codex Plugin | 低 | 低 | 不能注入 renderer UI | 无 | 不满足 UI 脚本需求 |

## 5. 更新策略

### Codex 更新

由于不修改安装包，Codex 更新不需要“修补恢复”。更新后的风险主要是：

- Chromium 参数或 AppX 激活方式变化；
- target 标识变化；
- Codex DOM/内部 renderer bridge 变化；
- Bennett UI 选择器失效。

加载器在发现新 Codex 版本时先运行兼容性探测；探测失败则进入安全模式，而不是反复注入导致 UI 卡顿。

### 加载器更新

- 第一阶段手动从 GitHub Release 下载；
- 第二阶段只检查更新并展示链接；
- 自动更新必须显式启用，验证签名和 SHA-256，支持回滚；
- 加载器更新与脚本更新分离。

### 脚本更新

- 默认仅检查，不自动安装；
- 更新前展示来源、版本、变更摘要和哈希；
- 保存上一版本，支持一键回滚；
- 更新失败不影响其他脚本。

## 6. 可靠性原则

- 文件监听防抖，避免保存脚本时连续注入；
- MutationObserver 和轮询属于脚本自身，不由加载器全局扫描 DOM；
- supervisor 正常时事件驱动，避免高频 `/json` 轮询；
- 每个脚本独立超时和错误边界；
- 连续失败脚本自动隔离，不拖慢输入框或侧边栏；
- 不对 React store、thread API 或会话列表参数做隐式改写，除非具体脚本明确声明并由用户启用。

