using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using CodexScriptLoader.Core;
using CodexScriptLoader.Interop;

namespace CodexScriptLoader.Windows;

internal enum ManagedCodexExitReason
{
    Closed,
    PackageUpdated,
}

internal sealed class LiveSupervisor : IAsyncDisposable
{
    public const string Version = "0.5.10";
    private const string TrustedInputPermission = "trusted-input";
    private static readonly TimeSpan GracefulRestartShutdownTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan ForcedRestartShutdownTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan PackageExitPollInterval = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan StablePackageExitWindow = TimeSpan.FromMilliseconds(500);
    private readonly LoaderPaths paths;
    private readonly JsonlLogger logger;
    private readonly SemaphoreSlim operation = new(1, 1);
    private readonly SemaphoreSlim hostInvocation = new(1, 1);
    private CancellationTokenSource? activeHostCommand;
    private readonly CancellationTokenSource lifetime = new();
    private readonly DateTimeOffset startedAt = DateTimeOffset.UtcNow;
    private ScriptRegistry? registry;
    private CdpClient? client;
    private CdpInjector? injector;
    private LoaderHostBridge? bridge;
    private LoopbackTransportHost? transport;
    private PageCompanionHost? pageCompanions;
    private PluginUpdateManager? pluginUpdateManager;
    private CodexPackageIdentity? package;
    private CdpEndpointIdentity? endpoint;
    private IReadOnlyList<ScriptLoadResult> scripts = [];
    private Task? monitorTask;
    private CancellationTokenSource? monitorLifetime;
    private int? activationProcessId;
    private int lastTargetCount;
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

    public event Action<ManagedCodexExitReason>? ManagedCodexExited;

    public Func<bool, CancellationToken, Task<string?>>? PackagePickerAsync { get; set; }

    public OnlineUpdateManager? UpdateManager { get; set; }

    public async Task<JsonElement> InvokeHostCommandAsync(HostCommandRequest request, CancellationToken cancellationToken)
    {
        if (!await hostInvocation.WaitAsync(0, cancellationToken).ConfigureAwait(false))
            throw new HostCommandException("COMMAND_BUSY", "A plugin host command is already in progress.");
        using var lease = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        CdpSession? commandSession = null;
        try
        {
            ScriptDescriptor descriptor;
            string expression;
            await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var activeRegistry = registry ?? throw new HostCommandException("COMMAND_UNAVAILABLE", "Managed renderer runtime is not ready.");
                var activeClient = client ?? throw new HostCommandException("COMMAND_UNAVAILABLE", "Managed renderer runtime is not ready.");
                var plan = await activeRegistry.BuildPlanAsync(force: false, cancellationToken).ConfigureAwait(false);
                descriptor = plan.Scripts.SingleOrDefault(candidate => string.Equals(candidate.Id, request.PluginId, StringComparison.Ordinal))
                    ?? throw new HostCommandException("PLUGIN_NOT_FOUND", "The requested plugin is not enabled.");
                if (descriptor.HostCommands is null || !descriptor.HostCommands.Operations.Contains(request.Operation, StringComparer.Ordinal))
                {
                    throw new HostCommandException("OPERATION_NOT_ALLOWED", "The requested plugin operation is not allowed.");
                }

                if (!scripts.Any(script => string.Equals(script.Id, request.PluginId, StringComparison.Ordinal) && script.LifecycleResult == "running"))
                {
                    throw new HostCommandException("PLUGIN_NOT_RUNNING", "The requested plugin is not running.");
                }

                var targets = await activeClient.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
                if (targets.Count != 1)
                {
                    throw new HostCommandException("RENDERER_UNAVAILABLE", "Exactly one managed Codex renderer is required.");
                }

                expression = BuildHostCommandExpression(request.PluginId, request.Operation, request.Payload);
                commandSession = await CdpSession.ConnectAsync(new Uri(targets[0].WebSocketDebuggerUrl), cancellationToken).ConfigureAwait(false);
                activeHostCommand = lease;
            }
            finally { operation.Release(); }

            var session = commandSession;
            using var invocationTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lease.Token);
            invocationTimeout.CancelAfter(HostCommandProtocol.InvocationTimeout);
            var invocationToken = invocationTimeout.Token;
            await session.SendAsync("Runtime.enable", cancellationToken: invocationToken).ConfigureAwait(false);

            async Task<JsonElement> EvaluateAsync(CancellationToken token)
            {
                var evaluation = await session.SendAsync(
                    "Runtime.evaluate",
                    new { expression, awaitPromise = true, returnByValue = true },
                    token,
                    HostCommandProtocol.InvocationTimeout).ConfigureAwait(false);
                if (evaluation.TryGetProperty("exceptionDetails", out _))
                {
                    throw new HostCommandException("PLUGIN_COMMAND_FAILED", "The renderer plugin rejected the host command.");
                }
                if (!evaluation.TryGetProperty("result", out var result) || !result.TryGetProperty("value", out var value))
                {
                    throw new HostCommandException("INVALID_PLUGIN_RESULT", "The renderer plugin returned no serializable JSON result.");
                }
                return value.Clone();
            }

            async Task PressEnterAsync(CancellationToken token)
            {
                var key = new
                {
                    key = "Enter",
                    code = "Enter",
                    text = "\r",
                    unmodifiedText = "\r",
                    windowsVirtualKeyCode = 13,
                    nativeVirtualKeyCode = 13,
                };
                await session.SendAsync("Input.dispatchKeyEvent", new { type = "keyDown", key.key, key.code, key.text, key.unmodifiedText, key.windowsVirtualKeyCode, key.nativeVirtualKeyCode }, token).ConfigureAwait(false);
                await session.SendAsync("Input.dispatchKeyEvent", new { type = "keyUp", key.key, key.code, windowsVirtualKeyCode = 13, nativeVirtualKeyCode = 13 }, token).ConfigureAwait(false);
            }

