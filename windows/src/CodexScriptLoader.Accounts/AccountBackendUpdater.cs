using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public static class AccountBackendUpdater
{
    public static async Task<int> RunAsync()
    {
        var line = await Console.In.ReadLineAsync() ?? throw new InvalidOperationException("INPUT_INVALID");
        if (line.Length > 8192) throw new InvalidOperationException("INPUT_INVALID");
        var options = JsonNode.Parse(line)!.AsObject();
        var directory = options["dataDirectory"]!.GetValue<string>();
        var package = options["packageDirectory"]!.GetValue<string>();
        var connection = JsonSerializer.Deserialize<AccountBackendConnection>(await File.ReadAllBytesAsync(Path.Combine(directory, "runtime", "backend.json")), AccountStore.JsonOptions)
            ?? throw new InvalidOperationException("ACCOUNT_BACKEND_NOT_READY");
        if (connection.ProtocolVersion != 1 || !connection.PipeName.StartsWith("CodexAccountsUpdate-", StringComparison.Ordinal) || connection.Token.Length != 64)
            throw new InvalidOperationException("ACCOUNT_UPDATE_PROTOCOL");
        await using var pipe = new NamedPipeClientStream(".", connection.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(5000);
        using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, leaveOpen: true))
        await using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, leaveOpen: true) { AutoFlush = true })
        {
            await writer.WriteLineAsync(connection.Token);
            if (await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)) != "ready") throw new InvalidOperationException("ACCOUNT_UPDATE_AUTHENTICATION_FAILED");
        }
        await using var rpc = new AccountRpc(pipe, pipe, (_, _, _) => throw new InvalidOperationException("ACCOUNT_OPERATION_DENIED"), 64 * 1024);
        var result = await rpc.CallAsync("update", new() { ["packageDirectory"] = Path.GetFullPath(package) });
        string? previous = null;
        while (true)
        {
            var state = result?["state"]?.GetValue<string>();
            if (state != previous) { Console.WriteLine(result!.ToJsonString()); previous = state; }
            if (options["wait"]?.GetValue<bool>() == false || state is "succeeded" or "idle") return 0;
            if (state == "failed") return 1;
            await Task.Delay(500);
            result = await rpc.CallAsync("status");
        }
    }
}
