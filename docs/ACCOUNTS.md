# Built-in account module

The Windows Loader owns this optional module. It is disabled by default and
ships in the same host package and version as Loader. No separate plugin ZIP,
manifest permission, backend executable selection, or public plugin API is
involved.

## Startup and settings

`AccountModule` persists the enable preference, owns one account service process,
and registers the account page and sidebar selector only while the service is
running. Settings can enable or disable it without reloading unrelated plugins.
Safe mode suppresses startup without deleting the preference.

Account management can start in an existing desktop session. Routing requires a
managed Codex launch with the module enabled: Loader temporarily supplies its CLI
entry point through Windows package activation, restores the activation lease,
and delegates official CLI work to the installed Codex CLI. Enabling or disabling
the module may require restarting Codex to reconnect the desktop backend.
Disabling is refused while the router, login, probe, or switch operation is busy.

Desktop startup can use a bootstrap connection followed by a main connection
with additional CLI configuration overrides. The router serializes bootstrap
metadata reads and can replace that preliminary backend before handling any
stateful requests. Once chat, login, or other stateful work begins, launch
configuration is fixed; later conflicting connections cannot replace it.

The existing renderer plugin contract remains unchanged. The account operations
are internal host commands with a fixed allowlist. `src/accounts-ui.js` is a
bundled Loader resource, not an installed third-party plugin.

## Accounts and data

The desktop primary account remains available. Additional subscription accounts
and imported relay configurations use separate private homes. Tokens and keys
stay in the current user's private filesystem and are excluded from renderer
settings and browser storage. Removing an account from selection retains its
credentials and history.

The router maintains ownership by thread ID and converges local threads on the
saved global account. Existing running turns and their subtasks stay on their
original account until idle; background reconciliation then migrates them while
preserving history. Historical threads not yet known to the router migrate when
resumed or used for a new turn. The UI reports pending and failed migrations,
with an explicit retry action; failures preserve the original owner. Its
secondary account routing does not extend to remote or cloud execution.
Zero-turn persistent threads are checkpointed through the official
archive/unarchive requests before moving their rollout; this preserves the ID
without inserting a model turn. Handoff notifications stay internal until the
owner changes. Windows extended paths are normalized before checking that the
history remains inside the source account's sessions directory.
Connection probes and quota refreshes report provider support or errors rather
than inventing a balance. Official Credits snapshots preserve unknown, zero and
unlimited values. DeepSeek reads `/user/balance`, OpenRouter reads `/credits`,
and relays exposing `/user/balance` show their remaining balance. Unsupported
relays show an unavailable label. The account menu and compact settings rows use
the same data.

An older standalone candidate is quarantined during managed startup. On first
enable, its saved account files, default choice, and thread ownership are copied
to a staged private store, which is published after the copy completes. The
legacy store stays intact. An existing built-in store is reused, never
overwritten by migration.

## Model providers and configuration versions

Account management can create DeepSeek, OpenRouter, and custom Responses
connections. A profile specifies the HTTPS base URL, model ID, context window,
reasoning effort, image input, patch-tool format, and parallel tool support.
OpenRouter uses the complete `provider/model` ID; capability values must match
that model. A model appearing in the picker does not prove its tool behavior.

Every ready API relay, including older imported records, exposes **Edit
configuration** in its account menu. First editing a legacy relay records its
original configuration as revision 0, preserves its provider identity for
running turns, and saves the edit in a new home. The original revision remains
restorable. Re-importing a version-managed relay is refused so that an import
cannot overwrite the selected revision or credential; edit it through the
configuration form instead.
Keeping the same legacy model while editing its key or endpoint can retain the
native CLI's existing model defaults, without requiring an unknown context
length. Changing models requires discovered or explicitly supplied metadata.

DeepSeek Flash and Pro presets fill their documented capabilities. Advanced
fields are collapsed by default. **Fetch models and configure** reads the
provider's `/models` endpoint and maps DeepSeek or OpenRouter metadata to the
same generic profile. Standard OpenAI-shaped model lists are also accepted;
missing context or capability metadata remains unknown and requires manual
configuration. Model discovery can filter by an ID or display-name keyword,
and limits each result to the account protocol's message budget. Display names
are separate from API IDs: DeepSeek-V4.1-Flash uses `deepseek-flash` on the
official API. No key is returned with model metadata or stored in browser state.

