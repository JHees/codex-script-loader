using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed class BackendRpcException(int code) : Exception($"Official backend request failed ({code}).")
{
    public int Code { get; } = code;
    internal JsonObject? Payload { get; init; }
}

public sealed class OfficialBackend : IAsyncDisposable
{
    private readonly Process process;
    private readonly SemaphoreSlim writeLock = new(1);
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonNode?>> pending = new();
    private readonly Task reader, stderr;
    private long nextId;
    private int disposed;
    private volatile Exception? terminalFailure;
    public event Action<JsonObject>? Notification;
    public event Action<JsonObject>? ServerRequest;
    public event Action<Exception>? Disconnected;

    public OfficialBackend(ProcessStartInfo start)
    {
        process = Process.Start(start) ?? throw new InvalidOperationException("Unable to start the official backend.");
        stderr = process.StandardError.BaseStream.CopyToAsync(Stream.Null);
        reader = ReadAsync();
    }

    public static ProcessStartInfo LoginStartInfo(string executable, string hash, string home)
    {
        using (var file = File.OpenRead(executable))
            if (!string.Equals(Convert.ToHexString(SHA256.HashData(file)), hash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The official CLI changed. Refresh the executable baseline.");
        if (!Path.IsPathFullyQualified(home) || !Directory.Exists(home)) throw new ArgumentException("Account home is unavailable.");
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = home,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false)
        };
        foreach (var argument in new[] { "-c", "cli_auth_credentials_store=\"file\"", "-c", "mcp_oauth_credentials_store=\"file\"", "app-server" })
            start.ArgumentList.Add(argument);
        start.Environment["CODEX_HOME"] = home;
        start.Environment["CODEX_SQLITE_HOME"] = Path.Combine(home, "sqlite");
        start.Environment["CODEX_CLI_PATH"] = executable;
        foreach (var key in new[] { "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_LOADER_TRANSPORT_PROBE_CONFIG" }) start.Environment.Remove(key);
        return start;
    }

    public async Task InitializeAsync(CancellationToken cancellation = default)
    {
        await RequestAsync("initialize", new JsonObject
        {
            ["clientInfo"] = new JsonObject { ["name"] = "codex_account_switcher", ["version"] = BackendService.Version },
            ["capabilities"] = new JsonObject { ["experimentalApi"] = true }
        }, cancellation);
        await SendAsync(new JsonObject { ["method"] = "initialized" }, cancellation);
    }

    public async Task<JsonNode?> RequestAsync(string method, JsonNode? parameters, CancellationToken cancellation = default)
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        var id = Interlocked.Increment(ref nextId);
        var completion = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        try
        {
            if (terminalFailure is { } failure) throw failure;
            await SendAsync(new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters?.DeepClone() }, cancellation);
            return await completion.Task.WaitAsync(TimeSpan.FromSeconds(45), cancellation);
        }
        finally { pending.TryRemove(id, out _); }
    }

    private async Task SendAsync(JsonObject message, CancellationToken cancellation)
    {
        await writeLock.WaitAsync(cancellation);
        try { await process.StandardInput.WriteLineAsync(message.ToJsonString().AsMemory(), cancellation); await process.StandardInput.FlushAsync(cancellation); }
        finally { writeLock.Release(); }
    }

    public Task ReplyAsync(JsonObject message, CancellationToken cancellation = default) => SendAsync(message, cancellation);

    private async Task ReadAsync()
    {
        Exception failure = new IOException("Official backend disconnected.");
        try
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                if (JsonNode.Parse(line) is not JsonObject message) throw new InvalidDataException("Invalid backend protocol frame.");
                if (message["method"] is not null)
                {
                    if (message["id"] is not null)
                    {
                        if (ServerRequest is { } handler) handler(message);
                        else await SendAsync(new JsonObject { ["id"] = message["id"]!.DeepClone(), ["error"] = new JsonObject { ["code"] = -32601, ["message"] = "No interactive task is running in the account login client." } }, CancellationToken.None);
                    }
                    else Notification?.Invoke(message);
                }
                else if (message["id"]?.GetValue<long>() is var id && id.HasValue && pending.TryRemove(id.Value, out var completion))
                {
                    if (message["error"] is JsonObject error) completion.TrySetException(new BackendRpcException(error["code"]?.GetValue<int>() ?? -1) { Payload = (JsonObject)error.DeepClone() });
                    else completion.TrySetResult(message["result"]?.DeepClone());
                }
            }
        }
        catch (Exception error) when (error is IOException or InvalidDataException or System.Text.Json.JsonException or InvalidOperationException or ObjectDisposedException)
        { failure = new IOException("Official backend protocol ended unexpectedly."); }
        finally
        {
            terminalFailure = failure;
            try { if (disposed == 0) Disconnected?.Invoke(failure); }
            finally { foreach (var entry in pending.Values) entry.TrySetException(failure); }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        try { process.StandardInput.Close(); }
        catch (Exception error) when (error is IOException or ObjectDisposedException) { }
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3)); }
        catch (TimeoutException) { if (!process.HasExited) process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
        await Task.WhenAll(reader, stderr);
        process.Dispose();
        writeLock.Dispose();
    }
}
