using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using CodexScriptLoader.Core;

Console.InputEncoding = Encoding.UTF8;
Console.OutputEncoding = new UTF8Encoding(false);
var requestId = Guid.NewGuid().ToString("N");

try
{
    if (args.Length != 6 || args[0] != "plugin" || args[1] != "invoke")
    {
        throw new InvalidDataException("Usage: CodexScriptLoader.Command.exe plugin invoke --id <plugin-id> --operation <operation>");
    }

    var options = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var index = 2; index < args.Length; index += 2)
    {
        if (!options.TryAdd(args[index], args[index + 1])) throw new InvalidDataException("Command options must be unique.");
    }

    if (!options.TryGetValue("--id", out var pluginId) || !options.TryGetValue("--operation", out var operation) || options.Count != 2)
    {
        throw new InvalidDataException("Both --id and --operation are required.");
    }

    await using var standardInput = Console.OpenStandardInput();
    var input = await HostCommandProtocol.ReadBoundedUtf8Async(standardInput, stopAtNewline: false, CancellationToken.None);
    using var payloadDocument = JsonDocument.Parse(input);
    if (payloadDocument.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("stdin must contain one JSON object.");
    var request = new HostCommandRequest(
        HostCommandProtocol.Version,
        requestId,
        "plugin_invoke",
        pluginId,
        operation,
        payloadDocument.RootElement.Clone());
    HostCommandProtocol.ValidateRequest(request);

    var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Current Windows user SID is unavailable.");
    var pipeName = HostCommandProtocol.PipeNameForUserSid(sid);
    using var timeout = new CancellationTokenSource(HostCommandProtocol.PipeTimeout);
    await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
    await pipe.ConnectAsync(2000, timeout.Token);
    var requestBytes = HostCommandProtocol.SerializeBounded(request);
    await pipe.WriteAsync(requestBytes, timeout.Token);
    await pipe.WriteAsync("\n"u8.ToArray(), timeout.Token);
    await pipe.FlushAsync(timeout.Token);

    var responseLine = await HostCommandProtocol.ReadBoundedUtf8Async(pipe, stopAtNewline: true, timeout.Token);
    if (responseLine.Length == 0) throw new IOException("Loader closed the command pipe without a response.");
    var response = JsonSerializer.Deserialize<HostCommandResponse>(responseLine, HostCommandProtocol.JsonOptions)
        ?? throw new InvalidDataException("Host command response is empty.");
    if (response.RequestId != requestId) throw new InvalidDataException("Host command response id does not match the request.");
    Console.WriteLine(responseLine);
    return response.Ok ? 0 : 1;
}
catch (OperationCanceledException)
{
    WriteFailure(requestId, "COMMAND_TIMEOUT", "Loader command timed out.");
    return 1;
}
catch (IOException)
{
    WriteFailure(requestId, "LOADER_UNAVAILABLE", "Codex Script Loader is not accepting commands.");
    return 1;
}
catch (TimeoutException)
{
    WriteFailure(requestId, "LOADER_UNAVAILABLE", "Codex Script Loader is not accepting commands.");
    return 1;
}
catch (Exception exception) when (exception is InvalidDataException or JsonException or ArgumentException)
{
    WriteFailure(requestId, "INVALID_REQUEST", exception.Message);
    return 2;
}
catch (Exception)
{
    WriteFailure(requestId, "COMMAND_FAILED", "Loader command failed.");
    return 1;
}

static void WriteFailure(string requestId, string code, string message)
{
    var response = new HostCommandResponse(HostCommandProtocol.Version, requestId, false, null, new HostCommandError(code, message));
    Console.WriteLine(Encoding.UTF8.GetString(HostCommandProtocol.SerializeBounded(response)));
}
