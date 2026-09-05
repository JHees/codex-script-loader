using System.IO.Compression;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task TestRuntimeRegressionsAsync(string testRoot)
    {
        foreach (var wire in new[] { Encoding.UTF8.GetBytes(new string('x', 65537) + "\n"), new byte[] { 0xff, 0x0a } })
        {
            var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, Guid.NewGuid().ToString("N")));
            var pipeName = $"CodexScriptLoader.Tests.{Guid.NewGuid():N}";
            await using var server = SingleInstanceCoordinator.Create(paths, pipeName);
            await using var client = SingleInstanceCoordinator.Create(paths, pipeName);
            var reload = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            server.CommandReceived += _ => reload.TrySetResult();
            server.StartServer();
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await using (var raw = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly))
            {
                await raw.ConnectAsync(1000, limit.Token);
                await raw.WriteAsync(wire, limit.Token);
                try { await HostCommandProtocol.ReadBoundedUtf8Async(raw, true, limit.Token); } catch (IOException) { }
            }
            await client.SendCommandAsync("ReloadScripts", limit.Token);
            await reload.Task.WaitAsync(limit.Token);
            True(true, "Malformed wire input does not stop the command listener");
        }

        {
            var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "concurrent-pipe"));
            var pipeName = $"CodexScriptLoader.Tests.{Guid.NewGuid():N}";
            await using var server = SingleInstanceCoordinator.Create(paths, pipeName);
            await using var client = SingleInstanceCoordinator.Create(paths, pipeName);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var reload = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            server.HostCommandReceived = async (_, token) => { entered.TrySetResult(); await release.Task.WaitAsync(token); return JsonSerializer.SerializeToElement(new { }); };
            server.CommandReceived += _ => reload.TrySetResult();
            server.StartServer();
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            foreach (var request in new[]
            {
                new HostCommandRequest(1, null!, "plugin_invoke", "local.example", "wait", JsonSerializer.SerializeToElement(new { })),
                new HostCommandRequest(1, new string('x', 65000), "plugin_invoke", "local.example", "wait", JsonSerializer.SerializeToElement(new { })),
            })
            {
                await using var raw = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await raw.ConnectAsync(1000, limit.Token);
                await raw.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request, HostCommandProtocol.JsonOptions) + "\n"), limit.Token);
                var response = JsonSerializer.Deserialize<HostCommandResponse>(await HostCommandProtocol.ReadBoundedUtf8Async(raw, true, limit.Token), HostCommandProtocol.JsonOptions)!;
                Equal("INVALID_REQUEST", response.Error!.Code, "Malformed request ids produce bounded errors");
            }
            var pending = client.SendHostCommandAsync(new(1, "pending", "plugin_invoke", "local.example", "wait", JsonSerializer.SerializeToElement(new { })), limit.Token);
            try
            {
                await entered.Task.WaitAsync(limit.Token);
                await client.SendCommandAsync("ReloadScripts", limit.Token);
                await reload.Task.WaitAsync(limit.Token);
                True(!pending.IsCompleted, "Legacy reload is handled while a plugin request is waiting");
            }
            finally { release.TrySetResult(); await pending; }
            server.HostCommandReceived = (_, _) => Task.FromResult(JsonSerializer.SerializeToElement(new { text = new string('x', 65536) }));
            var oversized = await client.SendHostCommandAsync(new(1, "oversized", "plugin_invoke", "local.example", "wait", JsonSerializer.SerializeToElement(new { })), limit.Token);
            Equal("RESULT_TOO_LARGE", oversized.Error!.Code, "Oversized plugin output is not misreported as an invalid request");
        }

        {
            var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "preserved-config"));
            paths.EnsureDirectories();
            await CreateTestPluginAsync(paths, "local.example");
            const string original = "{\"scripts\": BROKEN";
            await File.WriteAllTextAsync(paths.ConfigPath, original);
            var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
            await registry.InitializeAsync();
            await ThrowsAsync<InvalidDataException>(() => registry.SetEnabledAsync("local.example", false), "An invalid config cannot be overwritten by a toggle");
            Equal(original, await File.ReadAllTextAsync(paths.ConfigPath), "Invalid config bytes are preserved");
        }

        {
            var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "invalid-manifest-types"));
            paths.EnsureDirectories();
            await CreateTestPluginAsync(paths, "local.good");
            await CreateTestPluginAsync(paths, "local.bad");
            await File.WriteAllTextAsync(Path.Combine(paths.ScriptsRoot, "local.bad", "manifest.json"), "{\"id\":\"local.bad\",\"permissions\":[1]}");
            var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
            await registry.InitializeAsync();
            Equal("local.good", (await registry.BuildPlanAsync(false)).Scripts.Single().Id, "Malformed manifest does not block a valid plugin");
            Equal("invalid", (await registry.ListPluginsAsync()).Single(item => item.Id == "local.bad").Status, "Malformed manifest is listed as invalid");
        }

        {
            var paths = LoaderPaths.FromRoot(Path.Combine(testRoot, "serialized-removal"));
            var registry = new ScriptRegistry(paths, Path.Combine(AppContext.BaseDirectory, "fixtures", "settings-host.mjs"));
            await registry.InitializeAsync();
            await CreateTestPluginAsync(paths, "local.example", updateAware: true);
            var candidate = LoaderPaths.FromRoot(Path.Combine(testRoot, "serialized-candidate"));
            await CreateTestPluginAsync(candidate, "local.example", version: "1.1.0", updateAware: true);
            var zip = Path.Combine(testRoot, "serialized-candidate.zip");
            ZipFile.CreateFromDirectory(Path.Combine(candidate.ScriptsRoot, "local.example"), zip);
            var descriptor = await ScriptRegistry.LoadDescriptorAsync(Path.Combine(paths.ScriptsRoot, "local.example"));
            var preview = await registry.StageUpdatePackageAsync(zip, descriptor.Id, "1.1.0", descriptor.Update!, await UpdatePackageVerifier.ComputeSha256Async(zip));
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var updating = registry.ApplyPendingUpdateAsync(preview.Token, preview.CurrentFingerprint,
                async token => { entered.TrySetResult(); await release.Task.WaitAsync(token); }, _ => Task.CompletedTask, limit.Token);
            await entered.Task.WaitAsync(limit.Token);
            var removing = registry.QuarantineAsync(descriptor.Id, limit.Token);
            try { True(!removing.IsCompleted, "Removal waits for an active package transaction"); }
            finally { release.TrySetResult(); await updating; await removing; }
            True(!Directory.Exists(descriptor.Directory), "A removed plugin stays removed after update completion");
        }
    }
}
