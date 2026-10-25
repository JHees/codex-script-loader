using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace CodexScriptLoader.Accounts;

public sealed record ProviderModelSettings(
    string Id,
    string? Name = null,
    int? ContextWindow = null,
    IReadOnlyList<string>? ReasoningLevels = null,
    string? DefaultReasoningEffort = null,
    bool SupportsImages = false,
    bool? SupportsTools = null,
    string ToolFormat = "function",
    bool ParallelToolCalls = false,
    bool Enabled = true,
    IReadOnlyList<string>? SupportedReasoningLevels = null)
{
    public ProviderModelSettings Validate(string provider)
    {
        var id = Id?.Trim() ?? "";
        if (id.Length is < 1 or > 160 || id.Any(char.IsWhiteSpace) || id.Any(char.IsControl))
            throw new InvalidOperationException("MODEL_INVALID");
        var name = string.IsNullOrWhiteSpace(Name) ? id : Name!.Trim();
        if (name.Length > 240 || name.Any(char.IsControl)) throw new InvalidOperationException("MODEL_INVALID");
        var contextWindow = ContextWindow is > 0 ? ContextWindow : null;
        if (contextWindow is { } context && (context < 1024 || context > 2_147_483_647))
            throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        var levels = (ReasoningLevels ?? []).Select(level => level?.Trim() ?? "").Where(level => level.Length > 0)
            .Distinct(StringComparer.Ordinal).ToArray();
        var supported = (SupportedReasoningLevels ?? []).Select(level => level?.Trim() ?? "").Where(level => level.Length > 0)
            .Distinct(StringComparer.Ordinal).ToArray();
        if (levels.Any(level => !ProviderSettings.Efforts.Contains(level)) ||
            supported.Any(level => !ProviderSettings.Efforts.Contains(level)) ||
            supported.Length > 0 && levels.Any(level => !supported.Contains(level, StringComparer.Ordinal)) ||
            DefaultReasoningEffort is { } effort && !ProviderSettings.Efforts.Contains(effort) ||
            levels.Length > 0 && DefaultReasoningEffort is { } defaultEffort && !levels.Contains(defaultEffort) ||
            ToolFormat is not ("function" or "freeform"))
            throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        if (provider == "deepseek" && id is "deepseek-flash" or "deepseek-v4-pro" &&
            (levels.Any(level => level is not ("low" or "high" or "max")) || supported.Any(level => level is not ("low" or "high" or "max")) ||
             DefaultReasoningEffort is not (null or "low" or "high" or "max")))
            throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        return this with
        {
            Id = id, Name = name, ContextWindow = contextWindow, ReasoningLevels = levels,
            SupportedReasoningLevels = supported.Length > 0 ? supported : levels,
        };
    }
}

public sealed record ProviderUsageSettings(
    string Mode = "auto",
    string? Url = null,
    string RemainingPath = "remaining",
    string UnitPath = "unit",
    string LimitPath = "limit",
    string UsedPath = "used",
    string ValidPath = "isValid")
{
    public ProviderUsageSettings Validate(string baseUrl)
    {
        if (Mode is not ("auto" or "custom")) throw new InvalidOperationException("INPUT_INVALID");
        foreach (var path in new[] { RemainingPath, UnitPath, LimitPath, UsedPath, ValidPath })
            if (path.Length is < 1 or > 200 || path.Any(char.IsControl) || path.Any(value => !(char.IsLetterOrDigit(value) || value is '.' or '_' or '-')))
                throw new InvalidOperationException("INPUT_INVALID");
        if (Mode == "auto") return this with { Url = null };
        if (string.IsNullOrWhiteSpace(Url) || Url.Length > 2048) throw new InvalidOperationException("ENDPOINT_INVALID");
        var endpoint = new Uri(baseUrl);
        var uri = Uri.TryCreate(Url, UriKind.Absolute, out var absolute) ? absolute : new Uri(endpoint, Url);
        if (uri.Scheme != "https" || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0 ||
            uri.Host != endpoint.Host || uri.Port != endpoint.Port)
            throw new InvalidOperationException("ENDPOINT_INVALID");
        return this with { Url = Url };
    }
}

