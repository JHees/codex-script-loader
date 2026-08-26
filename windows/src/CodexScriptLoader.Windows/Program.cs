using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var instance = SingleInstanceCoordinator.Create();
        if (!instance.IsPrimary)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try
            {
                instance.SendCommandAsync(
                    args.Contains("--reload", StringComparer.OrdinalIgnoreCase) ? "ReloadScripts" : "ShowStatus",
                    timeout.Token).GetAwaiter().GetResult();
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

        var paths = LoaderPaths.ForProduction();
        paths.EnsureDirectories();
        using var logger = new JsonlLogger(paths.LogsRoot);
        var supervisor = new LiveSupervisor(paths, logger);
        try
        {
            using var context = new LoaderApplicationContext(instance, supervisor, logger);
            Application.Run(context);
        }
        finally
        {
            supervisor.DisposeAsync().AsTask().GetAwaiter().GetResult();
            instance.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }
}
