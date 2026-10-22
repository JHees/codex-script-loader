using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record AccountBackendUpdate(string State, string Revision, string? TargetRevision, int WorkerProcessId,
    int RouterProcessId, string? ErrorCode = null);

public sealed partial class AccountBackendCoordinator : IAsyncDisposable
{
    private readonly string dataDirectory, hostExecutable, uiPath;
    private readonly RouterHost router;
    private readonly AccountRuntimePackage packages;
    private readonly SemaphoreSlim management = new(1);
    private readonly object updateSync = new();
    private readonly CancellationTokenSource stop = new();
    private AccountWorkerProcess worker = null!;
    private AccountRuntimeManifest current = null!;
    private Task? updateTask;
    private AccountBackendUpdate update = new("starting", "", null, 0, Environment.ProcessId);
    public AccountBackendUpdate Snapshot => update;

    public AccountBackendCoordinator(string dataDirectory, string hostExecutable, string uiPath)
    {
        this.dataDirectory = Path.GetFullPath(dataDirectory);
        this.hostExecutable = Path.GetFullPath(hostExecutable);
        this.uiPath = Path.GetFullPath(uiPath);
        var store = new AccountStore(this.dataDirectory);
        packages = new(this.dataDirectory);
        router = new RouterHost(store, this.dataDirectory);
    }

    public async Task InitializeAsync(CancellationToken cancellation)
    {
        current = packages.EnsureCurrent(typeof(BackendService).Assembly.Location, uiPath);
        worker = await StartWorkerAsync(current, cancellation);
        update = new("idle", current.Revision, null, worker.Id, Environment.ProcessId);
        StartUpdateListener();
    }

    private async Task<AccountWorkerProcess> StartWorkerAsync(AccountRuntimeManifest manifest, CancellationToken cancellation)
    {
        _ = AccountRuntimePackage.Validate(packages.DirectoryFor(manifest.Revision));
        var process = new AccountWorkerProcess(hostExecutable, Path.Combine(packages.DirectoryFor(manifest.Revision), AccountRuntimePackage.AssemblyFile), HandleRouterAsync);
        try { await process.InitializeAsync(dataDirectory, cancellation); return process; }
        catch { await process.DisposeAsync(); throw; }
    }

    public async Task<JsonNode?> RequestAsync(string method, JsonObject parameters, CancellationToken cancellation)
    {
        if (method is not ("invoke" or "prepare_stop")) throw new InvalidOperationException("ACCOUNT_OPERATION_DENIED");
        await management.WaitAsync(cancellation);
        try
        {
            var result = await worker.Rpc.CallAsync(method, parameters, cancellation);
            var operation = parameters["operation"]?.GetValue<string>();
            if (operation == "status" && parameters["payload"]?["accountCommand"] is JsonObject command)
                operation = command["operation"]?.GetValue<string>();
            if (operation is "status" or "list_accounts" && result?["data"] is JsonObject data)
                data["backendUpdate"] = JsonSerializer.SerializeToNode(update, AccountStore.JsonOptions);
            return result;
        }
        finally { management.Release(); }
    }

    public AccountBackendUpdate BeginUpdate(string sourceDirectory)
    {
        var manifest = packages.Stage(sourceDirectory);
        lock (updateSync)
        {
            if (updateTask is { IsCompleted: false })
            {
                if (update.TargetRevision == manifest.Revision) return update;
                throw new InvalidOperationException("ACCOUNT_UPDATE_BUSY");
            }
            if (current.Revision == manifest.Revision && worker.IsRunning) return update;
            update = new("checking", current.Revision, manifest.Revision, worker.Id, Environment.ProcessId);
            updateTask = Task.Run(() => ApplyAsync(manifest));
            return update;
        }
    }