public sealed record ProviderSettings(
    string Provider, string BaseUrl, string Model, int ContextWindow,
    string? ReasoningEffort = null, bool SupportsImages = false,
    string ToolFormat = "function", bool ParallelToolCalls = false, bool UseDefaultModelMetadata = false,
    IReadOnlyList<ProviderModelSettings>? Models = null, ProviderUsageSettings? Usage = null)
{
    public static readonly string[] Efforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

    public ProviderSettings Validate()
    {
        var endpoint = ValidateEndpoint(Provider, BaseUrl);
        var model = Model?.Trim() ?? "";
        if (model.Length is < 1 or > 160 || model.Any(char.IsWhiteSpace) || model.Any(char.IsControl))
            throw new InvalidOperationException("MODEL_INVALID");
        if ((ContextWindow < 1024 && !(ContextWindow == 0 && UseDefaultModelMetadata)) || ReasoningEffort is not (null or "minimal" or "low" or "medium" or "high" or "xhigh" or "max" or "ultra") ||
            ToolFormat is not ("function" or "freeform")) throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        if (UseDefaultModelMetadata && ContextWindow != 0) throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        if (Provider == "deepseek" && model is "deepseek-flash" or "deepseek-v4-pro" &&
            ReasoningEffort is not (null or "low" or "high" or "max")) throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        var models = (Models ?? []).Where(item => item is not null).Select(item => item.Validate(Provider)).ToArray();
        if (models.Length > 100 || models.Select(item => item.Id).Distinct(StringComparer.Ordinal).Count() != models.Length)
            throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        if (models.Length == 0)
            models = [new(model, model, ContextWindow > 0 ? ContextWindow : null,
                ReasoningEffort is null ? [] : Provider == "deepseek" && model is "deepseek-flash" or "deepseek-v4-pro"
                    ? ["low", "high", "max"] : [ReasoningEffort],
                ReasoningEffort, SupportsImages, null, ToolFormat, ParallelToolCalls)];
        if (models.All(item => item.Id != model))
            models = [new(model, model, ContextWindow > 0 ? ContextWindow : null, ReasoningEffort is null ? [] : [ReasoningEffort],
                ReasoningEffort, SupportsImages, null, ToolFormat, ParallelToolCalls), .. models];
        models = models.Select(item => item.Id == model && !item.Enabled ? item with { Enabled = true } : item).ToArray();
        return this with { BaseUrl = endpoint, Model = model, Models = models, Usage = Usage?.Validate(endpoint) };
    }

    [JsonIgnore]
    public IReadOnlyList<ProviderModelSettings> EffectiveModels => Models is { Count: > 0 }
        ? Models
        : [new(Model, Model, ContextWindow > 0 ? ContextWindow : null,
            ReasoningEffort is null ? [] : Provider == "deepseek" && Model is "deepseek-flash" or "deepseek-v4-pro"
                ? ["low", "high", "max"] : [ReasoningEffort], ReasoningEffort, SupportsImages, null, ToolFormat, ParallelToolCalls)];

    public static string ValidateEndpoint(string provider, string baseUrl)
    {
        if (provider is not ("deepseek" or "openrouter" or "custom")) throw new InvalidOperationException("PROVIDER_INVALID");
        var endpoint = RelayAccountSource.ValidateEndpoint(baseUrl);
        var host = new Uri(endpoint).Host;
        if (provider == "deepseek" && host != "api.deepseek.com" || provider == "openrouter" && host != "openrouter.ai")
            throw new InvalidOperationException("PROVIDER_ORIGIN_MISMATCH");
        return endpoint.EndsWith("/responses", StringComparison.Ordinal) ? endpoint[..^10] : endpoint;
    }

    [JsonIgnore]
    public string DisplayName => Provider switch { "deepseek" => "DeepSeek", "openrouter" => "OpenRouter", _ => "自定义模型接入" };
}

public sealed record ProviderRevision(int Version, string AccountId, DateTimeOffset CreatedAt, string LoaderVersion);
internal sealed record ProviderGroup(int SchemaVersion, string Id, int ActiveVersion, IReadOnlyList<ProviderRevision> Versions);
internal sealed record ProviderConfiguration(int SchemaVersion, ProviderSettings Settings);

public sealed partial class AccountStore
{
    private string ProviderGroupPath(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidOperationException("CONFIGURATION_INVALID");
        return Path.Combine(root, "provider-configs", id + ".json");
    }

    private ProviderGroup ReadProviderGroup(string id)
    {
        var group = JsonSerializer.Deserialize<ProviderGroup>(File.ReadAllText(ProviderGroupPath(id)), JsonOptions)
            ?? throw new InvalidOperationException("CONFIGURATION_INVALID");
        if (group.SchemaVersion != 1 || group.Id != id) throw new InvalidOperationException("CONFIGURATION_VERSION_UNSUPPORTED");
        return group;
    }

