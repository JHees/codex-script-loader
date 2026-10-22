using CodexScriptLoader.Core;

namespace CodexScriptLoader.HostTransportProbe;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (DebuggerArguments(args) is { } target)
            {
                var config = await ProbeConfig.LoadAsync(ProbeConfig.DefaultConfigPath);
                await PackageDebugLease.ResumeAsync(config.PackageFullName, config.RunDirectory, target.ProcessId, target.ThreadId);
                return 0;
            }
            if (Environment.GetEnvironmentVariable(ProbeConfig.ConfigVariable) is { Length: > 0 } configPath)
                return await TransparentRelay.RunAsync(await ProbeConfig.LoadAsync(configPath), args);
            if (args.Length == 3 && args[0] == "--capture")
            { await ProbeConfig.CaptureAsync(int.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture), args[2]); return 0; }
            if (args.Length == 2 && args[0] == "--run") return await ColdStart.RunAsync(args[1]);
            if (args.Length == 2 && args[0] == "--cleanup")
            {
                var config = await AtomicJsonFile.ReadAsync<ProbeConfig>(args[1]) ?? throw new InvalidOperationException("Missing baseline.");
                var receipt = await AtomicJsonFile.ReadAsync<System.Text.Json.JsonElement>(Path.Combine(config.RunDirectory, "activation.json"));
                if (!receipt.GetProperty("debugRequested").GetBoolean() || receipt.GetProperty("package").GetString() != config.PackageFullName
                    || !System.Text.RegularExpressions.Regex.IsMatch(config.PackageFullName, @"^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$"))
                    throw new InvalidOperationException("This run did not request debugging for this package.");
                using var lease = new PackageDebugLease(config.PackageFullName);
                lease.Clear();
                await AtomicJsonFile.WriteAsync(Path.Combine(config.RunDirectory, "cleanup.json"), new { debugCleared = true });
                return 0;
            }
            throw new ArgumentException("Use the prepared Run-Probe.ps1 script. This tool never activates Codex without --run.");
        }
        catch (Exception error) { Console.Error.WriteLine($"HostTransportProbe: {error.GetType().Name}: {error.Message}"); return 1; }
    }

    internal static (int ProcessId, int ThreadId)? DebuggerArguments(string[] args)
    {
        if (args.Length != 4 || args[0] != "-p" || args[2] != "-tid") return null;
        if (!int.TryParse(args[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var pid) || pid <= 0
            || !int.TryParse(args[3], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var tid) || tid <= 0)
            throw new ArgumentException("Invalid debugger process/thread identifiers.");
        return (pid, tid);
    }
}