    private async Task ApplyAsync(AccountRuntimeManifest manifest)
    {
        AccountWorkerProcess? candidate = null;
        Task? retiredCleanup = null;
        try
        {
            candidate = await StartWorkerAsync(manifest, stop.Token);
            while (true)
            {
                await management.WaitAsync(stop.Token);
                try
                {
                    var state = worker.IsRunning ? await worker.Rpc.CallAsync("prepare_update", cancellation: stop.Token)
                        : JsonSerializer.SerializeToNode(new AccountManagementState(null, []), AccountStore.JsonOptions);
                    if (state is null)
                    {
                        update = update with { State = "waiting" };
                    }
                    else
                    {
                        update = update with { State = "switching" };
                        await candidate.Rpc.CallAsync("restore", state.AsObject(), stop.Token);
                        var existingUiHash = AccountRuntimePackage.Hash(uiPath);
                        if (existingUiHash != current.UiSha256 && existingUiHash != manifest.UiSha256) throw new InvalidOperationException("ACCOUNT_UPDATE_UI_CHANGED");
                        var originalUi = await File.ReadAllBytesAsync(uiPath, stop.Token);
                        var previous = current;
                        var temporaryUi = uiPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                        try
                        {
                            File.Copy(Path.Combine(packages.DirectoryFor(manifest.Revision), AccountRuntimePackage.UiFile), temporaryUi);
                            if (AccountRuntimePackage.Hash(temporaryUi) != manifest.UiSha256) throw new InvalidOperationException("ACCOUNT_UPDATE_HASH_MISMATCH");
                            File.Move(temporaryUi, uiPath, true);
                            try { packages.Activate(manifest.Revision, previous.Revision); }
                            catch
                            {
                                File.WriteAllBytes(temporaryUi, originalUi); File.Move(temporaryUi, uiPath, true);
                                throw;
                            }
                        }
                        finally { if (File.Exists(temporaryUi)) File.Delete(temporaryUi); }
                        var retired = worker;
                        worker = candidate; candidate = null; current = manifest;
                        update = new("succeeded", manifest.Revision, null, worker.Id, Environment.ProcessId);
                        retiredCleanup = retired.DisposeAsync().AsTask();
                        if (existingUiHash != manifest.UiSha256) RequestUiReload();
                        return;
                    }
                }
                finally { management.Release(); }
                await Task.Delay(500, stop.Token);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        catch (Exception error)
        {
            update = new("failed", current.Revision, manifest.Revision, worker.Id, Environment.ProcessId,
                error is InvalidOperationException && error.Message.StartsWith("ACCOUNT_UPDATE_", StringComparison.Ordinal) ? error.Message : "ACCOUNT_UPDATE_FAILED");
        }
        finally
        {
            if (candidate is not null) await candidate.DisposeAsync();
            if (retiredCleanup is not null) await retiredCleanup;
            AccountRuntimePackage.WriteJson(Path.Combine(packages.Root, "last-update.json"), update);
        }
    }

    private void RequestUiReload()
    {
        // Tests supply an isolated UI path; only the installed host's bundled UI triggers a desktop reload.
        if (!string.Equals(uiPath, Path.Combine(Path.GetDirectoryName(hostExecutable)!, "bundled", "accounts-ui.js"), StringComparison.OrdinalIgnoreCase)) return;
        var start = new ProcessStartInfo(hostExecutable) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("--reload");
        start.Environment.Remove("CODEX_SCRIPT_LOADER_ACCOUNTS");
        start.Environment.Remove(AccountBackendHost.WorkerAssemblyVariable);
        start.Environment.Remove(AccountBackendHost.CommandVariable);
        using var process = Process.Start(start);
    }

    private async Task<JsonNode?> HandleRouterAsync(AccountRpc sender, string method, JsonObject parameters, CancellationToken cancellation)
    {
        string Id() => parameters["id"]!.GetValue<string>();
        object? result;
        switch (method)
        {
            case "router/can_stop": result = router.CanStop; break;
            case "router/connected": result = router.Connected; break;
            case "router/account_busy": result = router.AccountBusy(Id()); break;
            case "router/bound_count": result = router.BoundCount(Id()); break;
            case "router/global_status": result = router.GlobalStatus; break;
            case "router/thread_status": result = router.ThreadStatus(Id()); break;
            case "router/retry_global": router.RetryGlobalSwitch(); result = true; break;
            case "router/read_account": result = await router.ReadAccountAsync(Id(), cancellation); break;
            case "router/switch": await router.SwitchAsync(Id(), parameters["accountId"]!.GetValue<string>(), cancellation); result = true; break;
            case "router/login":
                await router.LoginAsync(Id(), prompt => sender.NotifyAsync("login_prompt", new()
                {
                    ["callback"] = parameters["callback"]!.DeepClone(), ["prompt"] = JsonSerializer.SerializeToNode(prompt, AccountStore.JsonOptions),
                }), cancellation);
                result = true; break;
            default: throw new InvalidOperationException("ACCOUNT_OPERATION_DENIED");
        }
        return JsonSerializer.SerializeToNode(result, AccountStore.JsonOptions);
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        if (updateTask is not null) await updateTask;
        await StopUpdateListenerAsync();
        if (worker is not null) await worker.DisposeAsync();
        await router.DisposeAsync(); management.Dispose(); stop.Dispose();
    }
}
