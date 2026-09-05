using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Core;

public sealed record HostCommandRequest(
    int Version,
    string RequestId,
    string Command,
    string PluginId,
    string Operation,
    JsonElement Payload);

public sealed record HostCommandError(string Code, string Message);

public sealed record HostCommandResponse(
    int Version,
    string RequestId,
    bool Ok,
    JsonElement? Result,
    HostCommandError? Error);

public sealed class HostCommandException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public static partial class HostCommandProtocol
{
    public const int Version = 1;
    public const int MaximumMessageBytes = 64 * 1024;
    public static readonly TimeSpan InvocationTimeout = TimeSpan.FromSeconds(120);
    public static readonly TimeSpan PipeTimeout = TimeSpan.FromSeconds(125);

    public static string PipeNameForUserSid(string sid)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sid);
        var suffix = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..24];
        return $"CodexScriptLoader.v0.3.{suffix}";
    }

    public static void ValidateRequest(HostCommandRequest request)
    {
        if (request.Version != Version) throw new InvalidDataException("Unsupported host command protocol version.");
        if (!string.Equals(request.Command, "plugin_invoke", StringComparison.Ordinal)) throw new InvalidDataException("Unsupported host command.");
        if (request.RequestId is null || !OpaqueIdPattern().IsMatch(request.RequestId)) throw new InvalidDataException("Invalid host command request id.");
        if (request.PluginId is null || !PluginIdPattern().IsMatch(request.PluginId)) throw new InvalidDataException("Invalid plugin id.");
        if (request.Operation is null || !OperationPattern().IsMatch(request.Operation)) throw new InvalidDataException("Invalid plugin operation.");
        if (request.Payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Host command payload must be a JSON object.");
    }

    public static byte[] SerializeBounded<T>(T value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions);
        if (bytes.Length > MaximumMessageBytes) throw new InvalidDataException("Host command message exceeds 64 KiB.");
        return bytes;
    }

    public static async Task<string> ReadBoundedUtf8Async(Stream stream, bool stopAtNewline, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[4096];
        while (true)
        {
            var count = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false);
            if (count == 0) break;
            var accepted = count;
            if (stopAtNewline)
            {
                var newline = Array.IndexOf(chunk, (byte)'\n', 0, count);
                if (newline >= 0) accepted = newline;
            }
            if (buffer.Length + accepted > MaximumMessageBytes) throw new InvalidDataException("Host command message exceeds 64 KiB.");
            await buffer.WriteAsync(chunk.AsMemory(0, accepted), cancellationToken).ConfigureAwait(false);
            if (accepted != count) break;
        }
        var bytes = buffer.ToArray();
        if (stopAtNewline && bytes.Length > 0 && bytes[^1] == (byte)'\r') bytes = bytes[..^1];
        return new UTF8Encoding(false, true).GetString(bytes);
    }

    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    [GeneratedRegex("\\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex OpaqueIdPattern();

    [GeneratedRegex("\\A[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?\\z", RegexOptions.CultureInvariant)]
    private static partial Regex PluginIdPattern();

    [GeneratedRegex("\\A[a-z][a-z0-9_-]{0,63}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex OperationPattern();
}
