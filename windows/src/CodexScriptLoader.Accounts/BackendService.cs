using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record OperationSnapshot(string Id, string AccountId, string Kind, string State,
    string? AuthUrl = null, string? ErrorCode = null, ConnectionResult? Result = null, IReadOnlyList<ProviderModel>? Models = null);

public sealed record AccountManagementState(AccountEntry? PrimaryAccount, IReadOnlyList<OperationSnapshot> Operations);

public sealed partial class BackendService(AccountStore store, IAccountRouterControl? routerControl = null) : IAsyncDisposable
{
    public static string Version => System.Reflection.CustomAttributeExtensions
        .GetCustomAttribute<System.Reflection.AssemblyInformationalVersionAttribute>(typeof(BackendService).Assembly)!
        .InformationalVersion.Split('+', 2)[0];
    private readonly object sync = new();
    private readonly Dictionary<string, Operation> operations = new(StringComparer.Ordinal);
    private IAccountRouterControl? router = routerControl;
    private AccountEntry? primaryAccount;
    private bool stopped;
    public bool CanStop { get { lock (sync) return !operations.Values.Any(IsActive) && router?.CanStop != false; } }

    public void StartRouter(string directory) => router = new RouterHost(store, directory);

    public object Invoke(string operation, JsonObject payload)
    {
        // Protocol 2 carries account commands through the existing host's allowlisted status operation.
        if (operation == "status" && payload["accountCommand"] is JsonObject command)
        {
            if (command["protocol"]?.GetValue<int>() != 2 || command["operation"]?.GetValue<string>() == "status")
                throw new InvalidOperationException("INPUT_INVALID");
            return Invoke(Text(command, "operation", 64), command["payload"] as JsonObject ?? new());
        }
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(stopped, this);
            return operation switch
            {
                "status" => new { version = Version, accountCommandProtocol = 2, routingAvailable = router?.Connected == true, routerState = router?.Connected == true ? "connected" : "not_connected",
                    defaultAccountId = store.DefaultAccountId, activeOperations = operations.Values.Count(IsActive),
                    operations = operations.Values.Where(IsActive).Select(item => item.Snapshot).ToArray() },
                "list_accounts" => new { accounts = store.List(), defaultAccountId = store.DefaultAccountId,
                    preferences = new { newChatAccountPolicy = store.NewChatAccountPolicy },
                    history = new { shared = router?.HistoryShared == true, error = router?.HistoryError },
                    routingAvailable = router?.Connected == true,
                    globalAccount = router?.GlobalStatus ?? new(store.DefaultAccountId, 0, 0, 0),
                    primaryAccount,
                    boundThreads = store.List().ToDictionary(account => account.Id, account => router?.BoundCount(account.Id) ?? 0) },
                "list_threads" => ListThreads(payload),
                "set_new_chat_policy" => SetNewChatPolicy(payload),
                "test_usage" => TestUsage(payload),
                "batch_accounts" => BatchAccounts(payload),
                "thread_status" => router?.ThreadStatus(Text(payload, "threadId", 256))
                    ?? new { connected = false, accountId = "primary", busy = false },
                "switch_thread" => BeginSwitch(payload),
                "refresh_accounts" => BeginRefresh(payload),
                "list_imports" => new { accounts = CcSwitchImport.Read().Cast<object>().Concat(SavedAccountImport.Read()).ToArray() },
                "import_account" => Import(payload),
                "create_provider" => SaveProvider(payload, false),
                "save_provider_configuration" => SaveProvider(payload, true),
                "get_provider_configuration" => store.ProviderConfigurationStatus(Text(payload, "accountId", 32)),
                "begin_provider_models" => BeginProviderModels(payload),
                "activate_provider_version" => store.ActivateProviderConfiguration(Text(payload, "accountId", 32),
                    payload["version"]?.GetValue<int>() ?? throw new InvalidOperationException("INPUT_INVALID")),
                "rename_account" => Mutate(payload, id => store.Rename(id, Text(payload, "name", 80))),
                "set_enabled" => Mutate(payload, id => { if (payload["enabled"]?.GetValue<bool>() == true) store.Enable(id); else store.Disable(id); }, payload["enabled"]?.GetValue<bool>() != true),
                "remove_account" => Mutate(payload, store.Remove, true),
                "set_default" => SetDefault(payload),
                "begin_login" => BeginLogin(payload),
                "begin_probe" => BeginProbe(payload),
                "operation_status" => GetOperation(payload).Snapshot,
                "cancel_operation" => Cancel(payload),
                _ => throw new InvalidOperationException("OPERATION_NOT_SUPPORTED"),
            };
        }
    }

    private AccountEntry SaveProvider(JsonObject payload, bool update)
    {
        var settings = payload["settings"]?.Deserialize<ProviderSettings>(AccountStore.JsonOptions)
            ?? throw new InvalidOperationException("INPUT_INVALID");
        return store.SaveProviderConfiguration(Text(payload, "name", 80), settings, payload["apiKey"]?.GetValue<string>(),
            update ? Text(payload, "accountId", 32) : null);
    }


    private object ListThreads(JsonObject payload)
    {
        var limit = Math.Clamp(payload["limit"]?.GetValue<int>() ?? 100, 1, 100);
        var query = payload["query"]?.GetValue<string>()?.Trim().ToLowerInvariant() ?? "";
        var primary = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (string.IsNullOrEmpty(primary)) primary = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        var sessions = Path.Combine(primary, "sessions");
        if (!Directory.Exists(sessions)) return new { threads = Array.Empty<object>() };
        var ownership = new ThreadOwnership(store.Root);
        var result = new List<object>();
        foreach (var file in new DirectoryInfo(sessions).EnumerateFiles("*.jsonl", SearchOption.AllDirectories)
            .OrderByDescending(item => item.LastWriteTimeUtc).Take(Math.Max(limit * 4, 100)))
        {
            var match = ThreadIdAtEnd().Match(Path.GetFileNameWithoutExtension(file.Name));
            if (!match.Success) continue;
            var id = match.Value;
            var title = ReadThreadTitle(file.FullName) ?? id;
            if (query.Length > 0 && !title.ToLowerInvariant().Contains(query, StringComparison.Ordinal)) continue;
            var owner = ownership.Get(id);
            string accountName;
            try { accountName = owner.AccountId == "primary" ? "桌面主账号" : store.Get(owner.AccountId).Name; }
            catch (Exception error) when (error is IOException or InvalidOperationException or System.Text.Json.JsonException) { accountName = "已移除账号"; }
            result.Add(new { id, title, accountId = owner.AccountId, accountName, model = owner.Model, modelName = owner.Model,
                pinned = owner.Pinned, busy = false, updatedAt = new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
            if (result.Count >= limit) break;
        }
        return new { threads = result.ToArray() };
    }

    private static string? ReadThreadTitle(string path)
    {
        try
        {
            using var reader = new StreamReader(path);
            for (var index = 0; index < 200 && reader.ReadLine() is { } line; index++)
            {
                if (line.Length > 256 * 1024) break;
                var node = JsonNode.Parse(line) as JsonObject;
                var body = node?["payload"] as JsonObject;
                string? text = null;
                if (body?["type"]?.GetValue<string>() is "user_message")
                    text = body["message"]?.GetValue<string>() ?? body["text"]?.GetValue<string>();
                else if (body?["type"]?.GetValue<string>() is "message" && body?["role"]?.GetValue<string>() is "user")
                    text = (body["content"] as JsonArray)?.OfType<JsonObject>()
                        .FirstOrDefault(item => item["type"]?.GetValue<string>() is "input_text")?["text"]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(text) || text.StartsWith('<') || text.StartsWith("# ")) continue;
                var clean = text.Replace("\r", " ").Replace("\n", " ").Trim();
                if (clean.Length == 0 || clean.StartsWith("## ")) continue;
                return clean.Length > 120 ? clean[..120] : clean;
            }
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException) { }
        return null;
    }

    [System.Text.RegularExpressions.GeneratedRegex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant | System.Text.RegularExpressions.RegexOptions.IgnoreCase)]
    private static partial System.Text.RegularExpressions.Regex ThreadIdAtEnd();

    private object SetNewChatPolicy(JsonObject payload)
    {
        store.SetNewChatAccountPolicy(Text(payload, "policy", 16));
        return new { saved = true, newChatAccountPolicy = store.NewChatAccountPolicy };
    }

    private object TestUsage(JsonObject payload)
    {
        var accountId = payload["accountId"]?.GetValue<string>();
        var account = accountId is { Length: > 0 } ? store.Get(accountId) : null;
        var baseUrl = payload["baseUrl"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = account?.BaseUrl;
        if (string.IsNullOrWhiteSpace(baseUrl)) throw new InvalidOperationException("INPUT_INVALID");
        var endpoint = ProviderSettings.ValidateEndpoint(account?.Provider ?? ProviderFor(baseUrl), baseUrl);
        var apiKey = payload["apiKey"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(apiKey) && account is not null && account.Kind == "relay") apiKey = store.ReadRelayKey(account.Id);
        if (string.IsNullOrWhiteSpace(apiKey)) throw new InvalidOperationException("PROVIDER_KEY_REQUIRED");
        var usage = payload["usage"]?.Deserialize<ProviderUsageSettings>(AccountStore.JsonOptions);
        usage = usage?.Validate(endpoint);
        var credits = ConnectionProbe.RelayBalanceAsync(endpoint, apiKey, account?.Provider ?? ProviderFor(baseUrl), usage, CancellationToken.None)
            .GetAwaiter().GetResult();
        return new { credits, errorCode = credits is null ? "USAGE_UNAVAILABLE" : null };
    }

    private object BatchAccounts(JsonObject payload)
    {
        if (payload["accountIds"] is not JsonArray ids) throw new InvalidOperationException("INPUT_INVALID");
        var accountIds = ids.OfType<JsonValue>().Select(value => value.GetValue<string>()).Distinct(StringComparer.Ordinal).Take(50).ToArray();
        var operation = Text(payload, "operation", 32);
        if (operation is not ("enable" or "disable" or "remove" or "refresh" or "update_provider"))
            throw new InvalidOperationException("INPUT_INVALID");
        var fields = payload["fields"] as JsonObject ?? payload["settings"] as JsonObject;
        var results = new List<object>();
        foreach (var id in accountIds)
        {
            try
            {
                var account = store.Get(id);
                switch (operation)
                {
                    case "enable":
                        EnsureIdle(id);
                        if (account.Status == "disabled") store.Enable(id);
                        break;
                    case "disable":
                        EnsureIdle(id);
                        if (account.Status != "disabled") store.Disable(id);
                        break;
                    case "remove":
                        EnsureIdle(id);
                        if (store.ConfigurationAccounts(id).Any(item => router?.BoundCount(item) > 0))
                            throw new InvalidOperationException("ACCOUNT_HAS_THREADS");
                        store.Remove(id);
                        break;
                    case "refresh":
                        _ = RefreshAccountAsync(account, CancellationToken.None).GetAwaiter().GetResult();
                        break;
                    case "update_provider":
                        if (account.Kind != "relay") throw new InvalidOperationException("ACCOUNT_TYPE_MISMATCH");
                        EnsureIdle(id);
                        var settings = MergeProviderSettings(store.ReadProviderSettingsOrLegacy(id), fields ?? new());
                        var saved = store.SaveProviderConfiguration(account.Name, settings, null, id);
                        results.Add(new { accountId = id, ok = true, newAccountId = saved.Id });
                        continue;
                }
                results.Add(new { accountId = id, ok = true });
            }
            catch (Exception error)
            {
                results.Add(new { accountId = id, ok = false, errorCode = ErrorCode(error) });
            }
        }
        return new { results };
    }

    private static ProviderSettings MergeProviderSettings(ProviderSettings source, JsonObject fields)
    {
        var models = source.EffectiveModels.ToList();
        if (fields["models"] is JsonArray replaced)
        {
            models = replaced.Deserialize<ProviderModelSettings[]>(AccountStore.JsonOptions)?.ToList() ?? [];
        }
        if (fields["removeModels"] is JsonArray removed)
            foreach (var id in removed.OfType<JsonValue>().Select(value => value.GetValue<string>()))
                models.RemoveAll(item => item.Id == id);
        if (fields["appendModels"] is JsonArray appended)
            foreach (var item in appended.Deserialize<ProviderModelSettings[]>(AccountStore.JsonOptions) ?? [])
            {
                models.RemoveAll(existing => existing.Id == item.Id);
                models.Add(item);
            }
        var context = fields["contextWindow"] is { } contextNode ? contextNode.GetValue<int>() : source.ContextWindow;
        var model = fields["model"] is { } modelNode ? modelNode.GetValue<string>() : source.Model;
        if (models.All(item => item.Id != model))
            models.Add(new ProviderModelSettings(model, model, context >= 1024 ? context : null));
        if (models.All(item => item.Id != model)) model = models.FirstOrDefault()?.Id ?? model;
        var effort = fields.TryGetPropertyValue("reasoningEffort", out var effortNode) ? effortNode?.GetValue<string>() : source.ReasoningEffort;
        var images = fields["supportsImages"] is { } imageNode ? imageNode.GetValue<bool>() : source.SupportsImages;
        var parallel = fields["parallelToolCalls"] is { } parallelNode ? parallelNode.GetValue<bool>() : source.ParallelToolCalls;
        var toolFormat = fields["toolFormat"] is { } toolNode ? toolNode.GetValue<string>() : source.ToolFormat;
        var useDefault = fields["useDefaultModelMetadata"] is { } defaultNode ? defaultNode.GetValue<bool>() : source.UseDefaultModelMetadata;
        if (context >= 1024) useDefault = false;
        if (context <= 0 && useDefault is false) context = source.ContextWindow;
        var usage = fields.TryGetPropertyValue("usage", out var usageNode)
            ? usageNode?.Deserialize<ProviderUsageSettings>(AccountStore.JsonOptions)
            : source.Usage;
        return new ProviderSettings(source.Provider, source.BaseUrl, model, useDefault ? 0 : context,
            effort, images, toolFormat, parallel, useDefault, models, usage);
    }

    private static string ProviderFor(string baseUrl) => new Uri(baseUrl).Host switch
    {
        "api.deepseek.com" => "deepseek", "openrouter.ai" => "openrouter", _ => "custom",
    };

    private async Task<AccountEntry> RefreshAccountAsync(AccountEntry account, CancellationToken cancellation)
    {
        if (account.Kind == "relay")
        {
            var credits = await ConnectionProbe.RelayBalanceAsync(store, account.Id, cancellation);
            if (credits is null) return account;
            var updated = store.Get(account.Id) with { Credits = credits, LastCheckedAt = DateTimeOffset.UtcNow, LastError = null };
            store.Save(updated);
            return updated;
        }
        if (router?.Connected != true) throw new InvalidOperationException("ROUTER_NOT_CONNECTED");
        var checkedAccount = await router.ReadAccountAsync(account.Id, cancellation);
        store.Save(checkedAccount);
        return checkedAccount;
    }

    internal AccountManagementState? CaptureManagementState()
    {
        lock (sync)
        {
            if (operations.Values.Any(operation => IsActive(operation) || !operation.Task.IsCompleted)) return null;
            return new(primaryAccount, operations.Values.Select(operation => operation.Snapshot).ToArray());
        }
    }

    internal void RestoreManagementState(AccountManagementState state)
    {
        lock (sync)
        {
            if (operations.Count != 0 || state.Operations.Count > 64 || state.Operations.Any(operation => operation.State is not ("completed" or "failed" or "cancelled")))
                throw new InvalidOperationException("ACCOUNT_UPDATE_STATE_INVALID");
            primaryAccount = state.PrimaryAccount;
            foreach (var snapshot in state.Operations) operations.Add(snapshot.Id, new Operation(snapshot));
        }
    }

    private OperationSnapshot BeginProviderModels(JsonObject payload)
    {
        var provider = Text(payload, "provider", 32);
        var endpoint = ProviderSettings.ValidateEndpoint(provider, Text(payload, "baseUrl", 2048));
        var id = payload["accountId"]?.GetValue<string>();
        var key = store.ResolveProviderKey(endpoint, payload["apiKey"]?.GetValue<string>(), id);
        var query = payload["query"]?.GetValue<string>()?.Trim() ?? "";
        if (query.Length > 160) throw new InvalidOperationException("INPUT_INVALID");
        var operation = Start(id ?? "provider-models", "models", allowRunningThreads: true);
        operation.Task = Task.Run(async () =>
        {
            try
            {
                var models = await ProviderCatalog.ReadAsync(provider, endpoint, key, operation.Cancellation.Token);
                var selected = new List<ProviderModel>();
                var bytes = 0;
                foreach (var model in models.Where(model => model.Id.Contains(query, StringComparison.OrdinalIgnoreCase) || model.Name.Contains(query, StringComparison.OrdinalIgnoreCase)))
                {
                    bytes += JsonSerializer.SerializeToUtf8Bytes(model, AccountStore.JsonOptions).Length;
                    if (bytes > 48 * 1024) break;
                    selected.Add(model);
                }
                lock (sync) operation.Snapshot = operation.Snapshot with { State = "completed", Models = selected };
            }
            catch (OperationCanceledException) { Finish(operation, operation.Cancellation.IsCancellationRequested ? "cancelled" : "failed", "CONNECTION_TIMEOUT"); }
            catch (HttpRequestException) { Finish(operation, "failed", "CONNECTION_FAILED"); }
            catch (JsonException) { Finish(operation, "failed", "RESPONSE_INVALID"); }
            catch (Exception error) { Finish(operation, "failed", ErrorCode(error)); }
        });
        return operation.Snapshot;
    }

    private object Import(JsonObject payload)
    {
        var sourceId = Text(payload, "sourceId", 128);
        if (sourceId.StartsWith("saved:", StringComparison.Ordinal))
        {
            var saved = SavedAccountImport.Read().SingleOrDefault(item => item.Id == sourceId)
                ?? throw new InvalidOperationException("IMPORT_SOURCE_UNAVAILABLE");
            var previous = store.List().FirstOrDefault(item => item.SourceId == saved.Id ||
                item.Kind == "chatgpt" && saved.WorkspaceId is not null && item.WorkspaceId == saved.WorkspaceId && item.Email == saved.Email);
            if (previous is not null)
            {
                EnsureIdle(previous.Id);
                if (router?.BoundCount(previous.Id) > 0) throw new InvalidOperationException("ACCOUNT_HAS_THREADS");
            }
            return store.ImportSubscription(saved);
        }
        var source = CcSwitchImport.Read().SingleOrDefault(item => item.Id == sourceId)
            ?? throw new InvalidOperationException("IMPORT_SOURCE_UNAVAILABLE");
        var existing = store.List().FirstOrDefault(item => item.SourceId == source.Id);
        if (existing is not null)
        {
            EnsureIdle(existing.Id);
            if (router?.BoundCount(existing.Id) > 0) throw new InvalidOperationException("ACCOUNT_HAS_THREADS");
        }
        var baseUrl = payload["baseUrl"]?.GetValue<string>() ?? source.BaseUrl;
        var selected = payload["models"] is JsonArray chosen
            ? chosen.OfType<JsonValue>().Select(value => value.GetValue<string>()).ToHashSet(StringComparer.Ordinal)
            : null;
        var models = (source.Models ?? []).Where(model => selected is null || selected.Count == 0 || selected.Contains(model.Id)).ToArray();
        var provider = ProviderFor(baseUrl);
        var context = source.ContextWindow ?? 0;
        var settings = new ProviderSettings(provider, baseUrl, source.Model, context, source.ReasoningEffort,
            false, "function", false, context == 0, models, source.Usage);
        return store.ImportRelay(source, baseUrl, settings);
    }

    private object Mutate(JsonObject payload, Action<string> action, bool requireUnbound = false)
    {
        var id = Text(payload, "accountId", 32);
        EnsureIdle(id);
        if (requireUnbound && store.ConfigurationAccounts(id).Any(account => router?.BoundCount(account) > 0))
            throw new InvalidOperationException("ACCOUNT_HAS_THREADS");
        if (store.Get(id).Status == "removed") throw new InvalidOperationException("ACCOUNT_REMOVED");
        action(id);
        return new { saved = true };
    }

    private object SetDefault(JsonObject payload)
    {
        store.SetDefault(Text(payload, "accountId", 32));
        router?.RetryGlobalSwitch();
        return new { saved = true, routingAvailable = router?.Connected == true };
    }

    private OperationSnapshot BeginSwitch(JsonObject payload)
    {
        if (router is null || !router.Connected) throw new InvalidOperationException("ROUTER_NOT_CONNECTED");
        var threadId = Text(payload, "threadId", 256);
        var accountId = Text(payload, "accountId", 32);
        var operation = Start(accountId, "switch", allowRunningThreads: true);
        operation.Task = Task.Run(async () =>
        {
            try { await router.SwitchAsync(threadId, accountId, operation.Cancellation.Token, pinned: accountId != store.DefaultAccountId); Finish(operation, "completed"); }
            catch (OperationCanceledException) { Finish(operation, "cancelled"); }
            catch (Exception error) { Finish(operation, "failed", error.Message is "THREAD_BUSY" or "THREAD_SWITCHING" or "ACCOUNT_NOT_READY" ? error.Message : "SWITCH_FAILED"); }
        });
        return operation.Snapshot;
    }

    private OperationSnapshot BeginRefresh(JsonObject payload)
    {
        if (router?.Connected != true) throw new InvalidOperationException("ROUTER_NOT_CONNECTED");
        var wanted = payload["accountIds"] is JsonArray ids
            ? ids.OfType<JsonValue>().Select(value => value.GetValue<string>()).ToHashSet(StringComparer.Ordinal)
            : null;
        var operation = Start("primary", "usage", allowRunningThreads: true);
        operation.Task = Task.Run(async () =>
        {
            try
            {
                var primary = await router.ReadAccountAsync("primary", operation.Cancellation.Token);
                lock (sync) primaryAccount = primary;
                foreach (var account in store.List().Where(account => account.Status == "ready" && (wanted is null || wanted.Contains(account.Id))))
                {
                    if (account.Kind == "relay")
                    {
                        var credits = await ConnectionProbe.RelayBalanceAsync(store, account.Id, operation.Cancellation.Token);
                        if (credits is not null) lock (sync) store.Save(store.Get(account.Id) with
                        {
                            Credits = credits, LastCheckedAt = DateTimeOffset.UtcNow, LastError = null,
                        });
                        continue;
                    }
                    if (account.Kind != "chatgpt") continue;
                    var updated = await router.ReadAccountAsync(account.Id, operation.Cancellation.Token);
                    lock (sync) store.Save(store.Get(account.Id) with
                    {
                        Email = updated.Email, Plan = updated.Plan, Usage = updated.Usage, Credits = updated.Credits,
                        LastCheckedAt = updated.LastCheckedAt, LastError = updated.LastError,
                    });
                }
                Finish(operation, "completed");
            }
            catch (OperationCanceledException) { Finish(operation, "cancelled"); }
            catch { Finish(operation, "failed", "USAGE_UNAVAILABLE"); }
        });
        return operation.Snapshot;
    }

    private OperationSnapshot BeginLogin(JsonObject payload)
    {
        if (operations.Values.Any(item => item.Snapshot.Kind == "login" && IsActive(item)))
            throw new InvalidOperationException("LOGIN_ALREADY_RUNNING");
        var cli = OfficialCliLocator.Find();
        var account = payload["accountId"]?.GetValue<string>() is { Length: > 0 } id ? store.Get(id) : store.Create(Text(payload, "name", 80));
        if (account.Kind != "chatgpt" || account.Status is "removed" or "disabled") throw new InvalidOperationException("ACCOUNT_NOT_READY");
        var operation = Start(account.Id, "login");
        operation.Task = Task.Run(async () =>
        {
            try
            {
                Task ShowPrompt(LoginPrompt prompt)
                {
                    lock (sync) operation.Snapshot = operation.Snapshot with { State = "waiting_auth", AuthUrl = prompt.AuthUrl };
                    return Task.CompletedTask;
                }
                if (router?.Connected == true && account.Status == "ready")
                    await router.LoginAsync(account.Id, ShowPrompt, operation.Cancellation.Token);
                else
                {
                    await using var backend = new OfficialBackend(OfficialBackend.LoginStartInfo(cli.Executable, cli.Sha256, store.Home(account.Id)));
                    await AccountLogin.RunAsync(store, account.Id, backend, ShowPrompt, operation.Cancellation.Token);
                }
                Finish(operation, "completed");
            }
            catch (OperationCanceledException) { Finish(operation, "cancelled"); }
            catch (Exception error) { Finish(operation, "failed", error.Message == "ACCOUNT_ALREADY_EXISTS" ? error.Message : "LOGIN_FAILED"); }
        });
        return operation.Snapshot;
    }

    private OperationSnapshot BeginProbe(JsonObject payload)
    {
        var account = store.Get(Text(payload, "accountId", 32));
        if (account.Status != "ready") throw new InvalidOperationException("ACCOUNT_NOT_READY");
        var cli = account.Kind == "chatgpt" ? OfficialCliLocator.Find() : null;
        var operation = Start(account.Id, "probe");
        operation.Task = Task.Run(async () =>
        {
            try
            {
                ConnectionResult result;
                if (account.Kind == "chatgpt" && router?.Connected == true)
                {
                    var checkedAccount = await router.ReadAccountAsync(account.Id, operation.Cancellation.Token);
                    result = new(checkedAccount.LastError != "AUTHENTICATION_FAILED", checkedAccount.LastError, null, 0, checkedAccount.Usage, checkedAccount.Credits);
                    lock (sync) store.Save(checkedAccount);
                }
                else result = account.Kind == "relay"
                    ? await ConnectionProbe.RelayAsync(store, account.Id, operation.Cancellation.Token)
                    : await ConnectionProbe.SubscriptionAsync(store, account.Id, cli!, operation.Cancellation.Token);
                if (account.Kind == "relay")
                    result = result with { Credits = await ConnectionProbe.RelayBalanceAsync(store, account.Id, operation.Cancellation.Token) ?? account.Credits ?? result.Credits };
                lock (sync)
                {
                    store.Save(store.Get(account.Id) with { LastCheckedAt = DateTimeOffset.UtcNow, LastError = result.ErrorCode, Usage = result.Usage, Credits = result.Credits });
                    operation.Snapshot = operation.Snapshot with { State = result.Passed ? "completed" : "failed", ErrorCode = result.ErrorCode, Result = result };
                }
            }
            catch (OperationCanceledException) { Finish(operation, "cancelled"); }
            catch { Finish(operation, "failed", "CONNECTION_FAILED"); }
        });
        return operation.Snapshot;
    }

    private Operation Start(string id, string kind, bool allowRunningThreads = false)
    {
        if (!allowRunningThreads) EnsureIdle(id);
        else if (operations.Values.Any(item => item.Snapshot.AccountId == id && IsActive(item)))
            throw new InvalidOperationException("ACCOUNT_BUSY");
        if (operations.Values.Count(IsActive) >= 3) throw new InvalidOperationException("TOO_MANY_OPERATIONS");
        foreach (var old in operations.Values.Where(item => !IsActive(item)).Take(Math.Max(0, operations.Count - 16)).ToArray())
        {
            operations.Remove(old.Snapshot.Id);
            old.Cancellation.Dispose();
        }
        var operation = new Operation(new(Guid.NewGuid().ToString("N"), id, kind, "running"));
        operations.Add(operation.Snapshot.Id, operation);
        return operation;
    }

    private void EnsureIdle(string id)
    {
        var accounts = store.ConfigurationAccounts(id);
        if (accounts.Any(account => router?.AccountBusy(account) == true) || operations.Values.Any(item => accounts.Contains(item.Snapshot.AccountId) && IsActive(item)))
            throw new InvalidOperationException("ACCOUNT_BUSY");
    }

    private Operation GetOperation(JsonObject payload) => operations.GetValueOrDefault(Text(payload, "operationId", 32))
        ?? throw new InvalidOperationException("OPERATION_NOT_FOUND");

    private OperationSnapshot Cancel(JsonObject payload)
    {
        var operation = GetOperation(payload);
        operation.Cancellation.Cancel();
        return operation.Snapshot;
    }

    private void Finish(Operation operation, string state, string? error = null)
    {
        lock (sync) operation.Snapshot = operation.Snapshot with { State = state, ErrorCode = error, AuthUrl = null };
    }

    private static bool IsActive(Operation operation) => operation.Snapshot.State is "running" or "waiting_auth";
    private static string Text(JsonObject payload, string key, int maximum)
    {
        var text = payload[key]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(text) || text.Length > maximum || text.Any(char.IsControl)) throw new ArgumentException("INPUT_INVALID");
        return text;
    }

    public async ValueTask DisposeAsync()
    {
        Operation[] pending;
        lock (sync)
        {
            stopped = true;
            pending = operations.Values.ToArray();
            foreach (var item in pending) item.Cancellation.Cancel();
        }
        await Task.WhenAll(pending.Select(item => item.Task)).ConfigureAwait(false);
        if (router is not null) await router.DisposeAsync();
        foreach (var item in pending) item.Cancellation.Dispose();
    }

    private sealed class Operation(OperationSnapshot snapshot)
    {
        public OperationSnapshot Snapshot = snapshot;
        public readonly CancellationTokenSource Cancellation = new();
        public Task Task = Task.CompletedTask;
    }

    public static Task<int> RunAsync() => AccountBackendHost.RunAsync();

    public static Task<int> RunWorkerAsync() => AccountManagementWorker.RunAsync();

    public static async Task<int> RunStandaloneAsync()
    {
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        BackendService? service = null;
        try
        {
            while (await Console.In.ReadLineAsync() is { } line)
            {
                if (Encoding.UTF8.GetByteCount(line) > 64 * 1024) return 2;
                var request = JsonNode.Parse(line)!.AsObject();
                var id = request["id"]?.DeepClone();
                var method = request["method"]?.GetValue<string>();
                var parameters = request["params"]!.AsObject();
                object result;
                if (method == "initialize" && service is null)
                {
                    if (parameters["protocolVersion"]?.GetValue<int>() != 1) return 2;
                    service = new BackendService(new AccountStore(parameters["dataDirectory"]!.GetValue<string>()));
                    service.StartRouter(parameters["dataDirectory"]!.GetValue<string>());
                    result = new { protocolVersion = 1, version = Version };
                }
                else if (service is null) return 2;
                else if (method == "prepare_stop") result = new { canStop = service.CanStop };
                else if (method == "invoke")
                {
                    try { result = new { ok = true, data = service.Invoke(parameters["operation"]!.GetValue<string>(), parameters["payload"]!.AsObject()) }; }
                    catch (Exception error) { result = new { ok = false, errorCode = ErrorCode(error) }; }
                }
                else return 2;
                Console.WriteLine(new JsonObject { ["id"] = id, ["result"] = JsonSerializer.SerializeToNode(result, AccountStore.JsonOptions) }.ToJsonString());
            }
            return 0;
        }
        finally { if (service is not null) await service.DisposeAsync(); }
    }

    internal static string ErrorCode(Exception error)
    {
        var known = new HashSet<string>(StringComparer.Ordinal)
        {
            "ACCOUNT_BUSY", "ACCOUNT_NOT_READY", "ACCOUNT_NOT_DISABLED", "ACCOUNT_REMOVED", "ACCOUNT_NAME_INVALID",
            "IMPORT_SOURCE_UNAVAILABLE", "IMPORT_SOURCE_UNSUPPORTED", "IMPORT_SOURCE_BUSY", "IMPORT_ORIGIN_CHANGED",
            "ENDPOINT_INVALID", "OFFICIAL_CLI_UNAVAILABLE", "INPUT_INVALID", "TOO_MANY_OPERATIONS", "OPERATION_NOT_FOUND",
            "ROUTER_NOT_CONNECTED", "THREAD_BUSY", "THREAD_SWITCHING", "ACCOUNT_HAS_THREADS", "SWITCH_FAILED",
            "LOGIN_ALREADY_RUNNING",
            "PROVIDER_INVALID", "PROVIDER_ORIGIN_MISMATCH", "PROVIDER_KEY_REQUIRED", "PROVIDER_PROFILE_REQUIRED",
            "MODEL_INVALID", "MODEL_SETTINGS_INVALID", "CONFIGURATION_INVALID", "CONFIGURATION_CHANGED", "CONFIGURATION_VERSION_UNSUPPORTED",
            "PROVIDER_CONFIGURATION_MANAGED", "MODEL_DISCOVERY_UNSUPPORTED", "AUTHENTICATION_FAILED", "RATE_LIMITED", "SERVICE_UNAVAILABLE", "RESPONSE_INVALID",
        };
        return known.Contains(error.Message) ? error.Message : error is IOException ? "STORAGE_UNAVAILABLE" : "OPERATION_FAILED";
    }
}
