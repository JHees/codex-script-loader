# Model provider compatibility

The account module uses Codex's native **Responses** provider interface. It does
not translate Chat Completions or Anthropic Messages. Models behind OpenRouter
use OpenRouter's Responses endpoint; other services must provide an equivalent
endpoint to use the custom connection type.

## Provider profiles

| Service | Base URL | Model ID | Preset / discovery |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`, `deepseek-v4-pro` | Official presets and authenticated `/models` metadata |
| OpenRouter | `https://openrouter.ai/api/v1` | Complete `provider/model` slug | `/models` context, input modalities and supported parameters |
| Custom Responses | User-supplied HTTPS base | Service-supplied ID | Standard `/models` list, with manual capabilities when absent |

DeepSeek's Flash API ID is `deepseek-flash`, even when its display name contains
a release number such as DeepSeek-V4.1-Flash. Its current Flash and Pro presets
use a 1,048,576-token context, low/high/max reasoning, parallel calls and the
freeform `apply_patch` tool. Flash supports images; Pro is text-only. The UI
keeps advanced fields collapsed and lets the user choose these presets.

OpenRouter discovery maps `context_length`, `architecture.input_modalities`,
and `supported_parameters`. DeepSeek discovery maps `context_window`,
`input_modalities`, and `effort`. An unrecognized service can return a standard
`data` array containing model IDs without declaring capabilities. Missing
metadata is not interpreted as proof of support.
Legacy key/endpoint edits may retain the same model's existing native metadata;
this option is not used for a new connection or a changed model.

Profiles supply the official CLI with an isolated model catalog and API-key
authentication settings, so an inherited subscription-only login setting cannot
block them. Keys stay in the private account home and owned process environment.
Provider websocket and remote compaction assumptions are disabled. Both named
services are stateless Responses endpoints: send the conversation history on
each request and do not depend on stored response IDs. Connection probes allow
reasoning tokens and report incomplete responses separately from HTTP errors.

## Validation recorded on 2026-10-21

- DeepSeek's authenticated model list returned the expected API IDs and
  capabilities. A real `deepseek-flash` profile ran through the Loader account
  router and official Codex CLI in an isolated test workspace: streamed text,
  memory of a previous turn, and a synthetic function call plus result all
  passed. No existing conversations or project files were sent.
- OpenRouter's public model catalog was retrieved through the built-in discovery
  operation, including DeepSeek model IDs and capabilities. Metadata requests
  and probes negotiate HTTP/2 with HTTP/1.1 compatibility; system TLS defaults
  and certificate validation remain enabled. Responses protocol and tool
  configuration follow its official documentation. Paid generation and actual
  tool round trips require a user-provided OpenRouter key and are not implied
  by successful catalog discovery.
- Offline checks cover legacy relay migration and revision-0 rollback,
  credential-origin boundaries, model metadata mapping, stateless SSE probes,
  configuration isolation, and desktop bootstrap/main connection handoff.

## Official references

- [DeepSeek: Integrate with Codex (Chinese)](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)
- [DeepSeek: Responses API compatibility](https://api-docs.deepseek.com/guides/responses_api/)
- [DeepSeek: Model discovery metadata](https://api-docs.deepseek.com/api/list-models/)
- [OpenRouter: Codex integration](https://openrouter.ai/blog/tutorials/codex-cli-openrouter/)
- [OpenRouter: Stateless Responses API](https://openrouter.ai/docs/api_reference/responses/overview)
- [OpenRouter: Model discovery](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
