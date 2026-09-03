using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed class LoaderApplicationContext : ApplicationContext
{
    private readonly SingleInstanceCoordinator instance;
    private readonly LiveSupervisor supervisor;
    private readonly JsonlLogger logger;
    private readonly string? launcherReadyPipeName;
    private readonly HandoffCandidateOptions? candidate;
    private readonly OnlineUpdateManager updateManager;
    private readonly Control dispatcher = new();
    private DiagnosticsForm? diagnostics;

    public LoaderApplicationContext(SingleInstanceCoordinator instance, LiveSupervisor supervisor, JsonlLogger logger, string? launcherReadyPipeName, HandoffCandidateOptions? candidate)
    {
        this.instance = instance;
        this.supervisor = supervisor;
        this.logger = logger;
        this.launcherReadyPipeName = launcherReadyPipeName;
        this.candidate = candidate;
        updateManager = new OnlineUpdateManager(
            paths: LoaderPaths.ForProduction(),
            logger,
            SwitchHostAsync);
        supervisor.UpdateManager = updateManager;
        dispatcher.CreateControl();

        supervisor.StateChanged += snapshot => Post(() => ApplySnapshot(snapshot));
        supervisor.ManagedCodexExited += reason => Post(() => HandleManagedCodexExit(reason));
        supervisor.PackagePickerAsync = PickPluginPackageAsync;
        instance.CommandReceived += command => Post(() => HandleInstanceCommand(command));
        if (candidate is null) instance.StartServer();
        dispatcher.BeginInvoke(async () => await StartAsync());
    }

    private async Task StartAsync()
    {
        try
        {
            if (candidate is null)
            {
                await supervisor.StartAsync(CancellationToken.None);
                await updateManager.InitializeAsync(CancellationToken.None);
            }
            else
            {
                await updateManager.InitializeAsync(CancellationToken.None);
                await HostHandoffCoordinator.RunCandidateAsync(candidate, LoaderPaths.ForProduction(), supervisor, instance, logger, CancellationToken.None);
                try { await updateManager.RefreshTransactionStateAsync(CancellationToken.None, preserveTerminalState: true); }
                catch (Exception exception) when (exception is IOException or System.Text.Json.JsonException) { logger.Warn("update-status-restore-failed", new { message = JsonlLogger.Redact(exception.Message) }); }
            }
            await LauncherHealthSignal.SendAsync(launcherReadyPipeName, CancellationToken.None);
            _ = updateManager.StartAfterHealthyAsync(CancellationToken.None);
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

    private Task SwitchHostAsync(StagedUpdate staged, CancellationToken cancellationToken) =>
        HostHandoffCoordinator.SwitchAsync(staged, LoaderPaths.ForProduction(), supervisor, instance, logger, () => Post(ExitThread), cancellationToken);

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

    private void HandleManagedCodexExit(ManagedCodexExitReason reason)
    {
        if (reason == ManagedCodexExitReason.PackageUpdated)
        {
            _ = RecoverAfterCodexUpdateAsync();
            return;
        }

        ExitThread();
    }

    private async Task RecoverAfterCodexUpdateAsync()
    {
        try
        {
            logger.Info("codex-update-recovery-started");
            await supervisor.RestartAsync(CancellationToken.None);
            logger.Info("codex-update-recovery-succeeded", new
            {
                package = supervisor.Snapshot.PackageFullName,
                activationProcessId = supervisor.Snapshot.ActivationProcessId,
            });
        }
        catch (Exception exception)
        {
            logger.Error("codex-update-recovery-failed", exception);
            MessageBox.Show(
                $"Codex was updated, but Script Loader could not restart the updated app.{Environment.NewLine}{Environment.NewLine}{JsonlLogger.Redact(exception.Message)}",
                "Codex Script Loader",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            ExitThread();
        }
    }

    private void Post(Action action)
    {
        if (!dispatcher.IsDisposed)
        {
            dispatcher.BeginInvoke(action);
        }
    }

    private async Task<string?> PickPluginPackageAsync(bool archive, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var completion = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
        dispatcher.BeginInvoke(() =>
        {
            try
            {
                if (archive)
                {
                    using var dialog = new OpenFileDialog
                    {
                        Title = "Select a Script-Loader plugin ZIP",
                        Filter = "Plugin ZIP (*.zip)|*.zip",
                        CheckFileExists = true,
                        Multiselect = false,
                    };
                    completion.TrySetResult(dialog.ShowDialog() == DialogResult.OK ? dialog.FileName : null);
                }
                else
                {
                    using var dialog = new FolderBrowserDialog
                    {
                        Description = "Select a Script-Loader plugin folder containing manifest.json",
                        UseDescriptionForTitle = true,
                        ShowNewFolderButton = false,
                    };
                    completion.TrySetResult(dialog.ShowDialog() == DialogResult.OK ? dialog.SelectedPath : null);
                }
            }
            catch (Exception exception)
            {
                completion.TrySetException(exception);
            }
        });
        return await completion.Task.ConfigureAwait(false);
    }

    protected override void ExitThreadCore()
    {
        supervisor.PackagePickerAsync = null;
        diagnostics?.Dispose();
        dispatcher.Dispose();
        base.ExitThreadCore();
    }
}
