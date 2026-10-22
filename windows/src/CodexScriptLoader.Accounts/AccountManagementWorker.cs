using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

internal static class AccountManagementWorker
{
    public static async Task<int> RunAsync()
    {
        AccountRpc? rpc = null;
        BackendService? service = null;
        var router = new RemoteAccountRouter(() => rpc!);
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        rpc = new AccountRpc(input, output, async (method, parameters, cancellation) =>
        {
            if (method == "login_prompt") return await router.HandleAsync(method, parameters);
            object? result;
            if (method == "initialize" && service is null)
            {
                if (parameters["protocolVersion"]?.GetValue<int>() != 1) throw new InvalidOperationException("ACCOUNT_UPDATE_PROTOCOL");
                var store = new AccountStore(parameters["dataDirectory"]!.GetValue<string>());
                _ = store.List();
                service = new BackendService(store, router);
                result = new { protocolVersion = 1, accountCommandProtocol = 2, version = BackendService.Version, processId = Environment.ProcessId };
            }
            else if (service is null) throw new InvalidOperationException("ACCOUNT_BACKEND_NOT_READY");
            else if (method == "prepare_update") result = service.CaptureManagementState();
            else if (method == "restore")
            {
                service.RestoreManagementState(parameters.Deserialize<AccountManagementState>(AccountStore.JsonOptions)!);
                result = new { restored = true };
            }
            else if (method == "prepare_stop") result = new { canStop = service.CanStop };
            else if (method == "invoke")
            {
                try { result = new { ok = true, data = service.Invoke(parameters["operation"]!.GetValue<string>(), parameters["payload"] as JsonObject ?? new()) }; }
                catch (Exception error) { result = new { ok = false, errorCode = BackendService.ErrorCode(error) }; }
            }
            else throw new InvalidOperationException("ACCOUNT_OPERATION_DENIED");
            return JsonSerializer.SerializeToNode(result, AccountStore.JsonOptions);
        });
        try { await rpc.Completion; }
        finally
        {
            if (service is not null) await service.DisposeAsync();
            await rpc.DisposeAsync();
        }
        return 0;
    }
}
