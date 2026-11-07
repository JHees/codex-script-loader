using System.Diagnostics;
using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;
using CodexScriptLoader.Windows;

namespace CodexScriptLoader.Tests;

internal static partial class Program
{
    private static async Task<int> RunMsixAcceptanceAsync(string family, string root)
    {
        if (!family.StartsWith("CodexScriptLoader.Test.Msix_", StringComparison.Ordinal))
            throw new InvalidOperationException("Only the isolated MSIX test family is allowed.");
        root = Path.GetFullPath(root);
        var paths = LoaderPaths.FromRoot(Path.Combine(root, "loader-data"));
        paths.EnsureDirectories();
        using var logger = new JsonlLogger(paths.LogsRoot);
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(6));
        await using var supervisor = new LiveSupervisor(paths, logger, () => PackageDiscovery.DiscoverForCurrentUser(family));
        var recovered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var recovering = 0;
        supervisor.ManagedCodexExited += reason =>
        {
            if (reason != ManagedCodexExitReason.PackageUpdated) { recovered.TrySetException(new InvalidOperationException("Loader treated the test update as an ordinary exit.")); return; }
            if (Interlocked.Exchange(ref recovering, 1) != 0) return;
            _ = Task.Run(async () =>
            {
                try { await supervisor.RecoverAfterUpdateAsync(timeout.Token); recovered.TrySetResult(); }
                catch (Exception exception) { recovered.TrySetException(exception); }
            });
        };
        try
        {
            await supervisor.StartAsync(timeout.Token);
            var before = supervisor.Snapshot;
            var endpoint = before.Cdp ?? throw new InvalidOperationException("Fixture has no managed endpoint.");
            if (before.State != LoaderState.Healthy || !before.Scripts.Any(script => script.LifecycleResult == "running"))
                throw new InvalidOperationException("Initial Loader injection did not become healthy.");
            using var client = new CdpClient(endpoint.Port);
            async Task<JsonElement> Evaluate(string expression)
            {
                var target = (await client.GetCodexTargetsAsync(timeout.Token)).Single();
                await using var session = await CdpSession.ConnectAsync(new Uri(target.WebSocketDebuggerUrl), timeout.Token);
                var result = await session.SendAsync("Runtime.evaluate", new { expression, awaitPromise = true, returnByValue = true }, timeout.Token);
                if (result.TryGetProperty("exceptionDetails", out var exception)) throw new InvalidOperationException(exception.ToString());
                return result.GetProperty("result").GetProperty("value").Clone();
            }
            if (!(await Evaluate("globalThis.__codexScriptLoaderHostBridge?.lifecycleObserver === undefined")).GetBoolean())
                throw new InvalidOperationException("Unexpected renderer update observer.");
            Console.WriteLine($"MSIX_INITIAL_HEALTHY pid={endpoint.OwnerPid} port={endpoint.Port} scripts={before.Scripts.Count}");
            using (var original = Process.GetProcessById(endpoint.OwnerPid))
            {
                var remaining = TimeSpan.FromSeconds(65) - (DateTime.Now - original.StartTime);
                if (remaining > TimeSpan.Zero)
                {
                    Console.WriteLine("Waiting for the Windows minimum restart lifetime...");
                    await Task.Delay(remaining, timeout.Token);
                }
            }
            var deploy = new ProcessStartInfo("pwsh") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-File", Path.Combine(root, "deploy.ps1"), "-PackagePath", Path.Combine(root, "fixture-2.msix"), "-Family", family })
                deploy.ArgumentList.Add(argument);
            using (var installer = Process.Start(deploy)!)
            {
                var output = installer.StandardOutput.ReadToEndAsync(timeout.Token);
                var error = installer.StandardError.ReadToEndAsync(timeout.Token);
                await installer.WaitForExitAsync(timeout.Token);
                if (installer.ExitCode != 0) throw new InvalidOperationException(await error);
                Console.WriteLine("MSIX_DEPLOYED " + (await output).Trim());
            }
            await recovered.Task.WaitAsync(TimeSpan.FromMinutes(2), timeout.Token);
            var after = supervisor.Snapshot;
            if (after.Cdp?.Port != endpoint.Port || after.Cdp.OwnerPid == endpoint.OwnerPid || after.State != LoaderState.Healthy)
                throw new InvalidOperationException("Loader did not reconnect to a healthy replacement on the inherited port.");
            if (PackageDiscovery.DiscoverForCurrentUser(family).Version != new Version(2, 0, 0, 0)) throw new InvalidOperationException("Test package version did not advance.");
            var renderer = await Evaluate("({version:globalThis.fixtureVersion,errors:globalThis.__codexScriptLoader.errors.length,scripts:Object.values(globalThis.__codexScriptLoader.scripts).map(s=>s.status)})");
            if (renderer.GetProperty("version").GetString() != "2" || renderer.GetProperty("errors").GetInt32() != 0 ||
                renderer.GetProperty("scripts").EnumerateArray().Any(script => script.GetString() != "running"))
                throw new InvalidOperationException("The updated real renderer or plugin lifecycle was not healthy.");
            var launches = new List<JsonElement>();
            foreach (var path in Directory.EnumerateFiles(root, "launch-*.json"))
            {
                using var document = JsonDocument.Parse(await File.ReadAllTextAsync(path, timeout.Token));
                if (document.RootElement.GetProperty("version").GetString() == "2") launches.Add(document.RootElement.Clone());
            }
            if (launches.Count != 1 || launches[0].GetProperty("port").GetInt32() != endpoint.Port || launches[0].GetProperty("pid").GetInt32() != after.Cdp.OwnerPid)
                throw new InvalidOperationException("Version 2 was not started exactly once with the inherited port.");
            var registration = RestartRegistration.Read(after.Cdp.OwnerPid);
            if (!RestartRegistration.Matches(registration.Arguments, endpoint.Port)) throw new InvalidOperationException("Replacement restart registration was not restored.");
            var evidence = new { passed = true, family, oldVersion = "1.0.0.0", newVersion = "2.0.0.0", oldPid = endpoint.OwnerPid,
                newPid = after.Cdp.OwnerPid, port = endpoint.Port, firstLaunchCount = launches.Count, state = after.State.ToString(),
                renderer, restartFlags = registration.Flags, realCodexTouched = false };
            await AtomicJsonFile.WriteAsync(Path.Combine(root, "acceptance-result.json"), evidence, timeout.Token);
            Console.WriteLine(JsonSerializer.Serialize(evidence));
            Console.WriteLine("MSIX_UPDATE_ACCEPTANCE_PASS");
            return 0;
        }
        finally
        {
            if (!await supervisor.CloseManagedCodexAsync(CancellationToken.None, force: false))
                Console.Error.WriteLine("Fixture did not close normally; clean up only the isolated test package.");
        }
    }
}
