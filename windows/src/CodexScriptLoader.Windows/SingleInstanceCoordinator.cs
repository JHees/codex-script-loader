using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace CodexScriptLoader.Windows;

internal sealed class SingleInstanceCoordinator : IAsyncDisposable
{
    private readonly Mutex mutex;
    private readonly string pipeName;
    private readonly CancellationTokenSource lifetime = new();
    private Task? serverTask;

    private SingleInstanceCoordinator(Mutex mutex, string pipeName, bool isPrimary)
    {
        this.mutex = mutex;
        this.pipeName = pipeName;
        IsPrimary = isPrimary;
    }

    public bool IsPrimary { get; }

    public event Action<string>? CommandReceived;

    public static SingleInstanceCoordinator Create()
    {
        var sid = WindowsIdentity.GetCurrent().User?.Value
            ?? throw new InvalidOperationException("Current Windows user SID is unavailable.");
        var suffix = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..24];
        var mutex = new Mutex(initiallyOwned: true, $"Local\\CodexScriptLoader.v0.2.{suffix}", out var createdNew);
        return new SingleInstanceCoordinator(mutex, $"CodexScriptLoader.v0.2.{suffix}", createdNew);
    }

    public void StartServer()
    {
        if (!IsPrimary || serverTask is not null)
        {
            return;
        }

        serverTask = Task.Run(ServerLoopAsync);
    }

    public async Task SendCommandAsync(string command, CancellationToken cancellationToken)
    {
        if (command is not ("ShowStatus" or "ReloadScripts"))
        {
            throw new ArgumentException("Unsupported single-instance command.", nameof(command));
        }

        await using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await client.ConnectAsync(2000, cancellationToken).ConfigureAwait(false);
        await using var writer = new StreamWriter(client, new UTF8Encoding(false), leaveOpen: false) { AutoFlush = true };
        await writer.WriteLineAsync(command.AsMemory(), cancellationToken).ConfigureAwait(false);
    }

    private async Task ServerLoopAsync()
    {
        while (!lifetime.IsCancellationRequested)
        {
            await using var server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.In,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await server.WaitForConnectionAsync(lifetime.Token).ConfigureAwait(false);
                using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                var command = await reader.ReadLineAsync(lifetime.Token).ConfigureAwait(false);
                if (command is "ShowStatus" or "ReloadScripts")
                {
                    CommandReceived?.Invoke(command);
                }
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
            {
                break;
            }
            catch (IOException)
            {
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        if (serverTask is not null)
        {
            try
            {
                await serverTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        if (IsPrimary)
        {
            mutex.ReleaseMutex();
        }

        mutex.Dispose();
        lifetime.Dispose();
    }
}
