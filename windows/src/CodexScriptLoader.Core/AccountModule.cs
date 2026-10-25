using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CodexScriptLoader.Accounts;

namespace CodexScriptLoader.Core;

public sealed class AccountModuleException(string code) : InvalidOperationException(code);
public sealed record AccountModulePreferences(bool Enabled = false);
public sealed record AccountModuleStatus(bool Enabled, string State, bool RoutingAvailable, bool NeedsRestart, string? ErrorCode = null);
public sealed record AccountLaunch(string PackageFullName, string PackageFamilyName);

public sealed class AccountModule(LoaderPaths paths, string hostExecutable) : IAsyncDisposable
{
    public const string EnvironmentVariable = "CODEX_SCRIPT_LOADER_ACCOUNTS";
    public const string LegacyPluginId = "io.github.jhees.codex-account-switcher";
    private readonly SemaphoreSlim gate = new(1);
    private AccountProcess? process;
    private bool enabled;
    private bool safeMode;
    public string DataDirectory => Path.Combine(paths.DataRoot, "accounts");
    public static string PreferencesPath(LoaderPaths paths) => Path.Combine(paths.DataRoot, "accounts-settings.json");
    public static string LaunchPath(LoaderPaths paths) => Path.Combine(paths.StateRoot, "accounts-launch.json");
    public bool IsRunning => enabled && process?.IsRunning == true;
    private static readonly HashSet<string> Operations = new(StringComparer.Ordinal)
    {
        "status", "list_accounts", "list_imports", "import_account", "rename_account", "set_enabled",
        "remove_account", "set_default", "begin_login", "begin_probe", "operation_status", "cancel_operation",
        "thread_status", "switch_thread", "refresh_accounts", "list_threads", "set_new_chat_policy", "test_usage", "batch_accounts",
        "create_provider", "save_provider_configuration", "get_provider_configuration", "activate_provider_version",
        "begin_provider_models",
    };

    public async Task InitializeAsync(bool isSafeMode, CancellationToken cancellation)
    {
        await gate.WaitAsync(cancellation);
        try
        {
            safeMode = isSafeMode;
            enabled = (await AtomicJsonFile.ReadAsync<AccountModulePreferences>(PreferencesPath(paths), cancellation))?.Enabled == true;
            if (enabled && !safeMode) await StartCoreAsync(cancellation);
        }
        finally { gate.Release(); }
    }

