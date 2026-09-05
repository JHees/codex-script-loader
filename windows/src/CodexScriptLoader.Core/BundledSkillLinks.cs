using System.Text;
using System.Text.RegularExpressions;

namespace CodexScriptLoader.Core;

/// <summary>Projects one package-owned skill into Codex's discovery root without a second source copy.</summary>
internal sealed class BundledSkillLinks(LoaderPaths paths, string userSkillRoot, Action<string, string> createLink)
{
    private readonly string root = Path.GetFullPath(userSkillRoot);
    private readonly HashSet<string> conflicts = new(StringComparer.Ordinal);
    private string LedgerPath => Path.Combine(paths.StateRoot, "agent-skill-links.json");

    internal static bool ValidName(string? name) => name is not null &&
        Regex.IsMatch(name, "\\A[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\\z") &&
        !Regex.IsMatch(name, "\\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\\z", RegexOptions.IgnoreCase);

    internal static async Task ValidatePackageAsync(string package, string? name, CancellationToken token)
    {
        if (!ValidName(name)) throw new InvalidDataException("agentSkill must be a safe lowercase skill name of 1-64 characters.");
        var directory = Path.Combine(package, "skills", name!);
        foreach (var path in new[] { Path.Combine(package, "skills"), directory })
            if (!Directory.Exists(path) || File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidDataException("Bundled skill directories must not be links.");
        long bytes = 0;
        var files = 0;
        var pending = new Stack<string>([directory]);
        while (pending.TryPop(out var current))
        {
            foreach (var entry in new DirectoryInfo(current).EnumerateFileSystemInfos())
            {
                token.ThrowIfCancellationRequested();
                if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("Bundled skills cannot contain links.");
                if (entry is DirectoryInfo folder) { pending.Push(folder.FullName); continue; }
                bytes += ((FileInfo)entry).Length;
                if (++files > 128 || bytes > 1024 * 1024) throw new InvalidDataException("Bundled skill exceeds 128 files or 1 MiB.");
            }
        }
        var entryPath = Path.Combine(directory, "SKILL.md");
        if (!File.Exists(entryPath) || new FileInfo(entryPath).Length > 64 * 1024) throw new InvalidDataException("Bundled skill requires a SKILL.md no larger than 64 KiB.");
        var text = await File.ReadAllTextAsync(entryPath, Encoding.UTF8, token).ConfigureAwait(false);
        var frontmatter = Regex.Match(text, "\\A---\\r?\\n(?<body>[\\s\\S]*?)\\r?\\n---(?:\\r?\\n|\\z)");
        if (!frontmatter.Success || !Regex.IsMatch(frontmatter.Groups["body"].Value, $"(?m)^name: *{Regex.Escape(name!)} *\\r?$") ||
            !Regex.IsMatch(frontmatter.Groups["body"].Value, "(?m)^description: *\\S"))
            throw new InvalidDataException("Bundled skill frontmatter requires its declared unquoted name and a description.");
    }

    private string Target(string id, string name) => paths.EnsureWithin(paths.ScriptsRoot, Path.Combine(paths.ScriptsRoot, id, "skills", name), "Skill source");
    private string Link(string name) => paths.EnsureWithin(root, Path.Combine(root, name), "Skill entry");
    private static bool Exists(string path) => Path.Exists(path) || new DirectoryInfo(path).LinkTarget is not null;
    private static bool Matches(string link, string target) => new DirectoryInfo(link).LinkTarget is { } actual &&
        string.Equals(Path.GetFullPath(actual), target, StringComparison.OrdinalIgnoreCase);

    private async Task<Dictionary<string, string>> ReadOwnersAsync(CancellationToken token)
    {
        var owners = await AtomicJsonFile.ReadAsync<Dictionary<string, string>>(LedgerPath, token).ConfigureAwait(false) ?? new(StringComparer.Ordinal);
        if (owners.Any(item => !ValidName(item.Key) || item.Value is null || !Regex.IsMatch(item.Value, "\\A[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?\\z")))
            throw new InvalidDataException("Skill ownership record is invalid.");
        return owners;
    }

    internal async Task CheckAsync(string id, string? name, CancellationToken token)
    {
        if (name is null) return;
        var owners = await ReadOwnersAsync(token).ConfigureAwait(false);
        if ((owners.TryGetValue(name, out var owner) && owner != id) ||
            (Exists(Link(name)) && (owner != id || !Matches(Link(name), Target(id, name)))))
            throw new IOException($"Skill conflict: {name}. Existing user content will not be replaced.");
    }

    internal async Task SyncAsync(string id, string? name, CancellationToken token)
    {
        await CheckAsync(id, name, token).ConfigureAwait(false);
        var owners = await ReadOwnersAsync(token).ConfigureAwait(false);
        if (name is null && !owners.ContainsValue(id)) { conflicts.Remove(id); return; }
        if (name is not null && owners.TryGetValue(name, out var currentOwner) && currentOwner == id &&
            !owners.Any(item => item.Value == id && item.Key != name) && Matches(Link(name), Target(id, name)))
        { conflicts.Remove(id); return; }
        foreach (var entry in owners.Where(item => item.Value == id && item.Key != name).ToArray())
        {
            var link = Link(entry.Key);
            if (Exists(link))
            {
                if (!Matches(link, Target(id, entry.Key))) throw new IOException($"Skill entry was changed by the user: {entry.Key}.");
                Directory.Delete(link, recursive: false); // Delete only the link, never its target contents.
            }
            owners.Remove(entry.Key);
        }
        if (name is not null)
        {
            Directory.CreateDirectory(root);
            owners[name] = id;
        }
        // Write ownership before publishing the link. Startup reconciles an interrupted operation.
        await AtomicJsonFile.WriteAsync(LedgerPath, owners, token).ConfigureAwait(false);
        if (name is not null && !Exists(Link(name))) createLink(Link(name), Target(id, name));
        conflicts.Remove(id);
    }

    internal async Task ReconcileAsync(IReadOnlyList<ScriptDescriptor> installed, Func<string, bool> enabled, CancellationToken token)
    {
        var owners = await ReadOwnersAsync(token).ConfigureAwait(false);
        foreach (var id in owners.Values.Concat(installed.Select(item => item.Id)).Distinct(StringComparer.Ordinal))
        {
            var descriptor = installed.SingleOrDefault(item => item.Id == id);
            try { await SyncAsync(id, descriptor is not null && enabled(id) ? descriptor.AgentSkill : null, token).ConfigureAwait(false); }
            catch (IOException) { conflicts.Add(id); } // An owned entry changed by the user must not stop unrelated plugins.
        }
    }

    internal string Status(ScriptDescriptor descriptor) => conflicts.Contains(descriptor.Id) ? "conflict" : descriptor.AgentSkill is not { } name ? "none" :
        Matches(Link(name), Target(descriptor.Id, name)) && File.Exists(Path.Combine(Link(name), "SKILL.md")) ? "linked" : "inactive";
}
