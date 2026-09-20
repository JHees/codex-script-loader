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
