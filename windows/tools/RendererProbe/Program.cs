using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.RendererProbe;

internal static class Program
{
    private const string ExampleId = "dev.codex-script-loader.example-ui";

    private static async Task<int> Main(string[] args)
    {
        try
        {
            var port = int.Parse(Option(args, "--port") ?? throw new ArgumentException("--port is required."), System.Globalization.CultureInfo.InvariantCulture);
            var repositoryRoot = Path.GetFullPath(Option(args, "--repo-root") ?? Environment.CurrentDirectory);
            var paths = LoaderPaths.FromRoot(Path.Combine(repositoryRoot, ".runtime", "manual"));
            var registry = new ScriptRegistry(paths, Path.Combine(repositoryRoot, "src", "settings-host.mjs"));
            await registry.InitializeAsync();
            await registry.EnsureBundledScriptAsync(Path.Combine(repositoryRoot, "packages", "example-ui-plugin"));
            var plan = await registry.BuildPlanAsync(force: true);
            var expectedVersion = plan.Scripts.Single(script => script.Id == ExampleId).Version;

            var listeners = TcpOwnerLookup.GetIPv4LoopbackListeners(port);
            if (listeners.Count != 1)
            {
                throw new InvalidOperationException("Expected exactly one loopback listener on the supplied port.");
            }

            var family = ProcessIdentity.TryGetPackageFamilyName(listeners[0].ProcessId);
            if (!string.Equals(family, PackageDiscovery.CodexPackageFamilyName, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Renderer listener owner package is not Codex.");
            }

            using var client = new CdpClient(port);
            var targets = await client.GetCodexTargetsAsync(CancellationToken.None);
            if (targets.Count != 1)
            {
                throw new InvalidOperationException($"Expected one exact renderer target, found {targets.Count}.");
            }

            await using var bridge = new LoaderHostBridge(client, (command, _, _) => Task.FromResult<object>(new
            {
                loader = "healthy",
                codex = "healthy",
                cdp = "healthy",
                safeMode = plan.SafeMode,
                managedProcess = true,
                targetCount = targets.Count,
                enabledScripts = plan.Scripts.Count,
                failedScripts = 0,
                configHealthy = true,
                scope = "renderer-plugins-only",
                command,
            }));
            await bridge.SyncAsync(targets, CancellationToken.None);
            var injector = new CdpInjector(client);
            var first = await injector.InjectAsync(plan.Source, plan.Scripts, targets, CancellationToken.None);
            await Task.Delay(600);
            var second = await injector.InjectAsync(plan.Source, plan.Scripts, targets, CancellationToken.None);
            await Task.Delay(600);

            await using var session = await CdpSession.ConnectAsync(new Uri(targets[0].WebSocketDebuggerUrl), CancellationToken.None);
            var evaluation = await session.SendAsync("Runtime.evaluate", new
            {
                expression = """
                (() => {
                  const lifecycle = globalThis.__codexScriptLoaderExampleUi;
                  return {
                    version: lifecycle?.version || null,
                    hasStop: typeof lifecycle?.stop === "function",
                    hasSetBadgeEnabled: typeof lifecycle?.setBadgeEnabled === "function",
                    loaderStatus: globalThis.__codexScriptLoader?.scripts?.["dev.codex-script-loader.example-ui"]?.status || null,
                    styles: document.querySelectorAll("#codex-script-loader-example-ui-style").length,
                    badges: document.querySelectorAll("#codex-script-loader-example-ui-badge").length,
                    loaderEntries: document.querySelectorAll('[data-codex-loader-settings="nav:loader:runtime"]').length,
                    pluginEntries: document.querySelectorAll('[data-codex-loader-settings="nav:dev.codex-script-loader.example-ui:main"]').length,
                    loaderErrors: Array.isArray(globalThis.__codexScriptLoader?.errors) ? globalThis.__codexScriptLoader.errors.length : 0
                  };
                })()
                """,
                returnByValue = true,
            });
            var snapshot = evaluation.GetProperty("result").GetProperty("value");
            var version = snapshot.GetProperty("version").GetString();
            var loaderStatus = snapshot.GetProperty("loaderStatus").GetString();
            if (version != expectedVersion ||
                loaderStatus != "running" ||
                !snapshot.GetProperty("hasStop").GetBoolean() ||
                !snapshot.GetProperty("hasSetBadgeEnabled").GetBoolean())
            {
                throw new InvalidOperationException("Example plugin lifecycle validation failed.");
            }

            foreach (var property in new[] { "styles", "badges", "loaderEntries", "pluginEntries" })
            {
                var count = snapshot.GetProperty(property).GetInt32();
                if (count > 1)
                {
                    throw new InvalidOperationException($"Duplicate renderer node: {property}={count}.");
                }
            }

            Console.WriteLine(JsonSerializer.Serialize(new
            {
                result = "RENDERER_PASS",
                packageFamily = family,
                port,
                targetCount = targets.Count,
                first,
                second,
                snapshot,
            }, new JsonSerializerOptions { WriteIndented = true }));
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new { result = "FAIL", type = exception.GetType().Name, error = JsonlLogger.Redact(exception.Message) }));
            return 1;
        }
    }

    private static string? Option(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }
}
