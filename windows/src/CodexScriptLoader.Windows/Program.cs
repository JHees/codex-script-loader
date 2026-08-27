using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
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
