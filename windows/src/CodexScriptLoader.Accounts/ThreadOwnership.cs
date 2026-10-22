using System.Text.Json;
using System.Security.Cryptography;
using System.Text;

namespace CodexScriptLoader.Accounts;

public sealed record ThreadOwner(string AccountId, string? ParentId = null, bool Ephemeral = false);

public sealed class ThreadOwnership
{
    private readonly string path;
    private readonly Dictionary<string, ThreadOwner> owners;
    private readonly object sync = new();

    public ThreadOwnership(string directory)
    {
        path = Path.Combine(directory, "thread-owners.json");
        owners = File.Exists(path)
            ? JsonSerializer.Deserialize<Dictionary<string, ThreadOwner>>(File.ReadAllBytes(path), AccountStore.JsonOptions)
                ?? throw new InvalidDataException("Invalid thread ownership.")
            : new(StringComparer.Ordinal);
    }

    public ThreadOwner Get(string threadId)
    {
        lock (sync) return owners.GetValueOrDefault(threadId) ?? new("primary");
    }

    public bool Contains(string threadId) { lock (sync) return owners.ContainsKey(threadId); }
    public string[] AllThreads() { lock (sync) return owners.Where(pair => pair.Value.AccountId != "deleted" && !pair.Value.Ephemeral).Select(pair => pair.Key).ToArray(); }
    public string[] BoundTo(string accountId) { lock (sync) return owners.Where(pair => pair.Value.AccountId == accountId).Select(pair => pair.Key).ToArray(); }
    public string[] Children(string threadId) { lock (sync) return owners.Where(pair => pair.Value.ParentId == threadId).Select(pair => pair.Key).ToArray(); }

    public void Set(string threadId, ThreadOwner owner)
    {
        if (string.IsNullOrWhiteSpace(threadId) || threadId.Length > 256) throw new ArgumentException("THREAD_ID_INVALID");
        lock (sync)
        {
            using var mutex = new Mutex(false, @"Local\CodexAccountOwners-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToUpperInvariant()))));
            try { mutex.WaitOne(); } catch (AbandonedMutexException) { }
            try
            {
            var updated = File.Exists(path)
                ? JsonSerializer.Deserialize<Dictionary<string, ThreadOwner>>(File.ReadAllBytes(path), AccountStore.JsonOptions)
                    ?? throw new InvalidDataException("Invalid thread ownership.")
                : new Dictionary<string, ThreadOwner>(StringComparer.Ordinal);
            updated[threadId] = owner;
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, JsonSerializer.Serialize(updated, AccountStore.JsonOptions));
                File.Move(temporary, path, true);
                owners[threadId] = owner;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
}
