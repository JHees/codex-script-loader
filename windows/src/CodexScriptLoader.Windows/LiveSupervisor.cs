using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;

namespace CodexScriptLoader.Windows;

internal sealed class LiveSupervisor : IAsyncDisposable
{
    public const string Version = "0.3.0";
    private readonly LoaderPaths paths;
    private readonly JsonlLogger logger;
    private readonly SemaphoreSlim operation = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly DateTimeOffset startedAt = DateTimeOffset.UtcNow;
    private ScriptRegistry? registry;
    private CdpClient? client;
    private CdpInjector? injector;
    private LoaderHostBridge? bridge;
    private CodexPackageIdentity? package;
    private CdpEndpointIdentity? endpoint;
    private IReadOnlyList<ScriptLoadResult> scripts = [];
    private Task? monitorTask;
    private int? activationProcessId;
    private string? lastError;
    private DateTimeOffset? lastInjectionAt;

    public LiveSupervisor(LoaderPaths paths, JsonlLogger logger)
    {
        this.paths = paths;
        this.logger = logger;
        State = LoaderState.Starting;
    }

    public LoaderState State { get; private set; }

    public event Action<DiagnosticSnapshot>? StateChanged;

    public event Action? ManagedCodexExited;

    public DiagnosticSnapshot Snapshot => new(
        Version,
        State,
        package?.PackageFullName,
        package?.PackageFamilyName,
        package?.AppUserModelId,
        activationProcessId,
        endpoint,
        scripts,
        GetSignatureStatus(),
        lastError,
        startedAt,
        lastInjectionAt);

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            SetState(LoaderState.Starting, null);
            package = PackageDiscovery.DiscoverCodexForCurrentUser();
            var existing = ProcessIdentity.FindProcessesByPackageFamily(package.PackageFamilyName);
            if (existing.Count > 0)
            {
                throw new InvalidOperationException("Codex is already running. Close it completely before managed launch.");
            }

            var settingsHost = Path.Combine(AppContext.BaseDirectory, "bundled", "settings-host.mjs");
            var bundledBennett = Path.Combine(AppContext.BaseDirectory, "bundled", "bennett-ui-improvements");
            registry = new ScriptRegistry(paths, settingsHost);
            await registry.InitializeAsync(cancellationToken).ConfigureAwait(false);
            await registry.EnsureBundledScriptAsync(bundledBennett, cancellationToken).ConfigureAwait(false);

            var port = AllocateLoopbackPort();
            client = new CdpClient(port);
            activationProcessId = ApplicationActivator.Activate(package,
            [
                "--remote-debugging-address=127.0.0.1",
                $"--remote-debugging-port={port}",
                $"--remote-allow-origins=http://127.0.0.1:{port}",
            ]);
            logger.Info("codex-activated", new { package.PackageFullName, package.AppUserModelId, activationProcessId, port });

            var targets = await WaitForTargetsAsync(client, TimeSpan.FromSeconds(20), cancellationToken).ConfigureAwait(false);
            var listeners = TcpOwnerLookup.GetIPv4LoopbackListeners(port);
            if (listeners.Count != 1)
            {
                throw new InvalidOperationException("Managed CDP port does not have exactly one loopback listener.");
            }

