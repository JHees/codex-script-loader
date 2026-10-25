using System.Text.Json;
using System.Security.Cryptography;
using System.Text;

namespace CodexScriptLoader.Accounts;

public sealed record ThreadOwner(string AccountId, string? ParentId = null, bool Ephemeral = false, bool Pinned = false, string? Model = null);

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
        Update(() => new Dictionary<string, ThreadOwner>(StringComparer.Ordinal), updated => updated[threadId] = owner);
    }

    // A pinned thread keeps its account when the global default changes; it is the user's explicit
    // model-level choice rather than a pending global migration.
    public void SetPinned(string threadId, bool pinned)
    {
        if (string.IsNullOrWhiteSpace(threadId) || threadId.Length > 256) throw new ArgumentException("THREAD_ID_INVALID");
        Update(() => new Dictionary<string, ThreadOwner>(StringComparer.Ordinal), updated =>
        {
            if (updated.TryGetValue(threadId, out var owner) && owner.Pinned != pinned) updated[threadId] = owner with { Pinned = pinned };
        });
    }

    public void SetModel(string threadId, string? model)
    {
        if (string.IsNullOrWhiteSpace(threadId) || threadId.Length > 256) throw new ArgumentException("THREAD_ID_INVALID");
        Update(() => new Dictionary<string, ThreadOwner>(StringComparer.Ordinal), updated =>
        {
            if (updated.TryGetValue(threadId, out var owner) && owner.Model != model) updated[threadId] = owner with { Model = model };
        });
    }

    public void UnpinAllFor(string accountId)
    {
        Update(() => new Dictionary<string, ThreadOwner>(StringComparer.Ordinal), updated =>
        {
            foreach (var pair in updated.Where(pair => pair.Value.AccountId == accountId && pair.Value.Pinned).ToArray())
                updated[pair.Key] = pair.Value with { Pinned = false };
        });
    }

    private void Update(Func<Dictionary<string, ThreadOwner>> empty, Action<Dictionary<string, ThreadOwner>> mutate)
    {
        lock (sync)
        {
            using var mutex = new Mutex(false, @"Local\CodexAccountOwners-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToUpperInvariant()))));
            try { mutex.WaitOne(); } catch (AbandonedMutexException) { }
            try
            {
                var updated = File.Exists(path)
                    ? JsonSerializer.Deserialize<Dictionary<string, ThreadOwner>>(File.ReadAllBytes(path), AccountStore.JsonOptions)
                        ?? throw new InvalidDataException("Invalid thread ownership.")
                    : empty();
                mutate(updated);
                Commit(updated);
                owners.Clear();
                foreach (var pair in updated) owners[pair.Key] = pair.Value;
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private void Commit(Dictionary<string, ThreadOwner> updated)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(updated, AccountStore.JsonOptions));
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
