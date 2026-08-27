using System.IO.Pipes;
using System.Text;

namespace CodexScriptLoader.Windows;

internal static class LauncherHealthSignal
{
    public static async Task SendAsync(string? pipeName, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(pipeName)) return;
        await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(5000, cancellationToken).ConfigureAwait(false);
        await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: false) { AutoFlush = true };
        await writer.WriteLineAsync("healthy".AsMemory(), cancellationToken).ConfigureAwait(false);
    }
}
