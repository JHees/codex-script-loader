using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using CodexScriptLoader.Core;

namespace CodexScriptLoader.Windows;

internal sealed class SingleInstanceCoordinator : IAsyncDisposable
{
    public const int ProtocolVersion = 3;
    private readonly string lockPath;
    private readonly string pipeName;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim ownershipSync = new(1, 1);
    private FileStream? ownership;
    private CancellationTokenSource? serverLifetime;
    private Task? serverTask;

    private SingleInstanceCoordinator(string lockPath, string pipeName, FileStream? ownership)
    {
        this.lockPath = lockPath;
        this.pipeName = pipeName;
        this.ownership = ownership;
    }

    public bool IsPrimary => ownership is not null;

    public event Action<string>? CommandReceived;

    public Func<HostCommandRequest, CancellationToken, Task<JsonElement>>? HostCommandReceived { get; set; }

    public static SingleInstanceCoordinator Create(LoaderPaths paths, string? pipeNameOverride = null)
    {
        paths.EnsureDirectories();
        var sid = WindowsIdentity.GetCurrent().User?.Value
            ?? throw new InvalidOperationException("Current Windows user SID is unavailable.");
        return new SingleInstanceCoordinator(paths.InstanceLockPath, pipeNameOverride ?? HostCommandProtocol.PipeNameForUserSid(sid), TryOpenLock(paths.InstanceLockPath));
    }

