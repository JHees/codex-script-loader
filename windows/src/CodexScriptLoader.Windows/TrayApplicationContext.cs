using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed class LoaderApplicationContext : ApplicationContext
{
    private const int CodexRestartAttempts = 3;
    private static readonly TimeSpan CodexRestartRetryDelay = TimeSpan.FromSeconds(2);
    private readonly SingleInstanceCoordinator instance;
    private readonly LiveSupervisor supervisor;
    private readonly JsonlLogger logger;
    private readonly string? launcherReadyPipeName;
    private readonly HandoffCandidateOptions? candidate;
    private readonly OnlineUpdateManager updateManager;
    private readonly Control dispatcher = new();
    private DiagnosticsForm? diagnostics;
    private int shutdownStarted;

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
        instance.HostCommandReceived = supervisor.InvokeHostCommandAsync;
        if (candidate is null) instance.StartServer();
        dispatcher.BeginInvoke(async () => await StartAsync());
    }

    private async Task StartAsync()
    {
        try
        {
            // The launcher only needs to know the host process started. Startup
            // may legitimately wait for an already-running Codex window to close.
            await LauncherHealthSignal.SendAsync(launcherReadyPipeName, CancellationToken.None);
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
            diagnostics.ExitRequested += (_, _) => _ = ShutdownManagedStackAsync();
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
        else if (command == "ExitLoader")
        {
            _ = ShutdownManagedStackAsync();
        }
        else
        {
            ShowDiagnostics();
        }
    }

    private void HandleManagedCodexExit(ManagedCodexExitReason reason)
    {
        // A diagnostic exit is already closing Codex; let it finish the ordered shutdown
        // instead of disposing the supervisor from under the pending close request.
        if (Volatile.Read(ref shutdownStarted) != 0) return;
        if (reason == ManagedCodexExitReason.PackageUpdated)
        {
            _ = RecoverAfterCodexUpdateAsync();
            return;
        }

        ExitThread();
    }

    private async Task ShutdownManagedStackAsync()
    {
        if (Interlocked.Exchange(ref shutdownStarted, 1) != 0) return;
        logger.Info("loader-exit-requested");
        var closed = false;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            closed = await supervisor.CloseManagedCodexAsync(timeout.Token).ConfigureAwait(false);
            if (!closed)
            {
                logger.Warn("loader-exit-codex-cleanup-incomplete");
            }
        }
        catch (Exception exception)
        {
            logger.Warn("loader-exit-codex-cleanup-failed", new { message = JsonlLogger.Redact(exception.Message) });
        }
        finally
        {
            if (!closed)
            {
                try { supervisor.TerminateManagedCodex(); }
                catch (Exception exception) { logger.Warn("loader-exit-codex-force-cleanup-failed", new { message = JsonlLogger.Redact(exception.Message) }); }
            }
            Post(ExitThread);
        }
    }

    private async Task RecoverAfterCodexUpdateAsync()
    {
        // A Store update can briefly leave the package unregistered or its
        // processes half-closed, so the managed restart is retried instead of
        // exiting the Loader after one failed attempt.
        for (var attempt = 1; attempt <= CodexRestartAttempts; attempt++)
        {
            try
            {
                logger.Info("codex-update-recovery-started", new { attempt, attempts = CodexRestartAttempts });
                await supervisor.RestartAsync(CancellationToken.None);
                logger.Info("codex-update-recovery-succeeded", new
                {
                    package = supervisor.Snapshot.PackageFullName,
                    activationProcessId = supervisor.Snapshot.ActivationProcessId,
                });
                return;
            }
            catch (Exception exception)
            {
                var message = JsonlLogger.Redact(exception.Message);
                if (attempt == CodexRestartAttempts)
                {
                    logger.Error("codex-update-recovery-failed", exception);
                    supervisor.ReportRecoveryFailure($"Codex update recovery failed after {CodexRestartAttempts} attempts: {message}");
                    return;
                }

                logger.Warn("codex-restart-retry", new { attempt, attempts = CodexRestartAttempts, message });
                await Task.Delay(CodexRestartRetryDelay);
            }
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
