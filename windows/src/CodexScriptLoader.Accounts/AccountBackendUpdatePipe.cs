using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexScriptLoader.Accounts;

public sealed record AccountBackendConnection(int ProtocolVersion, string PipeName, string Token, int ProcessId);

public sealed partial class AccountBackendCoordinator
{
    private readonly AccountBackendConnection connection = new(1, "CodexAccountsUpdate-" + Guid.NewGuid().ToString("N"),
        Convert.ToHexString(RandomNumberGenerator.GetBytes(32)), Environment.ProcessId);
    private readonly ConcurrentDictionary<string, Task> updateSessions = new();
    private Task? listener;
    private string ConnectionPath => Path.Combine(packages.Root, "backend.json");

    private void StartUpdateListener()
    {
        AccountRuntimePackage.WriteJson(ConnectionPath, connection);
        listener = ListenUpdatesAsync();
    }

    private async Task ListenUpdatesAsync()
    {
        while (!stop.IsCancellationRequested)
        {
            var pipe = new NamedPipeServerStream(connection.PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try { await pipe.WaitForConnectionAsync(stop.Token); }
            catch { await pipe.DisposeAsync(); if (stop.IsCancellationRequested) break; throw; }
            updateSessions[Guid.NewGuid().ToString("N")] = ServeUpdateAsync(pipe);
            foreach (var completed in updateSessions.Where(pair => pair.Value.IsCompleted)) updateSessions.TryRemove(completed.Key, out _);
        }
    }

    private async Task ServeUpdateAsync(NamedPipeServerStream pipe)
    {
        await using var owned = pipe;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, leaveOpen: true))
            await using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, leaveOpen: true) { AutoFlush = true })
            {
                var hello = await reader.ReadLineAsync(timeout.Token);
                if (hello is null || hello.Length > 256 || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(hello), Encoding.UTF8.GetBytes(connection.Token))) return;
                await writer.WriteLineAsync("ready");
            }
            await using var rpc = new AccountRpc(pipe, pipe, (method, parameters, cancellation) =>
            {
                var state = method switch
                {
                    "status" => Snapshot,
                    "update" => BeginUpdate(parameters["packageDirectory"]!.GetValue<string>()),
                    _ => throw new InvalidOperationException("ACCOUNT_OPERATION_DENIED"),
                };
                return Task.FromResult(JsonSerializer.SerializeToNode(state, AccountStore.JsonOptions));
            }, 64 * 1024);
            await rpc.Completion.WaitAsync(stop.Token);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { }
    }

    private async Task StopUpdateListenerAsync()
    {
        if (listener is not null) await listener;
        await Task.WhenAll(updateSessions.Values);
        if (File.Exists(ConnectionPath) && JsonSerializer.Deserialize<AccountBackendConnection>(File.ReadAllBytes(ConnectionPath), AccountStore.JsonOptions)?.ProcessId == Environment.ProcessId)
            File.Delete(ConnectionPath);
    }
}
