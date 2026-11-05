# Desktop compatibility watch / 桌面兼容性预警

The `Desktop compatibility (static)` workflow runs at 02:17, 08:17, 14:17 and
20:17 UTC, on manual dispatch, and when its checker or tests change. Scheduled
runs require the workflow on the default branch and can be delayed by GitHub.
Each run inspects the latest official Windows x64 MSIX, including unchanged
versions, so fixes in Loader are checked without a persistent baseline cache.

The package URL comes from [OpenAI's Windows deployment documentation](https://learn.chatgpt.com/docs/enterprise/windows-deployment):
[latest desktop x64 MSIX](https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix).
It does not track the separate Codex CLI release feed.

The workflow runs Loader's Node and renderer contract tests, then reads the
downloaded MSIX and ASAR without installing or executing them. It checks:

- The expected package name, primary application ID and executable entry.
- The renderer HTML entry and composer editor/controller/task-identity markers.
- A model-control anchor supported by the checked-out composer host.
- The native settings navigation marker.

These checks inspect source text, not rendered DOM or service instances.
The result is **limited static evidence**, not a full compatibility certificate.
The normal Windows build workflow still owns native build/package tests.
Loader's watch contains no third-party plugin IDs, implementation or source;
plugins need their own independent compatibility checks.

| Result | Action |
| --- | --- |
| `passed-static` | Listed signals were found. Runtime behavior is still unverified. |
| `suspected-incompatibility` | A signal is missing; the job fails for investigation. |
| `check-error` | Download, layout or parsing failed; the job fails without asserting compatibility. |

The Actions summary and JSON artifact identify the checked commit, desktop
version, architecture, package SHA-256 and individual checks. SHA-256 identifies
the inspected file; it does not independently authenticate the publisher.
Only the report is uploaded, with 14-day retention. No package, application
source or user data is uploaded. Failure notifications follow the user's GitHub
Actions notification settings; no issue creation, automated repair, release or
deployment is performed.

Local invocation, using PowerShell 7:

```powershell
node --test test/desktop-compatibility.test.mjs
./scripts/check-desktop-compatibility.ps1 -PackagePath ./downloaded.msix -ReportPath ./report.json
```

Omit `-PackagePath` to download the latest official package. Exit 0 means
`passed-static`; missing signals and inspection errors exit 1. Windows package
activation, CDP ownership, plugin lifecycle, layout, interaction and server-side
feature changes require a separate real-desktop test and are not covered here.

## 中文说明

每天北京时间 04:17、10:17、16:17、22:17 检查官方最新 Windows x64 桌面包，
也支持手动运行。工作流需合入默认分支后才会定时执行，GitHub 调度可能延迟。

检查包身份、主程序入口、输入区控制器与任务身份标记、当前 Loader 支持的
挂载标记及设置导航特征，同时运行 Node 与 renderer 契约测试。缺失特征或
下载/解析错误会使 Actions 失败；网络失败不会被当成兼容或不兼容。

这是源码静态预警，不会安装应用、操作当前电脑或读取账号。真实激活、连接、
挂载、交互和生命周期仍需桌面验收；第三方插件由其自己的仓库独立检查。
报告保留 14 天，通知沿用 GitHub Actions 设置，不会自动修复、发版或部署。
