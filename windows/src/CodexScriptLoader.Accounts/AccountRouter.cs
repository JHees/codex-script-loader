using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record GlobalAccountStatus(string AccountId, int PendingThreads, int BusyThreads, int FailedThreads, int PinnedThreads = 0);

// One router owns the backends; desktop connections share it without sharing RPC IDs.
public sealed partial class AccountRouter(AccountStore store, ThreadOwnership ownership,
    Func<string, OfficialBackend> startBackend, Func<string, string> accountHome, bool primaryOnly = false) : IAsyncDisposable
{
    private readonly SemaphoreSlim startup = new(1);
    private readonly ConcurrentDictionary<string, OfficialBackend> backends = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> threadLocks = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> active = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> threadActivity = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> lastClient = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> subscribers = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Approval> approvals = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> switching = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> failed = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> authorizing = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> globalFailures = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, CachedThread> readCache = new(StringComparer.Ordinal);
    private AccountEntry? primaryUsage;
    private DateTimeOffset primaryUsageAt;
    private static readonly TimeSpan ReadCacheLifetime = TimeSpan.FromSeconds(30);
    private JsonObject? initialization;
    private JsonNode? initializationResult;
    private JsonArray extraSkillRoots = new();
    private long approvalSequence;
    private string? primaryClient;
    public event Action<string?, JsonObject>? Outgoing;
    public bool CanStop => active.IsEmpty && threadActivity.IsEmpty && approvals.IsEmpty && switching.IsEmpty && authorizing.IsEmpty;
    public bool IsConnected => backends.ContainsKey("primary") && !failed.ContainsKey("primary");
    public object Status(string threadId) => new { threadId, accountId = ownership.Get(threadId).AccountId,
        busy = IsBusy(threadId), switching = switching.ContainsKey(threadId), connected = IsConnected,
        backendFailed = failed.ContainsKey(ownership.Get(threadId).AccountId) };

    public async Task<AccountEntry> ReadAccountAsync(string id, CancellationToken cancellation)
    {
        var backend = await BackendAsync(id, cancellation);
        var status = await backend.RequestAsync("account/read", new JsonObject { ["refreshToken"] = false }, cancellation);
        var account = status?["account"];
        var entry = id == "primary" ? new AccountEntry("primary", "桌面主账号", "ready") : store.Get(id);
        if (account?["type"]?.GetValue<string>() == "apiKey")
            return entry with { Kind = "relay", LastError = null, LastCheckedAt = DateTimeOffset.UtcNow, Usage = null, Credits = null };
        if (account?["type"]?.GetValue<string>() != "chatgpt")
            return entry with { LastError = "AUTHENTICATION_FAILED", LastCheckedAt = DateTimeOffset.UtcNow };
        entry = entry with { Email = account["email"]?.GetValue<string>(), Plan = account["planType"]?.GetValue<string>(), LastCheckedAt = DateTimeOffset.UtcNow };
        try
        {
            var limits = await backend.RequestAsync("account/rateLimits/read", new JsonObject(), cancellation);
            return entry with { Usage = ConnectionProbe.ParseUsage(limits), Credits = ConnectionProbe.ParseCredits(limits), LastError = null };
        }
        catch (BackendRpcException) { return entry with { LastError = "USAGE_UNAVAILABLE" }; }
    }

    public bool AccountBusy(string id) => authorizing.ContainsKey(id) || ownership.BoundTo(id).Any(IsBusy);

    public GlobalAccountStatus GlobalStatus()
    {
        var target = store.DefaultAccountId;
        var pending = new List<string>();
        var pinned = 0;
        foreach (var id in ownership.AllThreads())
        {
            var owner = ownership.Get(id);
            if (owner.Pinned || (owner.AccountId != target && !IsRelayAccount(target) && IsRelayAccount(owner.AccountId))) pinned++;
            else if (owner.AccountId != target) pending.Add(id);
        }
        return new(target, pending.Count, pending.Count(IsFamilyBusy), pending.Count(id => globalFailures.GetValueOrDefault(id) == target), pinned);
    }

    // An explicit global selection returns every thread it now owns to ordinary global migration.
    public void RetryGlobalSwitch()
    {
        globalFailures.Clear();
        ownership.UnpinAllFor(store.DefaultAccountId);
    }

    public async Task ReconcileGlobalAsync(CancellationToken cancellation)
    {
        if (primaryOnly || !IsConnected) return;
        foreach (var id in ownership.AllThreads())
        {
            cancellation.ThrowIfCancellationRequested();
            var target = store.DefaultAccountId;
            var owner = ownership.Get(id);
            // A pinned thread deliberately uses a different backend for its model; it is not pending.
            if (owner.Pinned)
            {
                if (owner.AccountId == target) ownership.SetPinned(id, false);
                else continue;
            }
            // A thread running a relay model cannot keep that model on a Codex account;
            // switching the global account to Codex keeps it on its relay instead of
            // rewriting the thread to the new account's default model.
            if (owner.AccountId != target && !IsRelayAccount(target) && IsRelayAccount(owner.AccountId))
            {
                ownership.SetPinned(id, true);
                continue;
            }
            if (owner.AccountId == target || IsFamilyBusy(id) || globalFailures.GetValueOrDefault(id) == target) continue;
            try { await SwitchAsync(id, target, cancellation); globalFailures.TryRemove(id, out _); }
            catch (InvalidOperationException error) when (error.Message is "THREAD_BUSY" or "THREAD_SWITCHING") { }
            catch (Exception error) when (!cancellation.IsCancellationRequested &&
                error is IOException or InvalidOperationException or TimeoutException or BackendRpcException or OperationCanceledException)
            {
                globalFailures[id] = target;
            }
        }
    }

    public async Task LoginAsync(string id, Func<LoginPrompt, Task> prompt, CancellationToken cancellation)
    {
        if (id == "primary" || !authorizing.TryAdd(id, 0)) throw new InvalidOperationException("ACCOUNT_BUSY");
        try
        {
            if (ownership.BoundTo(id).Any(IsBusy)) throw new InvalidOperationException("ACCOUNT_BUSY");
            var backend = await BackendAsync(id, cancellation);
            await AccountLogin.RunAsync(store, id, backend, prompt, cancellation, initialized: true);
        }
        finally { authorizing.TryRemove(id, out _); }
    }

    public async Task DetachAsync(string client)
    {
        if (primaryClient == client) primaryClient = null;
        foreach (var pair in subscribers) pair.Value.TryRemove(client, out _);
        foreach (var pair in lastClient.Where(pair => pair.Value == client))
        {
            var replacement = subscribers.GetValueOrDefault(pair.Key)?.Keys.FirstOrDefault();
            if (replacement is null) lastClient.TryRemove(pair.Key, out _);
            else lastClient[pair.Key] = replacement;
        }
        foreach (var pair in approvals.Where(pair => pair.Value.Client == client))
        {
            if (!approvals.TryRemove(pair.Key, out var approval)) continue;
            if (approval.Answered) continue;
            try
            {
                await approval.Backend.ReplyAsync(new JsonObject { ["id"] = approval.OriginalId.DeepClone(),
                    ["error"] = new JsonObject { ["code"] = -32001, ["message"] = "Owning desktop connection closed." } });
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { }
        }
    }

    private bool IsBusy(string id) => active.ContainsKey(id) || threadActivity.ContainsKey(id) || approvals.Values.Any(item => item.ThreadId == id)
        || ownership.Children(id).Any(IsBusy);

    private bool IsFamilyBusy(string id)
    {
        for (string? current = id; current is not null; current = ownership.Get(current).ParentId)
            if (IsBusy(current)) return true;
        return false;
    }

    private async Task<OfficialBackend> BackendAsync(string id, CancellationToken cancellation)
    {
        if (primaryOnly && id != "primary") throw new InvalidOperationException("ACCOUNT_NOT_READY");
        if (!failed.ContainsKey(id) && backends.TryGetValue(id, out var readyBackend)) return readyBackend;
        await startup.WaitAsync(cancellation);
        try
        {
            if (failed.TryRemove(id, out _) && backends.TryRemove(id, out var previous)) await previous.DisposeAsync();
            if (backends.TryGetValue(id, out var ready)) return ready;
            if (id != "primary" && store.Get(id).Status != "ready") throw new InvalidOperationException("ACCOUNT_NOT_READY");
            if (initialization is null) throw new InvalidOperationException("ROUTER_NOT_INITIALIZED");
            var backend = startBackend(id);
            backend.Notification += message => OnNotification(id, message);
            backend.ServerRequest += message => OnApproval(id, backend, message);
            backend.Disconnected += _ => BackendFailed(id);
            try
            {
                var result = await backend.RequestAsync("initialize", initialization, cancellation);
                await backend.ReplyAsync(new JsonObject { ["method"] = "initialized" }, cancellation);
                if (id != "primary")
                {
                    var roots = extraSkillRoots.Select(value => value!.GetValue<string>()).ToList();
                    var personal = Path.Combine(accountHome("primary"), "skills");
                    if (Directory.Exists(personal)) roots.Add(personal);
                    if (roots.Count > 0) await backend.RequestAsync("skills/extraRoots/set",
                        new JsonObject { ["extraRoots"] = new JsonArray(roots.Distinct(StringComparer.OrdinalIgnoreCase).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()) }, cancellation);
                }
                backends[id] = backend;
                if (id == "primary") initializationResult = result;
                return backend;
            }
            catch { await backend.DisposeAsync(); throw; }
        }
        finally { startup.Release(); }
    }

    private void BackendFailed(string account)
    {
        failed[account] = 0;
        foreach (var id in ownership.BoundTo(account))
        {
            if (active.TryRemove(id, out var turn) && turn is not ("pending" or "running"))
            {
                var error = new JsonObject { ["message"] = "The account backend disconnected. Retry this chat to reconnect to the same account." };
                var failure = new JsonObject { ["method"] = "turn/completed", ["params"] = new JsonObject
                {
                    ["threadId"] = id, ["turn"] = new JsonObject { ["id"] = turn, ["status"] = "failed", ["items"] = new JsonArray(), ["error"] = error },
                } };
                if (subscribers.TryGetValue(id, out var listeners))
                    foreach (var client in listeners.Keys) Outgoing?.Invoke(client, failure);
            }
            threadActivity.TryRemove(id, out _);
        }
        foreach (var pair in approvals.Where(pair => pair.Value.AccountId == account))
            if (approvals.TryRemove(pair.Key, out var approval) && approval.ThreadId is not null)
                Outgoing?.Invoke(approval.Client, new JsonObject { ["method"] = "serverRequest/resolved", ["params"] = new JsonObject
                { ["threadId"] = approval.ThreadId, ["requestId"] = JsonNode.Parse(pair.Key) } });
    }

    public async Task<JsonObject?> HandleAsync(string client, JsonObject message, CancellationToken cancellation = default)
    {
        var id = message["id"];
        var method = message["method"]?.GetValue<string>();
        if (method is null)
        {
            var key = id?.ToJsonString();
            if (key is null || !approvals.TryGetValue(key, out var approval) || approval.Client != client || approval.Answered
                || !approvals.TryUpdate(key, approval with { Answered = true }, approval))
                throw new InvalidOperationException("APPROVAL_NOT_OWNED");
            var response = (JsonObject)message.DeepClone();
            response["id"] = approval.OriginalId.DeepClone();
            await approval.Backend.ReplyAsync(response, cancellation);
            if (approval.ThreadId is null) approvals.TryRemove(key, out _);
            return null;
        }
        if (id is null)
        {
            if (method != "initialized" && backends.TryGetValue("primary", out var primary))
                await primary.ReplyAsync(message, cancellation);
            return null;
        }
        try
        {
            JsonNode? result;
            var parameters = message["params"] as JsonObject ?? new();
            if (method == "initialize")
            {
                primaryClient ??= client;
                initialization ??= (JsonObject)parameters.DeepClone();
                await BackendAsync("primary", cancellation);
                result = initializationResult?.DeepClone();
            }
            else if (method == "thread/list") result = await ListAsync(parameters, cancellation);
            else if (method == "model/list" && !primaryOnly) result = await ListModelsAsync(parameters, cancellation);
            else if (method == "skills/extraRoots/set")
            {
                result = await (await BackendAsync("primary", cancellation)).RequestAsync(method, parameters, cancellation);
                extraSkillRoots = (JsonArray)parameters["extraRoots"]!.DeepClone();
                foreach (var pair in backends.Where(pair => pair.Key != "primary"))
                {
                    var roots = (JsonArray)extraSkillRoots.DeepClone();
                    var personal = Path.Combine(accountHome("primary"), "skills");
                    if (Directory.Exists(personal) && !roots.Any(value => value?.GetValue<string>() == personal)) roots.Add(personal);
                    await pair.Value.RequestAsync(method, new JsonObject { ["extraRoots"] = roots }, cancellation);
                }
            }
            else if (method == "thread/loaded/list")
            {
                if (parameters["cursor"]?.GetValue<string>() is { Length: > 0 } cursor) result = NextPage(cursor, "loaded");
                else
                {
                    var data = new List<JsonNode>();
                    foreach (var pair in backends)
                        foreach (var thread in await LoadedIdsAsync(pair.Value, cancellation))
                            if (ownership.Get(thread).AccountId == pair.Key) data.Add(JsonValue.Create(thread)!);
                    result = Page(data.ToArray(), 0, Math.Clamp(parameters["limit"]?.GetValue<int>() ?? 100, 1, 500), "loaded");
                }
            }
            else result = await RouteAsync(client, method, parameters, cancellation);
            return new JsonObject { ["id"] = id.DeepClone(), ["result"] = result?.DeepClone() };
        }
        catch (BackendRpcException error)
        {
            return new JsonObject { ["id"] = id.DeepClone(), ["error"] = error.Payload?.DeepClone()
                ?? new JsonObject { ["code"] = error.Code, ["message"] = "Account backend request failed." } };
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or TimeoutException or ArgumentException or FormatException or System.Text.Json.JsonException)
        {
            return new JsonObject { ["id"] = id.DeepClone(), ["error"] = new JsonObject
            {
                ["code"] = -32001,
                ["message"] = error is InvalidOperationException && error.Message is
                    "THREAD_BUSY" or "THREAD_SWITCHING" or "ACCOUNT_NOT_READY" or "ACCOUNT_BACKEND_DISCONNECTED" or "MODEL_ROUTE_UNAVAILABLE"
                    ? error.Message : "Account router request failed. The original account was retained.",
            } };
        }
    }

    private async Task<JsonNode?> RouteAsync(string client, string method, JsonObject parameters, CancellationToken cancellation)
    {
        var threadId = ThreadId(parameters);
        var gate = threadId is null ? null : threadLocks.GetOrAdd(threadId, _ => new(1));
        if (gate is not null) await gate.WaitAsync(cancellation);
        try
        {
            var requestedModel = method is "thread/start" or "thread/resume" or "turn/start" or "thread/settings/update" ? RequestedModel(parameters) : null;
            if (!primaryOnly && threadId is not null) await RouteThreadOwnerAsync(threadId, method, requestedModel, cancellation);
            var pinned = false;
            string account;
            if (threadId is null)
            {
                if (method == "thread/start" && !primaryOnly)
                {
                    account = await StartAccountAsync(requestedModel, cancellation);
                    pinned = account != store.DefaultAccountId;
                }
                else account = "primary";
            }
            else account = ownership.Get(threadId).AccountId;
            if (authorizing.ContainsKey(account)) throw new InvalidOperationException("ACCOUNT_BUSY");
            if (account != "primary" && method is "thread/start" or "thread/resume" or "thread/fork")
                RouterBackendFactory.ShareConfiguration(accountHome("primary"), accountHome(account));
            var backend = await BackendAsync(account, cancellation);
            string? relayModel = null;
            if (account != "primary" && store.Get(account) is { Kind: "relay" } relay
                && method is "thread/start" or "thread/resume" or "thread/fork" or "turn/start" or "thread/settings/update")
            {
                parameters = (JsonObject)parameters.DeepClone();
                relayModel = TargetModel(account, requestedModel ?? (threadId is null ? null : ownership.Get(threadId).Model));
                parameters["model"] = relayModel;
                if (parameters["settings"] is JsonObject settings) settings["model"] = relayModel;
                if (parameters["threadSettings"] is JsonObject threadSettings) threadSettings["model"] = relayModel;
                // Thread settings carry only a model; the provider is implied by the owning backend.
                if (method is not ("turn/start" or "thread/settings/update")) parameters["modelProvider"] = ProviderRuntime.ProviderId(relay);
                if (method == "turn/start")
                {
                    var profile = store.ReadProviderSettings(account);
                    var entry = profile?.EffectiveModels.FirstOrDefault(model => model.Id == relayModel);
                    var effort = entry?.DefaultReasoningEffort ?? profile?.ReasoningEffort;
                    // The picker sends an explicit effort; the profile value is only a default.
                    if (profile is { UseDefaultModelMetadata: false } && parameters["effort"] is null && effort is not null) parameters["effort"] = effort;
                    // Collaboration settings take precedence over the top-level model and effort.
                    if (parameters["collaborationMode"]?["settings"] is JsonObject mode)
                    {
                        mode["model"] = relayModel;
                        if (profile is { UseDefaultModelMetadata: false } && mode["reasoning_effort"] is null && effort is not null)
                            mode["reasoning_effort"] = effort;
                    }
                }
            }
            else if (method is "thread/start" or "thread/resume" or "thread/fork"
                && parameters["modelProvider"] is JsonValue provider
                && provider.TryGetValue<string>(out var providerName) && providerName != "openai")
            {
                // The official provider serves Codex models; only a relay supplies its own provider id.
                parameters = (JsonObject)parameters.DeepClone();
                parameters["modelProvider"] = "openai";
            }
            var markedActive = false;
            if (threadId is not null)
            {
                lastClient[threadId] = client;
                if (method is "thread/resume" or "thread/subscribe" or "turn/start" or "turn/steer" or "turn/interrupt")
                    subscribers.GetOrAdd(threadId, _ => new())[client] = 0;
                if (method == "thread/unsubscribe" && subscribers.TryGetValue(threadId, out var attached)) attached.TryRemove(client, out _);
                if (method == "turn/start") markedActive = active.TryAdd(threadId, "pending");
            }
            JsonNode? result;
            try
            {
                if (authorizing.ContainsKey(account)) throw new InvalidOperationException("ACCOUNT_BUSY");
                if (threadId is not null && method == "turn/start" && !(await LoadedIdsAsync(backend, cancellation)).Contains(threadId))
                    await backend.RequestAsync("thread/resume", new JsonObject { ["threadId"] = threadId }, cancellation);
                result = await backend.RequestAsync(method, parameters, cancellation);
            }
            catch { if (threadId is not null && markedActive) active.TryRemove(threadId, out _); throw; }
            if (result?["thread"] is JsonObject returnedThread) RewriteThread(returnedThread, account);
            if (result?["settings"] is JsonObject returnedSettings) RewriteSettings(returnedSettings, account);
            if (result?["threadSettings"] is JsonObject returnedThreadSettings) RewriteSettings(returnedThreadSettings, account);
            if (threadId is not null && method is "turn/start" or "thread/settings/update")
                ownership.SetModel(threadId, relayModel);
            if (method is "thread/start" or "thread/fork" or "thread/resume" && result?["thread"]?["id"]?.GetValue<string>() is { } created)
            {
                var createdPinned = method switch
                {
                    "thread/start" => pinned,
                    "thread/fork" when threadId is not null => ownership.Get(threadId).Pinned,
                    _ => false,
                };
                if (!ownership.Contains(created))
                    ownership.Set(created, new(account, method == "thread/fork" ? threadId : null,
                        result["thread"]?["ephemeral"]?.GetValue<bool>() == true, createdPinned, relayModel));
                else if (method is "thread/start" or "thread/fork" && ownership.Get(created).Pinned != createdPinned)
                    ownership.SetPinned(created, createdPinned);
                if (relayModel is not null) ownership.SetModel(created, relayModel);
                lastClient[created] = client;
                subscribers.GetOrAdd(created, _ => new())[client] = 0;
            }
            return result;
        }
        finally { gate?.Release(); }
    }

    // Follow the global default lazily, and move a pinned thread when the requested model belongs to
    // another relay or back to a Codex account. Opening or resuming a chat never migrates it; the
    // switch happens before the next turn.
    private async Task RouteThreadOwnerAsync(string threadId, string method, string? requestedModel, CancellationToken cancellation)
    {
        var owner = ownership.Get(threadId);
        var relay = RelayTargetFor(requestedModel);
        var requestedAccount = requestedModel is null ? owner.AccountId : relay?.AccountId ?? CodexAccount();
        if (owner.Ephemeral || IsFamilyBusy(threadId))
        {
            if (requestedAccount != owner.AccountId) throw new InvalidOperationException("THREAD_BUSY");
            return;
        }
        if (relay is not null)
        {
            if (relay.AccountId == owner.AccountId)
            {
                if (!owner.Pinned && relay.AccountId != store.DefaultAccountId) ownership.SetPinned(threadId, true);
                return;
            }
            await SwitchThreadAsync(threadId, relay.AccountId, true, cancellation, relay.Model);
            ownership.SetModel(threadId, relay.Model);
            return;
        }
        if (requestedModel is not null)
        {
            var target = CodexAccount();
            if (IsRelayAccount(owner.AccountId))
            {
                await SwitchThreadAsync(threadId, target, target != store.DefaultAccountId, cancellation, requestedModel);
                ownership.SetModel(threadId, null);
            }
            return;
        }
        // A settings update that only changes effort or working directory keeps the owner.
        if (method == "thread/settings/update") return;
        if (method != "turn/start" || owner.Pinned || owner.AccountId == store.DefaultAccountId) return;
        // Lazy migration: a non-pinned chat that followed the old default moves when it is continued.
        try
        {
            await SwitchThreadAsync(threadId, store.DefaultAccountId, false, cancellation);
            ownership.SetModel(threadId, null);
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or TimeoutException or BackendRpcException)
        {
            // Keep the original account and let the turn continue; the account page reports the failure.
            globalFailures[threadId] = store.DefaultAccountId;
        }
    }

    private async Task SwitchThreadAsync(string threadId, string targetAccount, bool pinned, CancellationToken cancellation, string? model = null)
    {
        switching[threadId] = 0;
        try { await SwitchCoreAsync(threadId, targetAccount, cancellation, pinned, model); }
        finally { switching.TryRemove(threadId, out _); }
    }

    // Recent Codex builds can carry the selected model inside thread settings or
    // collaborationMode instead of the legacy top-level field.
    private static string? RequestedModel(JsonObject parameters)
    {
        return parameters["collaborationMode"]?["settings"]?["model"]?.GetValue<string>()
            ?? parameters["model"]?.GetValue<string>()
            ?? parameters["settings"]?["model"]?.GetValue<string>()
            ?? parameters["threadSettings"]?["model"]?.GetValue<string>();
    }

    // A newly started thread lands on the relay that owns the requested model; a Codex-model
    // request follows the new-chat policy among ChatGPT subscriptions.
    private async Task<string> StartAccountAsync(string? requestedModel, CancellationToken cancellation)
    {
        if (RelayTargetFor(requestedModel) is { } relay) return relay.AccountId;
        var fallback = store.DefaultAccountId;
        if (requestedModel is null && fallback != "primary" && store.Get(fallback).Kind == "relay") return fallback;
        if (requestedModel is not null && fallback != "primary" && store.Get(fallback).Kind == "relay") fallback = "primary";
        if (store.NewChatAccountPolicy != "quota") return fallback;
        var candidates = new List<AccountEntry>();
        if (primaryUsage is not null && DateTimeOffset.UtcNow - primaryUsageAt < TimeSpan.FromSeconds(30)) candidates.Add(primaryUsage);
        else
        {
            try
            {
                primaryUsage = await ReadAccountAsync("primary", cancellation);
                primaryUsageAt = DateTimeOffset.UtcNow;
                candidates.Add(primaryUsage);
            }
            catch (Exception error) when (error is BackendRpcException or IOException or TimeoutException or InvalidOperationException) { }
        }
        candidates.AddRange(store.List().Where(account => account is { Kind: "chatgpt", Status: "ready" }));
        var chosen = candidates.OrderByDescending(account => RemainingPercent(account, 10080))
            .ThenByDescending(account => RemainingPercent(account, 300)).FirstOrDefault();
        return chosen?.Id ?? fallback;
    }

    private static int RemainingPercent(AccountEntry account, long? minutes) => account.Usage?
        .Where(window => minutes is null || window.WindowDurationMins == minutes)
        .Select(window => 100 - Math.Clamp(window.UsedPercent, 0, 100)).DefaultIfEmpty(-1).Max() ?? -1;

    private string CodexAccount()
    {
        var target = store.DefaultAccountId;
        return target != "primary" && store.Get(target).Kind == "relay" ? "primary" : target;
    }

    private bool IsRelayAccount(string accountId)
    {
        if (accountId == "primary") return false;
        try { return store.Get(accountId) is { Kind: "relay", Status: "ready" }; }
        catch (Exception error) when (error is IOException or InvalidOperationException or System.Text.Json.JsonException) { return false; }
    }

    private RelayTarget? RelayTargetFor(string? model)
    {
        if (string.IsNullOrWhiteSpace(model) || !model.StartsWith("loader/", StringComparison.Ordinal)) return null;
        var parts = model.Split('/', 3);
        if (parts.Length != 3 || DecodeModel(parts[2]) is not { } upstream)
            throw new InvalidOperationException("MODEL_ROUTE_UNAVAILABLE");
        try
        {
            var account = store.Get(parts[1]);
            var settings = store.ReadProviderSettings(account.Id);
            if (account is { Kind: "relay", Status: "ready" } &&
                (settings is null ? account.Model == upstream : settings.EffectiveModels.Any(item => item.Enabled && item.Id == upstream)))
                return new(parts[1], upstream);
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or System.Text.Json.JsonException) { }
        throw new InvalidOperationException("MODEL_ROUTE_UNAVAILABLE");
    }

    private string TargetModel(string accountId, string? requested)
    {
        if (RelayTargetFor(requested) is { } target && target.AccountId == accountId) return target.Model;
        var account = store.Get(accountId);
        try
        {
            var settings = store.ReadProviderSettings(accountId);
            if (requested is not null && settings?.EffectiveModels.Any(item => item.Id == requested) == true) return requested;
            return settings?.Model ?? account.Model ?? requested ?? "";
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or System.Text.Json.JsonException)
        {
            return account.Model ?? requested ?? "";
        }
    }

    public static string SyntheticModelId(string accountId, string model) =>
        "loader/" + accountId + "/" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(model)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string? DecodeModel(string value)
    {
        try
        {
            var text = value.Replace('-', '+').Replace('_', '/');
            text = text.PadRight((text.Length + 3) / 4 * 4, '=');
            var model = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(text));
            return model.Length is > 0 and <= 160 && !model.Any(char.IsWhiteSpace) && !model.Any(char.IsControl) ? model : null;
        }
        catch (FormatException) { return null; }
    }

    private RelayInfo? RelayInfoFor(string accountId)
    {
        if (accountId == "primary") return null;
        var entry = store.Get(accountId);
        if (entry.Kind != "relay") return null;
        ProviderSettings? settings = null;
        try { settings = store.ReadProviderSettings(accountId); }
        catch (Exception error) when (error is IOException or InvalidOperationException or System.Text.Json.JsonException) { }
        return new RelayInfo(entry.Id, settings?.Model ?? entry.Model, settings);
    }

    private void RewriteThread(JsonObject thread, string accountId)
    {
        if (thread["settings"] is JsonObject settings)
        {
            RewriteSettings(settings, accountId);
            if (thread["model"] is null && settings["model"] is JsonValue settingsModel)
            {
                thread["model"] = settingsModel.DeepClone();
                if (accountId != "primary" && IsRelayAccount(accountId))
                    thread["modelProvider"] = ProviderRuntime.ProviderId(store.Get(accountId));
            }
        }
        if (accountId == "primary" || !IsRelayAccount(accountId) || thread["model"] is not JsonValue modelValue ||
            !modelValue.TryGetValue<string>(out var model) || string.IsNullOrWhiteSpace(model)) return;
        var upstream = model;
        if (model.StartsWith("loader/", StringComparison.Ordinal))
        {
            var parts = model.Split('/', 3);
            if (parts.Length == 3 && DecodeModel(parts[2]) is { } decoded) upstream = decoded;
        }
        thread["model"] = SyntheticModelId(accountId, upstream);
        thread["modelProvider"] = ProviderRuntime.ProviderId(store.Get(accountId));
    }

    // Thread settings notifications carry the model directly. Rewriting only the
    // thread object leaves the picker label on the upstream model (shown as 自定义).
    private void RewriteSettings(JsonObject settings, string accountId)
    {
        if (accountId == "primary" || !IsRelayAccount(accountId) || settings["model"] is not JsonValue modelValue ||
            !modelValue.TryGetValue<string>(out var model) || string.IsNullOrWhiteSpace(model)) return;
        var upstream = model;
        if (model.StartsWith("loader/", StringComparison.Ordinal))
        {
            var parts = model.Split('/', 3);
            if (parts.Length == 3 && DecodeModel(parts[2]) is { } decoded) upstream = decoded;
        }
        var synthetic = SyntheticModelId(accountId, upstream);
        settings["model"] = synthetic;
        if (settings.ContainsKey("model_provider_id")) settings["model_provider_id"] = ProviderRuntime.ProviderId(store.Get(accountId));
        if (settings.ContainsKey("modelProvider")) settings["modelProvider"] = ProviderRuntime.ProviderId(store.Get(accountId));
        if (settings["collaboration_mode"]?["settings"] is JsonObject collaboration)
            collaboration["model"] = synthetic;
        if (settings["collaborationMode"]?["settings"] is JsonObject currentCollaboration)
            currentCollaboration["model"] = synthetic;
    }

    private void OnNotification(string account, JsonObject message)
    {
        var method = message["method"]?.GetValue<string>() ?? "";
        var parameters = message["params"] as JsonObject;
        if (parameters?["thread_settings"] is JsonObject threadSettings) RewriteSettings(threadSettings, account);
        if (parameters?["settings"] is JsonObject updatedSettings) RewriteSettings(updatedSettings, account);
        var id = parameters is null ? null : ThreadId(parameters);
        if (method == "serverRequest/resolved")
        {
            var originalId = parameters?["requestId"]?.ToJsonString();
            var match = approvals.FirstOrDefault(pair => pair.Value.AccountId == account &&
                pair.Value.OriginalId.ToJsonString() == originalId && pair.Value.ThreadId == id);
            if (match.Key is not null && approvals.TryRemove(match.Key, out var approval))
            {
                var forwarded = (JsonObject)message.DeepClone();
                forwarded["params"]!["requestId"] = JsonNode.Parse(match.Key);
                Outgoing?.Invoke(approval.Client, forwarded);
            }
            return;
        }
        if (method == "thread/started" && parameters?["thread"] is JsonObject thread)
        {
            id = thread["id"]?.GetValue<string>();
            if (id is not null && !ownership.Contains(id))
            {
                var parent = thread["parentThreadId"]?.GetValue<string>() ??
                    (thread["source"] is JsonObject source && source["subAgent"] is JsonObject subAgent
                    && subAgent["thread_spawn"] is JsonObject spawned ? spawned["parent_thread_id"]?.GetValue<string>() : null);
                ownership.Set(id, new(account, parent, thread["ephemeral"]?.GetValue<bool>() == true));
                if (parent is not null && lastClient.TryGetValue(parent, out var client))
                {
                    lastClient[id] = client;
                    subscribers.GetOrAdd(id, _ => new())[client] = 0;
                }
            }
            if (id is not null && thread["status"]?["type"]?.GetValue<string>() == "active") threadActivity[id] = 0;
            if (id is not null) { RewriteThread(thread, account); InvalidateThreadCache(id); }
        }
        if (id is not null)
        {
            if (ownership.Contains(id) && ownership.Get(id).AccountId != account) return;
            if (method is "thread/name/updated" or "thread/renamed") InvalidateThreadCache(id);
            if (method == "thread/status/changed")
            {
                if (parameters?["status"]?["type"]?.GetValue<string>() == "active") threadActivity[id] = 0;
                else threadActivity.TryRemove(id, out _);
            }
            if (method is "turn/completed" or "thread/closed") threadActivity.TryRemove(id, out _);
            if (method == "turn/started") active[id] = parameters?["turn"]?["id"]?.GetValue<string>() ?? "running";
            if (method == "thread/closed" || method == "turn/completed" &&
                (parameters?["turn"]?["id"]?.GetValue<string>() is not { } completed || active.GetValueOrDefault(id) == completed))
                active.TryRemove(id, out _);
            if (method == "thread/deleted")
            {
                // Keep a tombstone so an older account's retained rollout cannot reappear in the catalog.
                ownership.Set(id, ownership.Get(id) with { AccountId = "deleted" });
                InvalidateThreadCache(id);
                active.TryRemove(id, out _); threadActivity.TryRemove(id, out _); subscribers.TryRemove(id, out _);
            }
            if (switching.ContainsKey(id)) return;
        }
        // Account-wide identity and configuration belong to the desktop's primary login.
        if (account != "primary" && id is null) return;
        if (id is not null && (method.StartsWith("turn/", StringComparison.Ordinal) || method.StartsWith("item/", StringComparison.Ordinal)
            || method.StartsWith("hook/", StringComparison.Ordinal) || method.StartsWith("rawResponse", StringComparison.Ordinal)))
        {
            if (subscribers.TryGetValue(id, out var attached))
                foreach (var client in attached.Keys) Outgoing?.Invoke(client, message);
            return;
        }
        Outgoing?.Invoke(null, message);
    }

    private void OnApproval(string account, OfficialBackend backend, JsonObject message)
    {
        var threadId = message["params"] is JsonObject parameters ? ThreadId(parameters) : null;
        var client = threadId is not null ? lastClient.GetValueOrDefault(threadId) : account == "primary" ? primaryClient : null;
        if (client is null)
        {
            _ = RejectUnownedAsync(account, backend, message);
            return;
        }
        var id = JsonValue.Create("account-router:" + Interlocked.Increment(ref approvalSequence))!;
        approvals[id.ToJsonString()] = new(account, backend, message["id"]!.DeepClone(), client, threadId);
        var forwarded = (JsonObject)message.DeepClone();
        forwarded["id"] = id;
        Outgoing?.Invoke(client, forwarded);
    }

    private async Task RejectUnownedAsync(string account, OfficialBackend backend, JsonObject message)
    {
        try
        {
            await backend.ReplyAsync(new JsonObject { ["id"] = message["id"]!.DeepClone(),
                ["error"] = new JsonObject { ["code"] = -32001, ["message"] = "No owning desktop connection for this request." } });
        }
        catch (Exception error) when (error is IOException or InvalidOperationException) { failed[account] = 0; }
    }

    public async Task SwitchAsync(string threadId, string targetAccount, CancellationToken cancellation = default, bool pinned = false)
    {
        var gate = threadLocks.GetOrAdd(threadId, _ => new(1));
        await gate.WaitAsync(cancellation);
        switching[threadId] = 0;
        try { await SwitchCoreAsync(threadId, targetAccount, cancellation, pinned); }
        finally { switching.TryRemove(threadId, out _); gate.Release(); }
    }

    private async Task SwitchCoreAsync(string threadId, string targetAccount, CancellationToken cancellation, bool pinned = false, string? model = null)
    {
        if (IsFamilyBusy(threadId)) throw new InvalidOperationException("THREAD_BUSY");
        var owner = ownership.Get(threadId);
        if (owner.AccountId == targetAccount || owner.Ephemeral)
        {
            if (owner.AccountId == targetAccount && owner.Pinned != pinned) ownership.SetPinned(threadId, pinned);
            return;
        }
        var source = await BackendAsync(owner.AccountId, cancellation);
        var snapshot = await source.RequestAsync("thread/read", new JsonObject { ["threadId"] = threadId, ["includeTurns"] = false }, cancellation);
        var thread = snapshot?["thread"] ?? throw new IOException("THREAD_UNAVAILABLE");
        if (thread["ephemeral"]?.GetValue<bool>() == true)
        {
            ownership.Set(threadId, owner with { Ephemeral = true });
            return;
        }
        if (thread["status"]?["type"]?.GetValue<string>() is "active") throw new InvalidOperationException("THREAD_BUSY");
        if (string.IsNullOrWhiteSpace(thread["path"]?.GetValue<string>()))
        {
            await source.RequestAsync("thread/archive", new JsonObject { ["threadId"] = threadId }, cancellation);
            var restored = await source.RequestAsync("thread/unarchive", new JsonObject { ["threadId"] = threadId }, CancellationToken.None);
            thread = restored?["thread"] ?? throw new IOException("THREAD_NOT_PERSISTED");
            if (thread["id"]?.GetValue<string>() != threadId) throw new IOException("THREAD_ID_CHANGED");
        }
        var target = await BackendAsync(targetAccount, cancellation);
        var targetRelay = targetAccount != "primary" && store.Get(targetAccount).Kind == "relay";
        var sourceModel = owner.Model ?? thread["model"]?.GetValue<string>();
        var preservedModel = targetRelay || sourceModel is null || RelayTargetFor(sourceModel) is not null ? null : sourceModel;
        var targetModel = targetRelay ? model ?? owner.Model ?? store.Get(targetAccount).Model : model ?? preservedModel;
        try
        {
            await ReleaseAsync(source, threadId, cancellation);
            await ReleaseAsync(target, threadId, cancellation);
            // The target may need the shared rollout in its catalog before it can resume the thread.
            try { await target.RequestAsync("thread/read", new JsonObject { ["threadId"] = threadId, ["includeTurns"] = false }, cancellation); }
            catch (BackendRpcException) { }
            var resumed = await target.RequestAsync("thread/resume", new JsonObject
            {
                ["threadId"] = threadId, ["cwd"] = thread["cwd"]?.DeepClone(),
                ["modelProvider"] = targetRelay ? ProviderRuntime.ProviderId(store.Get(targetAccount)) : "openai",
                ["model"] = targetModel,
            }, cancellation);
            if (resumed?["thread"]?["id"]?.GetValue<string>() != threadId) throw new IOException("THREAD_ID_CHANGED");
            ownership.Set(threadId, owner with { AccountId = targetAccount, Pinned = pinned, Model = targetRelay ? targetModel : null });
            InvalidateThreadCache(threadId);
            var resumedThread = (JsonObject)resumed!["thread"]!.DeepClone();
            RewriteThread(resumedThread, targetAccount);
            Outgoing?.Invoke(null, new JsonObject { ["method"] = "thread/started", ["params"] = new JsonObject { ["thread"] = resumedThread } });
        }
        catch
        {
            try { await ReleaseAsync(target, threadId, CancellationToken.None); } catch (Exception) { }
            try { await source.RequestAsync("thread/resume", new JsonObject { ["threadId"] = threadId }, CancellationToken.None); } catch (Exception) { }
            throw;
        }
    }

    private static async Task ReleaseAsync(OfficialBackend backend, string threadId, CancellationToken cancellation)
    {
        try { await backend.RequestAsync("thread/unsubscribe", new JsonObject { ["threadId"] = threadId }, cancellation); }
        catch (BackendRpcException)
        {
            // A target may never have loaded this thread; prove it has no writer before copying.
            if ((await LoadedIdsAsync(backend, cancellation)).Contains(threadId)) throw;
            return;
        }
        // Unsubscribe is delayed. A copied rollout is safe only after the writer is gone.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromMinutes(2));
        while (true)
        {
            var loaded = await LoadedIdsAsync(backend, timeout.Token);
            if (!loaded.Contains(threadId)) return;
            await Task.Delay(250, timeout.Token);
        }
    }

    private static async Task<HashSet<string>> LoadedIdsAsync(OfficialBackend backend, CancellationToken cancellation)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var cursors = new HashSet<string>(StringComparer.Ordinal);
        var parameters = new JsonObject { ["limit"] = 500 };
        do
        {
            var page = await backend.RequestAsync("thread/loaded/list", parameters, cancellation);
            foreach (var value in page?["data"]?.AsArray() ?? []) if (value is not null) ids.Add(value.GetValue<string>());
            parameters["cursor"] = page?["nextCursor"]?.DeepClone();
            if (parameters["cursor"] is not null && !cursors.Add(parameters["cursor"]!.GetValue<string>()))
                throw new IOException("INVALID_BACKEND_CURSOR");
        } while (parameters["cursor"] is not null);
        return ids;
    }

    private void InvalidateThreadCache(string threadId)
    {
        var suffix = "\u0000" + threadId;
        foreach (var pair in readCache)
            if (pair.Key.EndsWith(suffix, StringComparison.Ordinal)) readCache.TryRemove(pair.Key, out _);
    }

    private async Task<JsonNode> ListAsync(JsonObject parameters, CancellationToken cancellation)
    {
        // Use an immutable snapshot cursor so changing accounts cannot shift subsequent pages.
        if (parameters["cursor"]?.GetValue<string>() is { Length: > 0 } cursor)
            return NextPage(cursor, "catalog");
        var archived = parameters["archived"]?.GetValue<bool>() == true;
        var items = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
        var current = store.List().Select(entry => entry.Id).ToHashSet(StringComparer.Ordinal);
        var accounts = store.List(includeRemoved: true).Where(entry => entry.Status == "ready" &&
            (current.Contains(entry.Id) || ownership.BoundTo(entry.Id).Length > 0)).Select(entry => entry.Id);
        foreach (var account in new[] { "primary" }.Concat(primaryOnly ? [] : accounts))
        {
            var backend = await BackendAsync(account, cancellation);
            var request = (JsonObject)parameters.DeepClone(); request["limit"] = 500; request.Remove("cursor");
            var cursors = new HashSet<string>(StringComparer.Ordinal);
            do
            {
                var result = await backend.RequestAsync("thread/list", request, cancellation);
                foreach (var item in result?["data"]?.AsArray() ?? [])
                {
                    if (item?["id"]?.GetValue<string>() is not { } id) continue;
                    if (account != "primary" && !ownership.Contains(id)) ownership.Set(id, new(account));
                    if (ownership.Get(id).AccountId == account) items[id] = item.DeepClone();
                }
                request["cursor"] = result?["nextCursor"]?.DeepClone();
                if (request["cursor"] is not null && !cursors.Add(request["cursor"]!.GetValue<string>()))
                    throw new IOException("INVALID_BACKEND_CURSOR");
            } while (request["cursor"] is not null);
            // A migrated rollout exists in the target home but not in that backend's session index,
            // so recover its thread object directly and keep it visible in the catalog.
            foreach (var id in ownership.BoundTo(account).Where(id => !items.ContainsKey(id) && !ownership.Get(id).Ephemeral).Take(500))
                if (await ReadThreadAsync(backend, account, id, archived, cancellation) is { } recovered
                    && MatchesListFilters(recovered, parameters)) items[id] = recovered;
        }
        var sort = parameters["sortKey"]?.GetValue<string>() == "created_at" ? "createdAt" : "updatedAt";
        foreach (var pair in items)
            if (pair.Value is JsonObject thread) RewriteThread(thread, ownership.Get(pair.Key).AccountId);
        var ordered = parameters["sortDirection"]?.GetValue<string>() == "asc"
            ? items.Values.OrderBy(item => item[sort]?.GetValue<long>() ?? 0).ThenBy(item => item["id"]!.GetValue<string>())
            : items.Values.OrderByDescending(item => item[sort]?.GetValue<long>() ?? 0).ThenBy(item => item["id"]!.GetValue<string>());
        return Page(ordered.ToArray(), 0, Math.Clamp(parameters["limit"]?.GetValue<int>() ?? 50, 1, 500));
    }

    public async Task<object> ListThreadsAsync(string? query, int limit, CancellationToken cancellation)
    {
        var bounded = Math.Clamp(limit, 1, 100);
        var sessions = Path.Combine(accountHome("primary"), "sessions");
        if (Directory.Exists(sessions) && Directory.EnumerateFiles(sessions, "*.jsonl", SearchOption.AllDirectories).Any())
            return ListThreadsFromHistory(sessions, query, bounded);
        var page = await ListAsync(new JsonObject { ["limit"] = bounded, ["sortKey"] = "updated_at", ["sortDirection"] = "desc" }, cancellation);
        var needle = query?.Trim().ToLowerInvariant() ?? "";
        var result = new List<object>();
        foreach (var node in page["data"]?.AsArray() ?? [])
        {
            if (node is not JsonObject thread || thread["id"]?.GetValue<string>() is not { } id) continue;
            var owner = ownership.Get(id);
            var title = thread["title"]?.GetValue<string>() ?? thread["name"]?.GetValue<string>()
                ?? thread["preview"]?.GetValue<string>() ?? id;
            if (needle.Length > 0 && !title.ToLowerInvariant().Contains(needle, StringComparison.Ordinal)) continue;
            string accountName;
            try { accountName = owner.AccountId == "primary" ? "桌面主账号" : store.Get(owner.AccountId).Name; }
            catch (Exception error) when (error is IOException or InvalidOperationException or System.Text.Json.JsonException) { accountName = "已移除账号"; }
            result.Add(new { id, title, accountId = owner.AccountId, accountName,
                model = thread["model"]?.GetValue<string>(), modelName = thread["model"]?.GetValue<string>(),
                pinned = owner.Pinned, busy = IsBusy(id), updatedAt = thread["updatedAt"]?.GetValue<long>() ?? 0 });
        }
        return new { threads = result.ToArray() };
    }

    // With one shared history store, the recent list can be read without starting every account backend.
    private object ListThreadsFromHistory(string sessions, string? query, int limit)
    {
        var needle = query?.Trim().ToLowerInvariant() ?? "";
        var files = Directory.EnumerateFiles(sessions, "*.jsonl", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true })
            .Select(path => new FileInfo(path)).Where(file => file.Exists).OrderByDescending(file => file.LastWriteTimeUtc)
            .Take(Math.Max(limit * 4, 100)).ToArray();
        var threads = new List<object>();
        foreach (var file in files)
        {
            var threadsId = ThreadIdFromFile(file.Name);
            if (threadsId is null) continue;
            var title = ReadThreadTitle(file.FullName) ?? threadsId;
            if (needle.Length > 0 && !title.ToLowerInvariant().Contains(needle, StringComparison.Ordinal)) continue;
            var owner = ownership.Get(threadsId);
            string accountName;
            try { accountName = owner.AccountId == "primary" ? "桌面主账号" : store.Get(owner.AccountId).Name; }
            catch (Exception error) when (error is IOException or InvalidOperationException or System.Text.Json.JsonException) { accountName = "已移除账号"; }
            threads.Add(new { id = threadsId, title, accountId = owner.AccountId, accountName,
                model = owner.Model, modelName = owner.Model, pinned = owner.Pinned, busy = IsBusy(threadsId),
                updatedAt = new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
            if (threads.Count >= limit) break;
        }
        return new { threads = threads.ToArray() };
    }

    private static string? ThreadIdFromFile(string name)
    {
        var match = ThreadIdAtEnd().Match(Path.GetFileNameWithoutExtension(name));
        return match.Success ? match.Value : null;
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
                var payload = node?["payload"] as JsonObject;
                string? text = null;
                if (payload?["type"]?.GetValue<string>() is "user_message")
                    text = payload["message"]?.GetValue<string>() ?? payload["text"]?.GetValue<string>();
                else if (payload?["type"]?.GetValue<string>() is "message" && payload?["role"]?.GetValue<string>() is "user")
                    text = (payload["content"] as JsonArray)?.OfType<JsonObject>()
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

    // Catalog polling must not re-read every migrated thread; cache the recovered object briefly and
    // drop it whenever ownership or the thread lifecycle changes.
    private async Task<JsonNode?> ReadThreadAsync(OfficialBackend backend, string account, string threadId, bool archived, CancellationToken cancellation)
    {
        var key = account + "\u0000" + threadId;
        if (readCache.TryGetValue(key, out var cached) && cached.Expires > DateTimeOffset.UtcNow)
            return MatchesArchive(cached.Thread, archived) ? cached.Thread.DeepClone() : null;
        JsonNode? thread;
        try
        {
            var snapshot = await backend.RequestAsync("thread/read", new JsonObject { ["threadId"] = threadId, ["includeTurns"] = false }, cancellation);
            thread = snapshot?["thread"];
        }
        catch (Exception error) when (error is BackendRpcException or IOException or TimeoutException) { return null; }
        if (thread is null || thread["id"]?.GetValue<string>() != threadId) return null;
        readCache[key] = new CachedThread(thread, DateTimeOffset.UtcNow.Add(ReadCacheLifetime));
        return MatchesArchive(thread, archived) ? thread.DeepClone() : null;
    }

    private static bool MatchesArchive(JsonNode thread, bool archived) =>
        (thread["path"]?.GetValue<string>()?.Contains("archived_sessions", StringComparison.OrdinalIgnoreCase) == true) == archived;

    // Recovered threads bypass the backend's own filters. Apply the client's filters here so a
    // pinned/project/search listing never receives a migrated thread that does not match it.
    private static bool MatchesListFilters(JsonNode thread, JsonObject parameters)
    {
        if (parameters["sectionId"] is JsonValue sectionValue && sectionValue.TryGetValue<string>(out var sectionId)
            && thread["section"]?["id"]?.GetValue<string>() != sectionId) return false;
        if (parameters["projectId"] is JsonValue projectValue && projectValue.TryGetValue<string>(out var projectId)
            && thread["projectId"]?.GetValue<string>() != projectId) return false;
        if (parameters["searchTerm"] is JsonValue searchValue && searchValue.TryGetValue<string>(out var search)
            && !string.IsNullOrEmpty(search))
        {
            var needle = search.ToLowerInvariant();
            var haystack = (thread["name"]?.GetValue<string>() ?? "") + "\n" + (thread["preview"]?.GetValue<string>() ?? "");
            if (!haystack.ToLowerInvariant().Contains(needle, StringComparison.Ordinal)) return false;
        }
        if (parameters["cwd"] is JsonValue cwdValue && cwdValue.TryGetValue<string>(out var cwd)
            && thread["cwd"]?.GetValue<string>() != cwd) return false;
        if (parameters["cwd"] is JsonArray cwdArray && cwdArray.Count > 0
            && !cwdArray.OfType<JsonValue>().Any(value => value.TryGetValue<string>(out var item) && item == thread["cwd"]?.GetValue<string>())) return false;
        if (parameters["modelProviders"] is JsonArray providers && providers.Count > 0
            && !providers.OfType<JsonValue>().Any(value => value.TryGetValue<string>(out var provider)
                && provider == thread["modelProvider"]?.GetValue<string>())) return false;
        // Unknown source-kind and ancestor filters are only applied by the backend catalog.
        if (parameters["sourceKinds"] is JsonArray sources && sources.Count > 0) return false;
        if (parameters["ancestorThreadId"] is not null || parameters["parentThreadId"] is not null) return false;
        return true;
    }

    // Aggregate the Codex catalog with every enabled model of every ready relay so a model selection
    // can identify its backend before any thread exists. Exactly one entry is marked as the default.
    public async Task<JsonNode> ListModelsAsync(JsonObject parameters, CancellationToken cancellation)
    {
        if (parameters["cursor"]?.GetValue<string>() is { Length: > 0 } cursor) return NextPage(cursor, "models");
        if (primaryOnly)
            return await (await BackendAsync("primary", cancellation)).RequestAsync("model/list", parameters, cancellation)
                ?? new JsonObject { ["data"] = new JsonArray(), ["nextCursor"] = null };
        var data = new List<JsonNode>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var backend = await BackendAsync(BaseModelAccount(), cancellation);
        // Preserve client filters such as includeHidden; only the page size and cursor are ours.
        var request = (JsonObject)parameters.DeepClone();
        request["limit"] = 500;
        request.Remove("cursor");
        var cursors = new HashSet<string>(StringComparer.Ordinal);
        do
        {
            var result = await backend.RequestAsync("model/list", request, cancellation);
            foreach (var item in result?["data"]?.AsArray() ?? [])
            {
                if (item is not JsonObject model || model["id"]?.GetValue<string>() is not { } id || !ids.Add(id)) continue;
                data.Add(model.DeepClone());
            }
            request["cursor"] = result?["nextCursor"]?.DeepClone();
            if (request["cursor"] is not null && !cursors.Add(request["cursor"]!.GetValue<string>()))
                throw new IOException("INVALID_BACKEND_CURSOR");
        } while (request["cursor"] is not null);
        var defaultAccount = store.DefaultAccountId;
        var defaultRelay = defaultAccount != "primary" && store.Get(defaultAccount).Kind == "relay";
        JsonObject? defaultEntry = null;
        foreach (var account in store.List().Where(entry => entry is { Kind: "relay", Status: "ready" }))
        {
            var relay = RelayInfoFor(account.Id);
            if (relay is null) continue;
            var models = relay.Settings?.EffectiveModels.Where(item => item.Enabled).ToArray()
                ?? [new ProviderModelSettings(relay.Model ?? account.Model ?? "", relay.Model ?? account.Model, null)];
            foreach (var model in models)
            {
                if (string.IsNullOrWhiteSpace(model.Id)) continue;
                var synthetic = SyntheticModelId(account.Id, model.Id);
                if (!ids.Add(synthetic)) continue;
                var entry = RelayModelEntry(account, relay.Settings, model, synthetic);
                data.Add(entry);
                if (defaultRelay && account.Id == defaultAccount && model.Id == (relay.Settings?.Model ?? account.Model))
                    defaultEntry = entry;
            }
        }
        if (defaultEntry is not null)
        {
            foreach (var item in data) item["isDefault"] = false;
            defaultEntry["isDefault"] = true;
        }
        else if (data.Count > 0)
        {
            // Keep the backend's own default, but never expose more than one.
            var firstDefault = data.FindIndex(item => item["isDefault"]?.GetValue<bool>() == true);
            if (firstDefault < 0) data[0]["isDefault"] = true;
            for (var index = Math.Max(0, firstDefault) + 1; index < data.Count; index++) data[index]["isDefault"] = false;
        }
        return Page(data.ToArray(), 0, Math.Clamp(parameters["limit"]?.GetValue<int>() ?? 100, 1, 500), "models");
    }

    private string BaseModelAccount()
    {
        var target = store.DefaultAccountId;
        return target != "primary" && store.Get(target).Kind == "relay" ? "primary" : target;
    }

    // Fields mirror the official `model/list` shape of a generated provider catalog.
    public static JsonObject RelayModelEntry(AccountEntry account, ProviderSettings? settings)
    {
        var model = string.IsNullOrWhiteSpace(settings?.Model) ? account.Model ?? "" : settings!.Model;
        var entry = RelayModelEntry(account, settings, new ProviderModelSettings(model, model), model);
        entry["displayName"] = model;
        entry["description"] = settings?.DisplayName ?? (string.IsNullOrWhiteSpace(account.Name) ? "模型接入" : account.Name);
        return entry;
    }

    public static JsonObject RelayModelEntry(AccountEntry account, ProviderSettings? settings, ProviderModelSettings model, string id)
    {
        var levels = (model.ReasoningLevels ?? []).ToArray();
        if (levels.Length == 0 && (model.DefaultReasoningEffort ?? settings?.ReasoningEffort) is { } fallback) levels = [fallback];
        var efforts = new JsonArray();
        foreach (var level in levels) efforts.Add(new JsonObject { ["reasoningEffort"] = level, ["description"] = level });
        var name = string.IsNullOrWhiteSpace(model.Name) ? model.Id : model.Name;
        var displayName = string.IsNullOrWhiteSpace(account.Name) || name.Contains(account.Name, StringComparison.Ordinal)
            ? name : name + " · " + account.Name;
        var context = model.ContextWindow ?? (settings?.ContextWindow is > 0 ? settings.ContextWindow : null);
        return new JsonObject
        {
            ["id"] = id,
            ["model"] = id,
            ["displayName"] = displayName,
            ["description"] = string.IsNullOrWhiteSpace(account.Name) ? "模型接入" : account.Name,
            ["hidden"] = false,
            ["isDefault"] = false,
            ["upgrade"] = null,
            ["upgradeInfo"] = null,
            ["availabilityNux"] = null,
            ["modelSpecialty"] = null,
            ["supportedReasoningEfforts"] = efforts,
            ["defaultReasoningEffort"] = levels.Length > 0
                ? (model.DefaultReasoningEffort is { } preferred && levels.Contains(preferred, StringComparer.Ordinal)
                    ? preferred : levels[0])
                : null,
            ["inputModalities"] = model.SupportsImages || settings?.SupportsImages == true
                ? new JsonArray(JsonValue.Create("text"), JsonValue.Create("image"))
                : new JsonArray(JsonValue.Create("text")),
            ["contextWindow"] = context,
            ["maxContextWindow"] = context,
            ["supportsPersonality"] = false,
            ["multiAgentVersion"] = "v2",
            ["additionalSpeedTiers"] = new JsonArray(),
            ["serviceTiers"] = new JsonArray(),
            ["defaultServiceTier"] = null,
            ["availableAccessPrograms"] = null,
        };
    }

    private readonly ConcurrentDictionary<string, ListPage> pages = new();
    private JsonObject NextPage(string cursor, string kind)
    {
        if (!pages.TryGetValue(cursor, out var page) || page.Kind != kind || page.Expires < DateTimeOffset.UtcNow)
            throw new ArgumentException("CURSOR_EXPIRED");
        return Page(page.Items, page.Offset, page.Limit, kind);
    }
    private JsonObject Page(JsonNode[] items, int offset, int limit, string kind = "catalog")
    {
        foreach (var old in pages.Where(pair => pair.Value.Expires < DateTimeOffset.UtcNow)) pages.TryRemove(old.Key, out _);
        string? cursor = null;
        if (offset + limit < items.Length)
        {
            cursor = "accounts:" + Guid.NewGuid().ToString("N");
            pages[cursor] = new(items, offset + limit, limit, DateTimeOffset.UtcNow.AddMinutes(5), kind);
        }
        return new JsonObject { ["data"] = new JsonArray(items.Skip(offset).Take(limit).Select(item => item.DeepClone()).ToArray()), ["nextCursor"] = cursor };
    }

    private static string? ThreadId(JsonObject parameters) =>
        (parameters["threadId"] ?? parameters["thread_id"] ?? parameters["conversationId"])?.GetValue<string>();
    private sealed record Approval(string AccountId, OfficialBackend Backend, JsonNode OriginalId, string Client, string? ThreadId, bool Answered = false);
    private sealed record ListPage(JsonNode[] Items, int Offset, int Limit, DateTimeOffset Expires, string Kind);
    private sealed record CachedThread(JsonNode Thread, DateTimeOffset Expires);
    private sealed record RelayInfo(string AccountId, string? Model, ProviderSettings? Settings);
    private sealed record RelayTarget(string AccountId, string Model);

    public async ValueTask DisposeAsync()
    {
        await Task.WhenAll(backends.Values.Select(backend => backend.DisposeAsync().AsTask()));
        foreach (var gate in threadLocks.Values) gate.Dispose();
        startup.Dispose();
    }
}
