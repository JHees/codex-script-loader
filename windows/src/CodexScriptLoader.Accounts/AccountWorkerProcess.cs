using System.Diagnostics;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

internal sealed class AccountWorkerProcess : IAsyncDisposable
{
    private readonly Process process;
    private readonly Task errors;
    public AccountRpc Rpc { get; }
    public int Id => process.Id;
    public bool IsRunning => !process.HasExited && !Rpc.Completion.IsCompleted;

    public AccountWorkerProcess(string hostExecutable, string assemblyPath,
        Func<AccountRpc, string, JsonObject, CancellationToken, Task<JsonNode?>> routerRequest)
    {
        var start = new ProcessStartInfo(hostExecutable)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        start.ArgumentList.Add("--accounts-backend");
        start.Environment.Remove("CODEX_SCRIPT_LOADER_ACCOUNTS");
        start.Environment.Remove(AccountBackendHost.CommandVariable);
        start.Environment[AccountBackendHost.WorkerAssemblyVariable] = assemblyPath;
        process = Process.Start(start) ?? throw new IOException("ACCOUNT_BACKEND_START_FAILED");
        errors = process.StandardError.BaseStream.CopyToAsync(Stream.Null);
        AccountRpc? connection = null;
        connection = new AccountRpc(process.StandardOutput.BaseStream, process.StandardInput.BaseStream,
            (method, parameters, cancellation) => routerRequest(connection!, method, parameters, cancellation));
        Rpc = connection;
    }

    public async Task InitializeAsync(string directory, CancellationToken cancellation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var ready = await Rpc.CallAsync("initialize", new() { ["protocolVersion"] = 1, ["dataDirectory"] = directory }, timeout.Token);
        if (ready?["protocolVersion"]?.GetValue<int>() != 1 || ready?["accountCommandProtocol"]?.GetValue<int>() != 2) throw new InvalidOperationException("ACCOUNT_UPDATE_PROTOCOL");
    }

    public async ValueTask DisposeAsync()
    {
        process.StandardInput.Close();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
        catch (TimeoutException) { if (!process.HasExited) process.Kill(entireProcessTree: false); await process.WaitForExitAsync(); }
        await Rpc.DisposeAsync(); await errors; process.Dispose();
    }
}
