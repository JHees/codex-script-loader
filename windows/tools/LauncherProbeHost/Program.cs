using System.IO.Pipes;
using System.Text;

namespace CodexScriptLoader.LauncherProbeHost;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var failVersion = ReadOption(args, "--fail-version");
        var currentVersion = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).Parent?.Name;
        if (failVersion == currentVersion) return 2;
        var pipeName = ReadOption(args, "--launcher-ready-pipe");
        if (string.IsNullOrWhiteSpace(pipeName)) return 3;
        await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(5000);
        var marker = ReadOption(args, "--marker");
        if (!string.IsNullOrWhiteSpace(marker)) await File.WriteAllTextAsync(marker, currentVersion);
        await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: false) { AutoFlush = true };
        await writer.WriteLineAsync("healthy");
        await Task.Delay(250);
        return 0;
    }

    private static string? ReadOption(string[] args, string name)
    {
        var index = Array.FindIndex(args, value => value == name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }
}
