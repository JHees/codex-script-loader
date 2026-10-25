using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public interface IAccountRouterControl : IAsyncDisposable
{
    bool CanStop { get; }
    bool Connected { get; }
    bool HistoryShared { get; }
    string? HistoryError { get; }
    bool AccountBusy(string id);
    int BoundCount(string id);
    GlobalAccountStatus GlobalStatus { get; }
    void RetryGlobalSwitch();
    object ThreadStatus(string id);
    Task<object> ListThreadsAsync(string? query, int limit, CancellationToken cancellation);
    Task SwitchAsync(string id, string accountId, CancellationToken cancellation, bool pinned = false);
    Task<AccountEntry> ReadAccountAsync(string id, CancellationToken cancellation);
    Task LoginAsync(string id, Func<LoginPrompt, Task> prompt, CancellationToken cancellation);
}

internal sealed class RemoteAccountRouter(Func<AccountRpc> connection) : IAccountRouterControl
{
    private readonly ConcurrentDictionary<string, Func<LoginPrompt, Task>> prompts = new();
    private T Read<T>(string method, JsonObject? parameters = null) => connection().CallAsync("router/" + method, parameters)
        .GetAwaiter().GetResult()!.Deserialize<T>(AccountStore.JsonOptions)!;
    public bool CanStop => Read<bool>("can_stop");
    public bool Connected => Read<bool>("connected");
    public bool HistoryShared => Read<bool>("history_shared");
    public string? HistoryError => Read<string>("history_error") is { Length: > 0 } value ? value : null;
    public bool AccountBusy(string id) => Read<bool>("account_busy", new() { ["id"] = id });
    public int BoundCount(string id) => Read<int>("bound_count", new() { ["id"] = id });
    public GlobalAccountStatus GlobalStatus => Read<GlobalAccountStatus>("global_status");
    public object ThreadStatus(string id) => Read<JsonObject>("thread_status", new() { ["id"] = id });
    public async Task<object> ListThreadsAsync(string? query, int limit, CancellationToken cancellation) =>
        (await connection().CallAsync("router/list_threads", new() { ["query"] = query, ["limit"] = limit }, cancellation))!;
    public void RetryGlobalSwitch() => Read<bool>("retry_global");
    public async Task SwitchAsync(string id, string accountId, CancellationToken cancellation, bool pinned = false) =>
        await connection().CallAsync("router/switch", new() { ["id"] = id, ["accountId"] = accountId, ["pinned"] = pinned }, cancellation);
    public async Task<AccountEntry> ReadAccountAsync(string id, CancellationToken cancellation) =>
        (await connection().CallAsync("router/read_account", new() { ["id"] = id }, cancellation))!.Deserialize<AccountEntry>(AccountStore.JsonOptions)!;
    public async Task LoginAsync(string id, Func<LoginPrompt, Task> prompt, CancellationToken cancellation)
    {
        var callback = Guid.NewGuid().ToString("N"); prompts[callback] = prompt;
        try { await connection().CallAsync("router/login", new() { ["id"] = id, ["callback"] = callback }, cancellation); }
        finally { prompts.TryRemove(callback, out _); }
    }
    public async Task<JsonNode?> HandleAsync(string method, JsonObject parameters)
    {
        if (method != "login_prompt") throw new InvalidOperationException("ACCOUNT_OPERATION_DENIED");
        if (prompts.TryGetValue(parameters["callback"]!.GetValue<string>(), out var prompt))
            await prompt(parameters["prompt"]!.Deserialize<LoginPrompt>(AccountStore.JsonOptions)!);
        return null;
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