    private async Task StartCoreAsync(CancellationToken cancellation)
    {
        if (process?.IsRunning == true) return;
        if (process is not null) await process.DisposeAsync();
        process = null;
        AccountDataMigration.EnsureStore(DataDirectory, Path.Combine(paths.DataRoot, "plugin-data", LegacyPluginId));
        // Consolidate history before the backend starts so its initialize call is not blocked by file copies.
        try
        {
            var primary = Environment.GetEnvironmentVariable("CODEX_HOME");
            if (string.IsNullOrEmpty(primary)) primary = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
            HistoryLayout.Migrate(new AccountStore(DataDirectory), DataDirectory, primary, Environment.GetEnvironmentVariable("CODEX_SQLITE_HOME"));
        }
        catch (Exception) { /* The router retries and falls back to the isolated layout. */ }
        var start = new ProcessStartInfo(hostExecutable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false),
        };
        start.ArgumentList.Add("--accounts-backend");
        start.Environment.Remove(EnvironmentVariable);
        var candidate = new AccountProcess(start);
        try
        {
            var ready = await candidate.RequestAsync("initialize", new JsonObject
            {
                ["protocolVersion"] = 1, ["dataDirectory"] = DataDirectory,
            }, cancellation);
            if (ready?["protocolVersion"]?.GetValue<int>() != 1) throw new AccountModuleException("ACCOUNT_MODULE_PROTOCOL");
            process = candidate;
        }
        catch { await candidate.DisposeAsync(); throw; }
    }

    public async Task SetEnabledAsync(bool value, CancellationToken cancellation)
    {
        await gate.WaitAsync(cancellation);
        try
        {
            if (value)
            {
                if (safeMode) throw new AccountModuleException("ACCOUNT_MODULE_SAFE_MODE");
                var wasRunning = process?.IsRunning == true;
                await StartCoreAsync(cancellation);
                try { await AtomicJsonFile.WriteAsync(PreferencesPath(paths), new AccountModulePreferences(true), cancellation); }
                catch { if (!wasRunning) { await process!.DisposeAsync(); process = null; } throw; }
                enabled = true;
            }
            else
            {
                await AtomicJsonFile.WriteAsync(PreferencesPath(paths), new AccountModulePreferences(false), cancellation);
                enabled = false;
                // The desktop's existing app-server connection lives in this process until restart.
            }
        }
        finally { gate.Release(); }
    }

    public async Task<AccountModuleStatus> StatusAsync(CancellationToken cancellation)
    {
        await gate.WaitAsync(cancellation);
        try
        {
            if (!enabled) return process?.IsRunning == true
                ? new(false, "pending_restart", false, true)
                : new(false, "stopped", false, false);
            if (safeMode) return new(true, "stopped", false, false, "ACCOUNT_MODULE_SAFE_MODE");
            if (process?.IsRunning != true) return new(true, "unavailable", false, false, "ACCOUNT_MODULE_UNAVAILABLE");
            try
            {
                var result = await InvokeCoreAsync("status", new JsonObject(), cancellation);
                var routed = result?["data"]?["routingAvailable"]?.GetValue<bool>() == true;
                return new(true, "running", routed, !routed);
            }
            catch (AccountModuleException) { return new(true, "unavailable", false, false, "ACCOUNT_MODULE_UNAVAILABLE"); }
        }
        finally { gate.Release(); }
    }

    public async Task<JsonNode?> InvokeAsync(string operation, JsonElement payload, CancellationToken cancellation)
    {
        if (!Operations.Contains(operation)) throw new AccountModuleException("ACCOUNT_OPERATION_DENIED");
        await gate.WaitAsync(cancellation);
        try
        {
            if (!IsRunning) throw new AccountModuleException("ACCOUNT_MODULE_DISABLED");
            return await InvokeCoreAsync(operation, JsonNode.Parse(payload.GetRawText())!, cancellation);
        }
        finally { gate.Release(); }
    }

    private Task<JsonNode?> InvokeCoreAsync(string operation, JsonNode payload, CancellationToken cancellation) =>
        process!.RequestAsync("invoke", new JsonObject { ["operation"] = operation, ["payload"] = payload }, cancellation);

    private async Task EnsureIdleAsync(CancellationToken cancellation)
    {
        if (process?.IsRunning != true) return;
        var result = await process.RequestAsync("prepare_stop", new JsonObject(), cancellation);
        if (result?["canStop"]?.GetValue<bool>() != true) throw new AccountModuleException("ACCOUNT_MODULE_BUSY");
    }

    public async Task SuspendAsync(CancellationToken cancellation)
    {
        await gate.WaitAsync(cancellation);
        try
        {
            await EnsureIdleAsync(cancellation);
            if (process is not null) { await process.DisposeAsync(); process = null; }
        }
        finally { gate.Release(); }
    }

    public string BuildUiSource(string source)
    {
        if (!IsRunning) return "globalThis.__codexLoaderAccounts?.stop?.();";
        return $$"""
      (() => {
        globalThis.__codexLoaderAccounts?.stop?.();
        if ({{(IsRunning ? "true" : "false")}}) {
          const runtime = globalThis.__codexScriptLoader;
          const request = (command, payload = {}) => globalThis.__codexScriptLoaderHostBridge.request(command, payload);
          ((api) => {
            {{source}}
          })({
            version: {{JsonSerializer.Serialize(BackendService.Version)}},
            settings: { registerPage: page => runtime.settingsHost.registerPage("loader", { name: "账号管理" }, page) },
            backend: {
              status: () => request("get_accounts_status"),
              invoke: (operation, payload = {}) => request("accounts_invoke", { operation, payload })
            }
          });
        }
      })();
      """;
    }

    public async ValueTask DisposeAsync()
    {
        await gate.WaitAsync();
        try { if (process is not null) { await process.DisposeAsync(); process = null; } }
        finally { gate.Release(); }
    }
}
