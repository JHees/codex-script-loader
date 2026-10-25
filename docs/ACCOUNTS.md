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
Disabling saves the off preference immediately, hides management UI and reports
`pending_restart` while an existing backend is attached. It does not interrupt
active chats or wait for activity caches to become empty. A disabled CLI launch
delegates directly to the official executable. Host handoff still requires an
idle backend; normal shutdown disposes the owned processes.

Desktop startup can use a bootstrap connection followed by a main connection
with additional CLI configuration overrides. The router serializes bootstrap
metadata reads and can replace that preliminary backend before handling any
stateful requests. Once chat, login, or other stateful work begins, launch
configuration is fixed; later conflicting connections cannot replace it.

The existing renderer plugin contract remains unchanged. The account operations
are internal host commands with a fixed allowlist. `src/accounts-ui.js` is a
bundled Loader resource, not an installed third-party plugin.

## Accounts page

The settings page has **Accounts** and **Chats** tabs. Account rows expose edit,
set-as-default and a small menu for test, re-authorize, enable/disable and remove.
The editor is a full-page view with basic fields, model catalog, usage query and
configuration versions. The sidebar picker only selects the new-chat default and
shows quotas.

A contiguous **Batch edit** mode lets the user select accounts and enable,
disable, refresh, remove or apply one model/usage configuration. Results are
reported per account; one failure does not abort the rest. Batch provider updates
reuse each account's saved key and create a new revision.

## Shared history

One thread has one authoritative rollout, stored under the primary Codex home.
Account homes keep only authentication, configuration, credentials and model
profiles; their `sessions`, `archived_sessions`, `attachments`,
`codex-remote-attachments` and `thread-writer-locks` directories are local
junctions to the primary home. Every account backend uses the primary
`CODEX_SQLITE_HOME`. Switching accounts changes ownership and resumes the same
thread on the target backend; it never copies rollouts or attachments.

The first start after this layout is introduced merges each account's existing
history into the primary store. A thread found in several homes keeps the copy
with the newest real user turn (then the larger file); the other copy is kept
under `<accountHome>/.history-conflicts`. Original directories are renamed to
`.history-backup-<timestamp>`, never deleted. `history-layout.json` records the
canonical and backup paths. If migration fails, the router keeps the previous
isolated layout and reports the failure instead of leaving a partial layout.

## Accounts and data

The desktop primary account remains available. Additional subscription accounts
and imported relay configurations use separate private homes. Tokens and keys
stay in the current user's private filesystem and are excluded from renderer
settings and browser storage. Removing an account from selection retains its
credentials and history.

The router maintains ownership by thread ID and changes the default account for
new chats only. It no longer migrates every existing chat in the background:
opening or resuming a chat does nothing, and a non-pinned chat moves to the new
default lazily before its next turn. Pinned chats, chats assigned by the quota
policy and chats using a relay model keep their account. A failed lazy switch
leaves the chat on its original account and is reported in the UI.
Historical threads not yet known to the router follow the same lazy rule. Its
secondary account routing does not extend to remote or cloud execution.
Zero-turn persistent threads are checkpointed through the official
archive/unarchive requests before handing ownership to another backend; this
preserves the ID without inserting a model turn. Handoff notifications stay
internal until the owner changes. Shared SQLite uses WAL; the router serializes
ownership changes per thread. If concurrent writes prove unsafe, turn starts are
serialized as a fallback rather than risking the history.
Connection probes and quota refreshes report provider support or errors rather
than inventing a balance. Official Credits snapshots preserve unknown, zero and
unlimited values. Relays are queried through their configured usage URL, or the
common `/user/balance`, `/v1/usage`, `/credits` and `/v1/credits` endpoints;
same-origin URLs only. A custom usage configuration stores the URL and JSON
field paths and never executes provider scripts. Unsupported relays show an
unavailable label.

An older standalone candidate is quarantined during managed startup. On first
enable, its saved account files, default choice, and thread ownership are copied
to a staged private store, which is published after the copy completes. The
legacy store stays intact. An existing built-in store is reused, never
overwritten by migration.

## Model-level routing with a Codex default

The desktop account can stay the global default while individual chats use a
different model backend. The editor fetches each provider's model catalog;
only models checked for inclusion are exposed in the Codex model picker. Each
model exposes only its supported reasoning levels, with a default chosen from
those levels. Relay entries use a stable synthetic ID
(`loader/<accountId>/<base64url(model)>`) and a display name with the account
name, so two providers that offer the same upstream model remain distinct;
selecting one starts or moves the chat to that relay and restores the upstream
model before the request reaches the provider. Only this namespaced ID selects a
relay; an unprefixed native model always stays on the Codex account. Codex models keep the official
catalog's default marker, and a relay default marks its own entry instead.
Selecting a relay model does not change the saved global account or migrate
other chats. Selecting a Codex model for a chat that is pinned to a relay moves
that chat back to the Codex account and clears the pin. A chat created with a
relay model keeps that backend for later turns, resumes and forks until a
different model is requested.

The selected collaboration mode's model takes precedence over the legacy
top-level model, matching the app-server contract. A malformed or unavailable
`loader/` model fails explicitly and never falls back to another provider. An
effort-only change retains the selected relay model. Account data refreshes on
user actions and operation completion; there is no periodic account-page refresh.
Unchanged shared configuration is not rewritten on thread resume.

The last desktop CLI disconnection closes its backend processes, releasing their
thread writers even if the Loader tray host remains alive. The next connection
starts a fresh backend with its own launch arguments.

Pinned chats are reported separately in the global status line and are excluded
from lazy default migration. Choosing a new global account unpins the chats that
account now owns; chats pinned to a different account stay where they are. A
per-thread switch requested explicitly from the account UI pins the target when
it differs from the global default.

A chat running a relay model is model-bound: switching the global account to a
Codex account pins it to its relay instead of migrating it, so its model and
provider stay unchanged and the chat does not reappear rewritten as a Codex
chat. Switching the global account between relay accounts affects new chats and
lazily moves non-pinned chats before their next turn. Selecting a Codex model on
such a chat moves it back to the Codex account and clears the pin. DeepSeek
Flash/Pro advertise the `low`, `high` and `max` reasoning levels, and the effort
explicitly chosen in the picker always wins over the provider profile default.

New chats can follow the selected default account or be assigned by the quota
policy. The quota policy compares the remaining weekly and five-hour windows of
the primary and ready ChatGPT accounts and falls back to the default when no
quota data is available. A chat assigned to an account other than the default is
pinned so later default changes do not pull it away.

## Migrated threads in the catalog

A target account's session index does not contain a row for a chat moved from
another account, so the router merges every account's `thread/list` and then
recovers missing owned chats through `thread/read`, with a short cache. Archived
chats are filtered by their `archived_sessions` path, and a recovered chat can be
opened and continued on its new backend. Recovered chats also honor the client's
section, project, path, search and provider filters, so they never leak into a
Pinned or project-filtered listing. The one-time repair that moves a relay-model
chat back to its relay skips any chat whose Codex-side rollout contains newer
user turns, so post-migration messages are never hidden by the move. Attachments
already live in the shared primary store; no file is copied during a handoff.

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

The default account affects new chats; existing non-pinned chats move lazily
before their next turn. Ephemeral background threads, such as title generation,
stay with the backend that created them and do not count as pending or failed
migrations. A missing history path reports a migration error without
terminating the router.

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
  loading a generated model catalog in the installed official CLI. The
  synthesized relay model entries are compared with the official CLI catalog
  fields for a DeepSeek profile. Provider tests use fake keys and an invalid test endpoint; they do not prove live
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