    private bool IsCurrentConfiguration(AccountEntry account) =>
        account.ConfigurationGroup is null || File.Exists(ProviderGroupPath(account.ConfigurationGroup)) &&
        ReadProviderGroup(account.ConfigurationGroup).ActiveVersion == account.ConfigurationVersion;

    public string[] ConfigurationAccounts(string id) => Get(id).ConfigurationGroup is { } group
        ? ReadProviderGroup(group).Versions.Select(version => version.AccountId).ToArray() : [id];

    public ProviderSettings? ReadProviderSettings(string id)
    {
        if (Get(id) is { ConfigurationGroup: null } or { Provider: null }) return null;
        var document = JsonSerializer.Deserialize<ProviderConfiguration>(
            File.ReadAllText(Path.Combine(Home(id), "provider-profile.json")), JsonOptions)
            ?? throw new InvalidOperationException("CONFIGURATION_INVALID");
        if (document.SchemaVersion != 1) throw new InvalidOperationException("CONFIGURATION_VERSION_UNSUPPORTED");
        return document.Settings.Validate();
    }

    public ProviderSettings ReadProviderSettingsOrLegacy(string id)
    {
        var account = Get(id);
        if (account.Kind != "relay" || account.BaseUrl is null || account.Model is null)
            throw new InvalidOperationException("PROVIDER_PROFILE_REQUIRED");
        return ReadProviderSettings(id) ?? LegacyProviderSettings(account);
    }

    public object ProviderConfigurationStatus(string id)
    {
        var account = Get(id);
        if (account.Kind != "relay" || account.Status == "removed") throw new InvalidOperationException("PROVIDER_PROFILE_REQUIRED");
        if (account.ConfigurationGroup is null)
            return new { schemaVersion = 1, activeVersion = 0, settings = LegacyProviderSettings(account), versions = Array.Empty<object>(), legacy = true };
        var group = ReadProviderGroup(account.ConfigurationGroup);
        if (account.ConfigurationVersion != group.ActiveVersion) throw new InvalidOperationException("CONFIGURATION_CHANGED");
        return new
        {
            schemaVersion = group.SchemaVersion, activeVersion = group.ActiveVersion,
            settings = ReadProviderSettings(id) ?? LegacyProviderSettings(account),
            versions = group.Versions.Select(version => new
            {
                version.Version, version.CreatedAt, version.LoaderVersion,
                model = Get(version.AccountId).Model, provider = Get(version.AccountId).Provider,
            }).ToArray(),
        };
    }

    private static ProviderSettings LegacyProviderSettings(AccountEntry account) => new(
        new Uri(account.BaseUrl!).Host switch { "api.deepseek.com" => "deepseek", "openrouter.ai" => "openrouter", _ => "custom" },
        account.BaseUrl!, account.Model!, 0, UseDefaultModelMetadata: true,
        Models: [new ProviderModelSettings(account.Model!, account.Model)]);

    internal string? ResolveProviderKey(string baseUrl, string? apiKey, string? id)
    {
        if (string.IsNullOrWhiteSpace(apiKey) && id is not null)
        {
            var previous = Get(id);
            if (new Uri(previous.BaseUrl!).GetLeftPart(UriPartial.Authority) != new Uri(baseUrl).GetLeftPart(UriPartial.Authority))
                throw new InvalidOperationException("PROVIDER_KEY_REQUIRED");
            apiKey = ReadRelayKey(id);
        }
        apiKey = apiKey?.Trim();
        if (string.IsNullOrEmpty(apiKey)) return null;
        if (apiKey.Length > 8192 || apiKey.Any(char.IsWhiteSpace) || apiKey.Any(char.IsControl))
            throw new InvalidOperationException("PROVIDER_KEY_REQUIRED");
        return apiKey;
    }

