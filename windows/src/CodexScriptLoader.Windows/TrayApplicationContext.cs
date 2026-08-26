using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed class LoaderApplicationContext : ApplicationContext
{
    private readonly SingleInstanceCoordinator instance;
    private readonly LiveSupervisor supervisor;
    private readonly JsonlLogger logger;
    private readonly Control dispatcher = new();
    private DiagnosticsForm? diagnostics;

    public LoaderApplicationContext(SingleInstanceCoordinator instance, LiveSupervisor supervisor, JsonlLogger logger)
    {
        this.instance = instance;
        this.supervisor = supervisor;
        this.logger = logger;
        dispatcher.CreateControl();

        supervisor.StateChanged += snapshot => Post(() => ApplySnapshot(snapshot));
        supervisor.ManagedCodexExited += () => Post(ExitAfterManagedCodex);
        instance.CommandReceived += command => Post(() => HandleInstanceCommand(command));
        instance.StartServer();
        dispatcher.BeginInvoke(async () => await StartAsync());
    }

    private async Task StartAsync()
    {
        try
        {
            await supervisor.StartAsync(CancellationToken.None);
        }
        catch (Exception exception)
        {
            logger.Error("background-startup-failed", exception);
            MessageBox.Show(
                $"{JsonlLogger.Redact(exception.Message)}{Environment.NewLine}{Environment.NewLine}Diagnostics were written to the Loader log directory.",
                "Codex Script Loader could not start",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            ExitThread();
        }
    }

    private void ApplySnapshot(DiagnosticSnapshot snapshot)
    {
        if (diagnostics is { IsDisposed: false })
        {
            diagnostics.UpdateSnapshot(snapshot, logger.CurrentPath);
        }
    }

    private async Task ReloadAsync()
    {
        try
        {
            await supervisor.ReloadAsync(CancellationToken.None);
        }
        catch (Exception exception)
        {
            MessageBox.Show(JsonlLogger.Redact(exception.Message), "Script reload failed", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void ShowDiagnostics()
    {
        if (diagnostics is null || diagnostics.IsDisposed)
        {
            diagnostics = new DiagnosticsForm();
        }
        diagnostics.UpdateSnapshot(supervisor.Snapshot, logger.CurrentPath);
        if (!diagnostics.Visible)
        {
            diagnostics.Show();
        }

        diagnostics.WindowState = FormWindowState.Normal;
        diagnostics.Activate();
    }

    private void HandleInstanceCommand(string command)
    {
        if (command == "ReloadScripts")
        {
            _ = ReloadAsync();
        }
        else
        {
            ShowDiagnostics();
        }
    }

    private void ExitAfterManagedCodex()
    {
        ExitThread();
    }

    private void Post(Action action)
    {
        if (!dispatcher.IsDisposed)
        {
            dispatcher.BeginInvoke(action);
        }
    }

    protected override void ExitThreadCore()
    {
        diagnostics?.Dispose();
        dispatcher.Dispose();
        base.ExitThreadCore();
    }
}
