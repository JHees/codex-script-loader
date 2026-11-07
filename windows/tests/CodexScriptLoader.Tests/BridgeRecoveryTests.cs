using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task TestBridgeRecoveryAsync()
    {
        await using var server = new RecoveryCdpServer();
        using var client = new CdpClient(server.Port);
        await using var bridge = new LoaderHostBridge(client, (_, _, _) => Task.FromResult<object>(new { }));
        await bridge.SyncAsync([server.Target], server.Token);
        Equal(1, server.Connections, "Bridge initially attaches once");
        await bridge.SyncAsync([server.Target], server.Token);
        Equal(1, server.Connections, "Healthy bridge is retained");
        server.Disconnect();
        // Wait for the actual peer-close event before exercising the next monitor tick.
        await Task.Delay(100, server.Token);
        await bridge.SyncAsync([server.Target], server.Token);
        Equal(2, server.Connections, "Same renderer target reconnects after its bridge socket closes");
        server.ClientMissing = true;
        await bridge.SyncAsync([server.Target], server.Token);
        Equal(3, server.Connections, "Missing renderer bridge client is restored without changing target ID");
    }

    private static async Task TestMonitorTimeoutRecoveryAsync(string testRoot)
    {
        await using var server = new RecoveryCdpServer { TimeoutFirstTargetQuery = true };
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "monitor-recovery"));
        Directory.CreateDirectory(paths.LogsRoot);
        using var logger = new JsonlLogger(paths.LogsRoot);
        await using var supervisor = new LiveSupervisor(paths, logger);
        var client = new CdpClient(server.Port);
        void Attach(string field, object value) => typeof(LiveSupervisor).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(supervisor, value);
        Attach("client", client);
        Attach("bridge", new LoaderHostBridge(client, (_, _, _) => Task.FromResult<object>(new { })));
        supervisor.CommitHandoff();
        try { await server.Attached.Task.WaitAsync(TimeSpan.FromSeconds(8)); }
        catch (TimeoutException) { throw new InvalidOperationException("Monitor must continue after an HTTP target-query timeout and attach the bridge on the next tick."); }
        True(server.Queries >= 2, "Monitor retries target discovery after timeout");
    }

    private static async Task TestRendererRuntimeRecoveryAsync(string testRoot)
    {
        await using var server = new RecoveryCdpServer();
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "renderer-state-recovery"));
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        await registry.EnsureBundledScriptAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "example-ui-plugin"));
        var plan = await registry.BuildPlanAsync(false);
        server.RuntimeDescriptors = plan.Scripts;
        using var logger = new JsonlLogger(paths.LogsRoot);
        await using var supervisor = new LiveSupervisor(paths, logger);
        using var client = new CdpClient(server.Port);
        var bridge = new LoaderHostBridge(client, (_, _, _) => Task.FromResult<object>(new { }));
        void Attach(string field, object value) => typeof(LiveSupervisor).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(supervisor, value);
        Attach("client", client); Attach("bridge", bridge); Attach("registry", registry);
        Attach("injector", new CdpInjector(client)); Attach("injectedDescriptors", plan.Scripts);
        var method = typeof(LiveSupervisor).GetMethod("SyncRendererRuntimeAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        async Task Sync(IReadOnlyList<CdpTarget> targets)
        {
            await bridge.SyncAsync(targets, server.Token);
            await (Task)method.Invoke(supervisor, new object[] { targets, server.Token })!;
        }
        await Sync([server.Target]);
        Equal(1, server.Injections, "Missing runtime is injected even when bridge is connected");
        await Sync([server.Target]);
        Equal(1, server.Injections, "Healthy runtime is retained without reinjection");
        server.RuntimePresent.Clear();
        await Sync([server.Target]);
        Equal(2, server.Injections, "Same target with a replaced document restores its plugins");
        var detached = new CdpTarget("detached", "page", "app://-/detached-window.html?initialRoute=%2Fdetached-window", $"ws://127.0.0.1:{server.Port}/detached");
        await Sync([server.Target, detached]);
        Equal(3, server.Injections, "New chat window is injected without replacing the original window");
        Equal(2 * plan.Scripts.Count, supervisor.Snapshot.Scripts.Count, "Snapshot accounts for both runtime instances");
        await Sync([detached]);
        Equal(plan.Scripts.Count, supervisor.Snapshot.Scripts.Count, "Closed window is removed from live status");

        True(CodexRendererUrl.IsAllowed(detached.Url), "Native target policy accepts detached chat");
        True(!CodexRendererUrl.IsAllowed("app://-/index.html?initialRoute=%2Favatar-overlay"), "Native policy rejects avatar overlay");
        True(!CodexRendererUrl.IsAllowed("app://-/detached-window.html?initialRoute=%2Favatar-overlay"), "Detached page cannot request an overlay route");
        True(!CodexRendererUrl.IsAllowed("https://chatgpt.com/"), "External pages cannot become plugin targets");
    }

    private static async Task TestCommandWindowSelectionAsync()
    {
        await using var server = new RecoveryCdpServer();
        var main = server.Target;
        var detached = new CdpTarget("detached", "page", "app://-/detached-window.html", $"ws://127.0.0.1:{server.Port}/detached");
        var method = typeof(LiveSupervisor).GetMethod("SelectCommandTargetAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        async Task<CdpTarget> Select(string json) => await (Task<CdpTarget>)method.Invoke(null,
            new object[] { new CdpTarget[] { main, detached }, JsonSerializer.Deserialize<JsonElement>(json), server.Token })!;
        Equal(main, await Select("{}"), "Context-free command uses primary chat");
        Equal(main, await Select("{\"task\":null}"), "Malformed task context does not crash routing");
        const string payload = "{\"task\":{\"hostId\":\"local\",\"taskId\":\"fixture-task\"}}";
        server.CommandContexts["/renderer"] = new { matches = false, visible = true, focused = true };
        server.CommandContexts["/detached"] = new { matches = true, visible = true, focused = false };
        Equal(detached, await Select(payload), "Task context routes to detached chat instead of focused unrelated main");
        server.CommandContexts["/renderer"] = new { matches = true, visible = true, focused = true };
        Equal(main, await Select(payload), "Focused visible match wins for a task open in both windows");
        server.CommandContexts["/renderer"] = new { matches = true, visible = true, focused = false };
        try { await Select(payload); throw new InvalidOperationException("Ambiguous context must be rejected"); }
        catch (HostCommandException exception) { Equal("RENDERER_UNAVAILABLE", exception.Code, "Ambiguous windows fail without sending"); }
    }

    private sealed class RecoveryCdpServer : IAsyncDisposable
    {
        private readonly HttpListener listener = new();
        private readonly CancellationTokenSource limit = new(TimeSpan.FromSeconds(20));
        private readonly ConcurrentBag<Task> requests = [];
        private readonly Task accepting;
        private WebSocket? latest;
        public int Port { get; }
        public int Connections;
        public int Queries;
        public int Injections;
        public IReadOnlyList<ScriptDescriptor>? RuntimeDescriptors;
        public ConcurrentDictionary<string, bool> RuntimePresent { get; } = new();
        public ConcurrentDictionary<string, object> CommandContexts { get; } = new();
        public bool ClientMissing;
        public bool TimeoutFirstTargetQuery;
        public CancellationToken Token => limit.Token;
        public TaskCompletionSource Attached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public CdpTarget Target => new("fixture", "page", "app://-/index.html", $"ws://127.0.0.1:{Port}/renderer");

        public RecoveryCdpServer()
        {
            using var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            Port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
            listener.Start();
            accepting = Task.Run(async () =>
            {
                try { while (!Token.IsCancellationRequested) requests.Add(ServeAsync(await listener.GetContextAsync().WaitAsync(Token))); }
                catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
            });
        }

        public void Disconnect() => latest!.Abort();

        private async Task ServeAsync(HttpListenerContext context)
        {
            try
            {
                if (!context.Request.IsWebSocketRequest)
                {
                    if (Interlocked.Increment(ref Queries) == 1 && TimeoutFirstTargetQuery)
                    {
                        await Task.Delay(Timeout.Infinite, Token);
                        return;
                    }
                    context.Response.ContentType = "application/json";
                    await context.Response.OutputStream.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(new[] { Target }), Token);
                    context.Response.Close();
                    return;
                }
                using var socket = (await context.AcceptWebSocketAsync(null)).WebSocket;
                latest = socket;
                Interlocked.Increment(ref Connections);
                var buffer = new byte[65536];
                while (socket.State == WebSocketState.Open)
                {
                    using var message = new MemoryStream();
                    WebSocketReceiveResult frame;
                    do
                    {
                        frame = await socket.ReceiveAsync(buffer, Token);
                        if (frame.MessageType == WebSocketMessageType.Close) return;
                        message.Write(buffer, 0, frame.Count);
                    } while (!frame.EndOfMessage);
                    using var document = JsonDocument.Parse(message.ToArray());
                    var root = document.RootElement;
                    var method = root.GetProperty("method").GetString();
                    object result = method == "Page.addScriptToEvaluateOnNewDocument"
                        ? new { identifier = "registration" }
                        : new { result = new { value = !ClientMissing } };
                    if (method == "Runtime.evaluate" && RuntimeDescriptors is not null)
                    {
                        var expression = root.GetProperty("params").GetProperty("expression").GetString() ?? "";
                        var path = context.Request.Url!.AbsolutePath;
                        if (expression.Contains("return {hosts:", StringComparison.Ordinal))
                        {
                            var present = RuntimePresent.ContainsKey(path);
                            result = new { result = new { value = new { hosts = present, scripts = RuntimeDescriptors.Select(descriptor =>
                                new { id = descriptor.Id, status = present ? "running" : "missing", hash = present ? descriptor.Fingerprint : "" }).ToArray() } } };
                        }
                        else if (expression.Contains("runtime.runtimeVersion =", StringComparison.Ordinal))
                        {
                            RuntimePresent[path] = true;
                            Interlocked.Increment(ref Injections);
                            result = new { result = new { value = RuntimeDescriptors.Select(descriptor => new { id = descriptor.Id, status = "running" }).ToArray() } };
                        }
                    }
                    if (method == "Runtime.evaluate" && CommandContexts.TryGetValue(context.Request.Url!.AbsolutePath, out var commandContext))
                        result = new { result = new { value = commandContext } };
                    if (method == "Runtime.addBinding") ClientMissing = false;
                    await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { id = root.GetProperty("id").GetInt32(), result }), WebSocketMessageType.Text, true, Token);
                    if (method == "Runtime.evaluate") Attached.TrySetResult();
                }
            }
            catch (WebSocketException) { }
            catch (OperationCanceledException) { }
            catch (HttpListenerException) when (Token.IsCancellationRequested) { }
            finally { context.Response.Close(); }
        }

        public async ValueTask DisposeAsync()
        {
            limit.Cancel();
            await accepting;
            await Task.WhenAll(requests);
            listener.Close();
            limit.Dispose();
        }
    }
}
