using System.Reflection;
using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task<int> RunRendererRecoveryAsync(int port, string root)
    {
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        using var client = new CdpClient(port);
        var main = (await client.GetCodexTargetsAsync(limit.Token)).Single(target => target.Url == "app://-/index.html");
        await using (var probe = await CdpSession.ConnectAsync(new Uri(main.WebSocketDebuggerUrl), limit.Token))
        {
            var matched = false;
            for (var attempt = 0; attempt < 30; attempt++)
            {
                var result = await probe.SendAsync("Runtime.evaluate", new { expression = "document.documentElement?.dataset.loaderFixture", returnByValue = true }, limit.Token);
                if (result.GetProperty("result").TryGetProperty("value", out var marker) && marker.GetString() == "renderer-regression") { matched = true; break; }
                await Task.Delay(100, limit.Token);
            }
            if (!matched) throw new InvalidOperationException("Refusing a non-fixture page.");
        }
        var paths = LoaderPaths.FromRoot(Path.Combine(root, "data"));
        var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
        await registry.InitializeAsync();
        await registry.EnsureBundledScriptAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "example-ui-plugin"));
        var plan = await registry.BuildPlanAsync(false);
        using var logger = new JsonlLogger(paths.LogsRoot);
        await using var supervisor = new LiveSupervisor(paths, logger);
        var bridge = new LoaderHostBridge(client, (_, _, _) => Task.FromResult<object>(new { }));
        void Attach(string field, object value) => typeof(LiveSupervisor).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(supervisor, value);
        Attach("client", client); Attach("bridge", bridge); Attach("registry", registry);
        Attach("injector", new CdpInjector(client)); Attach("injectedDescriptors", plan.Scripts);
        var method = typeof(LiveSupervisor).GetMethod("SyncRendererRuntimeAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        async Task Sync()
        {
            var targets = await client.GetCodexTargetsAsync(limit.Token);
            await bridge.SyncAsync(targets, limit.Token);
            await (Task)method.Invoke(supervisor, new object[] { targets, limit.Token })!;
            if (supervisor.State != LoaderState.Healthy) throw new InvalidOperationException("Runtime is not healthy.");
        }
        async Task<JsonElement> Read(CdpTarget target, string expression)
        {
            await using var session = await CdpSession.ConnectAsync(new Uri(target.WebSocketDebuggerUrl), limit.Token);
            var result = await session.SendAsync("Runtime.evaluate", new { expression, returnByValue = true }, limit.Token);
            return result.GetProperty("result").GetProperty("value").Clone();
        }
        const string stamp = "(() => {const s=globalThis.__codexScriptLoader.scripts['dev.codex-script-loader.example-ui'];return s.fixtureInstance ??= crypto.randomUUID()})()";
        await Sync();
        var original = (await Read(main, stamp)).ToString();
        await File.WriteAllTextAsync(Path.Combine(root, "add-window"), "1", limit.Token);
        IReadOnlyList<CdpTarget> windows;
        do { await Task.Delay(100, limit.Token); windows = await client.GetCodexTargetsAsync(limit.Token); } while (windows.Count != 2);
        await Sync();
        var detached = windows.Single(target => target.Url != main.Url);
        var detachedStamp = (await Read(detached, stamp)).ToString();
        if (original != (await Read(main, stamp)).ToString()) throw new InvalidOperationException("Adding a window restarted the original plugin.");
        await using (var session = await CdpSession.ConnectAsync(new Uri(main.WebSocketDebuggerUrl), limit.Token))
        {
            await session.SendAsync("Page.enable", cancellationToken: limit.Token);
            await session.SendAsync("Page.navigate", new { url = "app://-/index.html" }, limit.Token);
        }
        await Task.Delay(300, limit.Token);
        await Sync();
        if (original == (await Read(main, stamp)).ToString()) throw new InvalidOperationException("Main plugin did not recover after navigation.");
        if (detachedStamp != (await Read(detached, stamp)).ToString()) throw new InvalidOperationException("Recovery restarted the other window's plugin.");
        var excluded = (await client.GetPageTargetsAsync("app://-", limit.Token)).Single(target => target.Url.Contains("avatar-overlay", StringComparison.Ordinal));
        if (!(await Read(excluded, "typeof globalThis.__codexScriptLoader === 'undefined'")).GetBoolean()) throw new InvalidOperationException("Overlay was injected.");
        Console.WriteLine("LIVE_RENDERER_RECOVERY_PASS two_windows=true unrelated_instance_preserved=true navigation_recovered=true overlay_excluded=true");
        await using var browser = await CdpSession.ConnectAsync(await client.GetBrowserEndpointAsync(limit.Token), limit.Token);
        try { await browser.SendAsync("Browser.close", cancellationToken: limit.Token); } catch (IOException) { }
        return 0;
    }
}
