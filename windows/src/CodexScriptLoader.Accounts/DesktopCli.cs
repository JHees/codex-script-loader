using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text;

namespace CodexScriptLoader.Accounts;

public static class DesktopCli
{
    public static async Task<int> RunAsync(string directory, string[] arguments, bool enabled = true)
    {
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        if (!RouterHost.IsInteractiveServer(arguments)) return await PassthroughAsync(arguments);
        if (!enabled) return await PrimaryOnlyAsync(directory, arguments);
        var connection = JsonSerializer.Deserialize<RouterConnection>(
            await File.ReadAllBytesAsync(Path.Combine(directory, "router-connection.json")), AccountStore.JsonOptions)
            ?? throw new InvalidDataException("ROUTER_UNAVAILABLE");
        using var cancellation = new CancellationTokenSource();
        await using var pipe = new NamedPipeClientStream(".", connection.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(10000);
        await using var peer = new RouterHost.Peer(pipe);
        await peer.SendAsync(new JsonObject
        {
            ["token"] = connection.Token,
            ["arguments"] = new JsonArray(arguments.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
            ["packageFamily"] = Environment.GetEnvironmentVariable("CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY"),
        }, cancellation.Token);
        if ((await peer.ReadAsync(cancellation.Token))?["ready"]?.GetValue<bool>() != true) return 1;
        async Task Input()
        {
            while (await Console.In.ReadLineAsync(cancellation.Token) is { } line)
            {
                if (line.Length > 16 * 1024 * 1024) throw new InvalidDataException("ROUTER_MESSAGE_TOO_LARGE");
                await peer.SendAsync(JsonNode.Parse(line)!.AsObject(), cancellation.Token);
            }
        }
        async Task Output()
        {
            while (await peer.ReadAsync(cancellation.Token) is { } message)
                await Console.Out.WriteLineAsync(message.ToJsonString());
        }
        // Console.In may block synchronously on Windows even through ReadLineAsync.
        var input = Task.Run(Input); var output = Output();
        var ended = await Task.WhenAny(input, output);
        cancellation.Cancel(); peer.Disconnect();
        try { await output; if (input.IsCompleted) await input; }
        catch (OperationCanceledException) { }
        catch (IOException) when (ended.IsCompletedSuccessfully) { }
        _ = input.ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
        return 0;
    }

    private static async Task<int> PrimaryOnlyAsync(string directory, string[] arguments)
    {
        var store = new AccountStore(directory);
        var home = Environment.GetEnvironmentVariable("CODEX_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        var factory = new RouterBackendFactory(store, OfficialCliLocator.Find(), home,
            Environment.GetEnvironmentVariable("CODEX_SQLITE_HOME"), arguments, Environment.GetEnvironmentVariable("CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY"));
        await using var router = new AccountRouter(store, new ThreadOwnership(directory), factory.Start, factory.Home, primaryOnly: true);
        var output = TextWriter.Synchronized(Console.Out);
        router.Outgoing += (_, message) => output.WriteLine(message.ToJsonString());
        var pending = new List<Task>();
        async Task Handle(JsonObject message)
        {
            var response = await router.HandleAsync("primary", message);
            if (response is not null) await output.WriteLineAsync(response.ToJsonString());
        }
        while (await Console.In.ReadLineAsync() is { } line)
        {
            if (line.Length > 16 * 1024 * 1024) return 1;
            pending.Add(Handle(JsonNode.Parse(line)!.AsObject()));
            pending.RemoveAll(task => task.IsCompletedSuccessfully);
        }
        await Task.WhenAll(pending);
        return 0;
    }

    private static async Task<int> PassthroughAsync(string[] arguments)
    {
        var cli = OfficialCliLocator.Find();
        var start = new ProcessStartInfo(cli.Executable) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        start.Environment.Remove("CODEX_SCRIPT_LOADER_CLI_DESCRIPTOR");
        start.Environment["CODEX_CLI_PATH"] = cli.Executable;
        using var process = Process.Start(start) ?? throw new IOException("OFFICIAL_CLI_UNAVAILABLE");
        await process.WaitForExitAsync();
        return process.ExitCode;
    }
}