The DeepSeek preset follows its [Codex integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
and [Responses API](https://api-docs.deepseek.com/guides/responses_api/):
`https://api.deepseek.com`, `deepseek-flash`, 1,048,576 context tokens, high
reasoning, image input, freeform patch tools, and parallel calls. OpenRouter
uses `https://openrouter.ai/api/v1`, following its
[Codex integration guide](https://openrouter.ai/blog/tutorials/codex-cli-openrouter/).
These presets were checked on 2026-10-21. No Chat Completions translation is
involved. Each profile supplies a private native model catalog to the official
CLI, disables provider websocket and remote compaction assumptions, and routes
the desktop model list through the selected account.

Saving an edit creates a new account home and configuration revision. The
previous home, credential, generated `provider.toml`, and `models.json` remain
intact. `provider-profile.json` contains the versioned model settings;
`provider-configs/<group-id>.json` records the active revision and creation
history. Both documents carry `schemaVersion: 1`; unknown schema versions are
rejected without rewriting them. The active pointer changes only after the
new revision's files are written. History responses contain metadata and model
settings, never API keys.

The UI can restore any saved revision, including that revision's key. Leaving
the key blank on an edit reuses it only for the same HTTPS origin; changing
origin requires a new key. A selected profile's global account follows the
active revision. Busy turns finish on their old backend before migrating;
old revisions that still own threads remain included in history queries.
Failed migrations preserve their old owner.

Configuration versions cover provider/model settings and their credentials.
Each backend launch still inherits the current primary configuration and
repository instructions, then applies the selected model overrides. Restoring
a provider revision does not revert primary MCP, security, or trust settings,
and does not change the user's primary config file. This is provider revision
switching, not a promise of automatic Loader downgrade or schema migration.

## Independent account updates

Global selection migrates persistent conversations. Ephemeral background threads,
such as title generation, stay with the backend that created them and do not count
as pending or failed migrations. A missing history path reports a migration error
without terminating the reconciliation loop.

DeepSeek profiles disable the inherited desktop code-mode wrapper, whose custom
`exec` tool is unsupported by the provider. Ordinary function tools and the
supported `apply_patch` custom tool remain available. This override applies only
to DeepSeek backends and does not edit the primary desktop configuration.

The account backend keeps its router in a stable process and runs account
editing, model discovery, login and connection checks in a replaceable worker.
An update waits for active management operations to finish, then replaces that
worker. Ongoing chats, their official CLI processes and routing connections
remain attached. Completed management results are retained across the update.

Build an independent package with `windows/scripts/package-accounts.ps1`.
It contains the account assembly, account UI and a manifest with content hashes
and protocol versions. Apply it with `windows/scripts/update-accounts.ps1`,
passing `-PackageRoot`, the installed `-HostExecutable`, and the account store
as `-DataRoot`. The command reports completion or failure. A rejected candidate
keeps the previous worker, active revision and UI. Successful updates reload the
bundled account UI through the running Loader. The update endpoint is restricted
to the current Windows user and requires a per-process token.

Older installations need a one-time bootstrap with Codex closed. Replacing the
old router while the desktop is open can break the desktop's reconnect recovery
and leave its main view in an error state, even after the backend reconnects.
Do not disable/re-enable the account module or restart the app server as a live
bootstrap procedure. Once bootstrapped, management updates replace only the
worker and can run during chats. Changes to the stable router,
bootstrap or host protocol still need a separate runtime upgrade; a worker-only
package does not replace those components. Retained package revisions do not
constitute a guarantee that older code can read newer account data.

## Development checks

- `npm run check` and `npm test` include settings-toggle and account UI checks.
- Build `windows/CodexScriptLoader.Windows.sln` in Release configuration.
- Run both `CodexScriptLoader.Tests` and `CodexScriptLoader.Accounts.Tests`.
- Startup checks cover bootstrap/main argument changes with overlapping and
  sequential connections, applying the main overrides, and rejecting later
  changes without disconnecting an attached chat.
- Provider checks cover isolated revisions, same-origin key reuse, rejection
  of cross-origin key reuse, rollback, model routing, busy-turn handoff, and
  loading a generated model catalog in the installed official CLI. Provider
  tests use fake keys and an invalid test endpoint; they do not prove live
  DeepSeek/OpenRouter generation or tool compatibility. The separate
  [provider compatibility notes](PROVIDER_COMPATIBILITY.md) distinguish live
  service validation from these deterministic checks.
- `tools/accounts/verify_router.py --fixture` runs the production router with
  two official CLI clients, isolated test homes, and a local provider fixture.
  Supply the account test assembly and .NET host using its `--assembly` and
  `--dotnet` options; `--database` and `--provider` are unused in fixture mode.
- Package verification requires the account library and bundled UI alongside
  the host. An installed SDK is not required to run the packaged backend.
- `tools/accounts/verify_hot_update.py` runs two official CLI clients against a
  local fixture, replaces the worker during a streamed turn, checks history and
  cancellation, and rejects a corrupt candidate without replacing the router.

Cold-launch activation and interactive subscription authorization require a
desktop acceptance run. Do not use an already running user session as an
activation probe.
