using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record RouterConnection(string PipeName, string Token, int OwnerProcessId);

public sealed class RouterHost : IAccountRouterControl
{
    private readonly AccountStore store;
    private readonly ThreadOwnership ownership;
    private readonly string connectionPath;
    private readonly RouterConnection connection = new("CodexAccountRouter-" + Guid.NewGuid().ToString("N"),
        Convert.ToHexString(RandomNumberGenerator.GetBytes(32)), Environment.ProcessId);
    private readonly CancellationTokenSource stop = new();
    private readonly ConcurrentDictionary<string, Peer> peers = new();
    private readonly ConcurrentDictionary<string, Task> sessions = new();
    private readonly SemaphoreSlim initialization = new(1);
    private readonly Task listener;
    private readonly Task globalRouting;
    private AccountRouter? router;
    private HistoryLayout? sharedHistory;
    private string? historyError;
    private string[]? launchArguments;
    private volatile bool configurationLocked;
    private FileStream? lease;
    public bool CanStop => router?.CanStop != false;
    public bool Connected => router?.IsConnected == true;
    public bool HistoryShared => sharedHistory is not null;
    public string? HistoryError => historyError;
    public bool AccountBusy(string id) => router?.AccountBusy(id) == true;
    public int BoundCount(string accountId) => ownership.BoundTo(accountId).Length;
    public GlobalAccountStatus GlobalStatus => router?.GlobalStatus() ?? new(store.DefaultAccountId, 0, 0, 0);
    public void RetryGlobalSwitch() => router?.RetryGlobalSwitch();
    public object ThreadStatus(string id) => router?.Status(id) ?? new { threadId = id, accountId = ownership.Get(id).AccountId, busy = false, switching = false, connected = false };
    public async Task<object> ListThreadsAsync(string? query, int limit, CancellationToken cancellation) =>
        await (await LockConfigurationAsync(cancellation)).ListThreadsAsync(query, limit, cancellation);
    public async Task SwitchAsync(string id, string accountId, CancellationToken cancellation, bool pinned = false) =>
        // An explicit per-thread switch away from the global account is a deliberate model choice.
        await (await LockConfigurationAsync(cancellation)).SwitchAsync(id, accountId, cancellation, pinned || accountId != store.DefaultAccountId);
    public async Task<AccountEntry> ReadAccountAsync(string id, CancellationToken cancellation) =>
        await (await LockConfigurationAsync(cancellation)).ReadAccountAsync(id, cancellation);
    public async Task LoginAsync(string id, Func<LoginPrompt, Task> prompt, CancellationToken cancellation) =>
        await (await LockConfigurationAsync(cancellation)).LoginAsync(id, prompt, cancellation);

    private async Task<AccountRouter> LockConfigurationAsync(CancellationToken cancellation)
    {
        await initialization.WaitAsync(cancellation);
        try
        {
            var current = router ?? throw new InvalidOperationException("ROUTER_NOT_CONNECTED");
            configurationLocked = true;
            return current;
        }
        finally { initialization.Release(); }
    }

