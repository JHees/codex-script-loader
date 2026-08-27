using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
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

    public static SingleInstanceCoordinator Create(LoaderPaths paths)
    {
        paths.EnsureDirectories();
        var sid = WindowsIdentity.GetCurrent().User?.Value
            ?? throw new InvalidOperationException("Current Windows user SID is unavailable.");
        var suffix = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..24];
        return new SingleInstanceCoordinator(paths.InstanceLockPath, $"CodexScriptLoader.v0.3.{suffix}", TryOpenLock(paths.InstanceLockPath));
    }

    public void StartServer()
    {
        if (!IsPrimary || serverTask is not null) return;
        serverLifetime = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        serverTask = Task.Run(() => ServerLoopAsync(serverLifetime.Token));
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
            await using var server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                var command = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (command is "ShowStatus" or "ReloadScripts") CommandReceived?.Invoke(command);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (IOException)
            {
            }
        }
    }

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
