# 实现流程与里程碑

## 总体技术选择

- 核心与首个可用版本：Node.js 20+ ESM，只使用内置模块起步；
- HTTP/CDP：本地 loopback HTTP + 原生 fetch/WebSocket 能力；
- CLI：同一 Node 核心的轻量命令入口；
- 管理 UI：原生 HTML/CSS/JavaScript，由仅监听 `127.0.0.1` 的本地服务提供；
- 桌面壳：暂不绑定技术，可在产品化阶段选择 Electron、WebView2/Tauri 或保持浏览器 UI；
- 测试：Node 内置 test runner、临时数据目录和假的 CDP session/server；
- 原则：开发和离线测试不启动、关闭、附加或查询用户当前正在运行的 Codex。

Rust 不是必需条件。它在单文件分发、低后台占用和原生托盘方面有优势，但会延长当前功能验证周期。核心协议保持与语言无关；如果未来确实需要 Rust/Tauri 壳，可以复用 HTTP/控制契约和测试行为，而不重写脚本格式与 UI。复用 Codex++ 中 MIT 许可思路时仍需保留许可证和归属，不复制其 bridge、广告、供应商或数据库模块。

## Phase 0：可行性原型（已开始实现）

目标：先在不接触当前 Codex 的前提下，完成脚本安全边界、CDP 命令计划和 UI 后端契约的离线验证；随后再单独安排真实 Codex 的受控启动测试。

工作项：

已完成：

1. 跨平台数据目录和安全路径边界；
2. manifest、入口文件和 SHA-256 校验；
3. 本地脚本安装、启停和安全模式；
4. CDP loopback target 过滤；
5. 当前 document + future document 注入命令计划；
6. fake CDP session 测试；
7. UI 白名单命令和离线状态接口；
8. 默认 dry-run CLI，避免意外连接正在运行的 Codex。

待执行：

1. 发现当前 Codex/ChatGPT 宿主；
2. 分配 loopback 临时端口；
3. 启动宿主并轮询 `/json`；
4. 连接全部有效 Codex page targets；
5. 对当前 document 执行一个无副作用的标记脚本；
6. 注册 future-document 标记；
7. 加载 Bennett UI 的副本；
8. renderer reload 后验证自动恢复；
9. 确认无 `57321/57322` helper、无 Codex++ bridge 时的功能清单。

验收：

- 重启 Codex 后自动出现 Bennett UI；
- renderer reload 后 3 秒内恢复；
- 不修改 `.codex` 和 CC Switch 数据；
- 不产生重复 observer 导致输入或滚动卡顿。

## Phase 1：Core + Management UI MVP

### 1.1 仓库与核心模块

当前/预期目录：

```text
src/
  cli.mjs
  manager-server.mjs
  registry.mjs
  ui-controller.mjs
prototype/
test/
docs/
```

### 1.2 启动器

- Windows Store/ChatGPT Codex 发现；
- packaged activation；
- 已运行实例检测；
- loopback 随机端口；
- PID/监听端口归属验证；
- graceful shutdown/restart 提示。

### 1.3 CDP supervisor

- `/json/version`、`/json` 查询；
- target 过滤；
- WebSocket command/response correlation；
- `Runtime.enable`、`Page.enable`；
- current + future-document 注入；
- reload/reconnect；
- console/exception capture；
- 指数退避和健康状态。

### 1.4 registry

- manifest schema v1；
- 单文件兼容模式；
- SHA-256；
- 配置原子写入；
- 启停、排序、重复 ID 检查；
- safe mode。

### 1.5 本地管理 UI

- 总览、脚本、诊断、设置四个主要页面；
- 本地脚本加载向导和权限确认；
- 脚本启停、单独重载、移除和错误详情；
- Codex 启动/聚焦/受控重启；
- 安全模式和崩溃恢复提示；
- 实时事件流，列表虚拟化或增量更新，避免日志造成 UI 卡顿；
- 深色/浅色跟随系统，所有文字使用高对比度语义色；
- 中文和英文资源分离。

### 1.6 CLI

- `run`、`status --json`、`reload`、`enable`、`disable`；
- `doctor`、`safe-mode`、`open-scripts`；
- named pipe 控制常驻实例；
- 可读错误码和中文/英文日志。

验收：MVP 可作为“Codex with Scripts”快捷方式使用，UI 能完成无需终端的脚本加载与管理；连续 20 次启动/关闭和 20 次 renderer reload 无重复注入或僵尸 loader。

## Phase 2：Bennett UI 正式迁移

1. 从发布脚本生成独立 loader 包；
2. 去除 Codex++ 命名和设置页依赖；
3. 把 `__codexSessionDeleteBridge` 调用改为可选 adapter；
4. 增加明确 `start/stop`；
5. 统一清理 MutationObserver、event listener、timer、style；
6. 保留历史加载功能“只提高原生查询上限，不重写 provider/DB”的边界；
7. 对输入、滚动、会话展开、深色主题进行性能回归；
8. 设计从 Codex++ 用户脚本目录的只复制迁移。

验收：Codex++ 完全关闭时，Bennett UI 的目标功能可用；加载器退出或 safe mode 后 Codex 恢复原生 UI。

## Phase 3：托盘与安装体验完善

- 托盘状态和脚本开关；
- “Codex with Scripts”开始菜单/桌面快捷方式；
- 可选开机启动；
- 安装、升级、卸载和回滚；
- 卸载只移除加载器与自己的快捷方式，默认保留用户脚本；
- Windows 签名和 Release SHA-256；
- 更新只提示，不静默更新。

验收：普通用户无需终端即可启动、重载、禁用脚本和进入安全模式。

## Phase 4：macOS

- 检测 Codex.app/Owl 宿主；
- 使用 app 参数启动并开启 loopback CDP；
- 处理单实例和 Dock 激活；
- 验证 renderer target 与 bridge；
- notarized/universal binary 发布；
- 不修改 Codex.app，不重新签名 Codex。

## Phase 5：可选 CC Switch 集成

先稳定外部接口，再决定是否提交上游 PR：

- CC Switch 设置页只保存加载器可执行文件路径；
- “使用脚本启动 Codex”调用 `codex-script-loader run`；
- 状态读取调用 `status --json`；
- 不把 loader runtime 编译进 CC Switch；
- 不共享数据库；
- CC Switch 未安装或升级失败时，加载器仍独立可用。

如果 CC Switch 上游不接受，该阶段可以完全省略，不影响产品。

## 测试矩阵

### 单元测试

- manifest 验证、路径越界、哈希；
- CDP 消息 ID correlation；
- target 过滤；
- 配置损坏和原子恢复；
- 日志脱敏；
- script dependency 排序和循环检测。

### 集成测试

- fake CDP：正常响应、超时、断线、target 更换、异常事件；
- future-document registration/remove；
- 文件监听防抖；
- named pipe 单实例和并发命令；
- safe mode 崩溃恢复。

### 真机测试

- Windows Store Codex 新旧两个版本；
- Codex 已关闭、已正常启动、由 loader 启动三种状态；
- 官方账号和 CC Switch custom provider；
- renderer reload、Codex 更新、Windows 重启；
- 多窗口/设置窗口；
- 无网络、代理、端口占用；
- Bennett UI 高频交互性能。

## 发布门槛

第一个公开版本前必须满足：

- 无 Codex 安装包修改；
- 无 `.codex`/CC Switch 数据写入；
- CDP 仅 loopback；
- safe mode 可用；
- doctor 可定位常见启动失败；
- 脚本异常不会阻止 Codex 启动；
- 卸载可恢复到官方快捷方式；
- 许可证、第三方归属、安全说明和风险提示齐全。