    public RouterHost(AccountStore store, string directory)
    {
        this.store = store;
        ownership = new(directory);
        connectionPath = Path.Combine(directory, "router-connection.json");
        // A single owner prevents separate desktop connections from opening competing account writers.
        lease = new FileStream(Path.Combine(directory, "router.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        File.WriteAllText(connectionPath, JsonSerializer.Serialize(connection, AccountStore.JsonOptions));
        listener = ListenAsync();
        // Chats follow the default lazily on their next turn; do not migrate them in the background.
        globalRouting = Task.CompletedTask;
        var primaryHome = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (string.IsNullOrEmpty(primaryHome)) primaryHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        try { sharedHistory = HistoryLayout.Migrate(store, directory, primaryHome, Environment.GetEnvironmentVariable("CODEX_SQLITE_HOME")); }
        catch (Exception error)
        {
            // Keep the previous isolated layout rather than leaving a half-migrated store.
            historyError = error.Message;
            sharedHistory = null;
        }
    }

    private async Task ListenAsync()
    {
        while (!stop.IsCancellationRequested)
        {
            var pipe = new NamedPipeServerStream(connection.PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try { await pipe.WaitForConnectionAsync(stop.Token); }
            catch { await pipe.DisposeAsync(); if (stop.IsCancellationRequested) break; throw; }
            var id = Guid.NewGuid().ToString("N");
            sessions[id] = ServeAsync(id, pipe);
            foreach (var done in sessions.Where(pair => pair.Value.IsCompleted)) sessions.TryRemove(done.Key, out _);
        }
    }

    private async Task ServeAsync(string id, NamedPipeServerStream pipe)
    {
        await using var peer = new Peer(pipe);
        using var disconnected = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
        var requests = new List<Task>();
        try
        {
            using var authTimeout = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
            authTimeout.CancelAfter(TimeSpan.FromSeconds(10));
            var hello = await peer.ReadAsync(authTimeout.Token);
            var token = hello?["token"]?.GetValue<string>() ?? "";
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(connection.Token)))
                throw new InvalidDataException("ROUTER_AUTHENTICATION_FAILED");
            var args = hello!["arguments"]!.AsArray().Select(value => value!.GetValue<string>()).ToArray();
            if (args.Length > 256 || args.Any(value => value.Length > 32768) || !IsInteractiveServer(args))
                throw new InvalidDataException("ROUTER_ARGUMENTS_INVALID");
            await initialization.WaitAsync(stop.Token);
            try
            {
                if (router is not null && !launchArguments!.SequenceEqual(args, StringComparer.Ordinal))
                {
                    // Desktop bootstrap reads config before the main client adds its launch overrides.
                    if (configurationLocked || !router.CanStop) throw new InvalidOperationException("ROUTER_ARGUMENTS_CHANGED");
                    await router.DisposeAsync();
                    router = null;
                }
                if (router is null)
                {
                    var home = Environment.GetEnvironmentVariable("CODEX_HOME");
                    if (string.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
                    var factory = new RouterBackendFactory(store, OfficialCliLocator.Find(), home,
                        Environment.GetEnvironmentVariable("CODEX_SQLITE_HOME"), args,
                        hello["packageFamily"]?.GetValue<string>(), sharedHistory);
                    router = new AccountRouter(store, ownership, factory.Start, factory.Home);
                    router.Outgoing += Publish;
                    launchArguments = args;
                }
                peers[id] = peer;
            }
            finally { initialization.Release(); }
            await peer.SendAsync(new JsonObject { ["ready"] = true }, stop.Token);
            while (await peer.ReadAsync(stop.Token) is { } message)
            {
                var task = HandleAsync(id, peer, message, disconnected.Token);
                requests.Add(task);
                requests.RemoveAll(item => item.IsCompleted);
                if (requests.Count >= 128) await Task.WhenAny(requests);
            }
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or InvalidOperationException or JsonException or ArgumentException) { }
        finally
        {
            disconnected.Cancel();
            try { await Task.WhenAll(requests); }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { }
            await initialization.WaitAsync();
            try
            {
                peers.TryRemove(id, out _);
                if (router is not null) await router.DetachAsync(id);
                // No desktop owns these writers after the last CLI connection closes.
                if (peers.IsEmpty && router is not null)
                {
                    await router.DisposeAsync();
                    router = null;
                    launchArguments = null;
                    configurationLocked = false;
                }
            }
            finally { initialization.Release(); }
        }
    }

    private async Task HandleAsync(string id, Peer peer, JsonObject message, CancellationToken cancellation)
    {
        var gateHeld = false;
        try
        {
            await initialization.WaitAsync(cancellation);
            gateHeld = true;
            configurationLocked |= message["method"]?.GetValue<string>() is not
                ("initialize" or "initialized" or "config/read" or "configRequirements/read" or
                 "experimentalFeature/list" or "account/read" or "getAuthStatus" or "model/list");
            if (configurationLocked) { initialization.Release(); gateHeld = false; }
            var reply = await router!.HandleAsync(id, message, cancellation);
            if (reply is not null) await peer.SendAsync(reply, cancellation);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or InvalidOperationException) { peer.Disconnect(); }
        finally { if (gateHeld) initialization.Release(); }
    }

    private void Publish(string? client, JsonObject message)
    {
        foreach (var pair in peers)
            if (client is null || pair.Key == client) pair.Value.Enqueue(message);
    }

    public static bool IsInteractiveServer(IReadOnlyList<string> arguments)
    {
        var index = 0;
        while (index + 1 < arguments.Count && arguments[index] is "-c" or "--config") index += 2;
        if (index >= arguments.Count || arguments[index] != "app-server") return false;
        // 26.1021 added a one-shot startup probe before the interactive app-server.
        // It must reach the official CLI unchanged or the desktop stalls on
        // "organization settings could not be loaded".
        return !arguments.Skip(index + 1).Any(value => value is "generate-json-schema" or "generate-ts" or "--help" or "-h" or "--print-startup-config");
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        foreach (var peer in peers.Values) peer.Disconnect();
        try { await listener; } catch (OperationCanceledException) { }
        await globalRouting;
        await Task.WhenAll(sessions.Values);
        if (router is not null) await router.DisposeAsync();
        if (File.Exists(connectionPath)) File.Delete(connectionPath);
        lease?.Dispose(); lease = null;
        initialization.Dispose(); stop.Dispose();
    }

    internal sealed class Peer(Stream stream) : IAsyncDisposable
    {
        private readonly StreamReader reader = new(stream, new UTF8Encoding(false), false, 8192, true);
        private readonly StreamWriter writer = new(stream, new UTF8Encoding(false), 8192, true);
        private readonly SemaphoreSlim writing = new(1);
        private readonly System.Threading.Channels.Channel<JsonObject> outgoing =
            System.Threading.Channels.Channel.CreateBounded<JsonObject>(new System.Threading.Channels.BoundedChannelOptions(1024)
            { SingleReader = true, FullMode = System.Threading.Channels.BoundedChannelFullMode.Wait });
        private Task? pumping;
        public async Task<JsonObject?> ReadAsync(CancellationToken cancellation)
        {
            var line = await reader.ReadLineAsync(cancellation);
            if (line is null) return null;
            if (line.Length > 16 * 1024 * 1024) throw new InvalidDataException("ROUTER_MESSAGE_TOO_LARGE");
            return JsonNode.Parse(line)?.AsObject() ?? throw new InvalidDataException("ROUTER_MESSAGE_INVALID");
        }
        public async Task SendAsync(JsonObject message, CancellationToken cancellation)
        {
            await writing.WaitAsync(cancellation);
            try { await writer.WriteLineAsync(message.ToJsonString().AsMemory(), cancellation); await writer.FlushAsync(cancellation); }
            finally { writing.Release(); }
        }
        public void Enqueue(JsonObject message)
        {
            lock (outgoing)
            {
                pumping ??= PumpAsync();
                if (!outgoing.Writer.TryWrite((JsonObject)message.DeepClone())) Disconnect();
            }
        }
        private async Task PumpAsync()
        {
            try { await foreach (var message in outgoing.Reader.ReadAllAsync()) await SendAsync(message, CancellationToken.None); }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { Disconnect(); }
        }
        public void Disconnect() { outgoing.Writer.TryComplete(); stream.Dispose(); }
        public async ValueTask DisposeAsync()
        {
            Disconnect();
            if (pumping is not null) await pumping;
            reader.Dispose();
            try { writer.Dispose(); } catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            writing.Dispose();
        }
    }
}