            var owner = listeners[0];
            var ownerFamily = ProcessIdentity.TryGetPackageFamilyName(owner.ProcessId);
            if (!string.Equals(ownerFamily, package.PackageFamilyName, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("CDP listener owner does not belong to the managed Codex package.");
            }

            endpoint = new CdpEndpointIdentity(owner.Address, owner.Port, owner.ProcessId, ownerFamily!, targets[0].Url);
            injector = new CdpInjector(client);
            bridge = new LoaderHostBridge(client, DispatchBridgeAsync);
            await bridge.SyncAsync(targets, cancellationToken).ConfigureAwait(false);
            await InjectAsync(targets, force: true, cancellationToken).ConfigureAwait(false);
            monitorTask = Task.Run(MonitorAsync);
        }
        catch (Exception exception)
        {
            logger.Error("startup-failed", exception);
            SetState(LoaderState.Faulted, exception.Message);
            throw;
        }
        finally
        {
            operation.Release();
        }
    }

    public async Task ReloadAsync(CancellationToken cancellationToken)
    {
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (client is null || registry is null || injector is null || bridge is null)
            {
                throw new InvalidOperationException("Managed runtime is not ready.");
            }

            SetState(LoaderState.Reloading, null);
            var targets = await client.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
            if (targets.Count == 0)
            {
                throw new InvalidOperationException("No exact Codex renderer target is available.");
            }

            await bridge.SyncAsync(targets, cancellationToken).ConfigureAwait(false);
            await InjectAsync(targets, force: true, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            logger.Error("reload-failed", exception);
            SetState(LoaderState.Degraded, exception.Message);
            throw;
        }
        finally
        {
            operation.Release();
        }
    }

    public void FocusCodex()
    {
        if (package is null)
        {
            return;
        }

        _ = ApplicationActivator.Activate(package, []);
    }

    public async Task<bool> CloseManagedCodexAsync(CancellationToken cancellationToken)
    {
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (client is null || injector is null || package is null)
            {
                return true;
            }

            SetState(LoaderState.Stopping, null);
            IReadOnlyList<CdpTarget> targets = [];
            try
            {
                targets = await client.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
                await injector.StopAllAsync(targets, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is HttpRequestException or WebSocketException or InvalidOperationException)
            {
                logger.Warn("renderer-cleanup-incomplete", new { message = JsonlLogger.Redact(exception.Message) });
            }

            try
            {
                var browserEndpoint = await client.GetBrowserEndpointAsync(cancellationToken).ConfigureAwait(false);
                await using var browser = await CdpSession.ConnectAsync(browserEndpoint, cancellationToken).ConfigureAwait(false);
                try
                {
                    await browser.SendAsync("Browser.close", cancellationToken: cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is IOException or WebSocketException or OperationCanceledException)
                {
                }
            }
            catch (Exception exception) when (exception is HttpRequestException or WebSocketException or InvalidOperationException)
            {
                logger.Warn("browser-close-failed", new { message = JsonlLogger.Redact(exception.Message) });
            }

            var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(10);
            while (DateTimeOffset.UtcNow < deadline)
            {
                if (ProcessIdentity.FindProcessesByPackageFamily(package.PackageFamilyName).Count == 0)
                {
                    return true;
                }

                await Task.Delay(250, cancellationToken).ConfigureAwait(false);
            }

            SetState(LoaderState.Degraded, "Codex did not close within 10 seconds. Close it manually before exiting Loader.");
            return false;
        }
        finally
        {
            operation.Release();
        }
    }

    private async Task InjectAsync(IReadOnlyList<CdpTarget> targets, bool force, CancellationToken cancellationToken)
    {
        var plan = await registry!.BuildPlanAsync(force, cancellationToken).ConfigureAwait(false);
        scripts = await injector!.InjectAsync(plan.Source, plan.Scripts, targets, cancellationToken).ConfigureAwait(false);
        lastInjectionAt = DateTimeOffset.UtcNow;
        var failed = scripts.Count(script => script.LifecycleResult != "running");
        SetState(failed == 0 ? LoaderState.Healthy : LoaderState.Degraded, failed == 0 ? null : $"{failed} renderer scripts failed to start.");
        logger.Info("scripts-injected", new { targetCount = targets.Count, scriptCount = plan.Scripts.Count, failed, plan.SafeMode });
    }

    private async Task<object> DispatchBridgeAsync(string command, CancellationToken cancellationToken)
    {
        if (command == "reload_scripts")
        {
            await ReloadAsync(cancellationToken).ConfigureAwait(false);
        }

        var snapshot = Snapshot;
        return new
        {
            loader = snapshot.State is LoaderState.Healthy or LoaderState.Degraded ? "healthy" : snapshot.State.ToString().ToLowerInvariant(),
            codex = snapshot.Cdp is null ? "stopped" : "healthy",
            cdp = snapshot.State.ToString().ToLowerInvariant(),
            safeMode = registry?.SafeMode ?? false,
            managedProcess = snapshot.ActivationProcessId.HasValue,
            targetCount = snapshot.Cdp is null ? 0 : 1,
            enabledScripts = snapshot.Scripts.Count,
            failedScripts = snapshot.Scripts.Count(script => script.LifecycleResult != "running"),
            configHealthy = !(registry?.SafeMode ?? false),
            startedAt = snapshot.StartedAt,
            lastInjectionAt = snapshot.LastInjectionAt,
            lastError = snapshot.LastError,
            scope = "renderer-plugins-only",
        };
    }

    private async Task MonitorAsync()
    {
        var missingTicks = 0;
        while (!lifetime.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(1000, lifetime.Token).ConfigureAwait(false);
                var targets = client is null ? [] : await client.GetCodexTargetsAsync(lifetime.Token).ConfigureAwait(false);
                if (targets.Count == 0)
                {
                    missingTicks++;
                    if (missingTicks >= 5)
                    {
                        logger.Info("managed-codex-exited");
                        ManagedCodexExited?.Invoke();
                        return;
                    }
                }
                else
                {
                    missingTicks = 0;
                    if (bridge is not null)
                    {
                        await bridge.SyncAsync(targets, lifetime.Token).ConfigureAwait(false);
                    }
                }
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception) when (exception is HttpRequestException or WebSocketException or InvalidOperationException)
            {
                missingTicks++;
                if (missingTicks >= 5)
                {
                    logger.Warn("managed-codex-unreachable", new { message = JsonlLogger.Redact(exception.Message) });
                    ManagedCodexExited?.Invoke();
                    return;
                }
            }
        }
    }

    private void SetState(LoaderState state, string? error)
    {
        State = state;
        lastError = error is null ? null : JsonlLogger.Redact(error);
        StateChanged?.Invoke(Snapshot);
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

    private static async Task<IReadOnlyList<CdpTarget>> WaitForTargetsAsync(CdpClient client, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        Exception? lastError = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            try
            {
                var targets = await client.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
                if (targets.Count > 0)
                {
                    return targets;
                }
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or InvalidDataException)
            {
                lastError = exception;
            }

            await Task.Delay(250, cancellationToken).ConfigureAwait(false);
        }

        throw new TimeoutException("Codex CDP did not become ready within 20 seconds.", lastError);
    }

    private static string GetSignatureStatus()
    {
        try
        {
#pragma warning disable SYSLIB0057
            _ = X509Certificate.CreateFromSignedFile(Environment.ProcessPath!);
#pragma warning restore SYSLIB0057
            return "valid-present";
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return "unsigned-development-build";
        }
    }

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        if (monitorTask is not null)
        {
            try
            {
                await monitorTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        if (bridge is not null)
        {
            await bridge.DisposeAsync().ConfigureAwait(false);
        }

        client?.Dispose();
        operation.Dispose();
        lifetime.Dispose();
    }
}