    public AccountEntry SaveProviderConfiguration(string name, ProviderSettings settings, string? apiKey, string? previousId = null)
    {
        settings = settings.Validate();
        ProviderGroup? group = null;
        AccountEntry? previous = null;
        if (previousId is not null)
        {
            previous = Get(previousId);
            if (previous.Kind != "relay" || previous.Status != "ready") throw new InvalidOperationException("ACCOUNT_NOT_READY");
            if (previous.ConfigurationGroup is not null) group = ReadProviderGroup(previous.ConfigurationGroup);
            if (group is not null && previous.ConfigurationVersion != group.ActiveVersion) throw new InvalidOperationException("CONFIGURATION_CHANGED");
        }
        apiKey = ResolveProviderKey(settings.BaseUrl, apiKey, previousId) ?? throw new InvalidOperationException("PROVIDER_KEY_REQUIRED");
        if (settings.UseDefaultModelMetadata && (previous is null || previous.Model != settings.Model ||
            ReadProviderSettings(previous.Id) is { UseDefaultModelMetadata: false })) throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        if (previous is not null && group is null)
        {
            group = new(1, previous.Id, 0, [new(0, previous.Id, DateTimeOffset.UtcNow, BackendService.Version)]);
            Directory.CreateDirectory(Path.Combine(root, "provider-configs"));
            WritePrivateJson(ProviderGroupPath(group.Id), group);
            // Keep the original provider identity and files usable by in-flight turns and rollback.
            Save(previous with { ConfigurationGroup = group.Id });
        }
        var account = Create(name);
        var groupId = group?.Id ?? account.Id;
        var revision = (group?.Versions.Max(version => version.Version) ?? 0) + 1;
        account = account with
        {
            Kind = "relay", Status = "ready", BaseUrl = settings.BaseUrl, Model = settings.Model,
            ConfigurationGroup = groupId, ConfigurationVersion = revision, Provider = settings.Provider,
            SourceId = previous?.SourceId,
        };
        var home = Home(account.Id);
        Save(account);
        WritePrivateJson(Path.Combine(home, "credential.json"), new { apiKey });
        WritePrivateJson(Path.Combine(home, "provider-profile.json"), new ProviderConfiguration(1, settings));
        ProviderRuntime.WriteFiles(account, settings, home);
        var versions = (group?.Versions ?? []).Append(new ProviderRevision(revision, account.Id, DateTimeOffset.UtcNow, BackendService.Version)).ToArray();
        Directory.CreateDirectory(Path.Combine(root, "provider-configs"));
        WritePrivateJson(ProviderGroupPath(groupId), new ProviderGroup(1, groupId, revision, versions));
        return account;
    }

    public AccountEntry ActivateProviderConfiguration(string id, int version)
    {
        var account = Get(id);
        if (account.Status != "ready") throw new InvalidOperationException("ACCOUNT_NOT_READY");
        var group = ReadProviderGroup(account.ConfigurationGroup ?? throw new InvalidOperationException("PROVIDER_PROFILE_REQUIRED"));
        if (account.ConfigurationVersion != group.ActiveVersion) throw new InvalidOperationException("CONFIGURATION_CHANGED");
        var selected = group.Versions.SingleOrDefault(item => item.Version == version)
            ?? throw new InvalidOperationException("CONFIGURATION_INVALID");
        var target = Get(selected.AccountId);
        if (target.Status != "ready") throw new InvalidOperationException("ACCOUNT_NOT_READY");
        _ = ReadProviderSettings(target.Id);
        WritePrivateJson(ProviderGroupPath(group.Id), group with { ActiveVersion = version });
        return target;
    }
}

public static class ProviderRuntime
{
    public static string ProviderId(AccountEntry account) => account.Provider is not null && account.ConfigurationGroup is { } group
        ? "loader_" + Guid.ParseExact(group, "N").ToString("N") : "account_relay";

    public static string[] Overrides(AccountEntry account, ProviderSettings settings, string home)
    {
        var provider = ProviderId(account);
        List<string> options =
        [
            "model=" + JsonSerializer.Serialize(settings.Model),
            "model_provider=" + JsonSerializer.Serialize(provider),
            "preferred_auth_method=\"apikey\"",
            "forced_login_method=\"api\"",
            $"model_providers.{provider}.name=" + JsonSerializer.Serialize(settings.DisplayName),
            $"model_providers.{provider}.base_url=" + JsonSerializer.Serialize(settings.BaseUrl),
            $"model_providers.{provider}.wire_api=\"responses\"",
            $"model_providers.{provider}.env_key=\"ACCOUNT_SWITCHER_RELAY_KEY\"",
            $"model_providers.{provider}.requires_openai_auth=false",
            $"model_providers.{provider}.supports_websockets=false",
            $"model_providers.{provider}.capabilities.remote_compaction=\"unsupported\"",
        ];
        if (!settings.UseDefaultModelMetadata) options.AddRange([
            "model_context_window=" + settings.ContextWindow,
            "model_auto_compact_token_limit=" + (settings.ContextWindow * 9L / 10),
            "model_catalog_json=" + JsonSerializer.Serialize(Path.Combine(home, "models.json")),
            "model_supports_reasoning_summaries=" + (settings.ReasoningEffort is not null ? "true" : "false"),
            "model_reasoning_effort=" + JsonSerializer.Serialize(settings.ReasoningEffort ?? "low"),
            "model_reasoning_summary=\"none\"", "web_search=\"disabled\"",
        ]);
        if (settings.Provider == "deepseek") options.AddRange(["features.code_mode.enabled=false", "features.code_mode_host=false"]);
        return options.ToArray();
    }

