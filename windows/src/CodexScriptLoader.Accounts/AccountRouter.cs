using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record GlobalAccountStatus(string AccountId, int PendingThreads, int BusyThreads, int FailedThreads);

// One router owns the backends; desktop connections share it without sharing RPC IDs.
public sealed class AccountRouter(AccountStore store, ThreadOwnership ownership,
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
        var pending = ownership.AllThreads().Where(id => ownership.Get(id).AccountId != target).ToArray();
        return new(target, pending.Length, pending.Count(IsFamilyBusy), pending.Count(id => globalFailures.GetValueOrDefault(id) == target));
    }

    public void RetryGlobalSwitch() => globalFailures.Clear();

    public async Task ReconcileGlobalAsync(CancellationToken cancellation)
    {
        if (primaryOnly || !IsConnected) return;
        foreach (var id in ownership.AllThreads())
        {
            cancellation.ThrowIfCancellationRequested();
            var target = store.DefaultAccountId;
            if (ownership.Get(id).AccountId == target || IsFamilyBusy(id) || globalFailures.GetValueOrDefault(id) == target) continue;
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
                    "THREAD_BUSY" or "THREAD_SWITCHING" or "ACCOUNT_NOT_READY" or "ACCOUNT_BACKEND_DISCONNECTED"
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
            if (!primaryOnly && threadId is not null && method is "turn/start" or "thread/resume" or "thread/fork"
                && !IsFamilyBusy(threadId) && !ownership.Get(threadId).Ephemeral && ownership.Get(threadId).AccountId != store.DefaultAccountId)
            {
                switching[threadId] = 0;
                try { await SwitchCoreAsync(threadId, store.DefaultAccountId, cancellation); }
                finally { switching.TryRemove(threadId, out _); }
            }
            var account = threadId is null ? method is "thread/start" or "model/list" && !primaryOnly ? store.DefaultAccountId : "primary" : ownership.Get(threadId).AccountId;
            if (authorizing.ContainsKey(account)) throw new InvalidOperationException("ACCOUNT_BUSY");
            if (account != "primary" && method is "thread/start" or "thread/resume" or "thread/fork")
                RouterBackendFactory.ShareConfiguration(accountHome("primary"), accountHome(account));
            var backend = await BackendAsync(account, cancellation);
            if (account != "primary" && store.Get(account) is { Kind: "relay" } relay
                && method is "thread/start" or "thread/resume" or "thread/fork" or "turn/start")
            {
                parameters = (JsonObject)parameters.DeepClone();
                parameters["model"] = relay.Model;
                if (method != "turn/start") parameters["modelProvider"] = ProviderRuntime.ProviderId(relay);
                if (method == "turn/start")
                {
                    var profile = store.ReadProviderSettings(account);
                    if (profile is { UseDefaultModelMetadata: false }) parameters["effort"] = profile.ReasoningEffort;
                    // Collaboration settings take precedence over the top-level model and effort.
                    if (parameters["collaborationMode"]?["settings"] is JsonObject mode)
                    {
                        mode["model"] = relay.Model;
                        if (profile is { UseDefaultModelMetadata: false }) mode["reasoning_effort"] = profile.ReasoningEffort;
                    }
                }
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
            if (method is "thread/start" or "thread/fork" or "thread/resume" && result?["thread"]?["id"]?.GetValue<string>() is { } created)
            {
                if (!ownership.Contains(created)) ownership.Set(created, new(account, method == "thread/fork" ? threadId : null,
                    result["thread"]?["ephemeral"]?.GetValue<bool>() == true));
                lastClient[created] = client;
                subscribers.GetOrAdd(created, _ => new())[client] = 0;
            }
            return result;
        }
        finally { gate?.Release(); }
    }

    private void OnNotification(string account, JsonObject message)
    {
        var method = message["method"]?.GetValue<string>() ?? "";
        var parameters = message["params"] as JsonObject;
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
        }
        if (id is not null)
        {
            if (ownership.Contains(id) && ownership.Get(id).AccountId != account) return;
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

    public async Task SwitchAsync(string threadId, string targetAccount, CancellationToken cancellation = default)
    {
        var gate = threadLocks.GetOrAdd(threadId, _ => new(1));
        await gate.WaitAsync(cancellation);
        switching[threadId] = 0;
        try { await SwitchCoreAsync(threadId, targetAccount, cancellation); }
        finally { switching.TryRemove(threadId, out _); gate.Release(); }
    }

    private async Task SwitchCoreAsync(string threadId, string targetAccount, CancellationToken cancellation)
    {
        if (IsFamilyBusy(threadId)) throw new InvalidOperationException("THREAD_BUSY");
        var owner = ownership.Get(threadId);
        if (owner.AccountId == targetAccount || owner.Ephemeral) return;
        var source = await BackendAsync(owner.AccountId, cancellation);
        var snapshot = await source.RequestAsync("thread/read", new JsonObject { ["threadId"] = threadId, ["includeTurns"] = false }, cancellation);
        var thread = snapshot?["thread"] ?? throw new IOException("THREAD_UNAVAILABLE");
        if (thread["ephemeral"]?.GetValue<bool>() == true)
        {
            // Metadata/title turns have no transferable rollout and stay with their original backend.
            ownership.Set(threadId, owner with { Ephemeral = true });
            return;
        }
        if (thread["status"]?["type"]?.GetValue<string>() is "active") throw new InvalidOperationException("THREAD_BUSY");
        var historyPath = thread["path"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(historyPath)) throw new IOException("THREAD_NOT_PERSISTED");
        var target = await BackendAsync(targetAccount, cancellation);
        var home = NormalizeHistoryPath(accountHome(owner.AccountId));
        var relative = HistoryRelativePath(home, historyPath);
        var sourcePath = Path.Combine(home, relative);
        RejectLinks(home, sourcePath);
        if (!File.Exists(sourcePath))
        {
            // Official zero-turn threads are memory-only; archive/unarchive persists metadata without a model turn.
            if (thread["ephemeral"]?.GetValue<bool>() == true) throw new InvalidOperationException("THREAD_NOT_PERSISTED");
            await source.RequestAsync("thread/archive", new JsonObject { ["threadId"] = threadId }, cancellation);
            var restored = await source.RequestAsync("thread/unarchive", new JsonObject { ["threadId"] = threadId }, CancellationToken.None);
            thread = restored?["thread"] ?? throw new IOException("THREAD_UNAVAILABLE");
            if (thread["id"]?.GetValue<string>() != threadId) throw new IOException("THREAD_ID_CHANGED");
            relative = HistoryRelativePath(home, thread["path"]!.GetValue<string>());
            sourcePath = Path.Combine(home, relative);
        }
        var destination = Path.Combine(accountHome(targetAccount), relative);
        var committed = false;
        var copied = false;
        string? backup = null;
        try
        {
            await ReleaseAsync(source, threadId, cancellation);
            await ReleaseAsync(target, threadId, cancellation);
            RejectLinks(accountHome(targetAccount), destination);
            RejectLinks(home, sourcePath);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            if (File.Exists(destination)) { backup = destination + "." + Guid.NewGuid().ToString("N") + ".backup"; File.Copy(destination, backup); }
            File.Copy(sourcePath, destination, true);
            copied = true;
            var resumed = await target.RequestAsync("thread/resume", new JsonObject
            {
                ["threadId"] = threadId, ["cwd"] = thread["cwd"]?.DeepClone(),
                ["modelProvider"] = targetAccount == "primary" || store.Get(targetAccount).Kind != "relay" ? "openai" : ProviderRuntime.ProviderId(store.Get(targetAccount)),
                ["model"] = targetAccount != "primary" && store.Get(targetAccount).Kind == "relay" ? store.Get(targetAccount).Model : null,
            }, cancellation);
            if (resumed?["thread"]?["id"]?.GetValue<string>() != threadId) throw new IOException("THREAD_ID_CHANGED");
            ownership.Set(threadId, owner with { AccountId = targetAccount });
            committed = true;
            Outgoing?.Invoke(null, new JsonObject { ["method"] = "thread/started", ["params"] = new JsonObject { ["thread"] = resumed!["thread"]!.DeepClone() } });
        }
        finally
        {
            if (!committed)
            {
                // A target may already own the copied rollout after a late storage failure.
                if (copied)
                {
                    await ReleaseAsync(target, threadId, CancellationToken.None);
                    if (backup is not null) File.Move(backup, destination, true);
                    else File.Delete(destination);
                }
                await source.RequestAsync("thread/resume", new JsonObject { ["threadId"] = threadId }, CancellationToken.None);
            }
            if (backup is not null && committed) File.Delete(backup);
        }
    }

    private static string NormalizeHistoryPath(string path)
    {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path[8..];
        else if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path[4..];
        if (!Path.IsPathFullyQualified(path)) throw new IOException("THREAD_PATH_UNTRUSTED");
        return Path.GetFullPath(path);
    }

    private static string HistoryRelativePath(string home, string path)
    {
        var relative = Path.GetRelativePath(home, NormalizeHistoryPath(path));
        if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative) ||
            !(relative.StartsWith("sessions" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
              relative.StartsWith("archived_sessions" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)))
            throw new IOException("THREAD_PATH_UNTRUSTED");
        return relative;
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

    private static void RejectLinks(string root, string file)
    {
        for (var current = file; current is not null; current = Path.GetDirectoryName(current))
        {
            if ((File.Exists(current) || Directory.Exists(current)) && File.GetAttributes(current).HasFlag(FileAttributes.ReparsePoint))
                throw new IOException("THREAD_PATH_UNTRUSTED");
            if (Path.GetFullPath(current).Equals(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)) return;
        }
        throw new IOException("THREAD_PATH_UNTRUSTED");
    }

    private async Task<JsonNode> ListAsync(JsonObject parameters, CancellationToken cancellation)
    {
        // Use an immutable snapshot cursor so changing accounts cannot shift subsequent pages.
        if (parameters["cursor"]?.GetValue<string>() is { Length: > 0 } cursor)
            return NextPage(cursor, "catalog");
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
        }
        var sort = parameters["sortKey"]?.GetValue<string>() == "created_at" ? "createdAt" : "updatedAt";
        var ordered = parameters["sortDirection"]?.GetValue<string>() == "asc"
            ? items.Values.OrderBy(item => item[sort]?.GetValue<long>() ?? 0).ThenBy(item => item["id"]!.GetValue<string>())
            : items.Values.OrderByDescending(item => item[sort]?.GetValue<long>() ?? 0).ThenBy(item => item["id"]!.GetValue<string>());
        return Page(ordered.ToArray(), 0, Math.Clamp(parameters["limit"]?.GetValue<int>() ?? 50, 1, 500));
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

    public async ValueTask DisposeAsync()
    {
        await Task.WhenAll(backends.Values.Select(backend => backend.DisposeAsync().AsTask()));
        foreach (var gate in threadLocks.Values) gate.Dispose();
        startup.Dispose();
    }
}