            var result = await ResolveHostCommandResultAsync(
                EvaluateAsync,
                PressEnterAsync,
                descriptor.Permissions.Contains(TrustedInputPermission, StringComparer.Ordinal),
                invocationToken).ConfigureAwait(false);
            lease.Token.ThrowIfCancellationRequested();
            return result;
        }
        catch (OperationCanceledException) when (lease.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new HostCommandException("SESSION_LOST", "The renderer runtime changed during the plugin command.");
        }
        finally
        {
            await operation.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try { if (ReferenceEquals(activeHostCommand, lease)) activeHostCommand = null; }
            finally { operation.Release(); }
            try { if (commandSession is not null) await commandSession.DisposeAsync().ConfigureAwait(false); }
            finally { hostInvocation.Release(); }
        }
    }

    internal static async Task<JsonElement> ResolveHostCommandResultAsync(
        Func<CancellationToken, Task<JsonElement>> evaluateAsync,
        Func<CancellationToken, Task> pressEnterAsync,
        bool allowTrustedInput,
        CancellationToken cancellationToken)
    {
        var hostActions = 0;
        while (true)
        {
            var pluginResult = ReadPluginResult(await evaluateAsync(cancellationToken).ConfigureAwait(false));
            if (!IsTrustedEnterRequest(pluginResult)) return pluginResult;
            if (!allowTrustedInput)
            {
                throw new HostCommandException("HOST_ACTION_DENIED", "The plugin did not declare the trusted-input permission.");
            }
            if (hostActions >= 1)
            {
                throw new HostCommandException("HOST_ACTION_LIMIT", "A plugin command may request trusted Enter only once.");
            }
            hostActions += 1;
            await pressEnterAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private static JsonElement ReadPluginResult(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("ok", out var pluginOk) || pluginOk.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new HostCommandException("INVALID_PLUGIN_RESULT", "The renderer plugin returned an invalid command envelope.");
        }
        if (!pluginOk.GetBoolean())
        {
            var error = value.TryGetProperty("error", out var pluginError) && pluginError.ValueKind == JsonValueKind.Object ? pluginError : default;
            var code = error.ValueKind == JsonValueKind.Object && error.TryGetProperty("code", out var codeElement) ? codeElement.GetString() : null;
            var message = error.ValueKind == JsonValueKind.Object && error.TryGetProperty("message", out var messageElement) ? messageElement.GetString() : null;
            throw new HostCommandException(
                !string.IsNullOrWhiteSpace(code) && code.Length <= 64 && code.All(character => char.IsAsciiLetterUpper(character) || char.IsAsciiDigit(character) || character == '_') ? code : "PLUGIN_COMMAND_FAILED",
                !string.IsNullOrWhiteSpace(message) && message.Length <= 512 && message.All(character => !char.IsControl(character)) ? message : "The renderer plugin rejected the host command.");
        }
        if (!value.TryGetProperty("result", out var pluginResult))
        {
            throw new HostCommandException("INVALID_PLUGIN_RESULT", "The renderer plugin command envelope has no result.");
        }
        var clone = pluginResult.Clone();
        if (System.Text.Encoding.UTF8.GetByteCount(clone.GetRawText()) > HostCommandProtocol.MaximumMessageBytes)
        {
            throw new HostCommandException("RESULT_TOO_LARGE", "The renderer plugin result exceeds 64 KiB.");
        }
        return clone;
    }

    private static bool IsTrustedEnterRequest(JsonElement pluginResult)
    {
        if (pluginResult.ValueKind != JsonValueKind.Object || !pluginResult.TryGetProperty("$loaderHostAction", out var action)) return false;
        if (pluginResult.EnumerateObject().Count() != 1
            || action.ValueKind != JsonValueKind.Object
            || action.EnumerateObject().Count() != 2
            || !action.TryGetProperty("version", out var version)
            || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out var versionNumber)
            || versionNumber != 1
            || !action.TryGetProperty("type", out var type)
            || type.ValueKind != JsonValueKind.String
            || !string.Equals(type.GetString(), "press-enter", StringComparison.Ordinal))
        {
            throw new HostCommandException("INVALID_PLUGIN_RESULT", "The renderer plugin returned an invalid host action request.");
        }
        return true;
    }

    internal static string BuildHostCommandExpression(string pluginId, string hostOperation, JsonElement payload) => $$"""
        (async () => {
          const record = globalThis.__codexScriptLoader?.scripts?.[{{JsonSerializer.Serialize(pluginId)}}];
          if (!record || record.status !== "running" || typeof record.invokeHostCommand !== "function") {
            throw new Error("PLUGIN_NOT_RUNNING");
          }
          try {
            const result = await record.invokeHostCommand({{JsonSerializer.Serialize(hostOperation)}}, {{payload.GetRawText()}});
            return { version: 1, ok: true, result };
          } catch (error) {
            const code = typeof error?.code === "string" ? error.code : "PLUGIN_COMMAND_FAILED";
            const message = typeof error?.message === "string" ? error.message : "The renderer plugin rejected the host command.";
            return { version: 1, ok: false, error: { code, message } };
          }
        })()
        """;

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
            var bundledExample = Path.Combine(AppContext.BaseDirectory, "bundled", "example-ui-plugin");
            registry = new ScriptRegistry(paths, settingsHost, UserSkillRoot(), DirectoryJunction.Create);
            await registry.InitializeAsync(cancellationToken).ConfigureAwait(false);
            await registry.EnsureBundledScriptAsync(bundledExample, cancellationToken).ConfigureAwait(false);
            await InitializePluginUpdateManagerAsync(cancellationToken).ConfigureAwait(false);

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
            transport = new LoopbackTransportHost([port]);
            pageCompanions = new PageCompanionHost(client);
            var initialPlan = await registry.BuildPlanAsync(force: false, cancellationToken).ConfigureAwait(false);
            await transport.SetAuthorizedPluginsAsync(initialPlan.Scripts, cancellationToken).ConfigureAwait(false);
            await pageCompanions.SetAuthorizedPluginsAsync(initialPlan.Scripts, cancellationToken).ConfigureAwait(false);
            bridge = new LoaderHostBridge(client, DispatchBridgeAsync, transport);
            await bridge.SyncAsync(targets, cancellationToken).ConfigureAwait(false);
            await InjectAsync(targets, forceIds: null, cancellationToken).ConfigureAwait(false);
            StartMonitor();
            var startupPluginUpdateManager = pluginUpdateManager;
            if (State == LoaderState.Healthy && startupPluginUpdateManager is not null)
            {
                _ = Task.Run(async () =>
                {
                    try { await startupPluginUpdateManager.StartAfterHealthyAsync(lifetime.Token).ConfigureAwait(false); }
                    catch (Exception exception) { HandlePluginUpdateFailure("plugin-update-startup-scan-failed", null, exception); }
                });
            }
        }
        catch (Exception exception)
        {
            try { await DisposeBridgeAndTransportAsync().ConfigureAwait(false); } catch (Exception cleanup) { logger.Error("startup-transport-cleanup-failed", cleanup); }
            logger.Error("startup-failed", exception);
            SetState(LoaderState.Faulted, exception.Message);
            throw;
        }
        finally
        {
            operation.Release();
        }
    }

    public async Task AdoptAsync(UpdateTransaction transaction, CancellationToken cancellationToken)
    {
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            SetState(LoaderState.Starting, null);
            package = PackageDiscovery.DiscoverCodexForCurrentUser();
            if (!string.Equals(package.PackageFamilyName, transaction.Endpoint.OwnerPackageFamilyName, StringComparison.OrdinalIgnoreCase) ||
                transaction.Endpoint.TargetUrl != "app://-/index.html" || !IPAddress.TryParse(transaction.Endpoint.Address, out var endpointAddress) || !IPAddress.IsLoopback(endpointAddress))
            {
                throw new InvalidOperationException("Handoff endpoint identity does not match the installed Codex package.");
            }

            var settingsHost = Path.Combine(AppContext.BaseDirectory, "bundled", "settings-host.mjs");
            var bundledExample = Path.Combine(AppContext.BaseDirectory, "bundled", "example-ui-plugin");
            registry = new ScriptRegistry(paths, settingsHost, UserSkillRoot(), DirectoryJunction.Create);
            await registry.InitializeAsync(cancellationToken).ConfigureAwait(false);
            await registry.EnsureBundledScriptAsync(bundledExample, cancellationToken).ConfigureAwait(false);
            await InitializePluginUpdateManagerAsync(cancellationToken).ConfigureAwait(false);

            client = new CdpClient(transaction.Endpoint.Port);
            var targets = await WaitForTargetsAsync(client, TimeSpan.FromSeconds(10), cancellationToken).ConfigureAwait(false);
            var listeners = TcpOwnerLookup.GetIPv4LoopbackListeners(transaction.Endpoint.Port);
            if (listeners.Count != 1 || listeners[0].ProcessId != transaction.Endpoint.OwnerPid ||
                !string.Equals(ProcessIdentity.TryGetPackageFamilyName(listeners[0].ProcessId), package.PackageFamilyName, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Handoff CDP listener ownership changed before adoption.");
            }

            endpoint = transaction.Endpoint;
            activationProcessId = transaction.ActivationProcessId;
            injector = new CdpInjector(client);
            transport = new LoopbackTransportHost([transaction.Endpoint.Port]);
            pageCompanions = new PageCompanionHost(client);
            var initialPlan = await registry.BuildPlanAsync(force: false, cancellationToken).ConfigureAwait(false);
            await transport.SetAuthorizedPluginsAsync(initialPlan.Scripts, cancellationToken).ConfigureAwait(false);
            await pageCompanions.SetAuthorizedPluginsAsync(initialPlan.Scripts, cancellationToken).ConfigureAwait(false);
            bridge = new LoaderHostBridge(client, DispatchBridgeAsync, transport);
            await bridge.SyncAsync(targets, cancellationToken).ConfigureAwait(false);
            var forceIds = (await registry.BuildPlanAsync(force: true, cancellationToken).ConfigureAwait(false)).Scripts
                .Select(script => script.Id).ToHashSet(StringComparer.Ordinal);
            await InjectAsync(targets, forceIds, cancellationToken).ConfigureAwait(false);
            logger.Info("managed-codex-adopted", new { transaction.Id, endpoint.Port, endpoint.OwnerPid, targetCount = targets.Count });
            var adoptedPluginUpdateManager = pluginUpdateManager;
            if (State == LoaderState.Healthy && adoptedPluginUpdateManager is not null)
            {
                _ = Task.Run(async () =>
                {
                    try { await adoptedPluginUpdateManager.StartAfterHealthyAsync(lifetime.Token).ConfigureAwait(false); }
                    catch (Exception exception) { HandlePluginUpdateFailure("plugin-update-startup-scan-failed", null, exception); }
                });
            }
        }
        catch (Exception exception)
        {
            try { await DisposeBridgeAndTransportAsync().ConfigureAwait(false); } catch (Exception cleanup) { logger.Error("handoff-transport-cleanup-failed", cleanup); }
            logger.Error("handoff-adoption-failed", exception);
            SetState(LoaderState.Faulted, exception.Message);
            throw;
        }
        finally
        {
            operation.Release();
        }
    }

    public async Task SuspendForHandoffAsync()
    {
        await StopMonitorAsync().ConfigureAwait(false);
        await operation.WaitAsync().ConfigureAwait(false);
        try
        {
            if (client is null || injector is null) throw new InvalidOperationException("Managed runtime is not ready for handoff suspension.");
            var targets = await client.GetCodexTargetsAsync(CancellationToken.None).ConfigureAwait(false);
            if (transport is not null)
            {
                // The candidate must own the only active transport registration
                // after adoption; disable the old host before releasing the
                // single-instance lock so no stale future renderer executes it.
                await transport.SetAuthorizedPluginsAsync(Array.Empty<ScriptDescriptor>(), CancellationToken.None).ConfigureAwait(false);
            }
            if (pageCompanions is not null) await pageCompanions.SetAuthorizedPluginsAsync(Array.Empty<ScriptDescriptor>(), CancellationToken.None).ConfigureAwait(false);
            await injector.RemoveFutureRegistrationsAsync(targets, CancellationToken.None).ConfigureAwait(false);
        }
        finally
        {
            operation.Release();
        }
    }

    public void CommitHandoff() => StartMonitor();

    public async Task RestoreAfterHandoffFailureAsync(CancellationToken cancellationToken)
    {
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (client is null || registry is null || injector is null || bridge is null)
            {
                throw new InvalidOperationException("Managed runtime is not ready for handoff recovery.");
            }

            var targets = await client.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
            if (targets.Count == 0) throw new InvalidOperationException("No renderer target is available for handoff recovery.");
            var plan = await registry.BuildPlanAsync(force: true, cancellationToken).ConfigureAwait(false);
            if (transport is not null) await transport.SetAuthorizedPluginsAsync(plan.Scripts, cancellationToken).ConfigureAwait(false);
            if (pageCompanions is not null) await pageCompanions.SetAuthorizedPluginsAsync(plan.Scripts, cancellationToken).ConfigureAwait(false);
            await bridge.ReconnectAsync(targets, cancellationToken).ConfigureAwait(false);
            scripts = await injector.InjectAsync(plan.Source, plan.Scripts, targets, cancellationToken).ConfigureAwait(false);
            lastTargetCount = targets.Count;
            lastInjectionAt = DateTimeOffset.UtcNow;
            var failed = scripts.Count(script => script.LifecycleResult != "running");
            SetState(failed == 0 ? LoaderState.Healthy : LoaderState.Degraded, failed == 0 ? null : $"{failed} renderer scripts failed to recover.");
            StartMonitor();
            logger.Info("handoff-recovered", new { targetCount = targets.Count, failed });
        }
        finally
        {
            operation.Release();
        }
    }

    public async Task ReloadAsync(CancellationToken cancellationToken)
    {
        await ReloadAsync(null, cancellationToken).ConfigureAwait(false);
    }

    public async Task ReloadAsync(IReadOnlySet<string>? forceIds, CancellationToken cancellationToken)
    {
        if (registry is not null) await registry.ReconcileSkillEntriesAsync(cancellationToken).ConfigureAwait(false);
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            activeHostCommand?.Cancel();
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

            var authorizationPlan = await registry.BuildPlanAsync(force: false, cancellationToken).ConfigureAwait(false);
            if (transport is not null) await transport.SetAuthorizedPluginsAsync(authorizationPlan.Scripts, cancellationToken).ConfigureAwait(false);
            if (pageCompanions is not null) await pageCompanions.SetAuthorizedPluginsAsync(authorizationPlan.Scripts, cancellationToken).ConfigureAwait(false);
            await bridge.SyncAsync(targets, cancellationToken).ConfigureAwait(false);
            await InjectAsync(targets, forceIds, cancellationToken).ConfigureAwait(false);
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

    public async Task RestartAsync(CancellationToken cancellationToken)
    {
        await StopMonitorAsync().ConfigureAwait(false);
        var closed = await CloseManagedCodexAsync(cancellationToken).ConfigureAwait(false);
        if (!closed)
        {
            StartMonitor();
            throw new InvalidOperationException("Codex could not be closed for restart.");
        }

        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await DisposeBridgeAndTransportAsync().ConfigureAwait(false);
            if (pluginUpdateManager is not null)
            {
                await pluginUpdateManager.DisposeAsync().ConfigureAwait(false);
            }

            client?.Dispose();
            bridge = null;
            pluginUpdateManager = null;
            injector = null;
            client = null;
            registry = null;
            package = null;
            endpoint = null;
            scripts = [];
            activationProcessId = null;
            lastTargetCount = 0;
            lastInjectionAt = null;
        }
        finally
        {
            operation.Release();
        }

        await StartAsync(cancellationToken).ConfigureAwait(false);
        logger.Info("codex-restarted", new { activationProcessId, targetCount = lastTargetCount });
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
            activeHostCommand?.Cancel();
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

            var packageFamilyName = package.PackageFamilyName;
            if (await WaitForPackageExitAsync(packageFamilyName, GracefulRestartShutdownTimeout, cancellationToken).ConfigureAwait(false))
            {
                return true;
            }

            var gracefulRemaining = ProcessIdentity.FindProcessesByPackageFamily(packageFamilyName);
            logger.Warn("codex-graceful-close-incomplete", new { remainingProcessCount = gracefulRemaining.Count });
            var terminated = new HashSet<int>();
            var failureCodes = new Dictionary<int, int>();
            var deadline = DateTimeOffset.UtcNow + ForcedRestartShutdownTimeout;
            DateTimeOffset? emptySince = null;
            while (DateTimeOffset.UtcNow < deadline)
            {
                var remaining = ProcessIdentity.FindProcessesByPackageFamily(packageFamilyName);
                if (remaining.Count == 0)
                {
                    emptySince ??= DateTimeOffset.UtcNow;
                    if (DateTimeOffset.UtcNow - emptySince >= StablePackageExitWindow)
                    {
                        logger.Info("codex-force-closed", new { terminatedProcessCount = terminated.Count, failureCount = failureCodes.Count });
                        return true;
                    }
                }
                else
                {
                    emptySince = null;
                    var result = ProcessIdentity.TerminateProcessesByPackageFamily(packageFamilyName);
                    terminated.UnionWith(result.TerminatedProcessIds);
                    foreach (var failure in result.FailureCodes)
                    {
                        failureCodes[failure.Key] = failure.Value;
                    }
                }

                await Task.Delay(PackageExitPollInterval, cancellationToken).ConfigureAwait(false);
            }

            var finalRemaining = ProcessIdentity.FindProcessesByPackageFamily(packageFamilyName);
            logger.Warn("codex-force-close-incomplete", new
            {
                terminatedProcessCount = terminated.Count,
                remainingProcessCount = finalRemaining.Count,
                failureCodes = failureCodes.Values.Distinct().Order().ToArray(),
            });
            SetState(LoaderState.Degraded, "Codex package processes could not be stopped for a managed restart.");
            return false;
        }
        finally
        {
            operation.Release();
        }
    }

    private static async Task<bool> WaitForPackageExitAsync(
        string packageFamilyName,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        DateTimeOffset? emptySince = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (ProcessIdentity.FindProcessesByPackageFamily(packageFamilyName).Count == 0)
            {
                emptySince ??= DateTimeOffset.UtcNow;
                if (DateTimeOffset.UtcNow - emptySince >= StablePackageExitWindow)
                {
                    return true;
                }
            }
            else
            {
                emptySince = null;
            }

            await Task.Delay(PackageExitPollInterval, cancellationToken).ConfigureAwait(false);
        }

        return false;
    }

    private async Task InjectAsync(IReadOnlyList<CdpTarget> targets, IReadOnlySet<string>? forceIds, CancellationToken cancellationToken)
    {
        var plan = await registry!.BuildPlanAsync(forceIds, cancellationToken).ConfigureAwait(false);
        scripts = await injector!.InjectAsync(plan.Source, plan.Scripts, targets, cancellationToken).ConfigureAwait(false);
        lastTargetCount = targets.Count;
        lastInjectionAt = DateTimeOffset.UtcNow;
        var failed = scripts.Count(script => script.LifecycleResult != "running");
        SetState(failed == 0 ? LoaderState.Healthy : LoaderState.Degraded, failed == 0 ? null : $"{failed} renderer scripts failed to start.");
        logger.Info("scripts-injected", new { targetCount = targets.Count, scriptCount = plan.Scripts.Count, failed, plan.SafeMode });
    }

    private async Task<object> DispatchBridgeAsync(string command, JsonElement payload, CancellationToken cancellationToken)
    {
        if (registry is null)
        {
            throw new InvalidOperationException("Managed runtime is not ready.");
        }

        if (command is "reload_scripts" or "reload_plugins")
        {
            var ids = command == "reload_plugins" ? ReadIds(payload) : null;
            return await ReloadPluginsAsync(ids, cancellationToken).ConfigureAwait(false);
        }

        if (command == "page_companion_probe")
        {
            var pluginId = RequiredPayloadText(payload, "pluginId", 128);
            return await (pageCompanions ?? throw new InvalidOperationException("Page companion host is unavailable.")).ProbeAsync(pluginId, cancellationToken).ConfigureAwait(false);
        }

        if (command == "page_companion_bind")
        {
            var pluginId = RequiredPayloadText(payload, "pluginId", 128);
            return await (pageCompanions ?? throw new InvalidOperationException("Page companion host is unavailable.")).BindAsync(pluginId, cancellationToken).ConfigureAwait(false);
        }

        if (command == "page_companion_invoke")
        {
            var pluginId = RequiredPayloadText(payload, "pluginId", 128);
            var companionOperation = RequiredPayloadText(payload, "operation", 64);
            var companionPayload = payload.TryGetProperty("payload", out var supplied) && supplied.ValueKind == JsonValueKind.Object
                ? supplied.Clone()
                : JsonSerializer.SerializeToElement(new { });
            return await (pageCompanions ?? throw new InvalidOperationException("Page companion host is unavailable.")).InvokeAsync(pluginId, companionOperation, companionPayload, cancellationToken).ConfigureAwait(false);
        }

        if (command == "page_companion_unbind")
        {
            var pluginId = RequiredPayloadText(payload, "pluginId", 128);
            return await (pageCompanions ?? throw new InvalidOperationException("Page companion host is unavailable.")).UnbindAsync(pluginId, cancellationToken).ConfigureAwait(false);
        }

        if (command == "list_plugins")
        {
            var plugins = await registry.ListPluginsAsync(RuntimeById(), cancellationToken).ConfigureAwait(false);
            return plugins.Select(plugin => plugin with { Update = pluginUpdateManager?.SnapshotFor(plugin.Id) }).ToArray();
        }

        if (command == "set_plugin_enabled")
        {
            var id = RequiredPayloadText(payload, "id", 128);
            var enabled = RequiredPayloadBoolean(payload, "enabled");
            await registry.SetEnabledAsync(id, enabled, cancellationToken).ConfigureAwait(false);
            await ReloadAsync(new HashSet<string>(StringComparer.Ordinal), cancellationToken).ConfigureAwait(false);
            return (await registry.ListPluginsAsync(RuntimeById(), cancellationToken).ConfigureAwait(false)).Single(plugin => plugin.Id == id);
        }

        if (command is "pick_plugin_folder" or "pick_plugin_archive")
        {
            var picker = PackagePickerAsync ?? throw new InvalidOperationException("Plugin package picker is unavailable.");
            var archive = command == "pick_plugin_archive";
            var source = await picker(archive, cancellationToken).ConfigureAwait(false);
            return source is null
                ? new { cancelled = true }
                : await registry.StagePackageAsync(source, archive, cancellationToken).ConfigureAwait(false);
        }

        if (command == "preview_plugin_github")
        {
            var url = RequiredPayloadText(payload, "url", 2048);
            var asset = payload.TryGetProperty("asset", out _) ? RequiredPayloadText(payload, "asset", 164) : null;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Token);
            return await new GitHubPluginInstaller(paths, registry, new CurlUpdateTransport()).PreviewAsync(url, asset, timeout.Token).ConfigureAwait(false);
        }

        if (command == "install_plugin")
        {
            var token = RequiredPayloadText(payload, "token", 64);
            var enabled = RequiredPayloadBoolean(payload, "enabled");
            var plugin = await registry.InstallPendingAsync(token, enabled, cancellationToken, ReloadAndVerifyPluginAsync).ConfigureAwait(false);
            if (pluginUpdateManager is not null)
            {
                try { await pluginUpdateManager.RecordInstallationAsync(plugin.Id, CancellationToken.None).ConfigureAwait(false); }
                catch (Exception exception) { logger.Warn("plugin-install-update-state-failed", new { pluginId = plugin.Id, message = JsonlLogger.Redact(exception.Message) }); }
            }
            return plugin;
        }

        if (command == "cancel_plugin_install")
        {
            await registry.CancelPendingPackageAsync(RequiredPayloadText(payload, "token", 64), cancellationToken).ConfigureAwait(false);
            return new { cancelled = true };
        }

        if (command == "remove_plugin")
        {
            var record = await registry.QuarantineAsync(RequiredPayloadText(payload, "id", 128), cancellationToken).ConfigureAwait(false);
            await ReloadAsync(new HashSet<string>(StringComparer.Ordinal), cancellationToken).ConfigureAwait(false);
            return record;
        }

        if (command == "list_quarantined")
        {
            return await registry.ListQuarantinedAsync(cancellationToken).ConfigureAwait(false);
        }

        if (command == "restore_plugin")
        {
            var record = await registry.RestoreQuarantinedAsync(RequiredPayloadText(payload, "key", 128), cancellationToken).ConfigureAwait(false);
            await ReloadAsync(new HashSet<string>(StringComparer.Ordinal), cancellationToken).ConfigureAwait(false);
            return record;
        }

        if (command == "restart_codex")
        {
            _ = Task.Run(async () =>
            {
                await Task.Delay(250).ConfigureAwait(false);
                try { await RestartAsync(CancellationToken.None).ConfigureAwait(false); }
                catch (Exception exception) { logger.Error("restart-failed", exception); }
            });
            return new { accepted = true };
        }

        if (command == "get_update_status")
        {
            return UpdateManager?.Snapshot ?? throw new InvalidOperationException("Update manager is unavailable.");
        }

        if (command == "set_auto_update")
        {
            return await (UpdateManager ?? throw new InvalidOperationException("Update manager is unavailable."))
                .SetAutoUpdateAsync(RequiredPayloadBoolean(payload, "enabled"), cancellationToken).ConfigureAwait(false);
        }

        if (command == "check_for_updates")
        {
            return await (UpdateManager ?? throw new InvalidOperationException("Update manager is unavailable."))
                .CheckForUpdatesAsync(cancellationToken).ConfigureAwait(false);
        }

        if (command == "start_update")
        {
            var manager = UpdateManager ?? throw new InvalidOperationException("Update manager is unavailable.");
            _ = Task.Run(async () =>
            {
                try { await manager.StartUpdateAsync(CancellationToken.None).ConfigureAwait(false); }
                catch (Exception exception) { logger.Error("background-update-failed", exception); }
            });
            return new { accepted = true };
        }

        if (command == "cancel_update")
        {
            return (UpdateManager ?? throw new InvalidOperationException("Update manager is unavailable.")).CancelDownload();
        }

        if (command == "check_plugin_updates")
        {
            return await (pluginUpdateManager ?? throw new InvalidOperationException("Plugin update manager is unavailable."))
                .CheckAsync(ReadIds(payload), cancellationToken).ConfigureAwait(false);
        }

        if (command == "set_plugin_auto_update")
        {
            return await (pluginUpdateManager ?? throw new InvalidOperationException("Plugin update manager is unavailable."))
                .SetAutomaticAsync(RequiredPayloadText(payload, "id", 128), RequiredPayloadBoolean(payload, "enabled"), cancellationToken).ConfigureAwait(false);
        }

        if (command == "start_plugin_update")
        {
            var manager = pluginUpdateManager ?? throw new InvalidOperationException("Plugin update manager is unavailable.");
            var id = RequiredPayloadText(payload, "id", 128);
            _ = Task.Run(async () =>
            {
                try { await manager.StartUpdateAsync(id, CancellationToken.None).ConfigureAwait(false); }
                catch (Exception exception) { HandlePluginUpdateFailure("background-plugin-update-failed", id, exception); }
            });
            return new { accepted = true };
        }

        if (command == "confirm_plugin_update")
        {
            var manager = pluginUpdateManager ?? throw new InvalidOperationException("Plugin update manager is unavailable.");
            var id = RequiredPayloadText(payload, "id", 128);
            var token = RequiredPayloadText(payload, "token", 64);
            _ = Task.Run(async () =>
            {
                try { await manager.ConfirmAsync(id, token, CancellationToken.None).ConfigureAwait(false); }
                catch (Exception exception) { HandlePluginUpdateFailure("confirmed-plugin-update-failed", id, exception); }
            });
            return new { accepted = true };
        }

        if (command == "cancel_plugin_update")
        {
            return (pluginUpdateManager ?? throw new InvalidOperationException("Plugin update manager is unavailable."))
                .Cancel(RequiredPayloadText(payload, "id", 128));
        }

        var snapshot = Snapshot;
        return new
        {
            loader = snapshot.State is LoaderState.Healthy or LoaderState.Degraded ? "healthy" : snapshot.State.ToString().ToLowerInvariant(),
            codex = snapshot.Cdp is null ? "stopped" : "healthy",
            cdp = snapshot.State.ToString().ToLowerInvariant(),
            safeMode = registry?.SafeMode ?? false,
            managedProcess = snapshot.ActivationProcessId.HasValue,
            targetCount = lastTargetCount,
            enabledScripts = snapshot.Scripts.Count,
            failedScripts = snapshot.Scripts.Count(script => script.LifecycleResult != "running"),
            configHealthy = !(registry?.SafeMode ?? false),
            startedAt = snapshot.StartedAt,
            lastInjectionAt = snapshot.LastInjectionAt,
            lastError = snapshot.LastError,
            scope = "renderer-plugins-only",
        };
    }

    private async Task<PluginOperationResult> ReloadPluginsAsync(IReadOnlySet<string>? requestedIds, CancellationToken cancellationToken)
    {
        var installed = await registry!.ListPluginsAsync(RuntimeById(), cancellationToken).ConfigureAwait(false);
        var requested = requestedIds is null || requestedIds.Count == 0
            ? installed.Where(plugin => plugin.Enabled && plugin.Status != "invalid").Select(plugin => plugin.Id).ToArray()
            : requestedIds.ToArray();
        var installedById = installed.ToDictionary(plugin => plugin.Id, StringComparer.Ordinal);
        foreach (var id in requested)
        {
            if (!installedById.TryGetValue(id, out var plugin)) throw new InvalidOperationException($"Unknown plugin: {id}.");
            if (!plugin.Enabled) throw new InvalidOperationException($"Plugin is disabled: {id}.");
            if (plugin.Status == "invalid") throw new InvalidOperationException($"Plugin package is invalid: {id}.");
        }

        await ReloadAsync(requested.ToHashSet(StringComparer.Ordinal), cancellationToken).ConfigureAwait(false);
        var resultById = RuntimeById();
        var succeeded = requested.Where(id => resultById.TryGetValue(id, out var item) && item.LifecycleResult == "running").ToArray();
        var failed = requested.Except(succeeded, StringComparer.Ordinal).ToArray();
        return new PluginOperationResult(
            "live",
            requested,
            requested.Length,
            lastTargetCount,
            succeeded,
            failed,
            lastInjectionAt);
    }

    private IReadOnlyDictionary<string, ScriptLoadResult> RuntimeById() => scripts
        .GroupBy(script => script.Id, StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);

    private async Task ReloadAndVerifyPluginAsync(string id, CancellationToken cancellationToken)
    {
        var result = await ReloadPluginsAsync(new HashSet<string>(StringComparer.Ordinal) { id }, cancellationToken).ConfigureAwait(false);
        var lifecycle = scripts.Where(script => string.Equals(script.Id, id, StringComparison.Ordinal)).ToArray();
        if (result.Failed.Count > 0 || lifecycle.Length < Math.Max(1, lastTargetCount) || lifecycle.Any(script => script.LifecycleResult != "running" || script.ErrorCode is not null))
        {
            throw new InvalidOperationException($"Plugin lifecycle verification failed: {id}.");
        }
    }

    private async Task InitializePluginUpdateManagerAsync(CancellationToken cancellationToken)
    {
        if (registry is null) throw new InvalidOperationException("Plugin registry is unavailable.");
        if (pluginUpdateManager is not null) await pluginUpdateManager.DisposeAsync().ConfigureAwait(false);
        pluginUpdateManager = new PluginUpdateManager(paths, registry, logger, ReloadAndVerifyPluginAsync, () => endpoint is not null && lastTargetCount > 0);
        await pluginUpdateManager.InitializeAsync(cancellationToken).ConfigureAwait(false);
    }

    private void HandlePluginUpdateFailure(string eventName, string? pluginId, Exception exception)
    {
        if (exception is PluginUpdateRollbackException)
        {
            logger.Error(eventName, exception);
            SetState(LoaderState.Degraded, exception.Message);
            return;
        }
        logger.Warn(eventName, new { pluginId, message = JsonlLogger.Redact(exception.Message) });
    }

    private static IReadOnlySet<string>? ReadIds(JsonElement payload)
    {
        if (!payload.TryGetProperty("ids", out var ids) || ids.ValueKind == JsonValueKind.Null) return null;
        if (ids.ValueKind != JsonValueKind.Array || ids.GetArrayLength() > 64) throw new InvalidDataException("Plugin ids must be an array of at most 64 entries.");
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in ids.EnumerateArray())
        {
            var id = item.GetString();
            if (string.IsNullOrWhiteSpace(id) || id.Length > 128) throw new InvalidDataException("Plugin id is invalid.");
            result.Add(id);
        }

        return result;
    }

    private static string RequiredPayloadText(JsonElement payload, string name, int maxLength)
    {
        var value = payload.TryGetProperty(name, out var element) ? element.GetString() : null;
        if (string.IsNullOrWhiteSpace(value) || value.Length > maxLength || value.Any(char.IsControl)) throw new InvalidDataException($"Bridge payload {name} is invalid.");
        return value;
    }

    private static bool RequiredPayloadBoolean(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var element) || element.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new InvalidDataException($"Bridge payload {name} is invalid.");
        return element.GetBoolean();
    }

    private void StartMonitor()
    {
        monitorLifetime?.Cancel();
        monitorLifetime?.Dispose();
        monitorLifetime = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        monitorTask = Task.Run(() => MonitorAsync(monitorLifetime.Token));
    }

    private async Task StopMonitorAsync()
    {
        var cancellation = monitorLifetime;
        var task = monitorTask;
        monitorLifetime = null;
        monitorTask = null;
        cancellation?.Cancel();
        if (task is not null)
        {
            try { await task.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }

        cancellation?.Dispose();
    }

    private async Task MonitorAsync(CancellationToken cancellationToken)
    {
        var missingTicks = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(1000, cancellationToken).ConfigureAwait(false);
                var targets = client is null ? [] : await client.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
                if (targets.Count == 0)
                {
                    missingTicks++;
                    if (TryNotifyManagedCodexExit(missingTicks))
                    {
                        return;
                    }
                }
                else
                {
                    missingTicks = 0;
                    if (bridge is not null)
                    {
                        await bridge.SyncAsync(targets, cancellationToken).ConfigureAwait(false);
                    }
                    if (pageCompanions is not null) await pageCompanions.SyncAsync(cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception) when (exception is HttpRequestException or WebSocketException or InvalidOperationException)
            {
                missingTicks++;
                if (TryNotifyManagedCodexExit(missingTicks, exception))
                {
                    return;
                }
            }
        }
    }

    private bool TryNotifyManagedCodexExit(int missingTicks, Exception? connectionError = null)
    {
        if (package is not null)
        {
            try
            {
                var installed = PackageDiscovery.DiscoverCodexForCurrentUser();
                if (IsPackageUpgrade(package, installed))
                {
                    logger.Info("codex-package-update-detected", new
                    {
                        previousPackage = package.PackageFullName,
                        previousVersion = package.Version.ToString(),
                        installedPackage = installed.PackageFullName,
                        installedVersion = installed.Version.ToString(),
                    });
                    ManagedCodexExited?.Invoke(ManagedCodexExitReason.PackageUpdated);
                    return true;
                }
            }
            catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                if (missingTicks >= 5)
                {
                    logger.Warn("codex-package-update-detection-failed", new { message = JsonlLogger.Redact(exception.Message) });
                }
            }
        }

        if (missingTicks < 5)
        {
            return false;
        }

        if (connectionError is null)
        {
            logger.Info("managed-codex-exited");
        }
        else
        {
            logger.Warn("managed-codex-unreachable", new { message = JsonlLogger.Redact(connectionError.Message) });
        }

        ManagedCodexExited?.Invoke(ManagedCodexExitReason.Closed);
        return true;
    }

    internal static bool IsPackageUpgrade(CodexPackageIdentity current, CodexPackageIdentity installed) =>
        string.Equals(current.PackageFamilyName, installed.PackageFamilyName, StringComparison.OrdinalIgnoreCase) &&
        installed.Version > current.Version;

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
        await hostInvocation.WaitAsync().ConfigureAwait(false);
        await StopMonitorAsync().ConfigureAwait(false);

        if (bridge is not null)
        {
            await DisposeBridgeAndTransportAsync().ConfigureAwait(false);
        }
        else if (transport is not null)
        {
            await DisposeBridgeAndTransportAsync().ConfigureAwait(false);
        }
        if (pluginUpdateManager is not null)
        {
            await pluginUpdateManager.DisposeAsync().ConfigureAwait(false);
        }

        client?.Dispose();
        operation.Dispose();
        hostInvocation.Dispose();
        lifetime.Dispose();
    }

    private static string UserSkillRoot() => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agents", "skills");

    private async Task DisposeBridgeAndTransportAsync()
    {
        var currentPageCompanions = pageCompanions;
        pageCompanions = null;
        if (currentPageCompanions is not null) await currentPageCompanions.DisposeAsync().ConfigureAwait(false);
        var currentBridge = bridge;
        bridge = null;
        try
        {
            if (currentBridge is not null) await currentBridge.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            var currentTransport = transport;
            transport = null;
            if (currentTransport is not null) await currentTransport.DisposeAsync().ConfigureAwait(false);
        }
    }
}
