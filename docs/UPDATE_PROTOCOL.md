# Script-Loader update protocol

Script-Loader 0.5.0 introduces the versioned Windows installation used by online host updates. Version 0.5.0 itself must be installed once with the NSIS installer; standard installations can switch to later compatible hosts without restarting Codex.

Version 0.5.1 adds a Chromium-backed HTTPS fallback for the specific Windows Schannel `SEC_E_NO_CREDENTIALS` failure. It creates a hidden target through the already verified managed CDP endpoint, closes it after transfer, and retains all official-host, size, SHA-256, archive, manifest, and per-file checks. General TLS or certificate failures do not activate this fallback.

## Installation layout

```text
CodexScriptLoader/
├── CodexScriptLoader.exe
├── active.json
├── previous.json
└── versions/<version>/<rid>/
    └── CodexScriptLoader.exe
```

The root executable is a small NativeAOT launcher. It accepts only semantic versions, `win-x64` or `win-arm64`, and an entry point contained by the selected version directory. It waits for the host to report healthy after plugin injection. If the active host exits or misses the health deadline, the launcher restores `previous.json`. An incomplete update transaction also makes the launcher prefer the previous healthy host.

`active.json` and `previous.json` use schema version 1 and declare the required launcher and handoff protocol versions. Pointer files are replaced atomically on the same volume.

## Release policy and trust model

The production client checks only the latest stable release from `JHees/codex-script-loader`. Drafts, prereleases, equal versions, downgrades, custom repositories, custom download URLs, non-HTTPS URLs, and non-GitHub download hosts are rejected.

The client downloads the architecture-specific portable ZIP and that package's matching `.sha256` asset from the same release. It verifies the GitHub asset size and unique SHA-256 record before extraction. It then rejects absolute paths, traversal, duplicate paths, symbolic links, excessive file counts, excessive expanded size, wrong versions or RIDs, incompatible protocols, missing entry points, unlisted files, and per-file size or hash mismatches from `update-manifest.json`.

This is a GitHub Release + SHA-256 trust model. It detects corruption and mismatched assets, but it does not protect against an attacker who can replace both a release asset and its checksum file. Independent manifest signing and Authenticode are future hardening layers.

## Handoff protocol v1

The old and candidate hosts communicate over a random current-user-only named pipe. A random 256-bit token binds the messages to the transaction, while a current-user file lock implements single-instance protocol v0.3.

1. The old host records the exact loopback CDP endpoint, listener PID, Codex package family, renderer URL, activation PID, and candidate PID.
2. The candidate revalidates the listener and package identity, initializes its registry and bridge, and force-replaces the settings host and plugin lifecycles.
3. The old host removes its future-document injection registrations, pauses monitoring, and releases the instance lock.
4. The candidate acquires the lock, starts monitoring, writes the previous and active pointers, and commits the transaction.
5. Only after the commit acknowledgement does the old host exit. The Codex process, CDP port, renderer, task, and page stay alive.

If any step fails before commit, the old host reacquires the lock, reconnects its bridge, force-restores its runtime and plugins, restores the previous active pointer when necessary, and records `rolledBack`. Old versions are cleaned only after a later healthy standard-install startup, with the active and previous versions always retained.

## Renderer API

The current-user bridge exposes:

- `get_update_status`
- `set_auto_update`
- `check_for_updates`
- `start_update`
- `cancel_update` (download phase only)

`UpdatePreferences` has `schemaVersion`, `autoUpdate`, and the fixed `stable` channel. `UpdateSnapshot` exposes versions, state, check time, progress, release URL, a redacted error, installer compatibility, and preferences; it never exposes local filesystem paths.

Update state is one of `idle`, `checking`, `available`, `downloading`, `verifying`, `staging`, `switching`, `succeeded`, `failed`, or `rolledBack`.
