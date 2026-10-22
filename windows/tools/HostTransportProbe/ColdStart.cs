using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Principal;
using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;

namespace CodexScriptLoader.HostTransportProbe;

internal static class ColdStart
{
    internal static async Task<int> RunAsync(string configPath)
    {
        var config = await ProbeConfig.LoadAsync(configPath);
        var reportPath = Path.Combine(config.RunDirectory, "activation.json");
        var activated = false;
        var debugCleared = false;
        var debugRequested = false;
        var debugEnabled = false;
        var port = 0;
        var pid = 0;
        string? errorType = null;
        string? errorHResult = null, nativeOperation = null, cleanupErrorHResult = null;
        var stage = "preflight";
        string? failureStage = null;
        Exception? failure = null;
        var success = false;
        try
        {
            if (!string.Equals(Path.GetFullPath(configPath), ProbeConfig.DefaultConfigPath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Use the baseline/config.json beside this published probe.");
            using var identity = WindowsIdentity.GetCurrent();
            if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("Run the probe from a normal, non-administrator terminal.");
            var package = PackageDiscovery.DiscoverCodexForCurrentUser();
            if (package.PackageFullName != config.PackageFullName) throw new InvalidOperationException("Codex was updated after capture. Prepare a new probe baseline.");
            if (ProcessIdentity.FindProcessesByPackageFamily(package.PackageFamilyName).Count != 0)
                throw new InvalidOperationException("Close all Codex windows before running this probe. No running instance will be stopped.");
            foreach (var key in new[] { "CODEX_CLI_PATH", "CODEX_APP_SERVER_WS_URL", "CODEX_APP_SERVER_FORCE_CLI", ProbeConfig.ConfigVariable })
                if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key))) throw new InvalidOperationException($"Existing {key} conflicts with this isolated probe.");
            foreach (var key in new[] { "CODEX_HOME", "CODEX_SQLITE_HOME" })
                if (Environment.GetEnvironmentVariable(key) is { Length: > 0 } value && value != config.BackendEnvironment[key])
                    throw new InvalidOperationException($"Existing {key} differs from the captured official backend.");
            if (Directory.EnumerateFiles(config.RunDirectory, "relay-*.json").Any() || Directory.EnumerateFiles(config.RunDirectory, "resumed-*.json").Any())
                throw new InvalidOperationException("This probe baseline has already been used. Prepare a fresh run directory.");
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            stage = "creating-debug-session";
            using (var lease = new PackageDebugLease(package.PackageFullName))
            {
                try
                {
                    debugRequested = true;
                    stage = "enabling-package-debugging";
                    await WriteReport("ACTIVATING");
                    var environment = new Dictionary<string, string> { ["CODEX_CLI_PATH"] = ProbeConfig.Executable, [ProbeConfig.ConfigVariable] = Path.GetFullPath(configPath) };
                    foreach (var key in new[] { "CODEX_HOME", "CODEX_SQLITE_HOME" })
                        if (config.BackendEnvironment[key] is { } value) environment[key] = value;
                    lease.Enable(config.DebuggerCommandLine, environment);
                    debugEnabled = true;
                    stage = "activating-package";
                    await WriteReport("ACTIVATING");
                    pid = ApplicationActivator.Activate(package,
                    ["--remote-debugging-address=127.0.0.1", $"--remote-debugging-port={port}", $"--remote-allow-origins=http://127.0.0.1:{port}"]);
                    activated = true;
                    stage = "waiting-for-debugger-resume";
                    await WaitUntil(async () =>
                    {
                        var resumed = await AtomicJsonFile.ReadAsync<JsonElement?>(Path.Combine(config.RunDirectory, $"resumed-{pid}.json"));
                        return resumed?.GetProperty("resumed").GetBoolean() == true;
                    }, TimeSpan.FromSeconds(20));
                }
                catch (Exception error) { failure = error; failureStage = stage; throw; }
                finally
                {
                    try { lease.Clear(); debugCleared = true; }
                    catch (Exception error)
                    {
                        cleanupErrorHResult = $"0x{error.HResult:X8}";
                        failure ??= error;
                        failureStage ??= "clearing-package-debugging";
                        throw;
                    }
                }
            }
            stage = "waiting-for-renderer";
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            await WaitUntil(async () =>
            {
                var owners = TcpOwnerLookup.GetIPv4LoopbackListeners(port);
                if (owners.Count != 1 || ProcessSnapshot.PackageFullName(owners[0].ProcessId) != package.PackageFullName) return false;
                var targets = await http.GetFromJsonAsync<JsonElement[]>($"http://127.0.0.1:{port}/json");
                return targets?.Any(target => target.GetProperty("type").GetString() == "page" && target.GetProperty("url").GetString() == "app://-/index.html") == true;
            }, TimeSpan.FromSeconds(30));
            stage = "waiting-for-backend-initialize";
            await WaitUntil(async () =>
            {
                foreach (var path in Directory.EnumerateFiles(config.RunDirectory, "relay-*.json"))
                {
                    var relay = await AtomicJsonFile.ReadAsync<RelayReport>(path);
                    if (relay is { AppServer: true, State: "running", Counts.InitializeSucceeded: true }) return true;
                }
                return false;
            }, TimeSpan.FromSeconds(30));
            stage = "complete";
            success = true;
            await WriteReport("TRANSPORT_STARTUP_PASS");
            return 0;
        }
        catch (Exception error)
        {
            failure ??= error;
            failureStage ??= stage;
            errorType = failure.GetType().Name;
            errorHResult = $"0x{failure.HResult:X8}";
            nativeOperation = failure.Data["nativeOperation"] as string;
            Console.Error.WriteLine($"{failureStage}: {errorType} ({errorHResult}): {failure.Message}");
            if (cleanupErrorHResult != null) Console.Error.WriteLine($"Package debugging cleanup also failed ({cleanupErrorHResult}).");
            await WriteReport("FAIL");
            return 1;
        }
        Task WriteReport(string result) => AtomicJsonFile.WriteAsync(reportPath, new
        {
            result, package = config.PackageFullName, activated, activationPid = pid, cdpPort = port,
            debugRequested, debugEnabled, debugCleared, officialBackendHash = config.OfficialCliSha256,
            stage, failureStage, errorType, errorHResult, nativeOperation, cleanupErrorHResult,
            interactiveValidationPending = success, multiAccountEnabled = false
        });
    }

    private static async Task WaitUntil(Func<Task<bool>> condition, TimeSpan duration)
    {
        var deadline = DateTime.UtcNow + duration;
        while (DateTime.UtcNow < deadline)
        {
            try { if (await condition()) return; }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException or IOException) { }
            await Task.Delay(250);
        }
        throw new TimeoutException("The cold-start verification step timed out; inspect activation.json and relay reports.");
    }
}
