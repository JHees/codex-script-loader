using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

internal sealed class AccountRpc : IAsyncDisposable
{
    private readonly StreamReader reader;
    private readonly StreamWriter writer;
    private readonly SemaphoreSlim writing = new(1);
    private readonly CancellationTokenSource stopped = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> pending = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> incoming = new();
    private readonly ConcurrentDictionary<long, Task> handlers = new();
    private readonly Func<string, JsonObject, CancellationToken, Task<JsonNode?>> handle;
    private readonly int limit;
    private long sequence;
    public Task Completion { get; }

    public AccountRpc(Stream input, Stream output, Func<string, JsonObject, CancellationToken, Task<JsonNode?>> handle, int limit = 2 * 1024 * 1024)
    {
        reader = new(input, new UTF8Encoding(false), false, 8192, leaveOpen: true);
        writer = new(output, new UTF8Encoding(false), 8192, leaveOpen: true);
        this.handle = handle; this.limit = limit;
        Completion = Task.Run(ReadAsync);
    }

    public async Task<JsonNode?> CallAsync(string method, JsonObject? parameters = null, CancellationToken cancellation = default)
    {
        var id = Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        try
        {
            if (stopped.IsCancellationRequested) throw new IOException("ACCOUNT_BACKEND_DISCONNECTED");
            await SendAsync(new() { ["id"] = id, ["method"] = method, ["params"] = parameters?.DeepClone() ?? new JsonObject() }, cancellation);
            try { return await completion.Task.WaitAsync(cancellation); }
            catch (OperationCanceledException)
            {
                if (!stopped.IsCancellationRequested) await SendAsync(new() { ["method"] = "cancel", ["params"] = new JsonObject { ["requestId"] = id } }, CancellationToken.None);
                throw;
            }
        }
        finally { pending.TryRemove(id, out _); }
    }

    public Task NotifyAsync(string method, JsonObject parameters) => SendAsync(new() { ["method"] = method, ["params"] = parameters }, stopped.Token);

    private async Task SendAsync(JsonObject frame, CancellationToken cancellation)
    {
        var line = frame.ToJsonString();
        if (Encoding.UTF8.GetByteCount(line) > limit) throw new IOException("ACCOUNT_BACKEND_MESSAGE_TOO_LARGE");
        await writing.WaitAsync(cancellation);
        try { await writer.WriteLineAsync(line.AsMemory(), cancellation); await writer.FlushAsync(cancellation); }
        finally { writing.Release(); }
    }

    private async Task ReadAsync()
    {
        try
        {
            while (await reader.ReadLineAsync(stopped.Token) is { } line)
            {
                if (Encoding.UTF8.GetByteCount(line) > limit) throw new IOException("ACCOUNT_BACKEND_MESSAGE_TOO_LARGE");
                var frame = JsonNode.Parse(line)!.AsObject();
                var key = frame["id"]?.ToJsonString();
                if (frame["method"]?.GetValue<string>() is { } method)
                {
                    var parameters = frame["params"] as JsonObject ?? new();
                    if (method == "cancel")
                    {
                        var requestId = parameters["requestId"]?.ToJsonString();
                        if (requestId is not null && incoming.TryGetValue(requestId, out var cancellation)) cancellation.Cancel();
                        continue;
                    }
                    var number = Interlocked.Increment(ref sequence);
                    handlers[number] = Task.Run(() => DispatchAsync(frame["id"]?.DeepClone(), key, method, parameters));
                    foreach (var completed in handlers.Where(pair => pair.Value.IsCompleted)) handlers.TryRemove(completed.Key, out _);
                }
                else if (frame["id"]?.GetValue<string>() is { } id && pending.TryRemove(id, out var reply))
                {
                    if (frame["error"] is not null) reply.TrySetException(new InvalidOperationException(frame["error"]!["code"]?.GetValue<string>() ?? "ACCOUNT_BACKEND_FAILED"));
                    else reply.TrySetResult(frame["result"]?.DeepClone());
                }
            }
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException or System.Text.Json.JsonException or InvalidOperationException) { }
        finally
        {
            stopped.Cancel();
            foreach (var cancellation in incoming.Values) cancellation.Cancel();
            foreach (var reply in pending.Values) reply.TrySetException(new IOException("ACCOUNT_BACKEND_DISCONNECTED"));
        }
    }

    private async Task DispatchAsync(JsonNode? id, string? key, string method, JsonObject parameters)
    {
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(stopped.Token);
        if (key is not null) incoming[key] = cancellation;
        try
        {
            var result = await handle(method, parameters, cancellation.Token);
            if (id is not null) await SendAsync(new() { ["id"] = id, ["result"] = result }, stopped.Token);
        }
        catch (Exception error)
        {
            if (id is not null && !stopped.IsCancellationRequested)
            {
                var code = error is InvalidOperationException && error.Message.Length <= 64 && error.Message.All(character => character is >= 'A' and <= 'Z' or '_')
                    ? error.Message : error is OperationCanceledException ? "ACCOUNT_BACKEND_CANCELLED" : "ACCOUNT_BACKEND_FAILED";
                try { await SendAsync(new() { ["id"] = id, ["error"] = new JsonObject { ["code"] = code } }, stopped.Token); }
                catch (Exception failure) when (failure is IOException or OperationCanceledException or ObjectDisposedException) { }
            }
        }
        finally { if (key is not null) incoming.TryRemove(key, out _); }
    }

    public async ValueTask DisposeAsync()
    {
        stopped.Cancel();
        reader.BaseStream.Dispose();
        await Completion;
        await Task.WhenAll(handlers.Values);
        reader.Dispose();
        try { writer.Dispose(); } catch (Exception error) when (error is IOException or ObjectDisposedException) { }
        writing.Dispose(); stopped.Dispose();
    }
}
