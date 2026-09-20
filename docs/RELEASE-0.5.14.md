# Codex Script Loader 0.5.14

修复 Loader 启动正常、使用一段时间后状态请求无响应及插件设置入口消失的问题，增强短暂断连后的自动恢复。

## 修复与改进

- **连接恢复**：持续检查桥接会话和页面中的桥接客户端。即使 renderer target ID 不变，也会重连已失效的会话，并记录重连结果。
- **监控稳定性**：HTTP、WebSocket 和命令超时后继续重试；当 Codex 页面仍可达时，不再将单独的桥接故障当成 Codex 退出。
- **并发消息**：串行发送共享 CDP WebSocket 上的消息，避免状态回复、传输事件和健康检查同时发送。
- **设置入口保留**：获取插件列表失败时保留上次成功的列表；连接恢复后重新同步，避免短暂断连让插件设置入口消失。
- **Store 更新检测**：Codex 不可达后保留 90 秒检测窗口，为延迟注册的新 Store 包留出恢复时间。

## 升级与验证

本次包含原生宿主修复，仅热重载插件脚本不足以更新。控制连接仍正常的标准安装可使用 Loader 更新功能；连接已失效时，请退出 Codex 和 Loader，运行匹配系统架构的安装器。已安装插件和配置保留，通用插件接口与启动器接管协议不变。

提供 Windows x64、Arm64 安装器与便携 ZIP，以及各包的 `.sha256` 校验文件。发布二进制未进行 Authenticode 签名。关闭 Codex 后，Loader 可能继续等待最多 90 秒以检测 Store 更新；需要立即结束时可使用诊断窗口的“Exit Loader”。

回归测试覆盖同一页面的桥接断开与重连、桥接客户端丢失、目标查询超时后继续监控，以及断连期间保留插件设置列表。

## English

This release improves recovery when Loader starts normally but later stops answering status requests and plugin settings entries disappear.

### Fixed and improved

- Check both the bridge session and its renderer client, reconnect stale sessions even when the renderer target ID is unchanged, and log reconnections.
- Keep monitoring after transient HTTP, WebSocket, and command timeouts. A bridge failure alone no longer counts as Codex exiting while its page remains reachable.
- Serialize sends on shared CDP WebSockets so replies, transport events, and health checks do not send concurrently.
- Preserve the last successful plugin list during a temporary bridge failure, then reconcile settings entries when the connection recovers.
- Allow a 90-second detection window after Codex becomes unreachable so delayed Store package registration can be detected.

### Upgrading and validation

These fixes include native host changes; reloading plugin scripts alone is insufficient. Standard installations with a working control connection can use Loader updates. If the connection has already failed, exit Codex and Loader and run the installer for your Windows architecture. Installed plugins and configuration are preserved; the generic plugin interface and launcher handoff protocol are unchanged.

Windows x64 and Arm64 installers and portable ZIPs include separate `.sha256` files. Release binaries are not Authenticode-signed. After Codex closes, Loader may wait up to 90 seconds while checking for a Store update; use **Exit Loader** in the diagnostics window to exit immediately.

Regression coverage includes same-target bridge reconnection, missing renderer bridge clients, monitoring after target-query timeouts, and preserving plugin settings entries during disconnection.

**Full Changelog:** [v0.5.13...v0.5.14](https://github.com/JHees/codex-script-loader/compare/v0.5.13...v0.5.14)
