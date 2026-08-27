using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json.Serialization;
using CodexScriptLoader.Interop;

namespace CodexScriptLoader.ActivationProbe;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var discoverOnly = args.Contains("--discover-only", StringComparer.OrdinalIgnoreCase);
        try
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.WriteLine("Codex Script Loader Activation Probe v0.5.1");
            var package = PackageDiscovery.DiscoverCodexForCurrentUser();
            Write("package.fullName", package.PackageFullName);
            Write("package.family", package.PackageFamilyName);
            Write("package.applicationId", package.ApplicationId);
            Write("package.aumid", package.AppUserModelId);
            Write("package.version", package.Version);
            Write("package.architecture", package.Architecture);
            var existing = ProcessIdentity.FindProcessesByPackageFamily(package.PackageFamilyName);
            Write("package.existingProcessCount", existing.Count);
            if (discoverOnly)
            {
                Write("result", "DISCOVERY_PASS");
                return 0;
            }

            if (existing.Count > 0)
            {
                throw new InvalidOperationException(
                    "Codex is already running. Close every Codex window and wait for all package processes to exit before running the activation gate.");
            }

            var port = AllocateLoopbackPort();
            var activationPid = ApplicationActivator.Activate(package,
            [
                "--remote-debugging-address=127.0.0.1",
                $"--remote-debugging-port={port}",
                $"--remote-allow-origins=http://127.0.0.1:{port}",
            ]);
            Write("activation.pid", activationPid);
            Write("cdp.port", port);

            var targets = await WaitForTargetsAsync(port, TimeSpan.FromSeconds(20)).ConfigureAwait(false);
            var listeners = TcpOwnerLookup.GetIPv4LoopbackListeners(port);
            if (listeners.Count == 0)
            {
                throw new InvalidOperationException("No loopback CDP listener was found.");
            }

            foreach (var listener in listeners)
            {
                var ownerFamily = ProcessIdentity.TryGetPackageFamilyName(listener.ProcessId);
                Write("cdp.ownerPid", listener.ProcessId);
                Write("cdp.ownerFamily", ownerFamily ?? "<none>");
                if (!string.Equals(ownerFamily, package.PackageFamilyName, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("CDP listener owner does not belong to the discovered Codex package.");
                }
            }

            var codexTargets = targets.Where(target =>
                string.Equals(target.Type, "page", StringComparison.Ordinal) &&
                string.Equals(target.Url, "app://-/index.html", StringComparison.Ordinal) &&
                IsLoopbackWebSocket(target.WebSocketDebuggerUrl, port)).ToArray();
            Write("cdp.targetCount", codexTargets.Length);
            if (codexTargets.Length == 0)
            {
                throw new InvalidOperationException("CDP is reachable but no exact Codex renderer target exists.");
            }

            Write("result", "ACTIVATION_PASS");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"result=FAIL");
            Console.Error.WriteLine($"error.type={exception.GetType().Name}");
            Console.Error.WriteLine($"error.message={Sanitize(exception.Message)}");
            return 1;
        }
    }

    private static int AllocateLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }

    private static async Task<IReadOnlyList<CdpTarget>> WaitForTargetsAsync(int port, TimeSpan timeout)
    {
        using var client = new HttpClient
        {
            BaseAddress = new Uri($"http://127.0.0.1:{port}/"),
            Timeout = TimeSpan.FromSeconds(2),
        };
        var deadline = DateTimeOffset.UtcNow + timeout;
        Exception? lastError = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            try
            {
                var targets = await client.GetFromJsonAsync<CdpTarget[]>("json").ConfigureAwait(false);
                if (targets is { Length: > 0 })
                {
                    return targets;
                }
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
            {
                lastError = exception;
            }

            await Task.Delay(250).ConfigureAwait(false);
        }

        throw new TimeoutException("Codex CDP did not become ready within 20 seconds.", lastError);
    }

    private static bool IsLoopbackWebSocket(string endpoint, int port) =>
        Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) &&
        uri.Scheme is "ws" or "wss" && uri.Port == port && IPAddress.TryParse(uri.Host, out var address) && IPAddress.IsLoopback(address);

    private static string Sanitize(string value)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return string.IsNullOrEmpty(home) ? value : value.Replace(home, "[user-profile]", StringComparison.OrdinalIgnoreCase);
    }

    private static void Write(string key, object? value) => Console.WriteLine($"{key}={value}");

    private sealed record CdpTarget(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("webSocketDebuggerUrl")] string WebSocketDebuggerUrl);
}
