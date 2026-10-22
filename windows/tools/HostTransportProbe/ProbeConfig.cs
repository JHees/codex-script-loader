using System.Diagnostics;
using System.Security.Cryptography;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodexScriptLoader.Tests")]

namespace CodexScriptLoader.HostTransportProbe;

internal sealed record ProbeConfig(string PackageFullName, string OfficialCli, string OfficialCliSha256,
    Dictionary<string, string?> BackendEnvironment, bool SandboxService, string RunDirectory)
{
    internal const string ConfigVariable = "CODEX_LOADER_TRANSPORT_PROBE_CONFIG";
    internal static readonly string[] PreservedKeys = ["CODEX_WINDOWS_REGISTERED_CORE", "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY", "CODEX_HOME", "CODEX_SQLITE_HOME"];

    internal static string Executable => Path.Combine(AppContext.BaseDirectory, "CodexScriptLoader.HostTransportProbe.exe");
    internal static string DefaultConfigPath => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "baseline", "config.json"));
    internal string DebuggerCommandLine => $"\"{Executable}\"";

    internal static async Task CaptureAsync(int processId, string path)
    {
        var package = PackageDiscovery.DiscoverCodexForCurrentUser();
        using var process = Process.GetProcessById(processId);
        var snapshot = ProcessSnapshot.Read(processId, PreservedKeys);
        if (ProcessIdentity.TryGetPackageFamilyName(snapshot.ParentId) != package.PackageFamilyName
            || ProcessSnapshot.PackageFullName(snapshot.ParentId) != package.PackageFullName)
            throw new InvalidOperationException("The selected backend is not owned by the current Codex package.");
        var cli = process.MainModule?.FileName ?? throw new InvalidOperationException("Backend path unavailable.");
        if (Path.GetFileName(cli) != "codex.exe" || !snapshot.Arguments.Contains("app-server", StringComparer.Ordinal))
            throw new InvalidOperationException("The selected process is not the official app-server.");
        var runDirectory = Path.GetDirectoryName(Path.GetFullPath(path))!;
        if (File.Exists(path)) throw new IOException("A probe configuration already exists at this path.");
        var config = new ProbeConfig(package.PackageFullName, cli, Hash(cli), snapshot.Environment,
            snapshot.Arguments.Contains("features.windows_sandbox_service=true", StringComparer.Ordinal), runDirectory);
        await AtomicJsonFile.WriteAsync(path, config);
    }

    internal static async Task<ProbeConfig> LoadAsync(string path)
    {
        var config = await AtomicJsonFile.ReadAsync<ProbeConfig>(path) ?? throw new InvalidOperationException("Missing probe configuration.");
        if (!Path.IsPathFullyQualified(config.OfficialCli) || !File.Exists(config.OfficialCli)
            || string.Equals(Path.GetFullPath(config.OfficialCli), Executable, StringComparison.OrdinalIgnoreCase)
            || config.OfficialCliSha256 != Hash(config.OfficialCli)
            || !string.Equals(config.RunDirectory, Path.GetDirectoryName(Path.GetFullPath(path)), StringComparison.OrdinalIgnoreCase)
            || config.BackendEnvironment.Count != PreservedKeys.Length || PreservedKeys.Any(key => !config.BackendEnvironment.ContainsKey(key)))
            throw new InvalidOperationException("Probe baseline changed or is invalid. Prepare it again before activation.");
        return config;
    }

    internal ProcessStartInfo CreateBackendStartInfo(IEnumerable<string> arguments)
    {
        var start = new ProcessStartInfo(OfficialCli)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        if (SandboxService && TransparentRelay.IsAppServer(start.ArgumentList.ToArray())
            && !start.ArgumentList.Contains("features.windows_sandbox_service=true"))
        {
            if (start.ArgumentList.Any(argument => argument.StartsWith("features.windows_sandbox_service=", StringComparison.Ordinal)))
                throw new InvalidOperationException("The sandbox service override conflicts with the captured baseline.");
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add("features.windows_sandbox_service=true");
        }
        start.Environment.Remove(ConfigVariable);
        start.Environment["CODEX_CLI_PATH"] = OfficialCli;
        foreach (var key in PreservedKeys)
            if (BackendEnvironment[key] is { } value) start.Environment[key] = value;
            else start.Environment.Remove(key);
        return start;
    }

    private static string Hash(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }
}
