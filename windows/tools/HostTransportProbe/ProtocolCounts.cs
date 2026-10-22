using System.Text.Json;

namespace CodexScriptLoader.HostTransportProbe;

internal sealed class ProtocolCounts
{
    private const int FrameLimit = 64 * 1024;
    private static readonly HashSet<string> Methods = new(StringComparer.Ordinal)
    {
        "initialize", "initialized", "account/read", "getAuthStatus", "model/list", "config/read",
        "thread/list", "thread/read", "thread/start", "thread/resume", "thread/archive", "thread/unarchive",
        "thread/started", "thread/archived", "thread/metadata/update", "turn/start", "turn/interrupt", "turn/steer",
        "turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta",
        "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"
    };
    private sealed class Direction
    {
        internal readonly byte[] Frame = new byte[FrameLimit];
        internal readonly Dictionary<string, long> Methods = new(StringComparer.Ordinal);
        internal int Length;
        internal bool Oversized;
        internal long Bytes, Skipped;
    }
    private readonly Direction input = new(), output = new();
    private readonly object sync = new();
    private string? initializeId;
    private bool initialized;

    internal void Observe(bool toBackend, ReadOnlySpan<byte> bytes)
    {
        lock (sync)
        {
            var direction = toBackend ? input : output;
            direction.Bytes += bytes.Length;
            foreach (var value in bytes)
            {
                if (value == (byte)'\n') { Finish(direction, toBackend); continue; }
                if (direction.Oversized) continue;
                if (direction.Length == FrameLimit) { direction.Oversized = true; Array.Clear(direction.Frame); continue; }
                direction.Frame[direction.Length++] = value;
            }
        }
    }

    private void Finish(Direction direction, bool toBackend)
    {
        try
        {
            if (direction.Oversized) { direction.Skipped++; return; }
            if (direction.Length == 0) return;
            using var json = JsonDocument.Parse(direction.Frame.AsMemory(0, direction.Length));
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            var method = root.TryGetProperty("method", out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
            var key = method is null ? "<response>" : Methods.Contains(method) ? method : "<other>";
            direction.Methods[key] = direction.Methods.GetValueOrDefault(key) + 1;
            if (toBackend && method == "initialize" && root.TryGetProperty("id", out var id)) initializeId = id.GetRawText();
            if (!toBackend && initializeId != null && root.TryGetProperty("id", out var replyId)
                && replyId.GetRawText() == initializeId && root.TryGetProperty("result", out _))
            { initialized = true; initializeId = null; }
        }
        catch (JsonException) { direction.Skipped++; }
        finally { Array.Clear(direction.Frame, 0, direction.Length); direction.Length = 0; direction.Oversized = false; }
    }

    internal CountsSnapshot Snapshot()
    {
        lock (sync) return new(initialized, input.Bytes, output.Bytes, new(input.Methods), new(output.Methods), input.Skipped + output.Skipped);
    }
}

internal sealed record CountsSnapshot(bool InitializeSucceeded, long BytesToBackend, long BytesToDesktop,
    Dictionary<string, long> ToBackend, Dictionary<string, long> ToDesktop, long UncountedFrames);