    private static readonly Lazy<JsonObject> CodexModelMessages = new(LoadCodexModelMessages);

    private static JsonObject LoadCodexModelMessages()
    {
        using var stream = typeof(ProviderRuntime).Assembly.GetManifestResourceStream("CodexScriptLoader.Accounts.CodexModelMessages.json")
            ?? throw new InvalidOperationException("CODEX_MODEL_MESSAGES_MISSING");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return JsonNode.Parse(reader.ReadToEnd())!.AsObject();
    }

    private static JsonObject NativeModelMessages(ProviderSettings settings)
    {
        var messages = CodexModelMessages.Value.DeepClone().AsObject();
        var identity = settings.Provider switch
        {
            "deepseek" => "DeepSeek",
            "openrouter" => "OpenRouter",
            _ => "a compatible coding model",
        };
        if (messages["instructions_template"] is JsonValue value && value.TryGetValue<string>(out var template))
            messages["instructions_template"] = template.Replace(
                "You are Codex, an agent based on GPT-6.",
                $"You are Codex, an agent based on {identity}.",
                StringComparison.Ordinal);
        return messages;
    }

    public static void WriteFiles(AccountEntry account, ProviderSettings settings, string home)
    {
        File.WriteAllLines(Path.Combine(home, "provider.toml"), Overrides(account, settings, home));
        if (settings.UseDefaultModelMetadata) return;
        var models = settings.EffectiveModels.Where(item => item.Enabled).Select(item => ModelDocument(settings, item)).ToArray();
        if (models.Length == 0) throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        File.WriteAllText(Path.Combine(home, "models.json"), JsonSerializer.Serialize(new { models }, AccountStore.JsonOptions));
    }

    private static object ModelDocument(ProviderSettings settings, ProviderModelSettings item)
    {
        var context = item.ContextWindow ?? (settings.ContextWindow >= 1024 ? settings.ContextWindow : 0);
        if (context < 1024) throw new InvalidOperationException("MODEL_SETTINGS_INVALID");
        var levels = (item.ReasoningLevels ?? []).Where(level => level is not null).ToArray();
        if (levels.Length == 0 && item.DefaultReasoningEffort is { } fallback) levels = [fallback];
        var reasoning = levels.Length > 0;
        var effort = item.DefaultReasoningEffort ?? levels.FirstOrDefault();
        var images = item.SupportsImages || settings.SupportsImages;
        var toolFormat = item.ToolFormat == "freeform" || settings.ToolFormat == "freeform" ? "freeform" : "function";
        return new
        {
            slug = item.Id, display_name = item.Name ?? item.Id, description = settings.DisplayName,
            visibility = "list", supported_in_api = true, priority = 0, minimal_client_version = "0.144.0",
            default_reasoning_level = effort ?? "low",
            supported_reasoning_levels = levels.Select(level => new { effort = level, description = level }).ToArray(),
            supports_reasoning_summaries = reasoning, reasoning_summary_format = "experimental", default_reasoning_summary = "none",
            shell_type = "shell_command", apply_patch_tool_type = toolFormat,
            supports_parallel_tool_calls = item.ParallelToolCalls || settings.ParallelToolCalls, support_verbosity = false,
            default_verbosity = (string?)null, prefer_websockets = false,
            context_window = context, max_context_window = context,
            effective_context_window_percent = 95, auto_compact_token_limit = context * 9L / 10,
            truncation_policy = new { mode = "tokens", limit = 10000 },
            input_modalities = images ? new[] { "text", "image" } : ["text"],
            supports_image_detail_original = images && settings.Provider == "deepseek", supports_search_tool = false,
            experimental_supported_tools = Array.Empty<string>(), model_messages = NativeModelMessages(settings),
            tool_mode = (string?)null, multi_agent_version = "v2", use_responses_lite = false,
            include_skills_usage_instructions = false, auto_review_model_override = (string?)null,
            comp_hash = "loader-profile-v1", default_service_tier = (string?)null,
            availability_nux = (object?)null, upgrade = (object?)null, web_search_tool_type = "text",
            base_instructions = string.Empty,
        };
    }
}