    public void StartServer()
    {
        if (!IsPrimary || serverTask is not null) return;
        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        serverLifetime = cancellation;
        // A waiting plugin must not monopolize the legacy management channel.
        // Keep a bounded number of independent connections, all owned by this lifetime.
        serverTask = Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Task.Run(() => ServerLoopAsync(cancellation.Token))));
    }

    public async Task<bool> TryAcquireAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        await ownershipSync.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (ownership is not null) return true;
            while (DateTimeOffset.UtcNow < deadline)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ownership = TryOpenLock(lockPath);
                if (ownership is not null)
                {
                    StartServer();
                    return true;
                }

                await Task.Delay(50, cancellationToken).ConfigureAwait(false);
            }

            return false;
        }
        finally
        {
            ownershipSync.Release();
        }
    }

    public async Task ReleaseOwnershipAsync()
    {
        await ownershipSync.WaitAsync().ConfigureAwait(false);
        try
        {
            await StopServerAsync().ConfigureAwait(false);
            ownership?.Dispose();
            ownership = null;
        }
        finally
        {
            ownershipSync.Release();
        }
    }

    public async Task SendCommandAsync(string command, CancellationToken cancellationToken)
    {
        if (command is not ("ShowStatus" or "ReloadScripts")) throw new ArgumentException("Unsupported single-instance command.", nameof(command));
        await using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await client.ConnectAsync(2000, cancellationToken).ConfigureAwait(false);
        await using var writer = new StreamWriter(client, new UTF8Encoding(false), leaveOpen: false) { AutoFlush = true };
        await writer.WriteLineAsync(command.AsMemory(), cancellationToken).ConfigureAwait(false);
    }

    public async Task<HostCommandResponse> SendHostCommandAsync(HostCommandRequest request, CancellationToken cancellationToken)
    {
        HostCommandProtocol.ValidateRequest(request);
        var requestBytes = HostCommandProtocol.SerializeBounded(request);
        await using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await client.ConnectAsync(2000, cancellationToken).ConfigureAwait(false);
        await client.WriteAsync(requestBytes, cancellationToken).ConfigureAwait(false);
        await client.WriteAsync("\n"u8.ToArray(), cancellationToken).ConfigureAwait(false);
        await client.FlushAsync(cancellationToken).ConfigureAwait(false);
        var responseLine = await HostCommandProtocol.ReadBoundedUtf8Async(client, stopAtNewline: true, cancellationToken).ConfigureAwait(false);
        if (responseLine.Length == 0) throw new IOException("Loader closed the host command pipe without a response.");

        return JsonSerializer.Deserialize<HostCommandResponse>(responseLine, HostCommandProtocol.JsonOptions)
            ?? throw new InvalidDataException("Host command response is empty.");
    }

    private static FileStream? TryOpenLock(string path)
    {
        try
        {
            var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read, 256, FileOptions.WriteThrough);
            stream.SetLength(0);
            using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
            writer.Write($"protocol={ProtocolVersion};pid={Environment.ProcessId};started={DateTimeOffset.UtcNow:O}");
            stream.Position = 0;
            return stream;
        }
        catch (IOException)
        {
            return null;
        }
    }

    private async Task ServerLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                readTimeout.CancelAfter(TimeSpan.FromSeconds(5));
                string command;
                try
                {
                    command = await HostCommandProtocol.ReadBoundedUtf8Async(server, stopAtNewline: true, readTimeout.Token).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is InvalidDataException or DecoderFallbackException)
                {
                    var failure = HostCommandProtocol.SerializeBounded(Failure("unknown", "INVALID_REQUEST", "Command must be valid UTF-8 and no larger than 64 KiB."));
                    await server.WriteAsync(failure, readTimeout.Token).ConfigureAwait(false);
                    await server.WriteAsync("\n"u8.ToArray(), readTimeout.Token).ConfigureAwait(false);
                    continue;
                }
                if (command is "ShowStatus" or "ReloadScripts")
                {
                    CommandReceived?.Invoke(command);
                    continue;
                }

                if (command.Length == 0) continue;
                var response = await HandleHostCommandAsync(command, cancellationToken).ConfigureAwait(false);
                var responseBytes = HostCommandProtocol.SerializeBounded(response);
                using var writeTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                writeTimeout.CancelAfter(TimeSpan.FromSeconds(5));
                await server.WriteAsync(responseBytes, writeTimeout.Token).ConfigureAwait(false);
                await server.WriteAsync("\n"u8.ToArray(), writeTimeout.Token).ConfigureAwait(false);
                await server.FlushAsync(writeTimeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (OperationCanceledException)
            {
                // A client that never finishes its input loses only its own connection.
            }
            catch (IOException)
            {
            }
        }
    }

    private async Task<HostCommandResponse> HandleHostCommandAsync(string line, CancellationToken cancellationToken)
    {
        var requestId = "unknown";
        try
        {
            if (Encoding.UTF8.GetByteCount(line) > HostCommandProtocol.MaximumMessageBytes)
            {
                throw new InvalidDataException("Host command request exceeds 64 KiB.");
            }

            var request = JsonSerializer.Deserialize<HostCommandRequest>(line, HostCommandProtocol.JsonOptions)
                ?? throw new InvalidDataException("Host command request is empty.");
            HostCommandProtocol.ValidateRequest(request);
            requestId = request.RequestId;
            var handler = HostCommandReceived ?? throw new HostCommandException("COMMAND_UNAVAILABLE", "Plugin host commands are unavailable.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(HostCommandProtocol.InvocationTimeout);
            var result = await handler(request, timeout.Token).WaitAsync(timeout.Token).ConfigureAwait(false);
            var response = new HostCommandResponse(HostCommandProtocol.Version, request.RequestId, true, result, null);
            try { HostCommandProtocol.SerializeBounded(response); }
            catch (InvalidDataException) { return Failure(requestId, "RESULT_TOO_LARGE", "Plugin host command result exceeds 64 KiB."); }
            return response;
        }
        catch (HostCommandException exception)
        {
            return Failure(requestId, exception.Code, exception.Message);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return Failure(requestId, "COMMAND_TIMEOUT", "Plugin host command timed out.");
        }
        catch (InvalidDataException exception)
        {
            return Failure(requestId, "INVALID_REQUEST", exception.Message);
        }
        catch (JsonException)
        {
            return Failure(requestId, "INVALID_REQUEST", "Host command request is not valid JSON.");
        }
        catch (Exception)
        {
            return Failure(requestId, "COMMAND_FAILED", "Plugin host command failed.");
        }
    }

    private static HostCommandResponse Failure(string requestId, string code, string message) =>
        new(HostCommandProtocol.Version, requestId, false, null, new HostCommandError(code, message));

    private async Task StopServerAsync()
    {
        var cancellation = serverLifetime;
        var task = serverTask;
        serverLifetime = null;
        serverTask = null;
        cancellation?.Cancel();
        if (task is not null)
        {
            try { await task.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
            catch (IOException) { }
        }

        cancellation?.Dispose();
    }

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        await ownershipSync.WaitAsync().ConfigureAwait(false);
        try
        {
            await StopServerAsync().ConfigureAwait(false);
            ownership?.Dispose();
            ownership = null;
        }
        finally
        {
            ownershipSync.Release();
            ownershipSync.Dispose();
            lifetime.Dispose();
        }
    }
}
