using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Accounts;

// Repairs one 0.6.0-alpha regression: an account switch moved a relay-model chat to a
// Codex account and rewrote its model, while the relay home still holds the original
// DeepSeek settings. Move such chats back to their relay once. The marker keeps later
// explicit user switches from being reverted on every start.
public static partial class AccountOwnershipRepair
{
    private const string MarkerFile = "ownership-repair-v1.json";

    public static void Run(AccountStore store, string directory)
    {
        var marker = Path.Combine(directory, MarkerFile);
        if (File.Exists(marker)) return;
        try { Repair(store, directory, marker); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            // A damaged or locked home must not block the accounts backend; retry on the next start.
        }
    }

    private static void Repair(AccountStore store, string directory, string marker)
    {
        var ownership = new ThreadOwnership(directory);
        var relays = store.List().Where(entry => entry is { Kind: "relay", Status: "ready" }).ToArray();
        var repaired = new List<string>();
        var skipped = new List<string>();
        if (relays.Length > 0)
        {
            var files = IndexThreads(relays.Select(relay => store.Home(relay.Id)));
            var primaryHome = Environment.GetEnvironmentVariable("CODEX_HOME");
            if (string.IsNullOrEmpty(primaryHome))
                primaryHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
            var primaryFiles = IndexThreads([primaryHome]);
            foreach (var threadId in ownership.AllThreads())
            {
                var owner = ownership.Get(threadId);
                if (owner.AccountId != "primary" && store.Get(owner.AccountId).Kind == "relay") continue;
                if (!files.TryGetValue(threadId, out var file)) continue;
                if (LastProvider(file) is not { Length: > 0 } provider) continue;
                var relay = relays.FirstOrDefault(entry => string.Equals(ProviderRuntime.ProviderId(entry), provider, StringComparison.Ordinal));
                if (relay is null) continue;
                // Turns sent while the regression had this chat on the Codex account live only
                // in that copy. Moving ownership back would hide them, so leave the chat alone.
                if (primaryFiles.TryGetValue(threadId, out var primaryFile)
                    && LastUserAt(primaryFile) > LastUserAt(file))
                {
                    skipped.Add(threadId);
                    continue;
                }
                ownership.Set(threadId, owner with { AccountId = relay.Id, Pinned = true });
                repaired.Add(threadId);
            }
        }
        AccountRuntimePackage.WriteJson(marker, new { SchemaVersion = 1, Repaired = repaired.Count, Threads = repaired, Skipped = skipped });
    }

    private static Dictionary<string, string> IndexThreads(IEnumerable<string> homes)
    {
        var files = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var home in homes)
        {
            if (!Directory.Exists(home)) continue;
            foreach (var file in Directory.EnumerateFiles(home, "*.jsonl", new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = true,
            }))
            {
                var matches = ThreadIdPattern().Matches(Path.GetFileNameWithoutExtension(file));
                if (matches.Count > 0) files.TryAdd(matches[^1].Value, file);
            }
        }
        return files;
    }

    internal static DateTimeOffset LastUserAt(string file)
    {
        var last = DateTimeOffset.MinValue;
        try
        {
            foreach (var line in File.ReadLines(file))
            {
                if (!line.Contains("\"user\"", StringComparison.Ordinal) && !line.Contains("user_message", StringComparison.Ordinal)) continue;
                if (JsonNode.Parse(line) is not JsonObject frame) continue;
                var payload = frame["payload"];
                string? text = null;
                if (frame["type"]?.GetValue<string>() == "response_item" && payload?["type"]?.GetValue<string>() == "message"
                    && payload["role"]?.GetValue<string>() == "user")
                    text = string.Concat(payload["content"]?.AsArray().Select(item => item?["text"]?.GetValue<string>()) ?? []);
                else if (frame["type"]?.GetValue<string>() == "event_msg" && payload?["type"]?.GetValue<string>() == "user_message")
                    text = payload["message"]?.GetValue<string>();
                if (text is null || text.Contains("<external_codex_apps_open_page>", StringComparison.Ordinal)) continue;
                if (DateTimeOffset.TryParse(frame["timestamp"]?.GetValue<string>(), out var at) && at > last) last = at;
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { }
        return last;
    }

    private static string? LastProvider(string file)
    {
        string? provider = null;
        try
        {
            foreach (var line in File.ReadLines(file))
            {
                if (!line.Contains("thread_settings_applied", StringComparison.Ordinal)) continue;
                if (JsonNode.Parse(line) is not JsonObject frame) continue;
                if (frame["payload"]?["thread_settings"]?["model_provider_id"]?.GetValue<string>() is { } value)
                    provider = value;
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return null; }
        return provider;
    }

    [GeneratedRegex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex ThreadIdPattern();
}
