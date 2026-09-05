using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using CodexScriptLoader.Core;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task TestHostCommandReloadAsync(string testRoot)
    {
        var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "host-command-reload"));
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        await CreateTestPluginAsync(paths, "local.command-example");
        var manifestPath = Path.Combine(paths.ScriptsRoot, "local.command-example", "manifest.json");
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(manifestPath))!;
        manifest["hostCommands"] = new JsonObject { ["operations"] = new JsonArray("wait") };
        await File.WriteAllTextAsync(manifestPath, manifest.ToJsonString());

        using var portProbe = new TcpListener(IPAddress.Loopback, 0);
        portProbe.Start();
        var port = ((IPEndPoint)portProbe.LocalEndpoint).Port;
        portProbe.Stop();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var connections = new List<Task>();
        async Task ServeAsync(HttpListenerContext context)
        {
            if (!context.Request.IsWebSocketRequest)
            {
                var bytes = JsonSerializer.SerializeToUtf8Bytes(new[] { new CdpTarget("fixture", "page", "app://-/index.html", $"ws://127.0.0.1:{port}/renderer") });
                context.Response.ContentType = "application/json";
                await context.Response.OutputStream.WriteAsync(bytes, limit.Token);
                context.Response.Close();
                return;
            }
            using var socket = (await context.AcceptWebSocketAsync(null)).WebSocket;
            var buffer = new byte[65536];
            try
            {
                while (socket.State == WebSocketState.Open)
                {
                    using var message = new MemoryStream();
                    WebSocketReceiveResult frame;
                    do
                    {
                        frame = await socket.ReceiveAsync(buffer, limit.Token);
                        if (frame.MessageType == WebSocketMessageType.Close) return;
                        await message.WriteAsync(buffer.AsMemory(0, frame.Count), limit.Token);
                    } while (!frame.EndOfMessage);
                    using var document = JsonDocument.Parse(message.ToArray());
                    var root = document.RootElement;
                    var method = root.GetProperty("method").GetString();
                    if (method == "Runtime.evaluate" && root.GetProperty("params").TryGetProperty("awaitPromise", out var promise) && promise.GetBoolean())
                    {
                        entered.TrySetResult(); // Deliberately leave only the plugin Promise unresolved.
                        continue;
                    }
                    object result = method == "Page.addScriptToEvaluateOnNewDocument"
                        ? new { identifier = "fixture-registration" }
                        : new { result = new { value = new[] { new { id = "local.command-example", status = "running" } } } };
                    var reply = JsonSerializer.SerializeToUtf8Bytes(new { id = root.GetProperty("id").GetInt32(), result });
                    await socket.SendAsync(reply, WebSocketMessageType.Text, true, limit.Token);
                }
            }
            catch (WebSocketException) { }
            catch (OperationCanceledException) when (limit.IsCancellationRequested) { }
        }
        var accepting = Task.Run(async () =>
        {
            try { while (!limit.IsCancellationRequested) connections.Add(ServeAsync(await listener.GetContextAsync().WaitAsync(limit.Token))); }
            catch (OperationCanceledException) when (limit.IsCancellationRequested) { }
        });
        try
        {
            var client = new CdpClient(port);
            using var logger = new JsonlLogger(paths.LogsRoot);
            await using var supervisor = new LiveSupervisor(paths, logger);
            // Fixture-only attachment avoids Store activation and uses no running Codex process.
            void Attach(string field, object value) => typeof(LiveSupervisor).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(supervisor, value);
            Attach("registry", registry);
            Attach("client", client);
            Attach("injector", new CdpInjector(client));
            Attach("bridge", new LoaderHostBridge(client, (_, _, _) => Task.FromResult<object>(new { })));
            Attach("scripts", new ScriptLoadResult[] { new("local.command-example", "1.0.0", "fixture", "granted", "running", null) });
            var request = new HostCommandRequest(1, "pending", "plugin_invoke", "local.command-example", "wait", JsonSerializer.SerializeToElement(new { }));
            var pending = supervisor.InvokeHostCommandAsync(request, limit.Token);
            await entered.Task.WaitAsync(limit.Token);
            try { await supervisor.InvokeHostCommandAsync(request, limit.Token); throw new InvalidOperationException("Expected busy response."); }
            catch (HostCommandException exception) { Equal("COMMAND_BUSY", exception.Code, "Only one plugin invocation may be active"); }
            await supervisor.ReloadAsync(limit.Token);
            Equal(LoaderState.Healthy, supervisor.State, "Reload finishes while the old plugin Promise has no reply");
            try { await pending; throw new InvalidOperationException("Expected session loss."); }
            catch (HostCommandException exception) { Equal("SESSION_LOST", exception.Code, "Reload invalidates the pending host invocation"); }
        }
        finally
        {
            limit.Cancel();
            await accepting;
            await Task.WhenAll(connections);
        }
    }
}
