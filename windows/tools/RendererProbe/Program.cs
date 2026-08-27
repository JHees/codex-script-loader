using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.RendererProbe;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        try
        {
            var port = int.Parse(Option(args, "--port") ?? throw new ArgumentException("--port is required."), System.Globalization.CultureInfo.InvariantCulture);
            var repositoryRoot = Path.GetFullPath(Option(args, "--repo-root") ?? Environment.CurrentDirectory);
            var paths = LoaderPaths.FromRoot(Path.Combine(repositoryRoot, ".runtime", "manual"));
            var registry = new ScriptRegistry(paths, Path.Combine(repositoryRoot, "src", "settings-host.mjs"));
            await registry.InitializeAsync();
            var plan = await registry.BuildPlanAsync(force: true);
            var expectedVersion = plan.Scripts.Single(script => script.Id == "co.bennett.ui-improvements").Version;

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
            await Task.Delay(2200);
            var second = await injector.InjectAsync(plan.Source, plan.Scripts, targets, CancellationToken.None);
            await Task.Delay(2200);

            await using var session = await CdpSession.ConnectAsync(new Uri(targets[0].WebSocketDebuggerUrl), CancellationToken.None);
            var evaluation = await session.SendAsync("Runtime.evaluate", new
            {
                expression = """
                (() => {
                  const lifecycle = globalThis.__bennettUiImprovementsBigPizza;
                  const settings = globalThis.__codexScriptLoader?.settingsHost?.snapshot?.();
                  return {
                    version: lifecycle?.version || null,
                    hasStop: typeof lifecycle?.stop === "function",
                    hasSetFeature: typeof lifecycle?.setFeature === "function",
                    features: Array.isArray(lifecycle?.features) ? lifecycle.features : [],
                    loaderStatus: globalThis.__codexScriptLoader?.scripts?.["co.bennett.ui-improvements"]?.status || null,
                    settings,
                    projectStyles: document.querySelectorAll("#codexpp-sidebar-project-backgrounds").length,
                    conversationStyles: document.querySelectorAll("#codexpp-sidebar-conversation-colors").length,
                    settingsStyles: document.querySelectorAll("#bennett-ui-settings-style").length,
                    loaderEntries: document.querySelectorAll('[data-codex-loader-settings="nav:loader:runtime"]').length,
                    pluginEntries: document.querySelectorAll('[data-codex-loader-settings="nav:co.bennett.ui-improvements:main"]').length,
                    loaderErrors: Array.isArray(globalThis.__codexScriptLoader?.errors) ? globalThis.__codexScriptLoader.errors.length : 0
                  };
                })()
                """,
                returnByValue = true,
            });
            var snapshot = evaluation.GetProperty("result").GetProperty("value");
            var version = snapshot.GetProperty("version").GetString();
            var loaderStatus = snapshot.GetProperty("loaderStatus").GetString();
            if (version != expectedVersion || loaderStatus != "running" || !snapshot.GetProperty("hasStop").GetBoolean() || !snapshot.GetProperty("hasSetFeature").GetBoolean())
            {
                throw new InvalidOperationException("Bennett lifecycle validation failed.");
            }

            foreach (var property in new[] { "projectStyles", "conversationStyles" })
            {
                var count = snapshot.GetProperty(property).GetInt32();
                if (count != 1)
                {
                    throw new InvalidOperationException($"Duplicate or missing renderer node: {property}={count}.");
                }
            }

            if (snapshot.GetProperty("settingsStyles").GetInt32() > 1 ||
                snapshot.GetProperty("loaderEntries").GetInt32() > 1 ||
                snapshot.GetProperty("pluginEntries").GetInt32() > 1)
            {
                throw new InvalidOperationException("Duplicate settings host nodes were found.");
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
