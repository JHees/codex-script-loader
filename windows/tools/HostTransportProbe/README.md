# Host Transport Probe

Development-only Windows x64 probe. It is not installed into the production Loader and does not switch accounts. The wrapper forwards the desktop's bytes to the same captured, hash-pinned official CLI, preserving stdin/stdout/stderr and its exit code. Non-app-server commands are also passed through.

The probe does not edit Codex installation files, authentication, provider configuration, user/machine environment variables, CC Switch or chat history. Starting the official app naturally performs its normal startup and token-refresh operations.

## Prepare while the ordinary Codex instance is running

Run `Prepare-Probe.ps1` with PowerShell 7. Preparation builds a self-contained executable and captures the selected official app-server path/hash, package version, the two Windows sandbox environment markers that native CLI overrides otherwise remove, and any `CODEX_HOME`/`CODEX_SQLITE_HOME` location overrides. It does not capture credential values or activate, stop or restart Codex. The official CLI must have a valid OpenAI Authenticode signature.

The preparation directory is private runtime data. Do not commit `baseline/config.json`, activation receipts, process IDs or local paths. The published diagnostic executable is unsigned; it is not a formal Loader release.

## Run after exiting Codex

1. Finish active tasks, completely exit Codex, and let the ordinary Loader exit. Do not run the test from Codex's built-in terminal.
2. In an ordinary **non-administrator PowerShell 7** window, run the prepared `Run-Probe.ps1`. It refuses to proceed while any process of the Codex package exists. It does not terminate an existing instance or schedule a restart.
3. The probe temporarily calls Windows `IPackageDebugSettings.EnableDebugging`, activates the existing Store package, and uses a small helper mode to resume only the exact package's initial thread. The debugger command contains only the quoted executable; Windows supplies `-p` / `-tid`, and the helper reads the package/receipt context from the adjacent `baseline/config.json`. It then calls `DisableDebugging` and releases the COM object before checking desktop readiness.
4. `baseline/activation.json` must report `TRANSPORT_STARTUP_PASS` and `debugCleared: true`. A `relay-*.json` report must show `appServer: true` and `counts.initializeSucceeded: true`. These prove startup/transport selection, **not** complete interactive acceptance.
5. In the opened official window, confirm the same account and history, continue a small local chat, exercise a tool and its ordinary approval flow, cancel a turn, and check an application tool and the configured sandbox. Do not change login or weaken permissions to make the test pass.
6. Close this test window normally. Launch Codex through your usual Loader shortcut to return to the usual setup. The test window itself does not load renderer plugins.

`relay-*.json` is updated while a wrapper is running. It contains byte totals, fixed allowlisted method counts, initialization success and lifecycle status. It never stores JSON-RPC payloads, request IDs, tokens, chat contents or backend stderr. Large/unknown frames are forwarded unchanged even when the diagnostic cannot count them.

The original official child's sandbox markers are restored only for the captured hash-pinned CLI. A captured sandbox-service feature flag is preserved. Actual sandbox behavior remains part of manual acceptance; startup success does not certify it.

## Failure and cleanup

The probe leaves a newly opened Codex window for you to close; it never automatically relaunches it. Bring back `activation.json`, `relay-*.json` and `probe-error.txt`. A package/CLI update invalidates the captured baseline; prepare again from a normal run.

Failure reports distinguish `enabling-package-debugging`, `activating-package`, waiting for the helper, renderer, and backend initialization. They retain `errorHResult`, the specific `nativeOperation` when available, whether debug setup succeeded, and any separate cleanup error. A generic `ArgumentException` from an older report does not establish which native call failed. The executable-only debugger command is a compatibility correction; a successful unit test does not prove that the original Windows failure has disappeared.

The debug lease is cleared in a `finally` block and its COM object is released. If the report says debugging was requested but cleanup could not be verified, the prepared `Run-Probe.ps1 -Cleanup` retries only the recorded package cleanup; it does not activate Codex. Closing the test window and launching normally discards the process-scoped override. Do not reuse a directory with old relay/resume receipts for another activation.

## Build and tests

Build the Windows solution in Release and run `CodexScriptLoader.Tests`. Tests use synthetic child processes and do not activate Codex or call `EnableDebugging`. They check byte preservation, argument/environment handling, EOF and early exit, diagnostic redaction, and environment-block formatting.

Windows API references: [EnableDebugging](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ipackagedebugsettings-enabledebugging), [package debugging lifetime](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ipackagedebugsettings), [startup environment/helper sequence](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/profiling/clr-profilers-and-windows-store-apps#startup-load).
