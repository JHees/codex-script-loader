using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public static class AccountBackendHost
{
    internal const string WorkerAssemblyVariable = "CODEX_ACCOUNT_WORKER_ASSEMBLY";
    internal const string CommandVariable = "CODEX_ACCOUNT_BACKEND_COMMAND";

    public static async Task<int> RunAsync(string? uiPath = null)
    {
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        if (Environment.GetEnvironmentVariable(WorkerAssemblyVariable) is { Length: > 0 } assemblyPath)
        {
            var fullPath = Path.GetFullPath(assemblyPath);
            if (Path.GetFileName(fullPath) != AccountRuntimePackage.AssemblyFile) throw new InvalidOperationException("ACCOUNT_UPDATE_MANIFEST_INVALID");
            _ = AccountRuntimePackage.Validate(Path.GetDirectoryName(fullPath)!);
            var context = new AssemblyLoadContext("accounts-implementation", isCollectible: false);
            var assembly = context.LoadFromAssemblyPath(fullPath);
            var method = assembly.GetType(typeof(BackendService).FullName!)?.GetMethod(nameof(BackendService.RunWorkerAsync), BindingFlags.Public | BindingFlags.Static)
                ?? throw new InvalidOperationException("ACCOUNT_UPDATE_PROTOCOL");
            return await (Task<int>)method.Invoke(null, null)!;
        }
        if (Environment.GetEnvironmentVariable(CommandVariable) == "update") return await AccountBackendUpdater.RunAsync();
        AccountBackendCoordinator? backend = null;
        using var input = Console.OpenStandardInput(); using var output = Console.OpenStandardOutput();
        await using var rpc = new AccountRpc(input, output, async (method, parameters, cancellation) =>
        {
            if (method == "initialize" && backend is null)
            {
                if (parameters["protocolVersion"]?.GetValue<int>() != 1) throw new InvalidOperationException("ACCOUNT_UPDATE_PROTOCOL");
                backend = new(parameters["dataDirectory"]!.GetValue<string>(), Environment.ProcessPath!, uiPath ?? Path.Combine(AppContext.BaseDirectory, "bundled", "accounts-ui.js"));
                await backend.InitializeAsync(cancellation);
                return JsonSerializer.SerializeToNode(new { protocolVersion = 1, version = BackendService.Version }, AccountStore.JsonOptions);
            }
            if (backend is null) throw new InvalidOperationException("ACCOUNT_BACKEND_NOT_READY");
            return await backend.RequestAsync(method, parameters, cancellation);
        }, 64 * 1024);
        try { await rpc.Completion; }
        finally { if (backend is not null) await backend.DisposeAsync(); }
        return 0;
    }
}
