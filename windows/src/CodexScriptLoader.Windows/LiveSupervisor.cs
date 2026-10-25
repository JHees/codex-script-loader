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
    public const string Version = "0.6.0-alpha";
    private const string TrustedInputPermission = "trusted-input";
    private static readonly TimeSpan GracefulRestartShutdownTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan ForcedRestartShutdownTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan MonitorInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan PackageExitPollInterval = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan CloseGracePollInterval = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan StablePackageExitWindow = TimeSpan.FromMilliseconds(500);
    private readonly LoaderPaths paths;
    private readonly JsonlLogger logger;
    private readonly AccountModule accounts;
    private readonly string accountUiPath;
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
    private readonly ManagedCodexLifecycleTracker lifecycle = new();
    private int? activationProcessId;
    private int lastTargetCount;
    private string? lastError;
    private DateTimeOffset? lastInjectionAt;
    private bool packageDiscoveryWarningReported;
    private bool monitorSamplingFailureReported;

    public LiveSupervisor(LoaderPaths paths, JsonlLogger logger)
    {
        this.paths = paths;
        this.logger = logger;
        accounts = new AccountModule(paths, Environment.ProcessPath ?? throw new InvalidOperationException("Loader executable is unavailable."));
        accountUiPath = Path.Combine(AppContext.BaseDirectory, "bundled", "accounts-ui.js");
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

    private string ManagedPackageFamilyName => package?.PackageFamilyName ?? PackageDiscovery.CodexPackageFamilyName;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            lifecycle.Reset();
            SetState(LoaderState.Starting, null);
            package = PackageDiscovery.DiscoverCodexForCurrentUser();
            var existing = ProcessIdentity.FindProcessesByPackageFamily(package.PackageFamilyName);
            CdpEndpointIdentity? adoptedEndpoint = null;
            if (existing.Count > 0)
            {
                // A managed Codex left by a previous Loader can be adopted without
                // restarting it. Otherwise a Store update may have relaunched Codex
                // before Loader starts; wait for it to close instead of force-killing.
                adoptedEndpoint = await TryFindManagedEndpointAsync(package, existing, cancellationToken).ConfigureAwait(false);
                if (adoptedEndpoint is null)
                {
                    logger.Info("codex-already-running", new { processCount = existing.Count });
                    if (!await WaitForPackageExitAsync(package.PackageFamilyName, TimeSpan.FromSeconds(2), cancellationToken).ConfigureAwait(false))
                    {
                        RequestCodexClose(existing);
                        logger.Info("codex-start-waiting", new { processCount = existing.Count });
                        if (!await WaitForPackageExitAsync(package.PackageFamilyName, TimeSpan.FromMinutes(5), cancellationToken).ConfigureAwait(false))
                            throw new InvalidOperationException("Codex is still running. Close it completely before managed launch.");
                    }
                }
                else logger.Info("codex-adoptable", new { port = adoptedEndpoint.Port, ownerPid = adoptedEndpoint.OwnerPid });
            }

            var settingsHost = Path.Combine(AppContext.BaseDirectory, "bundled", "settings-host.mjs");
            var bundledExample = Path.Combine(AppContext.BaseDirectory, "bundled", "example-ui-plugin");
            registry = new ScriptRegistry(paths, settingsHost, UserSkillRoot(), DirectoryJunction.Create);
            registry.BuiltinSource = () => accounts.BuildUiSource(File.ReadAllText(accountUiPath));
            await registry.InitializeAsync(cancellationToken).ConfigureAwait(false);
            await registry.EnsureBundledScriptAsync(bundledExample, cancellationToken).ConfigureAwait(false);
            await InitializePluginUpdateManagerAsync(cancellationToken).ConfigureAwait(false);

            var port = adoptedEndpoint?.Port ?? AllocateLoopbackPort();
            client = new CdpClient(port);
            await RetireAccountPluginAsync(cancellationToken).ConfigureAwait(false);
            var launchPlan = await registry.BuildPlanAsync(force: false, cancellationToken).ConfigureAwait(false);
            await accounts.InitializeAsync(launchPlan.SafeMode, cancellationToken).ConfigureAwait(false);
            var extension = accounts.IsRunning;
            if (extension) await AtomicJsonFile.WriteAsync(AccountModule.LaunchPath(paths), new AccountLaunch(package.PackageFullName, package.PackageFamilyName), cancellationToken).ConfigureAwait(false);
            string[] activationArguments = [
                "--remote-debugging-address=127.0.0.1",
                $"--remote-debugging-port={port}",
                $"--remote-allow-origins=http://127.0.0.1:{port}",
            ];
            if (adoptedEndpoint is not null) activationProcessId = adoptedEndpoint.OwnerPid;
            else if (!extension) activationProcessId = ApplicationActivator.Activate(package, activationArguments);
            else
            {
                foreach (var variable in new[] { "CODEX_CLI_PATH", "CODEX_APP_SERVER_WS_URL", "CODEX_APP_SERVER_FORCE_CLI", AccountModule.EnvironmentVariable })
                    if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable(variable))) throw new InvalidOperationException($"Existing {variable} conflicts with the desktop CLI extension.");
                using var lease = new PackageEnvironmentLease(package.PackageFullName);
                var launchEnvironment = new Dictionary<string, string>
                {
                    ["CODEX_CLI_PATH"] = Environment.ProcessPath!,
                    [AccountModule.EnvironmentVariable] = "1",
                };
                foreach (var variable in new[] { "CODEX_HOME", "CODEX_SQLITE_HOME" })
                    if (Environment.GetEnvironmentVariable(variable) is { Length: > 0 } value) launchEnvironment[variable] = value;
                lease.Enable($"\"{Environment.ProcessPath!}\"", launchEnvironment);
                activationProcessId = ApplicationActivator.Activate(package, activationArguments);
                var receipt = Path.Combine(paths.StateRoot, $"desktop-cli-resumed-{activationProcessId}.json");
                var deadline = DateTime.UtcNow.AddSeconds(20);
                while (!File.Exists(receipt))
                {
                    if (DateTime.UtcNow >= deadline) throw new TimeoutException("Desktop CLI activation helper did not complete.");
                    await Task.Delay(100, cancellationToken).ConfigureAwait(false);
                }
                File.Delete(receipt);
            }
            logger.Info(adoptedEndpoint is null ? "codex-activated" : "codex-adopted", new { package.PackageFullName, package.AppUserModelId, activationProcessId, port });

            var targets = await WaitForTargetsAsync(client, TimeSpan.FromSeconds(120), cancellationToken).ConfigureAwait(false);
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

            if (adoptedEndpoint is not null && (adoptedEndpoint.Port != owner.Port || adoptedEndpoint.OwnerPid != owner.ProcessId))
                throw new InvalidOperationException("Adopted Codex listener identity changed before injection.");
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
            registry.BuiltinSource = () => accounts.BuildUiSource(File.ReadAllText(accountUiPath));
            await registry.InitializeAsync(cancellationToken).ConfigureAwait(false);
            await RetireAccountPluginAsync(cancellationToken).ConfigureAwait(false);
            await accounts.InitializeAsync(registry.SafeMode, cancellationToken).ConfigureAwait(false);
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
            await accounts.SuspendAsync(CancellationToken.None).ConfigureAwait(false);
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
            await accounts.InitializeAsync(registry.SafeMode, cancellationToken).ConfigureAwait(false);
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
        var packageFamilyName = ManagedPackageFamilyName;
        var closed = await CloseManagedCodexAsync(cancellationToken).ConfigureAwait(false);
        if (!closed)
        {
            logger.Warn("codex-restart-close-incomplete");
        }

        // CloseManagedCodexAsync returns true without touching processes when the
        // managed CDP client is unavailable. Always verify the package family is
        // empty so the replacement StartAsync cannot fail with "already running".
        if (!await EnsurePackageProcessesExitedAsync(packageFamilyName, cancellationToken).ConfigureAwait(false))
        {
            // Keep watching the old instance instead of re-arming update
            // reporting, so a failed recovery attempt cannot trigger a second
            // ManagedCodexExited(PackageUpdated) event.
            StartMonitor();
            throw new InvalidOperationException("Codex package processes could not be terminated for a managed restart.");
        }

        lifecycle.Reset();

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

    public void TerminateManagedCodex()
    {
        ReapResidualPackageProcesses();
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
            if (await EnsurePackageProcessesExitedAsync(packageFamilyName, cancellationToken).ConfigureAwait(false))
            {
                logger.Info("codex-force-closed");
                return true;
            }

            SetState(LoaderState.Degraded, "Codex package processes could not be stopped for a managed restart.");
            return false;
        }
        finally
        {
            operation.Release();
        }
    }

    private static async Task<CdpEndpointIdentity?> TryFindManagedEndpointAsync(
        CodexPackageIdentity package, IReadOnlyList<int> processIds, CancellationToken cancellationToken)
    {
        var candidates = processIds.ToHashSet();
        foreach (var listener in TcpOwnerLookup.GetIPv4LoopbackListeners())
        {
            if (!candidates.Contains(listener.ProcessId) ||
                !string.Equals(ProcessIdentity.TryGetPackageFamilyName(listener.ProcessId), package.PackageFamilyName, StringComparison.OrdinalIgnoreCase))
                continue;
            try
            {
                using var probe = new CdpClient(listener.Port);
                var targets = await probe.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
                if (targets.FirstOrDefault(target => target.Url == "app://-/index.html") is { } target)
                    return new CdpEndpointIdentity(listener.Address, listener.Port, listener.ProcessId, package.PackageFamilyName, target.Url);
            }
            catch (Exception exception) when (exception is HttpRequestException or WebSocketException or InvalidOperationException or TaskCanceledException)
            {
            }
        }
        return null;
    }

    private void RequestCodexClose(IReadOnlyList<int> processIds)
    {
        var requested = 0;
        foreach (var processId in processIds)
        {
            try
            {
                using var process = System.Diagnostics.Process.GetProcessById(processId);
                if (process.HasExited || process.MainWindowHandle == IntPtr.Zero) continue;
                if (process.CloseMainWindow()) requested++;
            }
            catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
            {
            }
        }
        logger.Info("codex-close-requested", new { requested, processCount = processIds.Count });
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

    /// <summary>
    /// Terminates any remaining processes of the managed package family and waits
    /// for a stable empty snapshot. Returns false only when processes stay alive
    /// past the forced shutdown deadline.
    /// </summary>
    private async Task<bool> EnsurePackageProcessesExitedAsync(string packageFamilyName, CancellationToken cancellationToken)
    {
        var terminated = new HashSet<int>();
        var failureCodes = new Dictionary<int, int>();
        var deadline = DateTimeOffset.UtcNow + ForcedRestartShutdownTimeout;
        DateTimeOffset? emptySince = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            IReadOnlyList<int> remaining;
            try
            {
                remaining = ProcessIdentity.FindProcessesByPackageFamily(packageFamilyName);
            }
            catch (Exception exception) when (exception is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                logger.Warn("codex-package-process-scan-failed", new { message = JsonlLogger.Redact(exception.Message) });
                return false;
            }

            if (remaining.Count == 0)
            {
                emptySince ??= DateTimeOffset.UtcNow;
                if (DateTimeOffset.UtcNow - emptySince >= StablePackageExitWindow)
                {
                    if (terminated.Count > 0)
                    {
                        logger.Info("codex-residual-processes-terminated", new
                        {
                            terminatedProcessCount = terminated.Count,
                            failureCount = failureCodes.Count,
                        });
                    }

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
        logger.Warn("codex-package-processes-remaining", new
        {
            terminatedProcessCount = terminated.Count,
            remainingProcessCount = finalRemaining.Count,
            failureCodes = failureCodes.Values.Distinct().Order().ToArray(),
        });
        return finalRemaining.Count == 0;
    }

    private async Task RetireAccountPluginAsync(CancellationToken cancellation)
    {
        if (Directory.Exists(Path.Combine(paths.ScriptsRoot, AccountModule.LegacyPluginId)))
            await registry!.QuarantineAsync(AccountModule.LegacyPluginId, cancellation).ConfigureAwait(false);
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

        if (command == "get_accounts_status") return await accounts.StatusAsync(cancellationToken).ConfigureAwait(false);
        if (command == "set_accounts_enabled")
        {
            if (!payload.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new ArgumentException("A boolean enabled value is required.");
            await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await accounts.SetEnabledAsync(value.GetBoolean(), cancellationToken).ConfigureAwait(false);
                var targets = await client!.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
                await InjectAsync(targets, new HashSet<string>(StringComparer.Ordinal), cancellationToken).ConfigureAwait(false);
                return await accounts.StatusAsync(cancellationToken).ConfigureAwait(false);
            }
            finally { operation.Release(); }
        }
        if (command == "accounts_invoke")
        {
            var body = payload.TryGetProperty("payload", out var supplied) && supplied.ValueKind == JsonValueKind.Object
                ? supplied.Clone() : JsonSerializer.SerializeToElement(new { });
            return (object?)await accounts.InvokeAsync(RequiredPayloadText(payload, "operation", 64), body, cancellationToken).ConfigureAwait(false) ?? new { };
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
        var connectionDegraded = false;
        var detachedReported = false;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(MonitorInterval, cancellationToken).ConfigureAwait(false);
                var sample = await SampleLifecycleAsync(cancellationToken).ConfigureAwait(false);
                if (ManagedCodexLifecyclePolicy.IsGrace(sample.Decision))
                {
                    string? loggedGraceReason = null;
                    while (!cancellationToken.IsCancellationRequested && ManagedCodexLifecyclePolicy.IsGrace(sample.Decision))
                    {
                        if (!string.Equals(loggedGraceReason, sample.Decision.Reason, StringComparison.Ordinal))
                        {
                            loggedGraceReason = sample.Decision.Reason;
                            LogManagedCodexGrace(sample);
                        }

                        await Task.Delay(CloseGracePollInterval, cancellationToken).ConfigureAwait(false);
                        sample = await SampleLifecycleAsync(cancellationToken).ConfigureAwait(false);
                    }
                }
                monitorSamplingFailureReported = false;

                switch (sample.Decision.Action)
                {
                    case ManagedCodexLifecycleAction.ReportUpdate:
                        logger.Info("codex-package-update-detected", new
                        {
                            previousPackage = package?.PackageFullName,
                            previousVersion = package?.Version.ToString(),
                            installedVersion = sample.InstalledVersion?.ToString(),
                        });
                        ManagedCodexExited?.Invoke(ManagedCodexExitReason.PackageUpdated);
                        return;
                    case ManagedCodexLifecycleAction.Exit:
                        logger.Info("managed-codex-exited", new
                        {
                            reason = sample.Decision.Reason,
                            packageProcessCount = sample.PackageProcessCount,
                        });
                        ReapResidualPackageProcesses();
                        ManagedCodexExited?.Invoke(ManagedCodexExitReason.Closed);
                        return;
                }

                if (sample.Targets.Count == 0)
                {
                    if (!detachedReported)
                    {
                        detachedReported = true;
                        logger.Warn("managed-codex-detached", new
                        {
                            reason = sample.Decision.Reason,
                            packageProcessCount = sample.PackageProcessCount,
                            graceSeconds = ManagedCodexLifecyclePolicy.GracePeriodFor(sample.PackageRegistered).TotalSeconds,
                            activationProcessId,
                            message = sample.ConnectionError is null ? null : JsonlLogger.Redact(sample.ConnectionError.Message),
                        });
                        SetState(LoaderState.Degraded, "Codex renderer is not reachable; waiting for the managed package process.");
                    }

                    continue;
                }

                var wasDetached = detachedReported;
                detachedReported = false;
                // A bridge failure is not evidence that the Codex process
                // exited: target discovery above has just succeeded.
                await operation.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    if (bridge is not null)
                    {
                        var recovered = await bridge.SyncAsync(sample.Targets, cancellationToken).ConfigureAwait(false);
                        if (recovered > 0) logger.Info("managed-bridge-reconnected", new { targetCount = recovered });
                    }
                    if (pageCompanions is not null) await pageCompanions.SyncAsync(cancellationToken).ConfigureAwait(false);
                    if (connectionDegraded || wasDetached)
                    {
                        var failed = scripts.Count(script => script.LifecycleResult != "running");
                        SetState(failed == 0 ? LoaderState.Healthy : LoaderState.Degraded, failed == 0 ? null : $"{failed} renderer scripts failed to start.");
                        logger.Info("managed-connection-recovered", new { targetCount = sample.Targets.Count, wasDetached });
                        connectionDegraded = false;
                    }
                }
                catch (Exception exception) when (IsTransientConnectionFailure(exception) && !cancellationToken.IsCancellationRequested)
                {
                    if (!connectionDegraded) logger.Warn("managed-bridge-retry", new { message = JsonlLogger.Redact(exception.Message) });
                    connectionDegraded = true;
                    SetState(LoaderState.Degraded, exception.Message);
                }
                finally { operation.Release(); }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                if (!monitorSamplingFailureReported)
                {
                    monitorSamplingFailureReported = true;
                    logger.Warn("managed-codex-monitor-failed", new { message = JsonlLogger.Redact(exception.Message) });
                }

                connectionDegraded = true;
                SetState(LoaderState.Degraded, exception.Message);
            }
        }
    }

    private void LogManagedCodexGrace(ManagedCodexLifecycleSample sample)
    {
        if (sample.Decision.Reason == "awaiting-package-registration")
        {
            logger.Info("managed-codex-awaiting-package-registration", new
            {
                graceSeconds = ManagedCodexLifecyclePolicy.PackageUnregisteredGracePeriod.TotalSeconds,
                packageProcessCount = sample.PackageProcessCount,
                installedVersion = sample.InstalledVersion?.ToString(),
            });
            return;
        }

        logger.Info("managed-codex-close-grace", new
        {
            graceSeconds = ManagedCodexLifecyclePolicy.CloseExitGracePeriod.TotalSeconds,
            packageProcessCount = sample.PackageProcessCount,
        });
    }

    private async Task<ManagedCodexLifecycleSample> SampleLifecycleAsync(CancellationToken cancellationToken)
    {
        IReadOnlyList<CdpTarget> targets = [];
        Exception? connectionError = null;
        try
        {
            targets = client is null ? [] : await client.GetCodexTargetsAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsTransientConnectionFailure(exception) && !cancellationToken.IsCancellationRequested)
        {
            connectionError = exception;
        }

        var packageFamilyName = ManagedPackageFamilyName;
        Version? installedVersion = null;
        var packageProcessCount = 0;
        // A live renderer implies a registered package; while detached the
        // registration is sampled directly so an update window is distinguishable
        // from an ordinary close.
        var packageRegistered = targets.Count > 0;
        if (targets.Count == 0)
        {
            try
            {
                var installed = PackageDiscovery.DiscoverCodexForCurrentUser();
                packageDiscoveryWarningReported = false;
                if (string.Equals(installed.PackageFamilyName, packageFamilyName, StringComparison.OrdinalIgnoreCase))
                {
                    packageRegistered = true;
                    installedVersion = installed.Version;
                }
            }
            catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // The package is unregistered for a moment while Store updates it.
                // An unknown version means "keep waiting", never "exit".
                if (!packageDiscoveryWarningReported)
                {
                    packageDiscoveryWarningReported = true;
                    logger.Warn("codex-package-discovery-failed", new { message = JsonlLogger.Redact(exception.Message) });
                }
            }

            packageProcessCount = CountPackageProcesses(packageFamilyName);
        }

        var decision = lifecycle.Observe(
            DateTimeOffset.UtcNow,
            targetPresent: targets.Count > 0,
            packageProcessCount,
            package?.Version,
            installedVersion,
            packageRegistered);
        return new ManagedCodexLifecycleSample(decision, targets, connectionError, installedVersion, packageProcessCount, packageRegistered);
    }

    private int CountPackageProcesses(string packageFamilyName)
    {
        try
        {
            return ProcessIdentity.FindProcessesByPackageFamily(packageFamilyName).Count;
        }
        catch (Exception exception) when (exception is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            logger.Warn("codex-package-process-scan-failed", new { message = JsonlLogger.Redact(exception.Message) });
            // An unknown process count must never be treated as "all processes exited".
            return 1;
        }
    }

    private static bool IsTransientConnectionFailure(Exception exception) =>
        exception is HttpRequestException or WebSocketException or InvalidOperationException or IOException or OperationCanceledException;

    private sealed record ManagedCodexLifecycleSample(
        ManagedCodexLifecycleDecision Decision,
        IReadOnlyList<CdpTarget> Targets,
        Exception? ConnectionError,
        Version? InstalledVersion,
        int PackageProcessCount,
        bool PackageRegistered);

    private void ReapResidualPackageProcesses()
    {
        if (package is null) return;
        try
        {
            var remaining = ProcessIdentity.FindProcessesByPackageFamily(package.PackageFamilyName);
            if (remaining.Count == 0) return;
            var result = ProcessIdentity.TerminateProcessesByPackageFamily(package.PackageFamilyName);
            logger.Info("codex-residual-processes-terminated", new
            {
                matchedProcessCount = result.MatchedProcessIds.Count,
                terminatedProcessCount = result.TerminatedProcessIds.Count,
                failureCount = result.FailureCodes.Count,
            });
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            logger.Warn("codex-residual-process-cleanup-failed", new { message = JsonlLogger.Redact(exception.Message) });
        }
    }

    internal static bool IsPackageUpgrade(CodexPackageIdentity current, CodexPackageIdentity installed) =>
        string.Equals(current.PackageFamilyName, installed.PackageFamilyName, StringComparison.OrdinalIgnoreCase) &&
        ManagedCodexLifecyclePolicy.IsVersionUpgrade(current.Version, installed.Version);

    internal void ReportRecoveryFailure(string message) => SetState(LoaderState.Degraded, message);

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

        throw new TimeoutException("Codex CDP did not become ready within 120 seconds.", lastError);
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
        await accounts.DisposeAsync().ConfigureAwait(false);
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
