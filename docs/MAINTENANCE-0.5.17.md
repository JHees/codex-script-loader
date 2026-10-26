# 0.5.17 maintenance backports / 维护回迁

The accepted maintenance candidate is released as **0.6.0**. This document records its 0.5.17 baseline; see [0.6.0 release notes](RELEASE-0.6.0.md).

This maintenance branch starts at the published `v0.5.17` commit (`6ed2275`).
It retains the `0.5.17` product version for candidate testing; it does not move
the existing release tag or replace its published assets.

The unfinished account-routing experiment is preserved at `fdbf9de` on
`archive/account-routing-wip-20261025`. That checkpoint is **not a release**.
Provider portability, native UI behavior and cross-provider delegation have not
completed end-to-end acceptance. No account-routing code is included here.

## Backport inventory

| Change | Source | Included |
| --- | --- | --- |
| Composer identity across separate native conversation and execution-host ancestors | `edba2c0` | Yes |
| Explicit installation of published alpha/beta plugin releases and semantic-version comparison | `edba2c0` | Yes; automatic discovery remains stable-only |
| Plugin update badges, progress, release-note links and error details | `edba2c0` | Yes |
| Accepted submission receipts remain valid when a follow-up merely mentions their ID | Working changes preserved in `fdbf9de` | Yes |
| Updating plugins whose root directory is held open, with verified rollback and journal recovery | Working changes preserved in `fdbf9de` | Yes |
| Account workers, model routing, provider injection, ownership and shared-history migration | Account experiment | No |
| App-server transport probe and account-module test harness | Account experiment diagnostics | No |
| Process-exit and package-registration lifecycle policy | Working changes preserved in `fdbf9de` | Yes; ordinary exit and Store update waiting |
| Update intent observation and reconnection to the inherited managed port | Maintenance candidate | Yes; native update RPC, process ownership checks and plugin reinjection |
| Experimental process discovery, automatic close/restart and forced cleanup | Working changes preserved in `fdbf9de` | No |
| Alpha product packaging and release workflow | Account experiment packaging | No |

The selected changes operate on the generic plugin and composer interfaces.
They do not depend on a third-party plugin ID, model account or account runtime.
The startup compatibility fixes already published in `v0.5.17` remain intact.

## Verification

- `npm run check` and all 165 Node tests pass.
- The Windows solution builds in Release configuration without warnings or errors.
- Native self-tests report `PASS 382 tests`, including lifecycle decisions, the pinned-directory update
  and interrupted-update recovery checks.
- No account assembly, account UI or account-routing reference is present in the
  production source or solution. Live activation remains a separate manual check.
- Real Codex exit and Store-update restart acceptance require installing the native candidate;
  renderer hot reload alone does not update the host lifecycle implementation.

## 中文说明

本维护线基于已经发布的 `v0.5.17`，保留该产品版本供候选验证，不移动正式 tag，
也不覆盖已有 Release 安装资产。账户路由实验完整保存在 `fdbf9de` 检查点，明确为未完成状态。

回迁内容包括新版输入框身份识别、插件预发布版本的显式安装及版本比较、插件更新状态与详情、
提交回执保留，以及目录被占用时的插件更新与回滚恢复。账户路由、共享历史、provider 注入及
实验性的强制退出/重启行为不进入本维护线。

当前候选另行恢复普通退出与包注册状态判断，并增加应用内更新意图通知和受管端口重连。
此恢复流程不强制结束进程。真实退出与 Store 升级重启仍需安装原生候选后验收。

回退程序不删除账号目录、凭据、聊天历史或已安装插件。曾被实验版写入自定义 provider 的
旧会话仍可能需要已有的配置修复；本维护线不会修改用户的 Codex 配置或重写这些历史记录。
