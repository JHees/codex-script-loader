using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;
using CodexScriptLoader.Accounts;

namespace CodexScriptLoader.Windows;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--accounts-backend")
        {
            try { Environment.ExitCode = BackendService.RunAsync().GetAwaiter().GetResult(); }
            catch { Environment.ExitCode = 1; }
            return;
        }
        if (args.Length == 4 && args[0] == "-p" && args[2] == "-tid")
        {
            try
            {
                var helperPaths = LoaderPaths.ForProduction();
                var launch = AtomicJsonFile.ReadAsync<AccountLaunch>(AccountModule.LaunchPath(helperPaths)).GetAwaiter().GetResult()
                    ?? throw new InvalidDataException("Missing desktop launch context.");
                var pid = int.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture);
                PackageEnvironmentLease.Resume(launch.PackageFamilyName, pid, int.Parse(args[3], System.Globalization.CultureInfo.InvariantCulture));
                AtomicJsonFile.WriteAsync(Path.Combine(helperPaths.StateRoot, $"desktop-cli-resumed-{pid}.json"), new { resumed = true }).GetAwaiter().GetResult();
            }
            catch { Environment.ExitCode = 1; }
            return;
        }
        if (Environment.GetEnvironmentVariable(AccountModule.EnvironmentVariable) == "1")
        {
            try
            {
                var modulePaths = LoaderPaths.ForProduction();
                var launch = AtomicJsonFile.ReadAsync<AccountLaunch>(AccountModule.LaunchPath(modulePaths)).GetAwaiter().GetResult()
                    ?? throw new InvalidDataException("Account launch context is unavailable.");
                var enabled = AtomicJsonFile.ReadAsync<AccountModulePreferences>(AccountModule.PreferencesPath(modulePaths)).GetAwaiter().GetResult()?.Enabled == true;
                Environment.SetEnvironmentVariable(AccountModule.EnvironmentVariable, null);
                Environment.SetEnvironmentVariable("CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY", launch.PackageFamilyName);
                Environment.ExitCode = DesktopCli.RunAsync(Path.Combine(modulePaths.DataRoot, "accounts"), args, enabled).GetAwaiter().GetResult();
            }
            catch { Environment.ExitCode = 1; }
            return;
        }
        ApplicationConfiguration.Initialize();
        var paths = LoaderPaths.ForProduction();
        paths.EnsureDirectories();
        var readyPipeName = ReadOption(args, "--launcher-ready-pipe");
        var candidate = HandoffCandidateOptions.Parse(args, paths);
        var instance = SingleInstanceCoordinator.Create(paths);
        if (!instance.IsPrimary && candidate is null)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try
            {
                instance.SendCommandAsync(
                    args.Contains("--reload", StringComparer.OrdinalIgnoreCase) ? "ReloadScripts" : "ShowStatus",
                    timeout.Token).GetAwaiter().GetResult();
                LauncherHealthSignal.SendAsync(readyPipeName, CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (Exception exception) when (exception is IOException or TimeoutException or OperationCanceledException)
            {
                MessageBox.Show(
                    "Codex Script Loader is already running, but its status window could not be opened.",
                    "Codex Script Loader",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }

            instance.DisposeAsync().AsTask().GetAwaiter().GetResult();
            return;
        }

        using var logger = new JsonlLogger(paths.LogsRoot);
        var supervisor = new LiveSupervisor(paths, logger);
        try
        {
            using var context = new LoaderApplicationContext(instance, supervisor, logger, readyPipeName, candidate);
            Application.Run(context);
        }
        finally
        {
            supervisor.DisposeAsync().AsTask().GetAwaiter().GetResult();
            instance.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    private static string? ReadOption(string[] args, string name)
    {
        var index = Array.FindIndex(args, argument => string.Equals(argument, name, StringComparison.OrdinalIgnoreCase));
        if (index < 0) return null;
        if (index + 1 >= args.Length || string.IsNullOrWhiteSpace(args[index + 1])) throw new ArgumentException($"Missing value for {name}.");
        return args[index + 1];
    }
}
