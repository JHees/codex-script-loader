using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CodexScriptLoader.Interop;

namespace CodexScriptLoader.Accounts;

public sealed record HistoryLayoutMarker(int SchemaVersion, string CanonicalHome, string SqliteHome,
    DateTimeOffset MigratedAt, string[] Backups);

// One authoritative history, shared by every account backend. Account homes keep auth and
// configuration only; their history directories are junctions to the primary Codex home.
public sealed partial class HistoryLayout
{
    private static readonly string[] HistoryDirectories =
        ["sessions", "archived_sessions", "attachments", "codex-remote-attachments", "thread-writer-locks"];
    private static readonly string MarkerFile = "history-layout.json";

    public string CanonicalHome { get; }
    public string SqliteHome { get; }

    public HistoryLayout(string canonicalHome, string sqliteHome)
    {
        CanonicalHome = Path.GetFullPath(canonicalHome);
        SqliteHome = Path.GetFullPath(sqliteHome);
    }

    public static HistoryLayout Migrate(AccountStore store, string dataDirectory, string primaryHome, string? primarySqliteHome)
    {
        var canonical = ResolveDirectory(primaryHome, "PRIMARY_HOME_INVALID");
        var sqlite = string.IsNullOrWhiteSpace(primarySqliteHome) ? canonical : ResolveDirectory(primarySqliteHome, "SQLITE_HOME_INVALID");
        var layout = new HistoryLayout(canonical, sqlite);
        var markerPath = Path.Combine(Path.GetFullPath(dataDirectory), MarkerFile);
        if (File.Exists(markerPath))
        {
            var marker = JsonSerializer.Deserialize<HistoryLayoutMarker>(File.ReadAllText(markerPath), AccountStore.JsonOptions)
                ?? throw new InvalidOperationException("HISTORY_LAYOUT_INVALID");
            if (!string.Equals(marker.CanonicalHome, layout.CanonicalHome, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(marker.SqliteHome, layout.SqliteHome, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("HISTORY_LAYOUT_CHANGED");
            foreach (var account in store.List(includeRemoved: true)) layout.EnsureLinks(store.Home(account.Id));
            return layout;
        }

        foreach (var name in HistoryDirectories) Directory.CreateDirectory(Path.Combine(layout.CanonicalHome, name));
        Directory.CreateDirectory(layout.SqliteHome);
        var accounts = store.List(includeRemoved: true)
            .Select(account => (Account: account, Home: store.Home(account.Id)))
            .Where(item => Directory.Exists(item.Home)).ToArray();

        // Phase 1: merge every real history directory into the canonical store. Nothing is renamed.
        foreach (var (_, home) in accounts)
            foreach (var name in HistoryDirectories)
            {
                var source = Path.Combine(home, name);
                if (!Directory.Exists(source) || IsLink(source) || name == "thread-writer-locks") continue;
                MergeDirectory(source, Path.Combine(layout.CanonicalHome, name), home, name);
            }

        // Phase 2: move originals aside, then create junctions. A failure restores every account.
        var backups = new List<string>();
        var moved = new List<(string Original, string Backup)>();
        var linked = new List<string>();
        try
        {
            foreach (var (_, home) in accounts)
            {
                foreach (var name in HistoryDirectories)
                {
                    var original = Path.Combine(home, name);
                    if (!Directory.Exists(original) || IsLink(original)) continue;
                    if (Directory.EnumerateFileSystemEntries(original).Any())
                    {
                        var backup = BackupPath(home, name);
                        Directory.Move(original, backup);
                        moved.Add((original, backup));
                        backups.Add(backup);
                    }
                    else Directory.Delete(original);
                }
                var sqliteDir = Path.Combine(home, "sqlite");
                if (Directory.Exists(sqliteDir) && !IsLink(sqliteDir))
                {
                    var backup = BackupPath(home, "sqlite");
                    Directory.Move(sqliteDir, backup);
                    moved.Add((sqliteDir, backup));
                    backups.Add(backup);
                }
                foreach (var name in HistoryDirectories)
                {
                    var link = Path.Combine(home, name);
                    if (!Directory.Exists(link)) { DirectoryJunction.Create(link, Path.Combine(layout.CanonicalHome, name)); linked.Add(link); }
                }
            }
        }
        catch
        {
            foreach (var link in linked) { try { if (Directory.Exists(link) && IsLink(link)) Directory.Delete(link); } catch (Exception) { } }
            foreach (var (original, backup) in moved)
                try { if (Directory.Exists(backup) && !Directory.Exists(original)) Directory.Move(backup, original); } catch (Exception) { }
            throw;
        }

        var markerValue = new HistoryLayoutMarker(1, layout.CanonicalHome, layout.SqliteHome, DateTimeOffset.UtcNow, backups.ToArray());
        var temporary = markerPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, JsonSerializer.Serialize(markerValue, AccountStore.JsonOptions)); File.Move(temporary, markerPath, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return layout;
    }

    public void EnsureLinks(string accountHome)
    {
        Directory.CreateDirectory(accountHome);
        foreach (var name in HistoryDirectories)
        {
            var canonical = Path.Combine(CanonicalHome, name);
            Directory.CreateDirectory(canonical);
            var link = Path.Combine(accountHome, name);
            if (Directory.Exists(link))
            {
                if (IsLink(link))
                {
                    var target = new DirectoryInfo(link).ResolveLinkTarget(true)?.FullName;
                    if (target is null || !string.Equals(Path.GetFullPath(target), Path.GetFullPath(canonical), StringComparison.OrdinalIgnoreCase))
                        throw new IOException("HISTORY_LINK_MISMATCH");
                    continue;
                }
                if (Directory.EnumerateFileSystemEntries(link).Any()) throw new IOException("HISTORY_NOT_MIGRATED");
                Directory.Delete(link);
            }
            DirectoryJunction.Create(link, canonical);
        }
    }

    private static void MergeDirectory(string source, string target, string accountHome, string name)
    {
        Directory.CreateDirectory(target);
        foreach (var entry in Directory.EnumerateFileSystemEntries(source))
        {
            if (IsLink(entry)) continue;
            var relative = Path.GetRelativePath(source, entry);
            var destination = Path.Combine(target, relative);
            if (Directory.Exists(entry))
            {
                MergeDirectory(entry, destination, accountHome, name);
                continue;
            }
            if (!File.Exists(entry)) continue;
            MergeFile(entry, destination, accountHome, name, relative);
        }
    }

    private static void MergeFile(string source, string destination, string accountHome, string name, string relative)
    {
        if (!File.Exists(destination)) { CopyFile(source, destination); return; }
        if (SameContent(source, destination)) return;
        var sourceTime = File.GetLastWriteTimeUtc(source);
        var destinationTime = File.GetLastWriteTimeUtc(destination);
        var sourceLength = new FileInfo(source).Length;
        var destinationLength = new FileInfo(destination).Length;
        var sourceThread = IsThreadHistory(name, source) ? AccountOwnershipRepair.LastUserAt(source) : DateTimeOffset.MinValue;
        var destinationThread = IsThreadHistory(name, destination) ? AccountOwnershipRepair.LastUserAt(destination) : DateTimeOffset.MinValue;
        var sourceWins = sourceThread != destinationThread ? sourceThread > destinationThread
            : sourceTime != destinationTime ? sourceTime > destinationTime : sourceLength > destinationLength;
        if (!sourceWins) { BackupFile(source, accountHome, name, relative); return; }
        BackupFile(destination, accountHome, name, relative);
        CopyFile(source, destination);
    }

    private static bool IsThreadHistory(string name, string path) =>
        (name is "sessions" or "archived_sessions") && ThreadId().IsMatch(Path.GetFileNameWithoutExtension(path));

    private static bool SameContent(string left, string right)
    {
        var leftInfo = new FileInfo(left); var rightInfo = new FileInfo(right);
        if (leftInfo.Length != rightInfo.Length) return false;
        using var a = File.OpenRead(left); using var b = File.OpenRead(right);
        return SHA256.HashData(a).SequenceEqual(SHA256.HashData(b));
    }

    private static void CopyFile(string source, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.Copy(source, temporary, true); File.Move(temporary, destination, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static void BackupFile(string source, string accountHome, string name, string relative)
    {
        var destination = Path.Combine(accountHome, ".history-conflicts", name, relative);
        CopyFile(source, destination);
    }

    private static string BackupPath(string home, string name)
    {
        var path = Path.Combine(home, "." + name + "-backup-" + DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss"));
        for (var index = 2; Directory.Exists(path); index++) path = Path.Combine(home, "." + name + "-backup-" + DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + index);
        return path;
    }

    private static string ResolveDirectory(string path, string error)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException(error);
        var full = new DirectoryInfo(Path.GetFullPath(path)).ResolveLinkTarget(true)?.FullName ?? Path.GetFullPath(path);
        if (full.StartsWith(@"\\", StringComparison.Ordinal) || !Directory.Exists(full)) throw new InvalidOperationException(error);
        return full;
    }

    private static bool IsLink(string path) => (File.Exists(path) || Directory.Exists(path)) &&
        File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint);

    [GeneratedRegex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex ThreadId();
}
