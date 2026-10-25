using System.Text.Json;
using CodexScriptLoader.Accounts;

internal static class HistoryLayoutChecks
{
    public static Task RunAsync(string root)
    {
        var directory = Path.Combine(root, "history-layout");
        var primary = Path.Combine(directory, "primary");
        foreach (var name in new[] { "sessions", "archived_sessions", "attachments", "codex-remote-attachments", "thread-writer-locks" })
            Directory.CreateDirectory(Path.Combine(primary, name));
        var store = new AccountStore(Path.Combine(directory, "store"));
        var account = store.Create("Shared history");
        var accountHome = store.Home(account.Id);
        Directory.CreateDirectory(Path.Combine(accountHome, "sessions"));
        var thread = "11111111-1111-1111-1111-111111111111";
        File.WriteAllText(Path.Combine(accountHome, "sessions", thread + ".jsonl"), "account-copy");
        File.WriteAllText(Path.Combine(primary, "sessions", thread + ".jsonl"), "primary-copy");
        File.SetLastWriteTimeUtc(Path.Combine(accountHome, "sessions", thread + ".jsonl"), DateTime.UtcNow.AddMinutes(-5));
        File.SetLastWriteTimeUtc(Path.Combine(primary, "sessions", thread + ".jsonl"), DateTime.UtcNow);

        var layout = HistoryLayout.Migrate(store, directory, primary, primary);
        Assert(File.ReadAllText(Path.Combine(layout.CanonicalHome, "sessions", thread + ".jsonl")) == "primary-copy");
        Assert(File.GetAttributes(Path.Combine(accountHome, "sessions")).HasFlag(FileAttributes.ReparsePoint));
        Assert(File.Exists(Path.Combine(accountHome, ".history-conflicts", "sessions", thread + ".jsonl")));
        Assert(File.Exists(Path.Combine(directory, "history-layout.json")));
        var marker = JsonSerializer.Deserialize<HistoryLayoutMarker>(File.ReadAllText(Path.Combine(directory, "history-layout.json")), AccountStore.JsonOptions)!;
        Assert(marker.CanonicalHome == Path.GetFullPath(primary) && marker.Backups.Length > 0);
        HistoryLayout.Migrate(store, directory, primary, primary);
        Assert(File.ReadAllText(Path.Combine(accountHome, "sessions", thread + ".jsonl")) == "primary-copy");
        Console.WriteLine("PASS: shared history migration creates junctions, keeps the canonical rollout and backs up conflicts");
        return Task.CompletedTask;
    }

    private static void Assert(bool value) { if (!value) throw new InvalidOperationException("History layout assertion failed"); }
}
